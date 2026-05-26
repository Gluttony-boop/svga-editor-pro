import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon, Button, Modal, PanelSplitter } from '@/components/ui'
import { CanvasPreview, PlaybackControls, Timeline } from '@/components/editor'
import { LayerPanel, ResourcePanel, SlotPanel, PropertyPanel, ExportPanel } from '@/components/panels'
import type { ImageSelectInfo } from '@/components/panels'
import { useEditorStore } from '@/stores'
import { svgaParser, LayerFactory, ExportEngine, saveGeneratedFile, svgaBuilder } from '@/core'
import { tauriAPI, createNativeAPI } from '@/lib/tauri-api'
import type { SvgaData } from '@/lib/tauri-api'
import { cn } from '@/utils/cn'
import type { ImageResource, Layer, VideoItem } from '@/types'

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function getCurrentParamsSnapshot() {
  const { params, customFps, customFrames } = useEditorStore.getState()
  if (!params) return null

  return {
    ...params,
    fps: customFps ?? params.fps,
    frames: customFrames ?? params.frames
  }
}

// 初始化 Tauri 兼容层
if (isTauriRuntime() && !window.nativeAPI) {
  ;(window as any).nativeAPI = createNativeAPI()
}

/**
 * 将 Tauri Rust 后端解析的 SvgaData 转换为前端 VideoItem
 */
function convertTauriSvgaToVideoItem(data: SvgaData): any | null {
  try {
    const { version, params, sprites, images, imageMimeTypes } = data

    // 构建图片 map (key -> HTMLImageElement)
    const imageMap: Record<string, HTMLImageElement> = {}
    const bufferMap: Record<string, ArrayBuffer> = {}

    for (const img of images) {
      const mimeInfo = imageMimeTypes.find(m => m.key === img.key)
      const mimeType = mimeInfo?.mimeType || 'image/png'
      const dataUrl = `data:${mimeType};base64,${img.data}`

      // 同步创建 Image 对象（注意：图片可能尚未 loaded）
      const image = new Image()
      image.src = dataUrl
      imageMap[img.key] = image

      // base64 -> ArrayBuffer
      const binary = atob(img.data)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }
      bufferMap[img.key] = bytes.buffer
    }

    // 等待图片加载的辅助函数
    const waitForImages = async () => {
      const promises = Object.entries(imageMap).map(([key, img]) => {
        if (img.complete && img.width > 0) return Promise.resolve()
        return new Promise<void>((resolve) => {
          img.onload = () => resolve()
          img.onerror = () => {
            console.warn(`[convertTauriSvgaToVideoItem] Image load failed: ${key}`)
            resolve()
          }
        })
      })
      await Promise.all(promises)
    }

    // 构造 VideoItem
    const videoItem = {
      version,
      movie: {
        params: {
          viewBoxWidth: params.viewBoxWidth,
          viewBoxHeight: params.viewBoxHeight,
          fps: params.fps,
          frames: params.frames,
        },
        sprites: sprites.map(sprite => ({
          imageKey: sprite.imageKey,
          matteKey: sprite.matteKey || '',
          frames: sprite.frames.map(frame => ({
            alpha: frame.alpha,
            layout: frame.layout,
            transform: frame.transform,
            clipPath: frame.clipPath || '',
            shapes: frame.shapes || [],
          })),
        })),
      },
      images: imageMap,
      buffers: bufferMap,
      // 标记：需要等待图片加载
      _waitForImages: waitForImages,
    }

    return videoItem
  } catch (err) {
    console.error('[convertTauriSvgaToVideoItem] Error:', err)
    return null
  }
}

function base64ToArrayBuffer(data: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function isSvgaFileName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.svga')
}

function getDefaultSvgaName(source: string | null): string {
  if (!source) return 'export.svga'
  const normalized = source.replace(/\\/g, '/')
  const fileName = normalized.split('/').pop() || 'export.svga'
  return isSvgaFileName(fileName) ? fileName : `${fileName}.svga`
}

