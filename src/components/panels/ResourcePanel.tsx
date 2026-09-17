import React from 'react'
import { Panel, Icon, Button, Modal } from '@/components/ui'
import { useEditorStore } from '@/stores'
import { resourceManager, createSaveFileTarget, saveGeneratedFile } from '@/core'
import { createResourceArchive, getResourceExtension, getResourceFileName, loadResourceImage } from '@/core/resource-archive'
import { selectResources, summarizeResources, formatResourceBytes, type ResourceSort } from '@/utils/resource-catalog'
import type { ImageResource } from '@/types'
import { cn } from '@/utils/cn'
import { fitImageToDataUrl, validateReplacementSize, type ImageFitMode } from '@/core/image-fit'
import { captureReplacementTarget, isReplacementTargetCurrent } from '@/core/replacement-target'
import { describeResourceScope, buildResourceUsageIndex } from '@/utils/resource-usage'
import { auditResources, RESOURCE_FILTERS, type ResourceFilter } from '@/utils/resource-audit'
import { requestLayerReveal } from '@/utils/layer-navigation'
import { ResourceInspector } from '@/components/editor/ResourceInspector'
import { ResourceAuditDialog } from '@/components/editor/ResourceAuditDialog'
import type { OperationStatusValue } from '@/components/ui/OperationStatus'
import { detectImageMime } from '@/utils/image-mime'

interface ReplacementDraft {
  key: string
  url: string
  width: number
  height: number
  mode: ImageFitMode
  target: ReturnType<typeof captureReplacementTarget>
}

/**
 * 图片选择信息
 * 支持新增图片和原始 SVGA 图片
 */
export interface ImageSelectInfo {
  /** 图片 key */
  key: string
  /** 是否为新增图片 */
  isNew: boolean
  /** 图片资源（新增图片有） */
  resource?: ImageResource
  /** 图片 buffer（原始图片有） */
  buffer?: ArrayBuffer
  /** blob URL */
  url?: string
  /** MIME 类型 */
  mimeType: string
}

interface ResourcePanelProps {
  className?: string
  /** 图片选择回调，支持新增和原始图片 */
  onImageSelect?: (info: ImageSelectInfo) => void
}

const RESOURCE_COLUMNS = 2
const RESOURCE_CARD_HEIGHT = 190
const RESOURCE_OVERSCAN_ROWS = 2

/**
 * 图片资源面板
 * 支持从文件、URL、拖拽添加图片资源
 */
