import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon, Button, Modal, PanelSplitter } from '@/components/ui'
import { CanvasPreview, LicenseDialog, LocalProjectLibraryDialog, PlaybackControls, Timeline, UpdateDialog } from '@/components/editor'
import { LayerPanel, ResourcePanel, SlotPanel, PropertyPanel, ExportPanel, HistoryPanel } from '@/components/panels'
import type { ImageSelectInfo } from '@/components/panels'
import { useEditorStore } from '@/stores'
import { svgaParser, LayerFactory } from '@/core'
import { tauriAPI, createNativeAPI } from '@/lib/tauri-api'
import { cn } from '@/utils/cn'
import type { AudioResource } from '@/types'
import { previewFileName } from '@/utils/preview-view'
import { createWindowCloseHandler } from '@/lib/window-close'
import { historyActionLabel } from '@/utils/history-label'
import { captureExportInputs, sameExportInputs } from '@/core/export-preview'
import { createProjectArchive, readProjectArchive, MAX_PROJECT_BYTES } from '@/core/project-archive'
import { hydrateProjectDocument } from '@/core/project-hydration'
import { createProjectSaveTarget, getProjectFileName, isProjectFileName } from '@/lib/project-files'
import { createProjectLibrary } from '@/core/project-library'
import { ProjectRecoveryCoordinator, type RecoveryStatus } from '@/core/project-recovery'
import { finishProjectSave } from '@/core/project-save-completion'
import { registerMcpBridge } from '@/lib/mcp-bridge'
import type { LocalProjectPreferences, LocalProjectSnapshot, LocalProjectSummary } from '@/types/project-library'

const INSPECTOR_TABS = [
  { id: 'properties', label: '属性', icon: 'settings' },
  { id: 'slots', label: '插槽', icon: 'key' },
  { id: 'export', label: '导出', icon: 'export' }
] as const
type InspectorTab = typeof INSPECTOR_TABS[number]['id']

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}


// 初始化 Tauri 兼容层
if (isTauriRuntime() && !window.nativeAPI) {
  ;(window as any).nativeAPI = createNativeAPI()
}


function base64ToArrayBuffer(data: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}


function isSvgaFileName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.svga')
}

function isSupportedFileName(fileName: string): boolean {
  return isSvgaFileName(fileName) || isProjectFileName(fileName)
}


// Windows 窗口控制组件 - 使用 Tauri API
const WindowControls: React.FC<{ onError: (message: string) => void }> = ({ onError }) => {
  const [isMaximized, setIsMaximized] = useState(false)
  const [platform, setPlatform] = useState<string>('')

  useEffect(() => {
    tauriAPI.platform.get().then(p => setPlatform(p)).catch(() => {})
  }, [])

  if (platform === 'darwin' || platform === 'macos') {
    return null
  }

  return (
    <div className="flex items-center">
      <button
        className="w-11 h-8 flex items-center justify-center hover:bg-white/10 transition-colors"
        onClick={() => tauriAPI.window.minimize()}
      >
        <Icon name="minus" size={14} className="text-text-secondary" />
      </button>
      <button
        className="w-11 h-8 flex items-center justify-center hover:bg-white/10 transition-colors"
        onClick={async () => {
          await tauriAPI.window.maximize()
          setIsMaximized(!isMaximized)
        }}
      >
        <Icon name={isMaximized ? 'maximize' : 'fullscreen'} size={14} className="text-text-secondary" />
      </button>
      <button
        className="w-11 h-8 flex items-center justify-center hover:bg-red-500 transition-colors"
        aria-label="关闭窗口"
        onClick={() => { void tauriAPI.window.close().catch(err => onError(`关闭窗口失败：${String(err)}`)) }}
      >
        <Icon name="close" size={14} className="text-text-secondary" />
      </button>
    </div>
  )
}

type MenuId = 'file' | 'edit' | 'view' | 'help'
type UnsavedChoice = 'save' | 'discard' | 'cancel'

interface MenuAction {
  label: string
  shortcut?: string
  disabled?: boolean
  onSelect?: () => void
}

interface MenuBarProps {
  onWindowError: (message: string) => void
  onOpenFile: () => void
  onOpenUrl: () => void
  onSave: () => void
  onSaveAs: () => void
  onExport: () => void
  onUndo: () => void
  onRedo: () => void
  showHistory: boolean
  onToggleHistory: () => void
  onShowAbout: () => void
  onCheckUpdates: () => void
  onShowLicense: () => void
}