function hasExportableLayerEdits(
  videoItem: VideoItem,
  layers: Layer[],
  imageResources: Map<string, ImageResource>
): boolean {
  const originalLayerCount = videoItem.movie.sprites?.length ?? 0
  const activeOriginalLayerCount = layers.filter((layer) => !layer.isNew && layer.editableIndex !== undefined).length
  const hasDeletedOriginalLayers = activeOriginalLayerCount < originalLayerCount
  const hasNewLayers = layers.some((layer) => layer.isNew)
  const hasNewImages = Array.from(imageResources.values()).some((resource) => resource.isNew)
  const hasAnimations = layers.some((layer) =>
    Object.values(layer.tracks).some((track) => track.keyframes.length > 0)
  )
  const hasLayerNameChanges = layers.some((layer) => {
    const nextName = layer.name.trim()
    return layer.imageKey && nextName.length > 0 && nextName !== layer.imageKey
  })

  return hasDeletedOriginalLayers || hasNewLayers || hasNewImages || hasAnimations || hasLayerNameChanges
}

// Windows 窗口控制组件 - 使用 Tauri API
const WindowControls: React.FC = () => {
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
        onClick={() => tauriAPI.window.close()}
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
  onOpenFile: () => void
  onOpenUrl: () => void
  onSave: () => void
  onSaveAs: () => void
  onExport: () => void
  onUndo: () => void
  onRedo: () => void
  onShowAbout: () => void
}