export const ResourcePanel: React.FC<ResourcePanelProps> = ({ 
  className,
  onImageSelect 
}) => {
  const videoItem = useEditorStore((s) => s.videoItem)
  const layers = useEditorStore((s) => s.layers)
  const imageResources = useEditorStore((s) => s.imageResources)
  const addImageResource = useEditorStore((s) => s.addImageResource)
  const removeImageResource = useEditorStore((s) => s.removeImageResource)
  const slotConfigs = useEditorStore((s) => s.slotConfigs)
  const setSlotConfig = useEditorStore((s) => s.setSlotConfig)
  const removeSlotConfig = useEditorStore((s) => s.removeSlotConfig)
  const renameImageResourceKey = useEditorStore((s) => s.renameImageResourceKey)

  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [dragOver, setDragOver] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const objectUrlCacheRef = React.useRef<Map<string, { url: string; buffer: ArrayBuffer; mimeType: string }>>(new Map())
  const resourceGridRef = React.useRef<HTMLDivElement>(null)
  const [resourceScrollTop, setResourceScrollTop] = React.useState(0)
  const [resourceViewportHeight, setResourceViewportHeight] = React.useState(0)
  const [renamingKey, setRenamingKey] = React.useState<string | null>(null)
  const [inspectedKey, setInspectedKey] = React.useState<string | null>(null)
  const [showAudit, setShowAudit] = React.useState(false)
  const [resourceFilter, setResourceFilter] = React.useState<ResourceFilter>('all')
  const [renameValue, setRenameValue] = React.useState('')
  const renameInputRef = React.useRef<HTMLInputElement>(null)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [sortOrder, setSortOrder] = React.useState<ResourceSort>('original')
  const [isExtracting, setIsExtracting] = React.useState(false)
  const extractingRef = React.useRef(false)
  const [extractionStatus, setExtractionStatus] = React.useState<string | null>(null)
  const [pendingReplacement, setPendingReplacement] = React.useState<ReplacementDraft | null>(null)
  const [replacementPreview, setReplacementPreview] = React.useState<{ draft: ReplacementDraft; dataUrl: string } | null>(null)
  const [replacementError, setReplacementError] = React.useState<string | null>(null)
  const mountedRef = React.useRef(true)
  const selectionIdRef = React.useRef(0)
  const replacementIsCurrent = !!pendingReplacement && isReplacementTargetCurrent(pendingReplacement.target, useEditorStore.getState())
  const replacementIsReady = !!pendingReplacement && replacementPreview?.draft === pendingReplacement

  React.useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  React.useEffect(() => {
    setPendingReplacement(null)
    setInspectedKey(null)
    setShowAudit(false)
    selectionIdRef.current++
  }, [videoItem])

  React.useEffect(() => {
    const url = pendingReplacement?.url
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [pendingReplacement?.url])

  React.useEffect(() => {
    setReplacementPreview(null)
    setReplacementError(null)
    if (!pendingReplacement) return
    const controller = new AbortController()
    const draft = pendingReplacement
    void fitImageToDataUrl(draft.url, draft.width, draft.height, draft.mode, controller.signal)
      .then(dataUrl => { if (!controller.signal.aborted) setReplacementPreview({ draft, dataUrl }) })
      .catch(err => { if (!controller.signal.aborted) setReplacementError((err as Error).message) })
    return () => controller.abort()
  }, [pendingReplacement])

  React.useEffect(() => {
    if (renamingKey && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingKey])

  React.useEffect(() => {
    const cache = objectUrlCacheRef.current
    return () => {
      cache.forEach(({ url }) => URL.revokeObjectURL(url))
      cache.clear()
    }
  }, [])

  const revokeCachedBufferUrl = React.useCallback((key: string) => {
    const cachedUrl = objectUrlCacheRef.current.get(key)
    if (cachedUrl) {
      URL.revokeObjectURL(cachedUrl.url)
      objectUrlCacheRef.current.delete(key)
    }
  }, [])

  const getCachedBufferUrl = React.useCallback((key: string, buffer: ArrayBuffer, mimeType: string) => {
    const cached = objectUrlCacheRef.current.get(key)
    if (cached?.buffer === buffer && cached.mimeType === mimeType) return cached.url
    if (cached) URL.revokeObjectURL(cached.url)

    const url = URL.createObjectURL(new Blob([buffer], { type: mimeType }))
    objectUrlCacheRef.current.set(key, { url, buffer, mimeType })
    return url
  }, [])

  // 合并 SVGA 原始图片和新增图片资源
  const allResources = React.useMemo(() => {
    const audioKeys = new Set(videoItem?.movie.audios?.map((audio) =>
      audio.key || ('audioKey' in audio && typeof audio.audioKey === 'string' ? audio.audioKey : '')
    ).filter(Boolean))
    const seenKeys = new Set<string>()
    const resources: Array<{
      key: string
      resource?: ImageResource
      url?: string
      mimeType: string
      isNew?: boolean
      width?: number
      height?: number
      buffer?: ArrayBuffer
    }> = []

    // 添加 SVGA 原始图片
    if (videoItem?.buffers) {
      Object.entries(videoItem.buffers).forEach(([key, buffer]) => {
        if (audioKeys.has(key)) return
        seenKeys.add(key)
        const existingResource = imageResources.get(key)
        const sourceBuffer = existingResource?.data.byteLength ? new Uint8Array(existingResource.data).buffer : buffer
        const mimeType = detectImageMime(new Uint8Array(sourceBuffer), existingResource?.data.byteLength ? existingResource.mimeType : undefined)
        resources.push({
          key,
          resource: existingResource,
          url: existingResource?.blobUrl,
          mimeType,
          width: existingResource?.width || videoItem.images?.[key]?.naturalWidth,
          height: existingResource?.height || videoItem.images?.[key]?.naturalHeight,
          buffer: sourceBuffer
        })
      })
    }

    // 添加新增的图片资源
    imageResources.forEach((resource, key) => {
      // 检查是否已存在（避免重复）
      if (!seenKeys.has(key) && !audioKeys.has(key)) {
        seenKeys.add(key)
        resources.push({
          key,
          resource,
          url: resource.blobUrl,
          mimeType: detectImageMime(resource.data, resource.mimeType),
          isNew: resource.isNew,
          width: resource.width,
          height: resource.height
        })
      }
    })

    return resources.map((item) => ({
      ...item,
      byteSize: item.resource?.data.byteLength || item.buffer?.byteLength || 0
    }))
  }, [videoItem, imageResources])

  const usageIndex = React.useMemo(() => buildResourceUsageIndex(layers, videoItem), [layers, videoItem])
  const audit = React.useMemo(() => auditResources(allResources, usageIndex, slotConfigs), [allResources, usageIndex, slotConfigs])
  const filteredResources = React.useMemo(
    () => selectResources(audit.rows.filter(row => row.tags.includes(resourceFilter)), searchQuery, sortOrder),
    [audit, resourceFilter, searchQuery, sortOrder]
  )
  const resourceStats = React.useMemo(() => summarizeResources(filteredResources), [filteredResources])
  const inspectedResource = audit.rows.find(resource => resource.key === inspectedKey)
  const inspectedSlot = inspectedKey && Object.prototype.hasOwnProperty.call(slotConfigs, inspectedKey) ? slotConfigs[inspectedKey] : undefined
  const inspectedReplacementUrl = inspectedSlot?.type === 'image'
    ? inspectedSlot.imageConfig?.url || String(inspectedSlot.value)
    : undefined
  const inspectedSourceUrl = inspectedResource?.url || (inspectedResource?.buffer ? getCachedBufferUrl(inspectedResource.key, inspectedResource.buffer, inspectedResource.mimeType) : undefined)
  const locateLayer = (id: string) => {
    setInspectedKey(null)
    setShowAudit(false)
    requestLayerReveal(id)
  }

  React.useEffect(() => {
    setSearchQuery('')
    setSortOrder('original')
    setResourceFilter('all')
    setExtractionStatus(null)
  }, [videoItem])

  React.useLayoutEffect(() => {
    if (resourceGridRef.current) resourceGridRef.current.scrollTop = 0
    setResourceScrollTop(0)
  }, [searchQuery, sortOrder, resourceFilter, videoItem])

  React.useEffect(() => {
    const grid = resourceGridRef.current
    if (!grid) return
    const updateHeight = () => {
      setResourceViewportHeight(grid.clientHeight)
      setResourceScrollTop(grid.scrollTop)
    }
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [allResources.length])

  React.useLayoutEffect(() => {
    const grid = resourceGridRef.current
    if (grid) setResourceScrollTop(grid.scrollTop)
  }, [filteredResources.length])

  // 文件切换后的清理只回收不再使用的字节，不能撤销新一轮渲染刚创建的 URL。
  React.useEffect(() => {
    const sources = new Map(allResources.map(resource => [resource.key, resource]))
    objectUrlCacheRef.current.forEach((cached, key) => {
      const resource = sources.get(key)
      if (!resource || resource.buffer !== cached.buffer || resource.mimeType !== cached.mimeType) revokeCachedBufferUrl(key)
    })
  }, [allResources, revokeCachedBufferUrl])

  const totalResourceItems = filteredResources.length
  const resourceRowCount = Math.ceil(totalResourceItems / RESOURCE_COLUMNS)
  const visibleResourceRowStart = Math.max(
    0,
    Math.floor(resourceScrollTop / RESOURCE_CARD_HEIGHT) - RESOURCE_OVERSCAN_ROWS
  )
  const visibleResourceRowEnd = Math.min(
    resourceRowCount,
    Math.ceil((resourceScrollTop + Math.max(resourceViewportHeight, RESOURCE_CARD_HEIGHT)) / RESOURCE_CARD_HEIGHT) + RESOURCE_OVERSCAN_ROWS
  )
  const visibleResourceItemStart = visibleResourceRowStart * RESOURCE_COLUMNS
  const visibleResourceItemEnd = Math.min(totalResourceItems, visibleResourceRowEnd * RESOURCE_COLUMNS)

  // 从文件添加图片资源
  const handleAddFromFile = async (files: FileList | File[]) => {
    setIsLoading(true)
    setError(null)

    try {
      const fileArray = Array.from(files)
      for (const file of fileArray) {
        const result = await resourceManager.loadFromFile(file)
        if (result.success && result.resource) {
          addImageResource(result.resource)
        } else {
          setError(result.error || '加载图片失败')
        }
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsLoading(false)
    }
  }

  // 点击添加按钮
  const handleAddClick = () => {
    fileInputRef.current?.click()
  }

  // 文件选择变化
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      handleAddFromFile(files)
    }
    // 重置 input
    e.target.value = ''
  }

  // 拖拽处理
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)

    const files = e.dataTransfer.files
    if (files.length > 0) {
      handleAddFromFile(files)
    }
  }

  const loadResourceBlob = async (item: typeof allResources[number]): Promise<Blob> => {
    const replacement = slotConfigs[item.key]
    return loadResourceImage({
      data: item.resource?.data,
      buffer: item.buffer,
      mimeType: item.mimeType,
      replacementUrl: replacement?.type === 'image'
        ? replacement.imageConfig?.url || String(replacement.value)
        : undefined
    })
  }

  // Extraction preserves original bytes (or the current replacement), never re-encodes images.
  const handleExtractResources = async () => {
    if (extractingRef.current || !filteredResources.length) return
    extractingRef.current = true
    setIsExtracting(true)
    setError(null)
    setExtractionStatus(null)
    const resources = filteredResources.map((item) => ({ key: item.key, load: () => loadResourceBlob(item) }))
    try {
      // Ask for the destination while the click still has browser user activation.
      const save = await createSaveFileTarget('resources.zip')
      if (!save) { setExtractionStatus('已取消提取'); return }
      const blob = await createResourceArchive(resources, (done, total) => setExtractionStatus(`正在提取 ${done} / ${total}`))
      await save(blob)
      setExtractionStatus(`已提取 ${resources.length} 张图片（含 Key 对照清单）`)
    } catch (err) {
      setExtractionStatus(null)
      setError((err as Error).message)
    } finally {
      extractingRef.current = false
      setIsExtracting(false)
    }
  }

  const handleExportImage = async (key: string): Promise<OperationStatusValue> => {
    if (extractingRef.current) return { kind: 'processing', message: '已有图片提取正在进行，请稍后再试。' }
    const item = allResources.find((resource) => resource.key === key)
    if (!item) return { kind: 'error', message: '资源已不存在，请关闭检查窗口后重新选择。' }
    extractingRef.current = true
    setIsExtracting(true)
    setError(null)
    try {
      const blob = await loadResourceBlob(item)
      if (!blob.size) throw new Error('图片数据为空')
      const extension = getResourceExtension(new Uint8Array(await blob.arrayBuffer()), blob.type)
      const saved = await saveGeneratedFile(blob, getResourceFileName(key, extension))
      setExtractionStatus(saved ? '图片提取完成' : '已取消提取')
      return { kind: saved ? 'success' : 'cancelled', message: saved ? '图片提取完成' : '已取消提取' }
    } catch (err) {
      setError((err as Error).message)
      return { kind: 'error', message: `图片提取失败：${(err as Error).message}` }
    } finally {
      extractingRef.current = false
      setIsExtracting(false)
    }
  }

  // 替换图片（插槽功能）
  const handleReplaceImage = (key: string) => {
    const item = allResources.find((resource) => resource.key === key)
    try { validateReplacementSize(item?.width ?? 0, item?.height ?? 0) } catch (err) { setError((err as Error).message); return }
    const target = captureReplacementTarget(useEditorStore.getState(), key)
    const selectionId = ++selectionIdRef.current
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp'
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (file) {
        if (!mountedRef.current || selectionId !== selectionIdRef.current) return
        if (!isReplacementTargetCurrent(target, useEditorStore.getState())) { setError('原素材已变化，请重新选择替换目标'); return }
        if (!file.size || file.size > 32 * 1024 * 1024) { setError('请选择非空且不超过 32 MiB 的图片'); return }
        const url = URL.createObjectURL(file)
        setError(null)
        setPendingReplacement({ key, url, width: item!.width!, height: item!.height!, mode: 'fit', target })
      }
    }
    input.click()
  }

  // 恢复原始图片
  const handleRestoreImage = (key: string) => {
    removeSlotConfig(key)
  }

  const cancelReplacement = () => {
    setPendingReplacement(null)
  }

  const confirmReplacement = () => {
    if (!pendingReplacement || replacementPreview?.draft !== pendingReplacement) return
    const current = pendingReplacement
    if (!isReplacementTargetCurrent(current.target, useEditorStore.getState())) { setReplacementError('原素材已变化，请关闭后重新替换'); return }
    const dataUrl = replacementPreview.dataUrl
    setSlotConfig(current.key, {
      type: 'image', name: current.key, value: dataUrl,
      // Fitting is already baked into the exact preview pixels.
      imageConfig: { url: dataUrl, scaleMode: 'stretch' }
    })
    setExtractionStatus(`已应用替换：${current.key}（${current.mode === 'fit' ? '等比适应' : current.mode === 'fill' ? '裁切填充' : '拉伸'}）`)
    setPendingReplacement(null)
  }

  // 删除新增的图片资源
  const handleDeleteResource = (key: string) => {
    revokeCachedBufferUrl(key)
    resourceManager.removeResource(key)
    removeImageResource(key)
  }

  // 重命名图片 Key
  const handleStartRenameKey = (key: string) => {
    setRenamingKey(key)
    setRenameValue(key)
  }

  const handleCommitRenameKey = () => {
    if (!renamingKey) return
    const newKey = renameValue.trim()
    if (newKey && newKey !== renamingKey) {
      const renamed = renameImageResourceKey(renamingKey, newKey)
      if (!renamed) {
        setError(`无法将资源 Key 修改为 "${newKey}"，请检查是否重名`)
      } else {
        const cachedUrl = objectUrlCacheRef.current.get(renamingKey)
        if (cachedUrl) {
          objectUrlCacheRef.current.delete(renamingKey)
          objectUrlCacheRef.current.set(newKey, cachedUrl)
        }

        resourceManager.renameResource(renamingKey, newKey)
      }
    }
    setRenamingKey(null)
    setRenameValue('')
  }

  const handleCancelRenameKey = () => {
    setRenamingKey(null)
    setRenameValue('')
  }

  // 选择图片（用于创建图层）
  const handleSelectImage = (info: ImageSelectInfo) => {
    onImageSelect?.(info)
  }

  return (
    <>
    <Panel
      title="图片资源"
      icon={<Icon name="image" size={16} />}
      className={className}
      contentClassName="p-0 overflow-hidden flex flex-col min-h-0"
      headerAction={
        <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" disabled={!videoItem && !allResources.length} onClick={() => setShowAudit(true)} title="检查共享、遮罩、缺失引用与源图内存">体检</Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleExtractResources}
          disabled={isExtracting || !filteredResources.length}
          title="将当前搜索结果中的图片打包为 ZIP，包含当前替换图片"
        >
          <Icon name="download" size={14} />
          {isExtracting ? '提取中' : '提取'}
        </Button>
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={handleAddClick}
          disabled={isLoading}
        >
          <Icon name="plus" size={14} />
          添加
        </Button>
        </div>
      }
    >
      {/* 隐藏的文件输入 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      {allResources.length > 0 && (
        <div className="flex-shrink-0 space-y-1.5 border-b border-border px-2 py-2">
          <div className="flex gap-1.5">
            <input
              type="search"
              aria-label="搜索图片资源"
              placeholder="搜索资源 Key"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase())) e.stopPropagation()
                if (e.key === 'Escape') { e.stopPropagation(); setSearchQuery('') }
              }}
              className="h-7 min-w-0 flex-1 rounded border border-border bg-bg-primary px-2 text-xs focus:border-accent focus:outline-none"
            />
            <select
              aria-label="图片资源排序"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as ResourceSort)}
              className="h-7 w-[86px] rounded border border-border bg-bg-primary px-1 text-xs focus:border-accent focus:outline-none"
            >
              <option value="original">原始顺序</option>
              <option value="name">名称顺序</option>
              <option value="size-desc">体积↓</option>
              <option value="size-asc">体积↑</option>
              <option value="memory-desc">内存↓</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="资源用途筛选">
            {RESOURCE_FILTERS.map(filter => <button type="button" key={filter.id} aria-pressed={resourceFilter === filter.id} onClick={() => setResourceFilter(filter.id)} className={cn('rounded px-1.5 py-1 text-[10px]', resourceFilter === filter.id ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-bg-tertiary')}>
              {filter.label} {audit.counts[filter.id]}
            </button>)}
          </div>
          <div className="text-[10px] text-text-muted" title="当前列表的源资源统计，不含插槽替换。体积是编码图片字节之和，不是 SVGA 文件大小；解码估算为宽×高×4，不含帧缓存及 GPU 额外开销。">
            <div>{filteredResources.length} / {allResources.length} 张 · 源图体积 {formatResourceBytes(resourceStats.encodedBytes)}</div>
            <div>源图解码估算 {formatResourceBytes(resourceStats.decodedBytes)}{resourceStats.unknownDimensions > 0 && `（${resourceStats.unknownDimensions} 张尺寸未知）`}</div>
          </div>
        </div>
      )}

      {extractionStatus && <p role="status" className="flex-shrink-0 px-2 py-1 text-xs text-text-secondary">{extractionStatus}</p>}

      {/* 错误提示 */}
      {error && (
        <div className="mb-2 p-2 bg-error/20 text-error text-sm rounded flex items-center gap-2">
          <Icon name="error" size={14} />
          {error}
          <button 
            className="ml-auto hover:bg-error/30 p-1 rounded"
            onClick={() => setError(null)}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      {/* 加载指示器 */}
      {isLoading && (
        <div className="mb-2 p-2 bg-accent/20 text-accent text-sm rounded flex items-center gap-2">
          <Icon name="loading" size={14} className="animate-spin" />
          加载中...
        </div>
      )}

      {allResources.length === 0 ? (
        // 空状态 - 拖拽区域
        <div
          className={cn(
            "text-center py-8 border-2 border-dashed rounded-lg transition-colors",
            dragOver ? "border-accent bg-accent/10" : "border-border hover:border-accent/50"
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleAddClick}
        >
          <Icon name="image" size={32} className="mx-auto mb-2 opacity-50" />
          <p className="text-text-muted text-sm mb-1">拖拽图片到这里</p>
          <p className="text-text-muted text-xs">或点击选择文件</p>
        </div>
      ) : (
        // 资源网格
        <div
          ref={resourceGridRef}
          className={cn(
            "min-h-0 flex-1 overflow-y-auto grid grid-cols-2 auto-rows-max content-start gap-2 transition-colors rounded-lg p-1",
            dragOver && "bg-accent/10 ring-2 ring-accent ring-dashed"
          )}
          onScroll={(e) => setResourceScrollTop(e.currentTarget.scrollTop)}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {filteredResources.length === 0 && (
            <div role="status" className="col-span-2 py-4 text-center text-xs text-text-muted">
              没有匹配的图片
              <button type="button" className="ml-2 text-accent hover:underline" onClick={() => { setSearchQuery(''); setResourceFilter('all') }}>清除筛选</button>
            </div>
          )}
          {visibleResourceRowStart > 0 && <div className="col-span-2" style={{ height: visibleResourceRowStart * RESOURCE_CARD_HEIGHT - 8 }} />}
          {filteredResources.slice(visibleResourceItemStart, visibleResourceItemEnd).map(({ key, resource, url, mimeType, isNew, width, height, buffer, byteSize, usages, tags }) => {
            const isReplaced = slotConfigs[key]?.type === 'image'
            const displayUrl = isReplaced
              ? (slotConfigs[key].imageConfig?.url || slotConfigs[key].value as string)
              : url || (buffer ? getCachedBufferUrl(key, buffer, mimeType) : undefined)
            
            // 查看与添加分离，浏览资源不能隐式修改动画。
            const handleAddLayer = () => {
              handleSelectImage({
                key,
                isNew: !!isNew,
                resource,
                buffer,
                url: displayUrl,
                mimeType
              })
            }
            
            return (
              <div
                key={key}
                className={cn(
                  "h-[182px] min-w-0 bg-bg-tertiary rounded-lg p-2 hover:bg-border/50 cursor-pointer transition-colors group relative",
                  isNew && "ring-1 ring-accent"
                )}
                onClick={() => setInspectedKey(key)}
              >
                <div className="h-[108px] bg-bg-primary rounded overflow-hidden mb-2 relative">
                  <button type="button" aria-label={`查看素材 ${key}`} className="absolute inset-0 z-10 rounded focus-visible:ring-2 focus-visible:ring-accent" onClick={(e) => { e.stopPropagation(); setInspectedKey(key) }} />
                  <img
                    src={displayUrl}
                    alt={key}
                    className="w-full h-full object-contain"
                    loading="lazy"
                    decoding="async"
                  />
                  
                  {/* 标签 */}
                  {isReplaced && (
                    <div className="absolute top-1 right-1 bg-accent text-white text-xs px-1.5 py-0.5 rounded">
                      已替换
                    </div>
                  )}
                  {isNew && !isReplaced && (
                    <div className="absolute top-1 left-1 bg-success text-white text-xs px-1.5 py-0.5 rounded">
                      新增
                    </div>
                  )}

                  {/* 悬停操作按钮 */}
                  <div className="absolute inset-0 z-20 pointer-events-none bg-black/50 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity flex flex-wrap content-center items-center justify-center gap-1 p-1 [&>button]:pointer-events-auto">
                    <button
                      className="p-1.5 bg-white/20 hover:bg-white/30 rounded text-white"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleAddLayer()
                      }}
                      title="添加为图层"
                    >
                      <Icon name="plus" size={14} />
                    </button>
                    <button
                      className="p-1.5 bg-white/20 hover:bg-white/30 rounded text-white"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleReplaceImage(key)
                      }}
                      title="替换图片"
                    >
                      <Icon name="edit" size={14} />
                    </button>
                    <button
                      className="p-1.5 bg-white/20 hover:bg-white/30 rounded text-white"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleStartRenameKey(key)
                      }}
                      title="修改 Key"
                    >
                      <Icon name="key" size={14} />
                    </button>
                    <button
                      className="p-1.5 bg-white/20 hover:bg-white/30 rounded text-white"
                      disabled={isExtracting}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleExportImage(key)
                      }}
                      title="导出图片"
                    >
                      <Icon name="download" size={14} />
                    </button>
                    {isReplaced && (
                      <button
                        className="p-1.5 bg-white/20 hover:bg-white/30 rounded text-white"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleRestoreImage(key)
                        }}
                        title="恢复原图"
                      >
                        <Icon name="undo" size={14} />
                      </button>
                    )}
                    {isNew && (
                      <button
                        className="p-1.5 bg-white/20 hover:bg-error/50 rounded text-white"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDeleteResource(key)
                        }}
                        title="删除资源"
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    )}
                  </div>
                </div>
                {renamingKey === key ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onBlur={handleCommitRenameKey}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        handleCommitRenameKey()
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        handleCancelRenameKey()
                      }
                    }}
                    className="w-full px-1 py-0.5 rounded bg-bg-primary border border-accent text-xs font-mono text-text-primary outline-none ring-1 ring-accent/30"
                  />
                ) : (
                  <p className="text-xs text-text-secondary truncate" title={key}>
                    {key}
                  </p>
                )}
                <p className="truncate text-[10px] text-text-muted">
                  {mimeType.split('/')[1].toUpperCase()}
                  {width && height && ` · ${width}×${height}`}
                </p>
                <p className="truncate text-[10px] text-text-muted" title="源图片编码体积，不含插槽替换；引用数量包含隐藏、锁定和遮罩关联">{formatResourceBytes(byteSize)} · {usages.length ? `${usages.length} 引用` : '未引用'}{tags.includes('matte') ? ' · 遮罩' : ''}{tags.includes('heavy') ? ' · 高内存' : ''}</p>
              </div>
            )
          })}

          {/* 添加更多按钮 */}
          {visibleResourceRowEnd < resourceRowCount && <div className="col-span-2" style={{ height: (resourceRowCount - visibleResourceRowEnd) * RESOURCE_CARD_HEIGHT - 8 }} />}

          <div
            className="h-[182px] border-2 border-dashed border-border hover:border-accent/50 rounded-lg flex items-center justify-center cursor-pointer transition-colors"
            onClick={handleAddClick}
          >
            <div className="text-center text-text-muted">
              <Icon name="plus" size={20} className="mx-auto mb-1" />
              <p className="text-xs">添加图片</p>
            </div>
          </div>
        </div>
      )}
    </Panel>
      {showAudit && <ResourceAuditDialog audit={audit} onClose={() => setShowAudit(false)}
        onFilter={filter => { setResourceFilter(filter); setSearchQuery(''); if (filter === 'heavy') setSortOrder('memory-desc'); setShowAudit(false) }}
        onInspect={key => { setShowAudit(false); setInspectedKey(key) }} onLocate={locateLayer} />}
      {inspectedResource && <ResourceInspector key={inspectedResource.key} resource={inspectedResource} sourceUrl={inspectedSourceUrl}
        replacementUrl={inspectedReplacementUrl} textSlot={inspectedSlot?.type === 'text'}
        onClose={() => setInspectedKey(null)} onLocate={locateLayer}
        onReplace={() => { const key = inspectedResource.key; setInspectedKey(null); handleReplaceImage(key) }}
        downloading={isExtracting} onDownload={() => handleExportImage(inspectedResource.key)} />}
      <Modal
        isolateKeyboard
        isOpen={Boolean(pendingReplacement)}
        onClose={cancelReplacement}
        title="预览素材替换"
        footer={<>
          <Button variant="ghost" onClick={cancelReplacement}>取消</Button>
          <Button variant="primary" disabled={!replacementIsReady || !replacementIsCurrent} onClick={confirmReplacement}>确认替换</Button>
        </>}
      >
        {pendingReplacement && <div className="space-y-3">
          <p className="text-xs text-text-muted">{pendingReplacement.key} · 目标尺寸 {pendingReplacement.width}×{pendingReplacement.height}</p>
          <p className="rounded bg-warning/10 p-2 text-xs text-warning">{describeResourceScope(pendingReplacement.key, layers, videoItem)}</p>
          {!replacementIsCurrent && <p role="alert" className="text-sm text-warning">原素材或替换配置已变化，不能应用旧预览。请取消后重新操作。</p>}
          {replacementError && <p role="alert" className="text-sm text-error">{replacementError}</p>}
          <div className="flex h-56 items-center justify-center overflow-hidden rounded border border-border" style={{ backgroundColor: '#d1d5db', backgroundImage: 'conic-gradient(#f3f4f6 25%, transparent 0 50%, #f3f4f6 0 75%, transparent 0)', backgroundSize: '20px 20px' }}>
            {replacementIsReady ? <img src={replacementPreview!.dataUrl} alt="替换预览" className="max-h-full max-w-full object-contain ring-1 ring-accent/60" /> : <span role="status" className="text-sm text-gray-700">{replacementError ? '无法生成预览' : '正在生成预览…'}</span>}
          </div>
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="图片适配方式">
            {(['fit', 'fill', 'stretch'] as const).map((mode) => <button key={mode} type="button" aria-pressed={pendingReplacement.mode === mode} onClick={() => setPendingReplacement({ ...pendingReplacement, mode })} className={cn('rounded border px-2 py-2 text-xs', pendingReplacement.mode === mode ? 'border-accent bg-accent/15 text-accent' : 'border-border text-text-secondary hover:border-accent/50')}>
              {mode === 'fit' ? '等比适应' : mode === 'fill' ? '裁切填充' : '拉伸'}
            </button>)}
          </div>
          <p className="text-xs text-text-muted">等比适应完整显示图片，空白区域保持透明；裁切填充居中铺满；拉伸强制匹配目标比例。确认将应用上方同一张静态 PNG，不改变原素材尺寸或图层动画；动态图片会定格为解码时的一帧。</p>
        </div>}
      </Modal>
    </>
  )
}
