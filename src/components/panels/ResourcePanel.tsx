import React from 'react'
import { Panel, Icon, Button } from '@/components/ui'
import { useEditorStore } from '@/stores'
import { resourceManager } from '@/core'
import type { ImageResource } from '@/types'
import { cn } from '@/utils/cn'

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
const RESOURCE_CARD_HEIGHT = 150
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
  const objectUrlCacheRef = React.useRef<Map<string, string>>(new Map())
  const resourceGridRef = React.useRef<HTMLDivElement>(null)
  const [resourceScrollTop, setResourceScrollTop] = React.useState(0)
  const [resourceViewportHeight, setResourceViewportHeight] = React.useState(0)
  const [renamingKey, setRenamingKey] = React.useState<string | null>(null)
  const [renameValue, setRenameValue] = React.useState('')
  const renameInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (renamingKey && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingKey])

  React.useEffect(() => {
    const cache = objectUrlCacheRef.current
    return () => {
      cache.forEach((url) => URL.revokeObjectURL(url))
      cache.clear()
    }
  }, [videoItem])

  const getCachedBufferUrl = React.useCallback((key: string, buffer: ArrayBuffer, mimeType: string) => {
    const cached = objectUrlCacheRef.current.get(key)
    if (cached) return cached

    const url = URL.createObjectURL(new Blob([buffer], { type: mimeType }))
    objectUrlCacheRef.current.set(key, url)
    return url
  }, [])

  React.useEffect(() => {
    const grid = resourceGridRef.current
    if (!grid) return

    const updateHeight = () => setResourceViewportHeight(grid.clientHeight)
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [videoItem])

  // 合并 SVGA 原始图片和新增图片资源
  const allResources = React.useMemo(() => {
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
        const mimeType = getImageMimeType(buffer)
        const existingResource = imageResources.get(key)
        resources.push({
          key,
          resource: existingResource,
          url: existingResource?.blobUrl,
          mimeType,
          width: existingResource?.width,
          height: existingResource?.height,
          buffer
        })
      })
    }

    // 添加新增的图片资源
    imageResources.forEach((resource, key) => {
      // 检查是否已存在（避免重复）
      if (!resources.find(r => r.key === key)) {
        resources.push({
          key,
          resource,
          url: resource.blobUrl,
          mimeType: resource.mimeType,
          isNew: resource.isNew,
          width: resource.width,
          height: resource.height
        })
      }
    })

    return resources
  }, [videoItem, imageResources])

  // 清理 URL 对象
  React.useEffect(() => {
    return () => {
      allResources.forEach(({ url, resource }) => {
        // 只清理临时创建的 URL，不清理 resource 中的 blobUrl
        if (url && !resource?.blobUrl) {
          void url
        }
      })
    }
  }, [allResources])

  const totalResourceItems = allResources.length
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

  // 导出单张图片
  const handleExportImage = (key: string, url: string) => {
    if (!url) {
      setError('当前图片没有可导出的预览地址')
      return
    }
    const a = document.createElement('a')
    a.href = url
    a.download = `${key}.png`
    a.click()
  }

  // 替换图片（插槽功能）
  const handleReplaceImage = (key: string) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (file) {
        const url = URL.createObjectURL(file)
        setSlotConfig(key, {
          type: 'image',
          name: key,
          value: url,
          imageConfig: {
            url,
            scaleMode: 'fit'
          }
        })
      }
    }
    input.click()
  }

  // 恢复原始图片
  const handleRestoreImage = (key: string) => {
    removeSlotConfig(key)
  }

  // 删除新增的图片资源
  const handleDeleteResource = (key: string) => {
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
    <Panel
      title="图片资源"
      icon={<Icon name="image" size={16} />}
      className={className}
      contentClassName="p-0 overflow-hidden"
      headerAction={
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={handleAddClick}
          disabled={isLoading}
        >
          <Icon name="plus" size={14} />
          添加
        </Button>
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
            "h-full overflow-y-auto grid grid-cols-2 gap-2 transition-colors rounded-lg p-1",
            dragOver && "bg-accent/10 ring-2 ring-accent ring-dashed"
          )}
          onScroll={(e) => setResourceScrollTop(e.currentTarget.scrollTop)}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {Array.from({ length: visibleResourceItemStart }).map((_, index) => (
            <div key={`resource-before-${index}`} className="h-[142px]" />
          ))}
          {allResources.slice(visibleResourceItemStart, visibleResourceItemEnd).map(({ key, resource, url, mimeType, isNew, width, height, buffer }) => {
            const isReplaced = !!slotConfigs[key]
            const displayUrl = isReplaced
              ? (slotConfigs[key].value as string)
              : url || (buffer ? getCachedBufferUrl(key, buffer, mimeType) : undefined)
            
            // 点击图片卡片创建图层
            const handleCardClick = () => {
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
                  "bg-bg-tertiary rounded-lg p-2 hover:bg-border/50 cursor-pointer transition-colors group relative",
                  isNew && "ring-1 ring-accent"
                )}
                onClick={handleCardClick}
              >
                <div className="aspect-square bg-bg-primary rounded overflow-hidden mb-2 relative">
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
                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
                    <button
                      className="p-1.5 bg-white/20 hover:bg-white/30 rounded text-white"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleCardClick()
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
                      onClick={(e) => {
                        e.stopPropagation()
                        handleExportImage(key, displayUrl || '')
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
                <p className="text-xs text-text-muted">
                  {mimeType.split('/')[1].toUpperCase()}
                  {width && height && ` · ${width}×${height}`}
                </p>
              </div>
            )
          })}

          {/* 添加更多按钮 */}
          {Array.from({ length: Math.max(0, totalResourceItems - visibleResourceItemEnd) }).map((_, index) => (
            <div key={`resource-after-${index}`} className="h-[142px]" />
          ))}

          <div
            className="aspect-square border-2 border-dashed border-border hover:border-accent/50 rounded-lg flex items-center justify-center cursor-pointer transition-colors"
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
  )
}

/**
 * 根据文件头判断图片 MIME 类型
 */
const getImageMimeType = (buffer: ArrayBuffer): string => {
  const data = new Uint8Array(buffer)
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
    return 'image/png'
  }
  // JPEG: FF D8
  if (data[0] === 0xFF && data[1] === 0xD8) {
    return 'image/jpeg'
  }
  // WebP: RIFF....WEBP
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
    return 'image/webp'
  }
  // GIF: GIF
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return 'image/gif'
  }
  return 'image/png'
}