// 菜单栏组件
const MenuBar: React.FC<MenuBarProps> = ({
  onOpenFile,
  onOpenUrl,
  onSave,
  onSaveAs,
  onExport,
  onUndo,
  onRedo,
  onShowAbout
}) => {
  const videoItem = useEditorStore((s) => s.videoItem)
  const isDirty = useEditorStore((s) => s.isDirty)
  const canUndo = useEditorStore((s) => s.canUndo)
  const canRedo = useEditorStore((s) => s.canRedo)
  const showGrid = useEditorStore((s) => s.showGrid)
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
      { label: '打开文件', shortcut: 'Ctrl+O', onSelect: onOpenFile },
      { label: '打开 URL', shortcut: 'Ctrl+Shift+O', onSelect: onOpenUrl },
      { label: '保存', shortcut: 'Ctrl+S', disabled: !videoItem, onSelect: onSave },
      { label: '另存为...', shortcut: 'Ctrl+Shift+S', disabled: !videoItem, onSelect: onSaveAs },
      { label: '导出', shortcut: 'Ctrl+E', disabled: !videoItem, onSelect: onExport }
    ],
    edit: [
      { label: '撤销', shortcut: 'Ctrl+Z', disabled: !canUndo, onSelect: onUndo },
      { label: '重做', shortcut: 'Ctrl+Shift+Z / Ctrl+Y', disabled: !canRedo, onSelect: onRedo },
      { label: videoItem ? '请选择图层后使用图层面板编辑' : '打开文件后可编辑图层', disabled: true }
    ],
    view: [
      { label: `${showGrid ? '隐藏' : '显示'}网格`, onSelect: toggleGrid },
      {
        label: `渲染器：${rendererMode === 'pixi' ? 'WebGL 极速' : rendererMode === 'official' ? '官方兼容' : 'Canvas 高性能'}`,
        onSelect: () => {
          const nextMode = rendererMode === 'pixi'
            ? 'official'
            : rendererMode === 'official'
              ? 'high-performance'
              : 'pixi'
          setRendererMode(nextMode)
        }
      }
    ],
    help: [
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
      <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2">
        <Icon name="play" size={16} className="text-accent" />
        <span className="text-sm text-text-primary">SVGA Editor Pro</span>
        {videoItem && <span className="text-xs text-text-muted">- 编辑中</span>}
        {isDirty && <span className="text-xs text-warning">●</span>}
      </div>

      {/* 右侧窗口控制 */}
      <WindowControls />
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
  const fps = useEditorStore((s) => s.playback.fps)
  const totalFrames = useEditorStore((s) => s.playback.totalFrames)
  const [currentFrame, setCurrentFrame] = useState(0)
  const [memory, setMemory] = useState('0 MB')

  // 监听动画播放时的帧更新事件
  useEffect(() => {
    const handleFrameUpdate = (e: CustomEvent<{ frameIndex: number }>) => {
      setCurrentFrame(e.detail.frameIndex)
    }
    
    window.addEventListener('svga-frame-update', handleFrameUpdate as EventListener)
    
    return () => {
      window.removeEventListener('svga-frame-update', handleFrameUpdate as EventListener)
    }
  }, [])

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
        <span>{videoItem ? (isDirty ? '未保存' : '已保存') : '等待文件'}</span>
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
  const [showUnsavedModal, setShowUnsavedModal] = useState(false)
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [launchFileChecked, setLaunchFileChecked] = useState(false)
  const devAutoLoadRef = useRef(false)
  const launchFileAutoLoadRef = useRef(false)
  const unsavedResolverRef = useRef<((choice: UnsavedChoice) => void) | null>(null)
  const allowNextCloseRef = useRef(false)
  const handleSaveRef = useRef<(() => Promise<boolean>) | null>(null)
  const svgaFileInputRef = useRef<HTMLInputElement>(null)
  
  // 面板宽度状态
  const [leftPanelWidth, setLeftPanelWidth] = useState(260)
  const [rightPanelWidth, setRightPanelWidth] = useState(300)
  const [layerPanelHeight, setLayerPanelHeight] = useState(300)

  const setVideoItem = useEditorStore((s) => s.setVideoItem)
  const setSource = useEditorStore((s) => s.setSource)
  const setOriginalBuffer = useEditorStore((s) => s.setOriginalBuffer)
  const setDetectedSlots = useEditorStore((s) => s.setDetectedSlots)
  const setAudioResources = useEditorStore((s) => s.setAudioResources)
  const reset = useEditorStore((s) => s.reset)
  const undo = useEditorStore((s) => s.undo)
  const redo = useEditorStore((s) => s.redo)
  const canUndo = useEditorStore((s) => s.canUndo)
  const canRedo = useEditorStore((s) => s.canRedo)
  const videoItem = useEditorStore((s) => s.videoItem)
  
  // 图层操作
  const addLayer = useEditorStore((s) => s.addLayer)
  const selectLayer = useEditorStore((s) => s.selectLayer)
  const params = useEditorStore((s) => s.params)
  const addImageResource = useEditorStore((s) => s.addImageResource)

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
    if (!useEditorStore.getState().isDirty) return 'discard'

    return new Promise((resolve) => {
      unsavedResolverRef.current = resolve
      setShowUnsavedModal(true)
    })
  }, [])

  const runWithUnsavedProtection = useCallback(async (operation: () => Promise<void> | void) => {
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
    setLoading(true)
    setError(null)

    try {
      await svgaParser.init()
      const videoItem = await svgaParser.parse(buffer)
      const slots = svgaParser.detectSlots(videoItem.movie)

      setVideoItem(videoItem)
      setSource(source, type)
      setOriginalBuffer(buffer)
      setDetectedSlots(slots)

      // 解析音频轨道（如果有）
      try {
        const audioResources = await svgaParser.parseAudios(videoItem.movie)
        if (audioResources.length > 0) {
          const audioMap = new Map<string, typeof audioResources[0]>()
          audioResources.forEach(r => audioMap.set(r.key, r))
          setAudioResources(audioMap)
        }
      } catch (audioErr) {
        console.warn('[App] 音频解析失败，不影响主流程:', audioErr)
      }
    } catch (err) {
      console.error('[App] Load error:', err)
      setError(`加载失败: ${(err as Error).message}`)
      reset()
    } finally {
      setLoading(false)
    }
  }, [setVideoItem, setSource, setOriginalBuffer, setDetectedSlots, setAudioResources, reset])

  const loadSVGAFromFilePath = useCallback(async (filePath: string) => {
    if (!isSvgaFileName(filePath)) return

    setLoading(true)
    setError(null)

    let originalBuffer: ArrayBuffer | null = null
    let fileReadError: string | undefined

    try {
      const fileResult = await tauriAPI.file.read(filePath)
      if (fileResult.success && fileResult.data) {
        originalBuffer = base64ToArrayBuffer(fileResult.data)
      } else {
        fileReadError = fileResult.error
      }

      try {
        const svgaData = await tauriAPI.svga.parseFromFile(filePath)
        const videoItem = convertTauriSvgaToVideoItem(svgaData)
        if (videoItem) {
          const slots = svgaParser.detectSlots(videoItem.movie)
          setVideoItem(videoItem)
          setSource(filePath, 'file')
          setOriginalBuffer(originalBuffer)
          setDetectedSlots(slots)
          return
        }
      } catch (rustErr) {
        console.warn('[App] Rust SVGA parse failed, falling back to frontend parser:', rustErr)
      }

      if (!originalBuffer) {
        throw new Error(fileReadError || 'Unable to read SVGA file')
      }

      await loadSVGA(originalBuffer, filePath, 'file')
    } catch (err) {
      console.error('[App] File path load error:', err)
      setError(`打开文件失败: ${(err as Error).message}`)
      reset()
    } finally {
      setLoading(false)
    }
  }, [loadSVGA, setVideoItem, setSource, setOriginalBuffer, setDetectedSlots, reset])

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
    if (!isSvgaFileName(file.name)) {
      setError('请选择 .svga 文件')
      return
    }

    const buffer = await file.arrayBuffer()
    await loadSVGA(buffer, file.name, 'file')
  }, [loadSVGA])

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
    if (!isTauriRuntime()) {
      const choice = await confirmDiscardUnsavedChanges()
      if (choice === 'cancel') return
      if (choice === 'save') {
        const saved = await handleSaveRef.current?.()
        if (!saved) return
      }
      svgaFileInputRef.current?.click()
      return
    }

    try {
      const filePath = await tauriAPI.dialog.openFile({
        filters: [
          { name: 'SVGA Files', extensions: ['svga'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      if (!filePath) return
      await runWithUnsavedProtection(() => loadSVGAFromFilePath(filePath))
    } catch (err) {
      setError(`打开文件失败: ${(err as Error).message}`)
    }
  }, [confirmDiscardUnsavedChanges, loadSVGAFromFilePath, runWithUnsavedProtection])

  // 打开 URL
  const handleOpenUrl = async () => {
    if (!url) return

    try {
      await runWithUnsavedProtection(async () => {
        const response = await fetch(url)
        const buffer = await response.arrayBuffer()
        await loadSVGA(buffer, url, 'url')
        setShowUrlModal(false)
        setUrl('')
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

          const filePath = event.payload.paths.find(isSvgaFileName)
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

    ;(async () => {
      try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
        unlisten = await getCurrentWebviewWindow().onCloseRequested(async (event) => {
          if (allowNextCloseRef.current) {
            allowNextCloseRef.current = false
            return
          }

          if (!useEditorStore.getState().isDirty) return

          event.preventDefault()
          const choice = await confirmDiscardUnsavedChanges()
          if (choice === 'cancel') return
          if (choice === 'save') {
            const saved = await handleSaveRef.current?.()
            if (!saved) return
          }
          allowNextCloseRef.current = true
          try {
            await tauriAPI.window.close()
          } catch (err) {
            allowNextCloseRef.current = false
            throw err
          }
        })

        if (disposed) {
          unlisten()
          unlisten = null
        }
      } catch (err) {
        console.warn('[App] Tauri close listener unavailable:', err)
      }
    })()

    return () => {
      disposed = true
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

  // 保存文件（覆盖原文件或另存为）
  const buildCurrentSvgaBlob = useCallback(async (): Promise<Blob> => {
    const { videoItem, originalBuffer, compressionConfig, slotConfigs, layers, imageResources } = useEditorStore.getState()
    const params = getCurrentParamsSnapshot()
    if (!videoItem || !params || !originalBuffer) {
      throw new Error('没有可保存的 SVGA 数据')
    }

    const canvas = document.createElement('canvas')
    canvas.width = params.viewBoxWidth
    canvas.height = params.viewBoxHeight
    const engine = new ExportEngine(canvas)
    engine.setVideoItem(videoItem)

    const hasEditableContent = hasExportableLayerEdits(videoItem, layers, imageResources)
    if (hasEditableContent) {
      const imageSizes = new Map<string, { width: number; height: number }>()
      imageResources.forEach((resource, key) => {
        if (resource.width > 0 && resource.height > 0) {
          imageSizes.set(key, { width: resource.width, height: resource.height })
        }
      })

      const originalImages: Record<string, Uint8Array> = {}
      if (videoItem.buffers) {
        Object.entries(videoItem.buffers).forEach(([key, buffer]) => {
          originalImages[key] = new Uint8Array(buffer)
        })
      }

      return svgaBuilder.mergeWithOriginal(originalBuffer, {
        params,
        layers,
        imageResources,
        originalImages,
        slotConfigs,
        imageSizes
      })
    }

    return engine.exportSVGALite(originalBuffer, {
      fps: params.fps,
      frames: params.frames,
      compression: compressionConfig,
      slotConfigs,
      layers
    })
  }, [])

  const handleSaveAs = useCallback(async () => {
    const { videoItem, currentSource } = useEditorStore.getState()
    if (!videoItem) return false

    setLoading(true)
    setError(null)
    try {
      const blob = await buildCurrentSvgaBlob()
      if (isTauriRuntime()) {
        const filePath = await tauriAPI.dialog.saveFile({
          defaultPath: getDefaultSvgaName(currentSource),
          filters: [
            { name: 'SVGA Files', extensions: ['svga'] },
            { name: 'All Files', extensions: ['*'] }
          ]
        })
        if (!filePath) return false
        const result = await tauriAPI.file.write(filePath, await blobToBase64(blob))
        if (result && !result.success) {
          throw new Error(result.error || '写入失败')
        }
        useEditorStore.setState({
          currentSource: filePath,
          sourceType: 'file',
          isDirty: false
        })
      } else {
        const saved = await saveGeneratedFile(blob, getDefaultSvgaName(currentSource))
        if (!saved) return false
        useEditorStore.setState({ isDirty: false })
      }
      return true
    } catch (err) {
      setError(`保存失败: ${(err as Error).message}`)
      return false
    } finally {
      setLoading(false)
    }
  }, [buildCurrentSvgaBlob])

  // 保存文件（本地文件覆盖保存；URL/浏览器来源转为另存为）
  const handleSave = useCallback(async () => {
    const { videoItem, currentSource, sourceType } = useEditorStore.getState()
    if (!videoItem) return false
    const shouldOverwriteSource = isTauriRuntime() && sourceType === 'file' && currentSource

    if (!shouldOverwriteSource) {
      return handleSaveAs()
    }

    setLoading(true)
    setError(null)
    try {
      const blob = await buildCurrentSvgaBlob()
      const result = await tauriAPI.file.write(currentSource, await blobToBase64(blob))
      if (result && !result.success) {
        throw new Error(result.error || '写入失败')
      }
      useEditorStore.setState({ isDirty: false })
      return true
    } catch (err) {
      setError(`保存失败: ${(err as Error).message}`)
      return false
    } finally {
      setLoading(false)
    }
  }, [buildCurrentSvgaBlob, handleSaveAs])

  // 导出文件（始终弹出保存对话框）
  const handleExport = useCallback(async () => {
    const { videoItem } = useEditorStore.getState()
    if (!videoItem) return

    setLoading(true)
    setError(null)
    try {
      const blob = await buildCurrentSvgaBlob()
      const saved = await saveGeneratedFile(blob, 'export.svga')
      if (!saved) return
    } catch (err) {
      setError(`导出失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [buildCurrentSvgaBlob])

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
          handleExport()
          break
      }
    })
    return unsubscribe
  }, [handleOpenFile, handleSave, handleSaveAs, handleExport])

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
            handleExport()
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
      if (e.key === ' ' && !(e.target as HTMLElement)?.matches?.('input, textarea')) {
        e.preventDefault()
        const { playback, setPlaying } = useEditorStore.getState()
        setPlaying(!playback.isPlaying)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleOpenFile, handleSave, handleSaveAs, handleExport, undo, redo])

  return (
    <div className="h-screen flex flex-col bg-bg-primary text-text-primary overflow-hidden">
      {/* 菜单栏 */}
      <MenuBar
        onOpenFile={handleOpenFile}
        onOpenUrl={() => setShowUrlModal(true)}
        onSave={handleSave}
        onSaveAs={handleSaveAs}
        onExport={handleExport}
        onUndo={undo}
        onRedo={redo}
        onShowAbout={() => setShowAboutModal(true)}
      />

      <input
        ref={svgaFileInputRef}
        type="file"
        accept=".svga,application/octet-stream"
        className="hidden"
        onChange={handleSvgaFileInputChange}
      />

      {/* 工具栏 */}
      <div className="h-12 bg-bg-secondary border-b border-border flex items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleOpenFile}>
            <Icon name="folder-open" size={16} />
            打开文件
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowUrlModal(true)}>
            <Icon name="globe" size={16} />
            打开 URL
          </Button>
          <Button variant="ghost" size="sm" onClick={handleSave} disabled={!videoItem}>
            <Icon name="save" size={16} />
            保存
          </Button>
          <Button variant="ghost" size="sm" onClick={undo} disabled={!canUndo} aria-label="撤销">
            <Icon name="undo" size={16} />
          </Button>
          <Button variant="ghost" size="sm" onClick={redo} disabled={!canRedo} aria-label="重做">
            <Icon name="redo" size={16} />
          </Button>
          <Button variant="ghost" size="sm" onClick={handleExport} disabled={!videoItem}>
            <Icon name="export" size={16} />
            导出
          </Button>
        </div>

        <div className="flex items-center gap-2">
          {loading && (
            <span className="text-sm text-text-muted flex items-center gap-2">
              <span className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              加载中...
            </span>
          )}
          {error && (
            <span className="text-sm text-error">{error}</span>
          )}
        </div>
      </div>

      {/* 主内容区 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧面板 - 可调整宽度 */}
        <div 
          className="border-r border-border flex flex-col overflow-hidden flex-shrink-0"
          style={{ width: leftPanelWidth }}
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
          onDrag={(delta) => setLeftPanelWidth(prev => Math.max(200, Math.min(400, prev + delta)))} 
        />

        {/* 中间区域 */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <CanvasPreview
            className="flex-1 min-h-0"
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
          <Timeline className="h-40 flex-shrink-0" />
        </div>

        {/* 右侧面板宽度调整手柄 */}
        <PanelSplitter 
          direction="horizontal" 
          onDrag={(delta) => setRightPanelWidth(prev => Math.max(220, Math.min(450, prev - delta)))} 
        />

        {/* 右侧面板 - 可调整宽度 */}
        <div 
          className="border-l border-border flex flex-col overflow-hidden flex-shrink-0"
          style={{ width: rightPanelWidth }}
        >
          <PropertyPanel 
            className="border-b border-border rounded-none min-h-0" 
            collapsible 
            defaultCollapsed={false}
          />
          <SlotPanel 
            className="border-b border-border rounded-none min-h-0" 
            collapsible 
            defaultCollapsed={true}
          />
          <ExportPanel className="flex-1 rounded-none border-0 min-h-[120px]" />
        </div>
      </div>

      {/* 状态栏 */}
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
        isOpen={showUnsavedModal}
        onClose={() => resolveUnsavedChoice('cancel')}
        title="保存当前修改？"
        footer={
          <>
            <Button variant="ghost" onClick={() => resolveUnsavedChoice('cancel')}>
              取消
            </Button>
            <Button variant="danger" onClick={() => resolveUnsavedChoice('discard')}>
              不保存
            </Button>
            <Button variant="primary" onClick={() => resolveUnsavedChoice('save')}>
              保存
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-secondary">
          当前 SVGA 还有未保存修改，继续操作会丢失这些修改。
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
            <div>保存：Ctrl+S</div>
            <div>导出：Ctrl+E</div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