// 菜单栏组件
const MenuBar: React.FC<MenuBarProps> = ({
  onWindowError,
  onOpenFile,
  onOpenUrl,
  onSave,
  onSaveAs,
  onExport,
  onUndo,
  onRedo,
  showHistory,
  onToggleHistory,
  onShowAbout,
  onCheckUpdates,
  onShowLicense
}) => {
  const videoItem = useEditorStore((s) => s.videoItem)
  const currentSource = useEditorStore((s) => s.currentSource)
  const projectName = useEditorStore(s => s.projectName)
  const isDirty = useEditorStore((s) => s.isDirty)
  const canUndo = useEditorStore((s) => s.canUndo)
  const canRedo = useEditorStore((s) => s.canRedo)
  const showGrid = useEditorStore((s) => s.showGrid)
  const undoLabel = useEditorStore((s) => s.history.timelineSnapshot ? '撤销：选择快照' : historyActionLabel('撤销', s.history.past[s.history.past.length - 1]))
  const redoLabel = useEditorStore((s) => s.history.timelineSnapshot ? '重做' : historyActionLabel('重做', s.history.future[0]))
  const rendererMode = useEditorStore((s) => s.rendererMode)
  const toggleGrid = useEditorStore((s) => s.toggleGrid)
  const setRendererMode = useEditorStore((s) => s.setRendererMode)
  const [activeMenu, setActiveMenu] = useState<MenuId | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!activeMenu) return

    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setActiveMenu(null)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveMenu(null)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [activeMenu])

  const runAction = (action?: () => void) => {
    setActiveMenu(null)
    action?.()
  }

  const menus: Record<MenuId, MenuAction[]> = {
    file: [
      { label: '打开 SVGA / 工程', shortcut: 'Ctrl+O', onSelect: onOpenFile },
      { label: '打开 URL', shortcut: 'Ctrl+Shift+O', onSelect: onOpenUrl },
      { label: '保存工程', shortcut: 'Ctrl+S', disabled: !videoItem, onSelect: onSave },
      { label: '工程另存为...', shortcut: 'Ctrl+Shift+S', disabled: !videoItem, onSelect: onSaveAs },
      { label: '导出 SVGA / 图片', shortcut: 'Ctrl+E', disabled: !videoItem, onSelect: onExport }
    ],
    edit: [
      { label: undoLabel, shortcut: 'Ctrl+Z', disabled: !canUndo, onSelect: onUndo },
      { label: redoLabel, shortcut: 'Ctrl+Shift+Z / Ctrl+Y', disabled: !canRedo, onSelect: onRedo },
      { label: videoItem ? '请选择图层后使用图层面板编辑' : '打开文件后可编辑图层', disabled: true }
    ],
    view: [
      { label: `${showHistory ? '隐藏' : '显示'}历史记录`, onSelect: onToggleHistory },
      { label: `${showGrid ? '隐藏' : '显示'}网格`, onSelect: toggleGrid },
      {
        label: `渲染器：${rendererMode === 'high-performance' ? 'Canvas 高性能' : '官方兼容'}`,
        onSelect: () => {
          const nextMode = rendererMode === 'official' ? 'high-performance' : 'official'
          setRendererMode(nextMode)
        }
      }
    ],
    help: [
      { label: '检查桌面更新', onSelect: onCheckUpdates },
      { label: '授权状态', onSelect: onShowLicense },
      { label: '关于 SVGA Editor Pro', onSelect: onShowAbout }
    ]
  }

  const menuLabels: Array<{ id: MenuId; label: string }> = [
    { id: 'file', label: '文件' },
    { id: 'edit', label: '编辑' },
    { id: 'view', label: '视图' },
    { id: 'help', label: '帮助' }
  ]

  return (
    <div className="h-8 bg-bg-tertiary border-b border-border flex items-center justify-between px-4">
      {/* 左侧菜单 */}
      <div ref={menuRef} className="relative flex items-center gap-1">
        {menuLabels.map((menu) => (
          <div key={menu.id} className="relative">
            <MenuButton
              active={activeMenu === menu.id}
              onClick={() => setActiveMenu(activeMenu === menu.id ? null : menu.id)}
            >
              {menu.label}
            </MenuButton>
            {activeMenu === menu.id && (
              <div className="absolute left-0 top-full z-40 mt-1 w-52 rounded border border-border bg-bg-secondary py-1 shadow-xl">
                {menus[menu.id].map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    disabled={item.disabled}
                    className="flex h-8 w-full items-center justify-between gap-3 px-3 text-left text-xs text-text-secondary transition-colors hover:bg-accent/15 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-text-secondary"
                    onClick={() => runAction(item.onSelect)}
                  >
                    <span className="truncate">{item.label}</span>
                    {item.shortcut && <span className="flex-shrink-0 text-[10px] text-text-muted">{item.shortcut}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 中间标题 */}
      <div className="absolute left-1/2 -translate-x-1/2 flex max-w-[36%] items-center gap-2 pointer-events-none">
        <Icon name="play" size={16} className="text-accent" />
        <span className="truncate text-sm text-text-primary">{videoItem ? projectName || previewFileName(currentSource) : 'SVGA Editor Pro'}</span>
        {isDirty && <span className="flex-shrink-0 h-1.5 w-1.5 rounded-full bg-warning" title="有未保存修改" />}
      </div>

      {/* 右侧窗口控制 */}
      <WindowControls onError={onWindowError} />
    </div>
  )
}

const MenuButton: React.FC<{
  children: React.ReactNode
  active?: boolean
  onClick: () => void
}> = ({ children, active = false, onClick }) => {
  return (
    <button
      type="button"
      className={cn(
        'px-3 py-1 text-sm text-text-secondary hover:text-text-primary hover:bg-white/5 rounded transition-colors',
        active && 'bg-white/10 text-text-primary'
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

// 状态栏组件
const StatusBar: React.FC = () => {
  const videoItem = useEditorStore((s) => s.videoItem)
  const isDirty = useEditorStore((s) => s.isDirty)
  const projectName = useEditorStore(s => s.projectName)
  const fps = useEditorStore((s) => s.playback.fps)
  const totalFrames = useEditorStore((s) => s.playback.totalFrames)
  const currentFrame = useEditorStore((s) => s.playback.currentFrame)
  const [memory, setMemory] = useState('0 MB')

  useEffect(() => {
    const updateMemory = () => {
      if ((performance as any).memory) {
        const mb = Math.round((performance as any).memory.usedJSHeapSize / 1024 / 1024)
        setMemory(`${mb} MB`)
      }
    }
    updateMemory()
    const timer = setInterval(updateMemory, 5000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="h-6 bg-bg-tertiary border-t border-border flex items-center justify-between px-4 text-xs text-text-muted">
      <div className="flex items-center gap-4">
        <span>{videoItem ? (isDirty ? '工程未保存' : projectName ? '工程已保存' : '源文件已载入 · 尚未保存工程') : '等待文件'}</span>
        {videoItem && (
          <span>内存: {memory}</span>
        )}
      </div>
      <div className="flex items-center gap-4">
        {videoItem && (
          <>
            <span>FPS: {fps}</span>
            <span>帧: {currentFrame + 1}/{totalFrames}</span>
          </>
        )}
        <span>SVGA Editor Pro v2.0.0</span>
      </div>
    </div>
  )
}

// 主应用组件
export const App: React.FC = () => {
  const [showUrlModal, setShowUrlModal] = useState(false)
  const [showAboutModal, setShowAboutModal] = useState(false)
  const [mcpStatus, setMcpStatus] = useState<{ enabled: boolean; endpoint: string; token: string; protocol_version: string; image_generation_configured: boolean } | null>(null)
  const [showUpdateModal, setShowUpdateModal] = useState(false)
  const [showLicenseModal, setShowLicenseModal] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [showUnsavedModal, setShowUnsavedModal] = useState(false)
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [projectNotice, setProjectNotice] = useState<string | null>(null)
  const [showProjectLibrary, setShowProjectLibrary] = useState(false)
  const [projectLibrarySnapshot, setProjectLibrarySnapshot] = useState<LocalProjectSnapshot | null>(null)
  const [projectLibraryLoading, setProjectLibraryLoading] = useState(false)
  const [projectLibraryError, setProjectLibraryError] = useState<string | null>(null)
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus | null>(null)
  const [startupRecoveryHint, setStartupRecoveryHint] = useState(false)
  const [localProjectNotice, setLocalProjectNotice] = useState<string | null>(null)
  const libraryReadSequenceRef = useRef(0)
  const documentBusyRef = useRef(false)
  const projectDisposeRef = useRef<(() => void) | null>(null)
  const projectLibraryRef = useRef<ReturnType<typeof createProjectLibrary> | null>(null)
  const recoveryRef = useRef<ProjectRecoveryCoordinator | null>(null)
  const [launchFileChecked, setLaunchFileChecked] = useState(false)
  const devAutoLoadRef = useRef(false)
  const launchFileAutoLoadRef = useRef(false)
  const unsavedResolverRef = useRef<((choice: UnsavedChoice) => void) | null>(null)
  const handleSaveRef = useRef<(() => Promise<boolean>) | null>(null)
  const svgaFileInputRef = useRef<HTMLInputElement>(null)
  const exportPanelRef = useRef<HTMLDivElement>(null)
  
  // 面板宽度状态
  const [leftPanelWidth, setLeftPanelWidth] = useState(320)
  const [rightPanelWidth, setRightPanelWidth] = useState(340)
  const [layerPanelHeight, setLayerPanelHeight] = useState(340)
  const [historyPanelHeight, setHistoryPanelHeight] = useState(280)
  const [showHistory, setShowHistory] = useState(true)
  const [historyCollapsed, setHistoryCollapsed] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('properties')
  const [isImmersive, setIsImmersive] = useState(false)
  const previewVideoItem = useEditorStore((s) => s.videoItem)
  const updateDirty = useEditorStore((s) => s.isDirty)
  const toggleImmersive = useCallback(() => {
    if (useEditorStore.getState().videoItem) setIsImmersive(value => !value)
  }, [])
  useEffect(() => { setIsImmersive(false) }, [previewVideoItem])
  const toggleHistory = useCallback(() => {
    setIsImmersive(false)
    setShowHistory(value => !value)
    setHistoryCollapsed(false)
  }, [])

  const setVideoItem = useEditorStore((s) => s.setVideoItem)
  const setSource = useEditorStore((s) => s.setSource)
  const setOriginalBuffer = useEditorStore((s) => s.setOriginalBuffer)
  const setDetectedSlots = useEditorStore((s) => s.setDetectedSlots)
  const setAudioResources = useEditorStore((s) => s.setAudioResources)
  const setRendererMode = useEditorStore((s) => s.setRendererMode)
  const undo = useEditorStore((s) => s.undo)
  const redo = useEditorStore((s) => s.redo)
  const undoLabel = useEditorStore((s) => s.history.timelineSnapshot ? '撤销：选择快照' : historyActionLabel('撤销', s.history.past[s.history.past.length - 1]))
  const redoLabel = useEditorStore((s) => s.history.timelineSnapshot ? '重做' : historyActionLabel('重做', s.history.future[0]))
  const canUndo = useEditorStore((s) => s.canUndo)
  const canRedo = useEditorStore((s) => s.canRedo)
  
  // 图层操作
  const addLayer = useEditorStore((s) => s.addLayer)
  const selectLayer = useEditorStore((s) => s.selectLayer)
  const params = useEditorStore((s) => s.params)
  const addImageResource = useEditorStore((s) => s.addImageResource)

  const refreshProjectLibrary = useCallback(async () => {
    const repository = projectLibraryRef.current
    if (!repository) return
    const sequence = ++libraryReadSequenceRef.current
    setProjectLibraryLoading(true)
    const isCurrent = () => repository === projectLibraryRef.current && sequence === libraryReadSequenceRef.current
    try {
      const snapshot = await repository.snapshot()
      if (isCurrent()) setProjectLibrarySnapshot(snapshot)
    } catch (error) {
      if (isCurrent()) setProjectLibraryError(error instanceof Error ? error.message : String(error))
    } finally { if (isCurrent()) setProjectLibraryLoading(false) }
  }, [])

  useEffect(() => {
    const repository = createProjectLibrary()
    projectLibraryRef.current = repository
    let active = true
    const coordinator = new ProjectRecoveryCoordinator({ repository, onStatus: status => { if (active) setRecoveryStatus(status) } })
    recoveryRef.current = coordinator
    const unsubscribe = repository.subscribe(() => { void refreshProjectLibrary() })
    void coordinator.start()
    void refreshProjectLibrary()
    void repository.snapshot().then(snapshot => {
      if (active) setStartupRecoveryHint(snapshot.entries.some(entry => entry.kind === 'recovery'))
    }).catch(() => {})
    return () => {
      active = false
      unsubscribe(); coordinator.stop(); repository.close()
      if (projectLibraryRef.current === repository) projectLibraryRef.current = null
      if (recoveryRef.current === coordinator) recoveryRef.current = null
    }
  }, [refreshProjectLibrary])

  const openProjectLibrary = useCallback(() => {
    setProjectLibraryError(null)
    setStartupRecoveryHint(false)
    setShowProjectLibrary(true)
    void refreshProjectLibrary()
  }, [refreshProjectLibrary])

  // 处理图片选择 - 创建新图层
  const handleImageSelect = useCallback((info: ImageSelectInfo) => {
    
    // 如果是原始 SVGA 图片，需要先创建 ImageResource
    let resource = info.resource
    if (!resource && info.buffer) {
      // 从原始 buffer 创建 ImageResource
      resource = {
        key: info.key,
        data: new Uint8Array(info.buffer),
        width: 0,  // 将在加载后更新
        height: 0,
        mimeType: info.mimeType as any,
        blobUrl: info.url,
        isNew: false
      }
      // 添加到资源库
      addImageResource(resource)
    }
    
    if (!resource) {
      console.error('[App] No resource available for layer creation')
      return
    }
    
    // 创建新图层 - 在回调中使用 getState() 避免订阅 playback
    const currentFrame = useEditorStore.getState().playback.currentFrame
    const newLayer = LayerFactory.createImageLayer(resource, {
      name: info.key,
      startFrame: currentFrame,
      params: params || undefined
    })
    
    const layerId = addLayer(newLayer)
    selectLayer(layerId)
  }, [addLayer, selectLayer, params, addImageResource])

  const resolveUnsavedChoice = useCallback((choice: UnsavedChoice) => {
    unsavedResolverRef.current?.(choice)
    unsavedResolverRef.current = null
    setShowUnsavedModal(false)
  }, [])

  const confirmDiscardUnsavedChanges = useCallback(async (): Promise<UnsavedChoice> => {
    // 同时收到打开/关闭请求时，后来的操作不能替换正在等待的确认回调。
    if (unsavedResolverRef.current) return 'cancel'
    useEditorStore.getState().endCanvasTransform(true)
    if (!useEditorStore.getState().isDirty) return 'discard'

    return new Promise((resolve) => {
      unsavedResolverRef.current = resolve
      setShowUnsavedModal(true)
    })
  }, [])

  const runWithUnsavedProtection = useCallback(async (operation: () => Promise<void> | void) => {
    if (documentBusyRef.current) return
    const choice = await confirmDiscardUnsavedChanges()
    if (choice === 'cancel') return
    if (choice === 'save') {
      const saved = await handleSaveRef.current?.()
      if (!saved) return
    }
    await operation()
  }, [confirmDiscardUnsavedChanges])

  // 加载 SVGA 文件
  const loadSVGA = useCallback(async (buffer: ArrayBuffer, source: string, type: 'url' | 'file') => {
    documentBusyRef.current = true
    const previousInputs = captureExportInputs(useEditorStore.getState())
    setLoading(true)
    setError(null)
    setProjectNotice(null)

    try {
      await svgaParser.init()
      const videoItem = await svgaParser.parse(buffer)
      const slots = svgaParser.detectSlots(videoItem.movie)
      const hasMatte = videoItem.movie.sprites?.some((sprite) => Boolean(sprite.matteKey))

      // 先完成异步资源解析，再一次性建立打开状态，避免初始化期间的编辑被清空。
      let parsedAudioResources = new Map<string, AudioResource>()
      try {
        const resources = await svgaParser.parseAudios(videoItem.movie)
        parsedAudioResources = new Map(resources.map(resource => [resource.key, resource]))
      } catch (audioErr) {
        console.warn('[App] 音频解析失败，不影响主流程:', audioErr)
      }

      if (!sameExportInputs(previousInputs, captureExportInputs(useEditorStore.getState()))) throw new Error('打开期间当前工程已修改，请再次打开文件。')
      projectDisposeRef.current?.()
      projectDisposeRef.current = null
      setVideoItem(videoItem)
      setSource(source, type)
      setOriginalBuffer(buffer)
      setDetectedSlots(slots)
      setAudioResources(parsedAudioResources)
      if (hasMatte) {
        setRendererMode('official')
      }

      useEditorStore.getState().initializeHistory()
    } catch (err) {
      console.error('[App] Load error:', err)
      setError(`加载失败: ${(err as Error).message}`)
    } finally {
      documentBusyRef.current = false
      setLoading(false)
    }
  }, [setVideoItem, setSource, setOriginalBuffer, setDetectedSlots, setAudioResources, setRendererMode])

  const loadProject = useCallback(async (buffer: ArrayBuffer, displayName: string, filePath: string | null, localCopy = false): Promise<boolean> => {
    documentBusyRef.current = true
    const previousInputs = captureExportInputs(useEditorStore.getState())
    setLoading(true); setError(null); setProjectNotice(null)
    let prepared: Awaited<ReturnType<typeof hydrateProjectDocument>> | undefined
    try {
      const document = await readProjectArchive(buffer)
      prepared = await hydrateProjectDocument(document)
      if (!sameExportInputs(previousInputs, captureExportInputs(useEditorStore.getState()))) throw new Error('打开期间当前工程已修改，请重新打开工程。')
      useEditorStore.getState().restoreProjectDocument(prepared.document, filePath, displayName)
      // 本机副本不是已确认写入的磁盘工程；恢复后必须另行保存，不能丢掉关闭保护。
      if (localCopy) useEditorStore.setState({ isDirty: true, projectFilePath: null })
      projectDisposeRef.current?.()
      projectDisposeRef.current = prepared.dispose
      prepared = undefined
      setProjectNotice(localCopy ? '已打开本机工程副本；请保存为工程文件，原磁盘文件不会自动覆盖。' : '工程已恢复，关键帧、文字和素材均可继续编辑。')
      if (!localCopy) {
        try { await recoveryRef.current?.recordRecent(new Blob([buffer]), displayName) }
        catch { setLocalProjectNotice('工程已打开，但未能保留最近工程的本机副本。磁盘文件不受影响。') }
      }
      return true
    } catch (error) { prepared?.dispose(); setError(`工程未打开，当前工作保留：${(error as Error).message}`); return false }
    finally { documentBusyRef.current = false; setLoading(false) }
  }, [])

  const loadSVGAFromFilePath = useCallback(async (filePath: string) => {
    if (!isSupportedFileName(filePath) || documentBusyRef.current) return
    documentBusyRef.current = true
    const previousInputs = captureExportInputs(useEditorStore.getState())
    setLoading(true); setError(null)
    try {
      const result = isProjectFileName(filePath) ? await tauriAPI.file.readProject(filePath) : await tauriAPI.file.read(filePath)
      if (!result.success || !result.data) throw new Error(result.error || '文件读取失败')
      if (!sameExportInputs(previousInputs, captureExportInputs(useEditorStore.getState()))) throw new Error('读取期间当前工程已修改，请再次打开。')
      const buffer = base64ToArrayBuffer(result.data)
      if (isProjectFileName(filePath)) await loadProject(buffer, filePath.split(/[\\\\/]/).pop()!, filePath)
      // 桌面与网页使用同一完整解析结果，避免原生简化传输遗漏音频和形状字段。
      else await loadSVGA(buffer, filePath, 'file')
    } catch (error) { setError('打开文件失败，当前工作保留：' + (error instanceof Error ? error.message : String(error))) }
    finally { documentBusyRef.current = false; setLoading(false) }
  }, [loadSVGA, loadProject])

  useEffect(() => {
    if (launchFileAutoLoadRef.current) return
    launchFileAutoLoadRef.current = true

    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
      setLaunchFileChecked(true)
      return
    }

    ;(async () => {
      try {
        const filePath = await tauriAPI.app.getLaunchSvgaFile()
        if (filePath) {
          await loadSVGAFromFilePath(filePath)
        }
      } catch (err) {
        setError(`Open associated file failed: ${(err as Error).message}`)
      } finally {
        setLaunchFileChecked(true)
      }
    })()
  }, [loadSVGAFromFilePath])

  useEffect(() => {
    if (!import.meta.env.DEV || devAutoLoadRef.current) return

    const loadParam = new URLSearchParams(window.location.search).get('load')
    if (!loadParam) return

    devAutoLoadRef.current = true
    ;(async () => {
      try {
        const response = await fetch(loadParam)
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const buffer = await response.arrayBuffer()
        await loadSVGA(buffer, loadParam, 'url')
      } catch (err) {
        setError(`自动加载失败: ${(err as Error).message}`)
      }
    })()
  }, [loadSVGA])

  const handleSvgaFile = useCallback(async (file: File) => {
    if (documentBusyRef.current) return
    if (!isSupportedFileName(file.name)) {
      setError('请选择 .svga 或 .svgaproj 文件')
      return
    }
    if (file.size > MAX_PROJECT_BYTES) { setError('文件超过 128 MiB，未打开。'); return }
    documentBusyRef.current = true
    const previousInputs = captureExportInputs(useEditorStore.getState())
    setLoading(true)
    try {
      const buffer = await file.arrayBuffer()
      if (!sameExportInputs(previousInputs, captureExportInputs(useEditorStore.getState()))) throw new Error('读取期间当前工程已修改，请再次打开。')
      if (isProjectFileName(file.name)) await loadProject(buffer, file.name, null)
      else await loadSVGA(buffer, file.name, 'file')
    } finally { documentBusyRef.current = false; setLoading(false) }
  }, [loadSVGA, loadProject])

  const handleSvgaFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    try {
      await runWithUnsavedProtection(() => handleSvgaFile(file))
    } catch (err) {
      setError(`打开文件失败: ${(err as Error).message}`)
    }
  }, [handleSvgaFile, runWithUnsavedProtection])

  // 打开文件 - Tauri 使用系统对话框，Web 使用隐藏 input
  const handleOpenFile = useCallback(async () => {
    if (documentBusyRef.current) return
    if (!isTauriRuntime()) {
      // 先选择文件，选择成功后再询问；取消文件对话框不会提前放弃当前修改。
      svgaFileInputRef.current?.click()
      return
    }

    try {
      const filePath = await tauriAPI.dialog.openFile({
        filters: [
          { name: 'SVGA / 编辑工程', extensions: ['svga', 'svgaproj'] },
          { name: 'SVGA Files', extensions: ['svga'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      if (!filePath) return
      await runWithUnsavedProtection(() => loadSVGAFromFilePath(filePath))
    } catch (err) {
      setError(`打开文件失败: ${(err as Error).message}`)
    }
  }, [loadSVGAFromFilePath, runWithUnsavedProtection])

  // 打开 URL
  const handleOpenUrl = async () => {
    if (!url || documentBusyRef.current) return

    try {
      await runWithUnsavedProtection(async () => {
        documentBusyRef.current = true
        const previousInputs = captureExportInputs(useEditorStore.getState())
        setLoading(true)
        try {
          const response = await fetch(url)
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const buffer = await response.arrayBuffer()
          if (!sameExportInputs(previousInputs, captureExportInputs(useEditorStore.getState()))) throw new Error('下载期间当前工程已修改，请再次打开。')
          if (isProjectFileName(new URL(url).pathname)) await loadProject(buffer, new URL(url).pathname.split('/').pop()!, null)
          else await loadSVGA(buffer, url, 'url')
          setShowUrlModal(false)
          setUrl('')
        } finally { documentBusyRef.current = false; setLoading(false) }
      })
    } catch (err) {
      setError(`加载 URL 失败: ${(err as Error).message}`)
    }
  }

  // 拖放文件
  const handleDrop = useCallback(async (e: DragEvent) => {
    if (e.defaultPrevented) return
    e.preventDefault()
    const file = e.dataTransfer?.files[0]
    if (file) {
      try {
        await runWithUnsavedProtection(() => handleSvgaFile(file))
      } catch (err) {
        setError(`拖放文件失败: ${(err as Error).message}`)
      }
    }
  }, [handleSvgaFile, runWithUnsavedProtection])

  useEffect(() => {
    const handleDragOver = (e: DragEvent) => e.preventDefault()

    document.addEventListener('drop', handleDrop)
    document.addEventListener('dragover', handleDragOver)
    return () => {
      document.removeEventListener('drop', handleDrop)
      document.removeEventListener('dragover', handleDragOver)
    }
  }, [handleDrop])

  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return

    let disposed = false
    let unlisten: (() => void) | null = null

    ;(async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview')
        unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
          if (event.payload.type !== 'drop') return

          const filePath = event.payload.paths.find(isSupportedFileName)
          if (filePath) {
            await runWithUnsavedProtection(() => loadSVGAFromFilePath(filePath))
          }
        })

        if (disposed) {
          unlisten()
          unlisten = null
        }
      } catch (err) {
        console.warn('[App] Tauri drag-drop listener unavailable:', err)
      }
    })()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [loadSVGAFromFilePath, runWithUnsavedProtection])

  useEffect(() => {
    if (!isTauriRuntime()) return

    let disposed = false
    let unlisten: (() => void) | null = null
    let closeHandler: ReturnType<typeof createWindowCloseHandler> | null = null

    ;(async () => {
      try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
        if (disposed) return
        const nativeWindow = getCurrentWebviewWindow()
        closeHandler = createWindowCloseHandler({
          isBusy: () => documentBusyRef.current,
          isDirty: () => useEditorStore.getState().isDirty,
          confirm: confirmDiscardUnsavedChanges,
          save: async () => await handleSaveRef.current?.() ?? false,
          destroy: () => nativeWindow.destroy(),
          onError: err => setError(`关闭窗口失败：${String(err)}`)
        })
        unlisten = await nativeWindow.onCloseRequested(closeHandler.handle)

        if (disposed) {
          unlisten()
          unlisten = null
        }
      } catch (err) {
        console.warn('[App] Tauri close listener unavailable:', err)
        if (!disposed) setError(`未能启用关闭保护：${String(err)}`)
      }
    })()

    return () => {
      disposed = true
      closeHandler?.dispose()
      unlisten?.()
    }
  }, [confirmDiscardUnsavedChanges])

  // 开发模式：自动加载测试文件
  useEffect(() => {
    if (!launchFileChecked) return
    if (new URLSearchParams(window.location.search).has('load')) return
    if (useEditorStore.getState().videoItem) return

    if (import.meta.env.DEV) {
      const loadTestSVGA = async () => {
        try {
          const response = await fetch('/test.svga')
          if (response.ok) {
            const buffer = await response.arrayBuffer()
            await loadSVGA(buffer, '/test.svga', 'url')
          }
        } catch (err) {
          // No test.svga found, skipping auto-load
        }
      }
      loadTestSVGA()
    }
  }, [loadSVGA, launchFileChecked])

  // 保存工程与导出运行时 SVGA 分离；只有确认写入且内容未改变才清除未保存状态。
  const saveProject = useCallback(async (saveAs = false): Promise<boolean> => {
    if (documentBusyRef.current || !useEditorStore.getState().videoItem) return false
    useEditorStore.getState().endCanvasTransform(true)
    const before = useEditorStore.getState()
    documentBusyRef.current = true
    setLoading(true); setError(null); setProjectNotice(null)
    try {
      const target = await createProjectSaveTarget(getProjectFileName(before.projectName || before.currentSource), saveAs ? null : before.projectFilePath)
      if (!target) { setProjectNotice('已取消保存工程，当前修改保留。'); return false }
      if (useEditorStore.getState().videoItem !== before.videoItem) throw new Error('当前文件已变化，请重新保存。')
      const document = useEditorStore.getState().captureProjectDocument()
      const inputs = captureExportInputs(useEditorStore.getState())
      const blob = await createProjectArchive(document)
      await target.write(blob)
      if (target.confirmation === 'download') {
        setProjectNotice('工程下载已发起；浏览器无法确认落盘，请检查下载文件。未保存标记保留。')
        // 下载快照可用于最近工程，但不能清除未保存状态或恢复副本。
        if (sameExportInputs(inputs, captureExportInputs(useEditorStore.getState()))) {
          try { await recoveryRef.current?.recordRecent(blob, target.displayName) }
          catch { setLocalProjectNotice('未能保留最近工程副本，请检查已发起的工程下载。') }
        }
        return false
      }
      const { current, localWarning } = await finishProjectSave({ archive: blob, inputs, filePath: target.filePath, displayName: target.displayName, recovery: recoveryRef.current })
      if (localWarning) setLocalProjectNotice(localWarning)
      void refreshProjectLibrary()
      setProjectNotice(current ? '工程已保存；文字、关键帧和素材可在下次打开时继续编辑。' : '已保存先前快照；保存期间出现的新修改仍未保存。')
      return current
    } catch (error) {
      setError('工程未保存：' + (error instanceof Error ? error.message : String(error)))
      return false
    } finally { documentBusyRef.current = false; setLoading(false) }
  }, [refreshProjectLibrary])

  const handleSave = useCallback(() => saveProject(false), [saveProject])
  const handleSaveAs = useCallback(() => saveProject(true), [saveProject])

  const openLocalProject = useCallback(async (entry: LocalProjectSummary) => {
    if (documentBusyRef.current) return
    setProjectLibraryError(null)
    let ownsBusy = false
    try {
      const repository = projectLibraryRef.current
      if (!repository) throw new Error('本机工程库尚未准备好')
      const choice = await confirmDiscardUnsavedChanges()
      if (choice === 'cancel') return
      if (choice === 'save' && !await handleSaveRef.current?.()) {
        setProjectLibraryError('当前工程尚未确认保存，已取消打开副本。当前修改保留；请关闭工程库查看保存提示，确认保存后再打开。')
        return
      }
      if (documentBusyRef.current) return
      documentBusyRef.current = true; ownsBusy = true
      const inputs = captureExportInputs(useEditorStore.getState())
      const record = await repository.get(entry.id)
      if (!record) throw new Error('本机副本已不存在，请刷新列表。')
      if (record.revision !== entry.revision) throw new Error('该本机副本已被更新，请刷新列表后再选择。')
      const bytes = await record.archive.arrayBuffer()
      if (!sameExportInputs(inputs, captureExportInputs(useEditorStore.getState()))) throw new Error('读取期间当前工程有新修改，请再次打开。')
      if (!await loadProject(bytes, getProjectFileName(record.name), null, true)) throw new Error('副本未能打开，当前工程和原副本均保留。请下载副本检查，或重新选择磁盘工程。')
      setShowProjectLibrary(false)
    } catch (error) { setProjectLibraryError(error instanceof Error ? error.message : String(error)); throw error }
    finally { if (ownsBusy) documentBusyRef.current = false }
  }, [confirmDiscardUnsavedChanges, loadProject])

  const downloadLocalProject = useCallback(async (entry: LocalProjectSummary) => {
    setProjectLibraryError(null)
    try {
      const repository = projectLibraryRef.current
      if (!repository) throw new Error('本机工程库尚未准备好')
      // 在 IndexedDB 异步读取之前请求保存目标，保留文件对话框需要的用户手势。
      const target = await createProjectSaveTarget(entry.name, null)
      if (!target) return
      const record = await repository.get(entry.id)
      if (!record) throw new Error('本机副本已不存在，请刷新列表。')
      if (record.revision !== entry.revision) throw new Error('该副本已更新，请刷新后再下载。')
      await target.write(record.archive)
      setLocalProjectNotice(target.confirmation === 'written' ? '本机工程副本已保存到所选文件。' : '工程下载已发起，请检查下载目录。')
    } catch (error) { setProjectLibraryError(error instanceof Error ? error.message : String(error)); throw error }
  }, [])

  const removeLocalProject = useCallback(async (entry: LocalProjectSummary) => {
    const repository = projectLibraryRef.current
    setProjectLibraryError(null)
    try {
      if (!repository) throw new Error('本机工程库尚未准备好')
      await repository.remove(entry.id)
      await refreshProjectLibrary()
    } catch (error) { setProjectLibraryError(error instanceof Error ? error.message : String(error)); throw error }
  }, [refreshProjectLibrary])

  const clearLocalProjects = useCallback(async () => {
    const repository = projectLibraryRef.current
    setProjectLibraryError(null)
    try {
      if (!repository) throw new Error('本机工程库尚未准备好')
      await repository.clear()
      setStartupRecoveryHint(false)
      await refreshProjectLibrary()
    } catch (error) { setProjectLibraryError(error instanceof Error ? error.message : String(error)); throw error }
  }, [refreshProjectLibrary])

  const configureLocalProjects = useCallback(async (patch: Partial<Pick<LocalProjectPreferences, 'recoveryEnabled' | 'recentEnabled'>>) => {
    const repository = projectLibraryRef.current
    setProjectLibraryError(null)
    try {
      if (!repository) throw new Error('本机工程库尚未准备好')
      await repository.configure(patch)
      await refreshProjectLibrary()
    } catch (error) { setProjectLibraryError(error instanceof Error ? error.message : String(error)); throw error }
  }, [refreshProjectLibrary])

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (useEditorStore.getState().isDirty || documentBusyRef.current) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      unsavedResolverRef.current?.('cancel')
      unsavedResolverRef.current = null
      projectDisposeRef.current?.()
    }
  }, [])

  useEffect(() => {
    if (!showAboutModal) return
    if (isTauriRuntime()) {
      void tauriAPI.app.getMcpStatus().then(setMcpStatus).catch(() => setMcpStatus(null))
      return
    }
    void fetch('/mcp/status').then(response => response.ok ? response.json() : Promise.reject(new Error('MCP web status unavailable'))).then(setMcpStatus).catch(() => setMcpStatus(null))
  }, [showAboutModal])

  // 桌面端 MCP 请求通过事件进入前端，复用 Zustand actions，避免第二套编辑逻辑。
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void registerMcpBridge().then(cleanup => {
      if (disposed) cleanup?.()
      else unlisten = cleanup
    }).catch(error => console.warn('[MCP] 桥接初始化失败：', error))
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const handleFocusExportPanel = useCallback(() => {
    setIsImmersive(false)
    setInspectorTab('export')
    requestAnimationFrame(() => {
      document.getElementById('inspector-tab-export')?.focus({ preventScroll: true })
      exportPanelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }, [])

  useEffect(() => {
    handleSaveRef.current = handleSave
  }, [handleSave])

  // 菜单事件监听 - 使用 Tauri 兼容层
  useEffect(() => {
    const unsubscribe = (window as any).nativeAPI?.onMenuAction?.((action: string) => {
      switch (action) {
        case 'openFile':
          handleOpenFile()
          break
        case 'openUrl':
          setShowUrlModal(true)
          break
        case 'save':
          handleSave()
          break
        case 'saveAs':
          handleSaveAs()
          break
        case 'export':
          handleFocusExportPanel()
          break
      }
    })
    return unsubscribe
  }, [handleOpenFile, handleSave, handleSaveAs, handleFocusExportPanel])

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      const hasDialog = !!document.querySelector('[role="dialog"]')
      if (hasDialog) return
      if (!hasDialog && e.key === 'F9' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        toggleImmersive()
        return
      }
      if (!hasDialog && isImmersive && e.key === 'Escape') {
        e.preventDefault()
        setIsImmersive(false)
        return
      }
      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'o':
            e.preventDefault()
            if (e.shiftKey) {
              setShowUrlModal(true)
            } else {
              handleOpenFile()
            }
            break
          case 's':
            e.preventDefault()
            if (e.shiftKey) {
              handleSaveAs()
            } else {
              handleSave()
            }
            break
          case 'e':
            e.preventDefault()
            handleFocusExportPanel()
            break
          case 'z':
            e.preventDefault()
            if (e.shiftKey) {
              redo()
            } else {
              undo()
            }
            break
          case 'y':
            e.preventDefault()
            redo()
            break
        }
      }

      // 空格播放/暂停
      if (e.key === ' ' && !e.repeat && !(e.target as HTMLElement)?.closest?.('input, textarea, select, button, [contenteditable="true"], [role="dialog"]')) {
        e.preventDefault()
        const { playback, setPlaying } = useEditorStore.getState()
        setPlaying(!playback.isPlaying)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleOpenFile, handleSave, handleSaveAs, handleFocusExportPanel, undo, redo, isImmersive, toggleImmersive])

  return (
    <div className="editor-shell h-screen flex flex-col bg-bg-primary text-text-primary overflow-hidden" data-immersive={isImmersive}>
      {/* 菜单栏 */}
      <MenuBar
        onWindowError={setError}
        onOpenFile={handleOpenFile}
        onOpenUrl={() => setShowUrlModal(true)}
        onSave={handleSave}
        onSaveAs={handleSaveAs}
        onExport={handleFocusExportPanel}
        onUndo={undo}
        onRedo={redo}
        showHistory={showHistory}
        onToggleHistory={toggleHistory}
        onShowAbout={() => setShowAboutModal(true)}
        onCheckUpdates={() => setShowUpdateModal(true)}
        onShowLicense={() => setShowLicenseModal(true)}
      />

      <input
        ref={svgaFileInputRef}
        type="file"
        accept=".svga,.svgaproj,application/octet-stream,application/zip"
        className="hidden"
        onChange={handleSvgaFileInputChange}
      />

      {/* 工具栏 */}
      <div className={cn('min-h-14 gap-3 bg-bg-secondary border-b border-border flex items-center justify-between px-4', isImmersive && !loading && !error && '!hidden')}>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleOpenFile} disabled={loading} title="打开 SVGA 或可编辑工程（Ctrl+O）">
            <Icon name="folder-open" size={16} />
            打开文件
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowUrlModal(true)}>
            <Icon name="globe" size={16} />
            打开 URL
          </Button>
          <Button variant="ghost" size="sm" onClick={undo} disabled={!canUndo} aria-label={undoLabel} title={`${undoLabel} (Ctrl+Z)`}>
            <Icon name="undo" size={16} />
          </Button>
          <div className="mx-1 h-5 w-px bg-border" />
          <Button variant="ghost" size="sm" onClick={redo} disabled={!canRedo} aria-label={redoLabel} title={`${redoLabel} (Ctrl+Shift+Z / Ctrl+Y)`}>
            <Icon name="redo" size={16} />
          </Button>
          <div className="mx-1 h-5 w-px bg-border" />
          <Button variant="ghost" size="sm" onClick={toggleHistory} aria-label="历史记录面板" aria-pressed={showHistory} aria-controls="history-panel" title="显示或隐藏历史记录" className={showHistory ? 'bg-accent/10 text-accent' : undefined}>
            <Icon name="history" size={16} />
            <span className="hidden xl:inline">历史记录</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={openProjectLibrary} aria-label="恢复与最近工程" title="查看本机恢复副本与最近工程">
            <Icon name="history" size={15} /><span>恢复 / 最近</span>
          </Button>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          {loading && (
            <span className="text-sm text-text-muted flex items-center gap-2">
              <span className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              加载中...
            </span>
          )}
          {error && (
            <span role="alert" className="max-w-[220px] truncate text-sm text-error" title={error}>{error}</span>
          )}
          <Button variant="ghost" size="sm" title="重置面板宽度和高度" onClick={() => { setLeftPanelWidth(320); setRightPanelWidth(340); setLayerPanelHeight(340); setHistoryPanelHeight(280); setHistoryCollapsed(false); setShowHistory(true) }}>
            <Icon name="refresh" size={15} />
            <span className="hidden xl:inline">重置面板</span>
          </Button>
          <Button variant="secondary" size="sm" disabled={!previewVideoItem || loading} onClick={handleSave} title="保存可编辑工程（Ctrl+S），导出 SVGA 不替代工程备份"><Icon name="save" size={15} />保存工程</Button>
          <Button variant="primary" size="sm" disabled={!previewVideoItem} onClick={handleFocusExportPanel} title="打开导出设置（Ctrl+E）"><Icon name="export" size={15} />导出</Button>
        </div>
      </div>

      {projectNotice && !isImmersive && <div role="status" className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-bg-tertiary px-4 py-1.5 text-[11px] text-text-secondary">
        <span>{projectNotice}</span><button type="button" aria-label="关闭工程提示" onClick={() => setProjectNotice(null)} className="shrink-0 text-text-muted hover:text-accent">×</button>
      </div>}

      {startupRecoveryHint && projectLibrarySnapshot?.entries.some(entry => entry.kind === 'recovery') && !isImmersive && <div role="status" className="flex shrink-0 items-center gap-3 border-b border-warning/25 bg-warning/5 px-4 py-2 text-xs">
        <span className="mr-auto text-text-secondary">发现 {projectLibrarySnapshot.entries.filter(entry => entry.kind === 'recovery').length} 份本机恢复副本，可查看是否包含上次未保存的修改。</span>
        <button type="button" onClick={openProjectLibrary} className="text-accent">查看恢复副本</button>
        <button type="button" onClick={() => setStartupRecoveryHint(false)} className="text-text-muted">稍后查看</button>
      </div>}
      {localProjectNotice && !isImmersive && <div role="status" className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-tertiary px-4 py-1.5 text-[11px] text-text-secondary">
        <span className="mr-auto">{localProjectNotice}</span><button type="button" aria-label="关闭本机副本提示" onClick={() => setLocalProjectNotice(null)}>×</button>
      </div>}

      {/* 主内容区 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧面板 - 可调整宽度 */}
        <div 
          className={cn('border-r border-border flex flex-col overflow-hidden flex-shrink-0', isImmersive && '!hidden')}
          style={{ width: leftPanelWidth, maxWidth: '28vw', minWidth: 240 }}
          aria-label="图层与资源"
        >
          <div className="min-h-[180px] overflow-hidden border-b border-border" style={{ height: layerPanelHeight }}>
            <LayerPanel className="h-full rounded-none overflow-auto" />
          </div>
          <PanelSplitter 
            direction="vertical" 
            onDrag={(delta) => setLayerPanelHeight(prev => Math.max(180, Math.min(520, prev + delta)))}
          />
          <ResourcePanel 
            className="flex-1 min-h-[180px] rounded-none border-0 overflow-auto"
            onImageSelect={handleImageSelect}
          />
        </div>
        
        {/* 左侧面板宽度调整手柄 */}
        <PanelSplitter 
          direction="horizontal" 
          className={isImmersive ? '!hidden' : undefined}
          onDrag={(delta) => setLeftPanelWidth(prev => Math.max(200, Math.min(400, prev + delta)))} 
        />

        {/* 中间区域 */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <CanvasPreview
            className="flex-1 min-h-0"
            immersive={isImmersive}
            onToggleImmersive={toggleImmersive}
            onOpenFile={handleOpenFile}
            onSvgaDrop={async (file) => {
              try {
                await runWithUnsavedProtection(() => handleSvgaFile(file))
              } catch (err) {
                setError(`拖放文件失败: ${(err as Error).message}`)
              }
            }}
          />
          <PlaybackControls />
          <Timeline className={cn('flex-shrink-0', isImmersive && '!hidden')} />
        </div>

        {/* 右侧面板宽度调整手柄 */}
        <PanelSplitter 
          direction="horizontal" 
          className={isImmersive ? '!hidden' : undefined}
          onDrag={(delta) => setRightPanelWidth(prev => Math.max(220, Math.min(450, prev - delta)))} 
        />

        {/* 右侧面板 - 可调整宽度 */}
        <div 
          className={cn('border-l border-border flex flex-col overflow-hidden flex-shrink-0', isImmersive && '!hidden')}
          style={{ width: rightPanelWidth, maxWidth: '30vw', minWidth: 280 }}
          aria-label="检查器"
        >
          <div className="flex h-11 flex-shrink-0 items-center justify-between px-4 text-xs text-text-muted"><span className="font-medium tracking-wide">检查器</span><span className="rounded border border-border px-1.5 py-0.5 text-[10px]">SVGA</span></div>
          <div role="tablist" aria-label="检查器面板" className="inspector-tabs mx-3 mb-2 flex flex-shrink-0 rounded-lg bg-bg-primary p-1">
            {INSPECTOR_TABS.map((tab, index) => (
              <button key={tab.id} id={`inspector-tab-${tab.id}`} role="tab" type="button" aria-controls={`inspector-view-${tab.id}`} aria-selected={inspectorTab === tab.id} tabIndex={inspectorTab === tab.id ? 0 : -1}
                className={cn('flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-2 text-sm transition-colors', inspectorTab === tab.id ? 'bg-bg-tertiary text-text-primary shadow-sm' : 'text-text-muted hover:text-text-primary')}
                onClick={() => setInspectorTab(tab.id)}
                onKeyDown={e => {
                  const next = e.key === 'ArrowRight' ? (index + 1) % 3 : e.key === 'ArrowLeft' ? (index + 2) % 3 : e.key === 'Home' ? 0 : e.key === 'End' ? 2 : -1
                  if (next < 0) return
                  e.preventDefault(); e.stopPropagation()
                  setInspectorTab(INSPECTOR_TABS[next].id)
                  document.getElementById(`inspector-tab-${INSPECTOR_TABS[next].id}`)?.focus()
                }}>
                <Icon name={tab.icon} size={14} />{tab.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id="inspector-view-properties" aria-labelledby="inspector-tab-properties" hidden={inspectorTab !== 'properties'} className={cn('inspector-view flex-1 min-h-0', inspectorTab !== 'properties' && '!hidden')}>
            <PropertyPanel className="h-full rounded-none border-0" collapsible={false} />
          </div>
          <div role="tabpanel" id="inspector-view-slots" aria-labelledby="inspector-tab-slots" hidden={inspectorTab !== 'slots'} className={cn('inspector-view flex-1 min-h-0', inspectorTab !== 'slots' && '!hidden')}>
            <SlotPanel className="h-full rounded-none border-0" collapsible={false} />
          </div>
          <div role="tabpanel" id="inspector-view-export" aria-labelledby="inspector-tab-export" hidden={inspectorTab !== 'export'} ref={exportPanelRef} className={cn('inspector-view flex-1 min-h-0', inspectorTab !== 'export' && '!hidden')}>
            <ExportPanel className="h-full rounded-none border-0" collapsible={false} onBusyChange={setExporting} />
          </div>
          {showHistory && (
            <>
              {!historyCollapsed && <PanelSplitter direction="vertical" onDrag={delta => setHistoryPanelHeight(height => Math.max(180, Math.min(520, height - delta)))} />}
              <HistoryPanel collapsed={historyCollapsed} onToggleCollapsed={() => setHistoryCollapsed(value => !value)} onHide={() => setShowHistory(false)} disabled={loading} style={{ height: historyCollapsed ? 36 : historyPanelHeight, maxHeight: historyCollapsed ? 36 : '48%' }} />
            </>
          )}
        </div>
      </div>

      {/* 状态栏 */}
      {!isImmersive && <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-bg-secondary px-4 py-1 text-[10px]">
        <span role="status" aria-label="本机自动恢复状态" title={recoveryStatus?.message} className={cn('truncate', recoveryStatus?.phase === 'error' ? 'text-warning' : 'text-text-muted')}>
          {recoveryStatus?.message || '正在准备本机恢复…'}{recoveryStatus?.updatedAt ? `（${new Date(recoveryStatus.updatedAt).toLocaleTimeString()}）` : ''}
        </span>
        <div className="flex shrink-0 gap-3">
          <button type="button" disabled={loading || !previewVideoItem || recoveryStatus?.phase === 'saving' || recoveryStatus?.phase === 'disabled'} onClick={() => { void recoveryRef.current?.flush() }} className="text-accent disabled:opacity-40">{recoveryStatus?.phase === 'error' ? '重试本机备份' : '立即备份'}</button>
          <button type="button" onClick={openProjectLibrary} className="text-text-muted hover:text-accent">本机副本设置</button>
        </div>
      </div>}
      <StatusBar />

      {/* URL 输入模态框 */}
      <Modal
        isOpen={showUrlModal}
        onClose={() => setShowUrlModal(false)}
        title="打开 URL"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowUrlModal(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={handleOpenUrl} loading={loading}>
              打开
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-text-secondary mb-2">
              输入 SVGA 文件的 URL：
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/animation.svga"
              className="w-full px-3 py-2 rounded-lg bg-bg-tertiary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
              onKeyDown={(e) => e.key === 'Enter' && handleOpenUrl()}
            />
          </div>
          {error && (
            <p className="text-sm text-error">{error}</p>
          )}
        </div>
      </Modal>

      <Modal
        isolateKeyboard
        isOpen={showUnsavedModal}
        onClose={() => resolveUnsavedChoice('cancel')}
        title="保存当前工程？"
        footer={
          <>
            <Button variant="ghost" onClick={() => resolveUnsavedChoice('cancel')}>
              取消
            </Button>
            <Button variant="danger" onClick={() => resolveUnsavedChoice('discard')}>
              不保存
            </Button>
            <Button variant="primary" onClick={() => resolveUnsavedChoice('save')}>
              保存工程
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-secondary">
          当前工程还有未保存修改。保存 .svgaproj 可保留文字模拟、可编辑关键帧与素材；仅导出 SVGA 不会保存完整编辑状态。
        </p>
      </Modal>

      <Modal
        isOpen={showAboutModal}
        onClose={() => setShowAboutModal(false)}
        title="关于 SVGA Editor Pro"
        footer={
          <Button variant="primary" onClick={() => setShowAboutModal(false)}>
            知道了
          </Button>
        }
      >
        <div className="space-y-3 text-sm text-text-secondary">
          <p>SVGA Editor Pro v2.0.0</p>
          <p>支持 SVGA 预览、图层调整、资源替换、插槽配置与导出。</p>
          <div className="rounded border border-border bg-bg-tertiary p-3 text-xs">
            <div>打开文件：Ctrl+O</div>
            <div>打开 URL：Ctrl+Shift+O</div>
            <div>保存工程：Ctrl+S（保留可编辑状态）</div>
            <div>导出：Ctrl+E</div>
          </div>
          <div className="rounded border border-accent/30 bg-accent/5 p-3 text-xs">
            <div className="mb-1 font-medium text-text-primary">AI / MCP</div>
            {mcpStatus ? <>
              <div className={mcpStatus.enabled ? 'text-success' : 'text-warning'}>{mcpStatus.enabled ? '本机 MCP 已启动' : '本机 MCP 未启动（端口可能被占用）'}</div>
              <div className="mt-1 break-all select-all text-text-muted">地址：{mcpStatus.endpoint}</div>
              <div className="mt-1 break-all select-all text-text-muted">令牌：{mcpStatus.token}</div>
              <div className={cn('mt-1', mcpStatus.image_generation_configured ? 'text-success' : 'text-warning')}>
                生图 API：{mcpStatus.image_generation_configured ? '已读取 OPENAI_API_KEY' : '未配置 OPENAI_API_KEY'}
              </div>
              <div className="mt-2 text-text-muted">扩展目录：integrations/gpt-web-extension</div>
            </> : <div className="text-text-muted">桌面端启动后可查看 MCP 地址和令牌。</div>}
          </div>
        </div>
      </Modal>

      <LocalProjectLibraryDialog
        isOpen={showProjectLibrary && !showUnsavedModal}
        onClose={() => setShowProjectLibrary(false)}
        snapshot={projectLibrarySnapshot}
        loading={projectLibraryLoading}
        error={projectLibraryError}
        onRefresh={async () => { setProjectLibraryError(null); await refreshProjectLibrary(); await recoveryRef.current?.refreshSettings() }}
        onConfigure={configureLocalProjects}
        onClear={clearLocalProjects}
        onRemove={removeLocalProject}
        onOpen={openLocalProject}
        onDownload={downloadLocalProject}
      />
      <UpdateDialog
        isOpen={showUpdateModal}
        onClose={() => setShowUpdateModal(false)}
        dirty={updateDirty}
        busy={loading || documentBusyRef.current || !!projectLibraryLoading}
        exporting={exporting}
        currentInputs={captureExportInputs(useEditorStore.getState())}
        getGuards={() => ({
          dirty: useEditorStore.getState().isDirty,
          busy: loading || documentBusyRef.current || !!projectLibraryLoading,
          exporting,
          currentInputs: captureExportInputs(useEditorStore.getState()),
        })}
        beforeInstall={() => {
          useEditorStore.getState().endCanvasTransform(true)
          useEditorStore.getState().setPlaying(false)
        }}
        onSave={async () => Boolean(await handleSaveRef.current?.())}
      />
      <LicenseDialog isOpen={showLicenseModal} onClose={() => setShowLicenseModal(false)} />
    </div>
  )
}
