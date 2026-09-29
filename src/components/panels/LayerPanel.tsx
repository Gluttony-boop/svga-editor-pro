import React from 'react'
import { Button, Modal, Panel, Icon } from '@/components/ui'
import { useEditorStore } from '@/stores'
import { LayerUtils } from '@/core'
import type { AnimationPreset, ImageResource, Layer, VideoItem } from '@/types'
import { cn } from '@/utils/cn'
import { filterLayers, type LayerFilter } from '@/utils/layer-filter'
import { listenForLayerReveal } from '@/utils/layer-navigation'
import { detectImageMime } from '@/utils/image-mime'
import { getLayerOutputRange, getLayerSourceFrame, getLayerTimeOffset } from '@/core/layer-time'
import { getSelectedLayerIds, selectLayerInList } from '@/utils/layer-selection'
import { captureExportInputs } from '@/core/export-preview'
import { getLayerDuplicateError } from '@/core/keyframe-editing'

const getLayerThumbnail = (
  layer: Layer,
  imageResources: Map<string, ImageResource>,
  videoItem: VideoItem | null,
  objectUrlCache: Map<string, { url: string; buffer: ArrayBuffer; mimeType: string }>
): string | null => {
  if (layer.type !== 'image' || !layer.imageKey) return null

  const resource = imageResources.get(layer.imageKey)
  if (resource?.blobUrl) {
    return resource.blobUrl
  }

  if (videoItem?.buffers?.[layer.imageKey]) {
    const buffer = videoItem.buffers[layer.imageKey]
    const mimeType = detectImageMime(new Uint8Array(buffer))
    const cached = objectUrlCache.get(layer.imageKey)
    if (cached?.buffer === buffer && cached.mimeType === mimeType) return cached.url
    if (cached) URL.revokeObjectURL(cached.url)

    const url = URL.createObjectURL(new Blob([buffer], { type: mimeType }))
    objectUrlCache.set(layer.imageKey, { url, buffer, mimeType })
    return url
  }

  return null
}

const LAYER_ROW_HEIGHT = 72
const LAYER_OVERSCAN = 8

interface LayerPanelProps {
  className?: string
  onAddLayer?: (resource: ImageResource) => void
}

const ANIMATION_PRESETS: AnimationPreset[] = [
  {
    id: 'fadeIn',
    name: '淡入',
    category: 'entrance',
    duration: 12,
    keyframes: {
      alpha: [
        { frame: 0, value: 0, easing: 'easeOut' },
        { frame: 12, value: 1, easing: 'linear' }
      ]
    }
  },
  {
    id: 'fadeOut',
    name: '淡出',
    category: 'exit',
    duration: 12,
    keyframes: {
      alpha: [
        { frame: 0, value: 1, easing: 'easeIn' },
        { frame: 12, value: 0, easing: 'linear' }
      ]
    }
  },
  {
    id: 'slideInFromLeft',
    name: '从左滑入',
    category: 'entrance',
    duration: 15,
    keyframes: {
      position: [
        { frame: 0, x: -200, y: 'centerY', easing: 'easeOut' },
        { frame: 15, x: 'centerX', y: 'centerY', easing: 'linear' }
      ]
    }
  },
  {
    id: 'slideInFromRight',
    name: '从右滑入',
    category: 'entrance',
    duration: 15,
    keyframes: {
      position: [
        { frame: 0, x: 200, y: 'centerY', easing: 'easeOut' },
        { frame: 15, x: 'centerX', y: 'centerY', easing: 'linear' }
      ]
    }
  },
  {
    id: 'scaleIn',
    name: '缩放进入',
    category: 'entrance',
    duration: 12,
    keyframes: {
      scale: [
        { frame: 0, scaleX: 0, scaleY: 0, easing: 'easeOut' },
        { frame: 12, scaleX: 1, scaleY: 1, easing: 'linear' }
      ],
      alpha: [
        { frame: 0, value: 0, easing: 'easeOut' },
        { frame: 6, value: 1, easing: 'linear' }
      ]
    }
  },
  {
    id: 'scaleOut',
    name: '缩放退出',
    category: 'exit',
    duration: 12,
    keyframes: {
      scale: [
        { frame: 0, scaleX: 1, scaleY: 1, easing: 'easeIn' },
        { frame: 12, scaleX: 0, scaleY: 0, easing: 'linear' }
      ],
      alpha: [
        { frame: 6, value: 1, easing: 'linear' },
        { frame: 12, value: 0, easing: 'easeIn' }
      ]
    }
  },
  {
    id: 'bounce',
    name: '弹跳',
    category: 'emphasis',
    duration: 20,
    keyframes: {
      scale: [
        { frame: 0, scaleX: 1, scaleY: 1, easing: 'linear' },
        { frame: 5, scaleX: 1.2, scaleY: 1.2, easing: 'easeOut' },
        { frame: 10, scaleX: 0.9, scaleY: 0.9, easing: 'easeInOut' },
        { frame: 15, scaleX: 1.05, scaleY: 1.05, easing: 'easeInOut' },
        { frame: 20, scaleX: 1, scaleY: 1, easing: 'easeIn' }
      ]
    }
  },
  {
    id: 'rotate',
    name: '旋转',
    category: 'emphasis',
    duration: 24,
    keyframes: {
      rotation: [
        { frame: 0, value: 0, easing: 'linear' },
        { frame: 24, value: 360, easing: 'linear' }
      ]
    }
  },
  {
    id: 'shake',
    name: '抖动',
    category: 'emphasis',
    duration: 10,
    keyframes: {
      position: [
        { frame: 0, x: 'centerX', y: 'centerY', easing: 'linear' },
        { frame: 2, x: -10, y: 'centerY', easing: 'linear' },
        { frame: 4, x: 10, y: 'centerY', easing: 'linear' },
        { frame: 6, x: -5, y: 'centerY', easing: 'linear' },
        { frame: 8, x: 5, y: 'centerY', easing: 'linear' },
        { frame: 10, x: 'centerX', y: 'centerY', easing: 'linear' }
      ]
    }
  }
]

export const LayerPanel: React.FC<LayerPanelProps> = ({ className }) => {
  const layers = useEditorStore((s) => s.layers)
  const selectedLayerId = useEditorStore((s) => s.selectedLayerId)
  const selectedLayerIds = useEditorStore((s) => s.selectedLayerIds)
  const selectLayer = useEditorStore((s) => s.selectLayer)
  const updateLayer = useEditorStore((s) => s.updateLayer)
  const operateLayers = useEditorStore((s) => s.operateLayers)
  const duplicateLayer = useEditorStore((s) => s.duplicateLayer)
  const applyAnimationPreset = useEditorStore((s) => s.applyAnimationPreset)
  const reorderLayers = useEditorStore((s) => s.reorderLayers)
  const imageResources = useEditorStore((s) => s.imageResources)
  const videoItem = useEditorStore((s) => s.videoItem)
  const selection = React.useMemo(
    () => getSelectedLayerIds({ layers, selectedLayerId, selectedLayerIds }),
    [layers, selectedLayerId, selectedLayerIds]
  )
  const selectedIdSet = React.useMemo(() => new Set(selection), [selection])
  const listRef = React.useRef<HTMLDivElement>(null)
  const objectUrlCacheRef = React.useRef<Map<string, { url: string; buffer: ArrayBuffer; mimeType: string }>>(new Map())

  const currentFrame = useEditorStore(state => state.playback.currentFrame)
  const [showAnimationMenu, setShowAnimationMenu] = React.useState<string | null>(null)
  const [showActionMenu, setShowActionMenu] = React.useState<string | null>(null)
  const [draggedIndex, setDraggedIndex] = React.useState<number | null>(null)
  const [editingLayerId, setEditingLayerId] = React.useState<string | null>(null)
  const [editingName, setEditingName] = React.useState('')
  const [scrollTop, setScrollTop] = React.useState(0)
  const [viewportHeight, setViewportHeight] = React.useState(0)
  const [pendingDelete, setPendingDelete] = React.useState<{ ids: string[]; names: string[]; inputs: readonly unknown[] } | null>(null)
  const [operationNotice, setOperationNotice] = React.useState('')
  const selectionAnchor = React.useRef<string | null>(null)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [statusFilter, setStatusFilter] = React.useState<LayerFilter>('all')
  const [revealLayerId, setRevealLayerId] = React.useState<string | null>(null)
  const filteredLayers = React.useMemo(
    () => filterLayers(layers, searchQuery, statusFilter),
    [layers, searchQuery, statusFilter]
  )
  const isFiltered = searchQuery.trim().length > 0 || statusFilter !== 'all'

  React.useEffect(() => listenForLayerReveal((id) => {
    if (!useEditorStore.getState().layers.some(layer => layer.id === id)) return
    selectLayer(id)
    setSearchQuery('')
    setStatusFilter('all')
    setRevealLayerId(id)
  }), [selectLayer])

  React.useEffect(() => {
    setSearchQuery('')
    setStatusFilter('all')
    setRevealLayerId(null)
    selectionAnchor.current = null
    setPendingDelete(null)
    setOperationNotice('')
  }, [videoItem])

  React.useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
    setScrollTop(0)
    setDraggedIndex(null)
    setShowActionMenu(null)
    setShowAnimationMenu(null)
  }, [searchQuery, statusFilter, videoItem])

  React.useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    // Clamp after deleting/filtering rows at the end of a virtualized list.
    const maxScroll = Math.max(0, filteredLayers.length * LAYER_ROW_HEIGHT + 16 - list.clientHeight)
    if (list.scrollTop > maxScroll) list.scrollTop = maxScroll
    if (revealLayerId) {
      const index = filteredLayers.findIndex(({ layer }) => layer.id === revealLayerId)
      if (index >= 0) {
        list.scrollTop = Math.max(0, index * LAYER_ROW_HEIGHT + 8 - (list.clientHeight - LAYER_ROW_HEIGHT) / 2)
      }
      setRevealLayerId(null)
    }
    setScrollTop(list.scrollTop)
  }, [filteredLayers, revealLayerId, viewportHeight])

  React.useEffect(() => {
    const list = listRef.current
    if (!list) return

    const updateHeight = () => setViewportHeight(list.clientHeight)
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(list)
    return () => observer.disconnect()
  }, [layers.length])

  React.useEffect(() => {
    const cache = objectUrlCacheRef.current
    cache.forEach((entry, key) => {
      if (videoItem?.buffers?.[key] !== entry.buffer) {
        URL.revokeObjectURL(entry.url)
        cache.delete(key)
      }
    })
  }, [videoItem])
  React.useEffect(() => {
    const cache = objectUrlCacheRef.current
    return () => {
      cache.forEach(({ url }) => URL.revokeObjectURL(url))
      cache.clear()
    }
  }, [])

  const visibleStart = Math.max(
    0,
    Math.floor(scrollTop / LAYER_ROW_HEIGHT) - LAYER_OVERSCAN
  )
  const visibleEnd = Math.min(
    filteredLayers.length,
    Math.ceil((scrollTop + Math.max(viewportHeight, LAYER_ROW_HEIGHT)) / LAYER_ROW_HEIGHT) + LAYER_OVERSCAN
  )
  const visibleLayers = filteredLayers.slice(visibleStart, visibleEnd)
  const selectedLayer = layers.find((layer) => layer.id === selectedLayerId)
  const renamedCount = layers.filter((layer) => {
    const nextName = layer.name.trim()
    return layer.imageKey && nextName.length > 0 && nextName !== layer.imageKey
  }).length

  const handleToggleVisibility = (layerId: string, currentVisible: boolean) => {
    updateLayer(layerId, { visible: !currentVisible })
  }

  const handleToggleLock = (layerId: string, currentLocked: boolean) => {
    updateLayer(layerId, { locked: !currentLocked })
  }

  const handleDeleteLayer = (layerId: string) => {
    requestDelete([layerId])
  }

  const requestDelete = (ids: string[]) => {
    const state = useEditorStore.getState()
    if (!ids.length) return
    setOperationNotice('')
    setPendingDelete({ ids: [...ids], names: ids.map(id => state.layers.find(layer => layer.id === id)?.name ?? id), inputs: captureExportInputs(state) })
  }
  const handleConfirmDeleteLayer = () => {
    if (!pendingDelete) return
    const result = operateLayers(pendingDelete.ids, 'delete', pendingDelete.inputs)
    setOperationNotice(result.error ?? `已删除 ${pendingDelete.ids.length} 个图层，可一步撤销。`)
    setPendingDelete(null)
  }
  const operateSelection = (operation: 'show' | 'hide' | 'lock' | 'unlock') => {
    const result = operateLayers(selection, operation)
    setOperationNotice(result.error ?? (result.changed ? '已更新所选图层，可一步撤销。' : '所选图层已经是该状态。'))
  }

  const handleApplyAnimation = (layerId: string, preset: AnimationPreset) => {
    const layer = layers.find(item => item.id === layerId)
    if (!layer) return
    applyAnimationPreset(layerId, preset, Math.max(layer.clip.startFrame, getLayerSourceFrame(layer, currentFrame)))
    setShowAnimationMenu(null)
    setShowActionMenu(null)
  }

  const handleStartRename = (layer: Layer) => {
    selectLayer(layer.id)
    setShowAnimationMenu(null)
    setShowActionMenu(null)
    setEditingLayerId(layer.id)
    setEditingName(layer.name)
  }

  const handleCommitRename = (layerId: string) => {
    const layer = layers.find((item) => item.id === layerId)
    if (!layer) {
      setEditingLayerId(null)
      setEditingName('')
      return
    }

    const nextName = editingName.trim()
    if (nextName && nextName !== layer.name) {
      updateLayer(layerId, { name: nextName })
    }
    setEditingLayerId(null)
    setEditingName('')
  }

  const handleCancelRename = () => {
    setEditingLayerId(null)
    setEditingName('')
  }

  const handleDragStart = (index: number) => {
    setDraggedIndex(index)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleDrop = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (!isFiltered && draggedIndex !== null && draggedIndex !== index) {
      reorderLayers(draggedIndex, index)
    }
    setDraggedIndex(null)
  }

  const getLayerStatus = (layer: Layer) => {
    const inRange = LayerUtils.isLayerVisibleAtFrame(layer, getLayerSourceFrame(layer, currentFrame))
    const hasAnimation = [...Object.values(layer.tracks), ...Object.values(layer.animationTracks || {})].some(
      (track) => track.keyframes.length > 0
    )
    return { inRange, hasAnimation }
  }

  return (
    <>
      <Panel
        title="图层"
        icon={<Icon name="layer" size={16} />}
        className={className}
        contentClassName="p-0 overflow-hidden"
        headerAction={
          <div className="flex items-center gap-2 text-[10px] text-text-muted">
            {renamedCount > 0 && (
              <span className="rounded bg-accent/15 px-1.5 py-0.5 text-accent">
                已改名 {renamedCount}
              </span>
            )}
            <span>{isFiltered ? `${filteredLayers.length} / ${layers.length}` : layers.length} 层</span>
          </div>
        }
      >
        <div className="flex h-full min-h-0 flex-col" tabIndex={0} aria-label="图层列表操作区"
          onKeyDown={event => {
            if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return
            if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); requestDelete(selection) }
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
              event.preventDefault(); event.stopPropagation(); useEditorStore.getState().selectLayers(filteredLayers.map(({ layer }) => layer.id))
            }
          }}>
          <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-border/70 px-2 py-2">
            <input
              type="search"
              aria-label="搜索图层名称或资源名"
              placeholder="搜索名称 / 资源名"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                // Preserve native text undo inside the search field.
                if ((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase())) e.stopPropagation()
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setSearchQuery('')
                }
              }}
              className="h-7 min-w-0 flex-1 rounded border border-border bg-bg-primary px-2 text-xs text-text-primary placeholder-text-muted focus:border-accent focus:outline-none"
            />
            <select
              aria-label="筛选图层状态"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as LayerFilter)}
              className="h-7 w-[72px] flex-shrink-0 rounded border border-border bg-bg-primary px-1 text-xs text-text-secondary focus:border-accent focus:outline-none"
            >
              <option value="all">全部</option>
              <option value="visible">已显示</option>
              <option value="hidden">已隐藏</option>
              <option value="locked">已锁定</option>
              <option value="unlocked">未锁定</option>
            </select>
          </div>
          <div aria-label="图层批量操作" className="flex flex-wrap flex-shrink-0 gap-1 border-b border-border/70 px-2 py-1">
            <Button size="sm" disabled={!filteredLayers.length} onClick={() => useEditorStore.getState().selectLayers(filteredLayers.map(({ layer }) => layer.id))}>全选当前列表</Button>
            <Button size="sm" disabled={!selection.length} onClick={() => selectLayer(null)}>取消选择</Button>
            {selection.length > 0 && <>
              <Button size="sm" onClick={() => operateSelection('show')}>显示所选</Button>
              <Button size="sm" onClick={() => operateSelection('hide')}>隐藏所选</Button>
              <Button size="sm" onClick={() => operateSelection('lock')}>锁定所选</Button>
              <Button size="sm" onClick={() => operateSelection('unlock')}>解锁所选</Button>
              <Button size="sm" variant="danger" onClick={() => requestDelete(selection)}>删除所选（{selection.length}）</Button>
            </>}
          </div>
          {operationNotice && <p role="status" className="px-2 py-1 text-xs text-warning">{operationNotice}</p>}
          <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-border/70 px-3 text-xs">
            <div className="min-w-0 text-text-muted">
              {selectedLayer ? (
                <span className="block truncate text-text-secondary" title={selection.length > 1 ? `已选 ${selection.length} 层，主选中：${selectedLayer.name}` : `当前：${selectedLayer.name}`}>
                  {selection.length > 1 ? `已选 ${selection.length} 层 · 主：${selectedLayer.name}` : `当前：${selectedLayer.name}`}
                </span>
              ) : (
                <span>未选择图层</span>
              )}
            </div>
            <div className="flex flex-shrink-0 items-center gap-1.5 text-[10px] text-text-muted">
              <button
                type="button"
                disabled={!selectedLayer}
                title="清除筛选并定位当前选中图层"
                className="rounded px-1 py-1 text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => {
                  setSearchQuery('')
                  setStatusFilter('all')
                  setRevealLayerId(selectedLayerId)
                }}
              >
                定位
              </button>
              <span>帧 {currentFrame + 1}</span>
            </div>
          </div>

          {isFiltered && (
            <div className="flex flex-shrink-0 items-center justify-between px-3 py-1 text-[10px] text-text-muted">
              <span>筛选中，拖拽排序已暂停</span>
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => { setSearchQuery(''); setStatusFilter('all') }}
              >
                清除筛选
              </button>
            </div>
          )}

          <div
            ref={listRef}
            className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            {layers.length === 0 ? (
              <div className="flex h-full min-h-[160px] flex-col items-center justify-center px-6 text-center text-sm text-text-muted">
                <div className="mb-3 grid h-12 w-12 place-items-center rounded border border-border bg-bg-tertiary">
                  <Icon name="layer" size={24} className="opacity-60" />
                </div>
                <p className="text-text-secondary">打开 SVGA 文件或添加图片</p>
                <p className="mt-1 text-xs">图层会显示在这里</p>
              </div>
            ) : filteredLayers.length === 0 ? (
              <div className="flex h-full min-h-[72px] items-center justify-center px-3 text-center text-xs text-text-muted" role="status">
                没有匹配的图层，请调整搜索或筛选条件
              </div>
            ) : (
              <div
                className="relative"
                style={{ height: filteredLayers.length * LAYER_ROW_HEIGHT }}
              >
                {visibleLayers.map(({ layer, index }, offset) => {
                  const displayIndex = visibleStart + offset
                  const { inRange, hasAnimation } = getLayerStatus(layer)
                  const thumbnailUrl = getLayerThumbnail(
                    layer,
                    imageResources,
                    videoItem,
                    objectUrlCacheRef.current
                  )

                  return (
                    <div
                      key={layer.id}
                      className="absolute left-0 right-0 px-0.5 py-1"
                      style={{ top: displayIndex * LAYER_ROW_HEIGHT, height: LAYER_ROW_HEIGHT }}
                    >
                      <LayerItem
                        layer={layer}
                        index={index}
                        canReorder={!isFiltered}
                        selected={selectedIdSet.has(layer.id)}
                        primary={selection.length > 1 && selectedLayerId === layer.id}
                        inRange={inRange}
                        hasAnimation={hasAnimation}
                        showAnimationMenu={showAnimationMenu === layer.id}
                        showActionMenu={showActionMenu === layer.id}
                        thumbnailUrl={thumbnailUrl}
                        isEditing={editingLayerId === layer.id}
                        editingName={editingName}
                        onClick={(event) => {
                          const next = selectLayerInList(filteredLayers.map(({ layer: item }) => item.id), selection, layer.id,
                            selectionAnchor.current ?? selectedLayerId, event.shiftKey, event.ctrlKey || event.metaKey)
                          selectionAnchor.current = next.anchor
                          useEditorStore.getState().selectLayers(next.ids)
                          setShowActionMenu(null)
                          setShowAnimationMenu(null)
                        }}
                        onToggleVisibility={() => handleToggleVisibility(layer.id, layer.visible)}
                        onToggleLock={() => handleToggleLock(layer.id, layer.locked)}
                        onDelete={() => handleDeleteLayer(layer.id)}
                        onDuplicate={() => duplicateLayer(layer.id)}
                        duplicateError={getLayerDuplicateError(layer, layers, videoItem)}
                        onShowAnimationMenu={() => {
                          setShowActionMenu(null)
                          setShowAnimationMenu(showAnimationMenu === layer.id ? null : layer.id)
                        }}
                        onShowActionMenu={() => {
                          setShowAnimationMenu(null)
                          setShowActionMenu(showActionMenu === layer.id ? null : layer.id)
                        }}
                        onApplyAnimation={(preset) => handleApplyAnimation(layer.id, preset)}
                        onCloseAnimationMenu={() => setShowAnimationMenu(null)}
                        onCloseActionMenu={() => setShowActionMenu(null)}
                        onStartRename={() => handleStartRename(layer)}
                        onChangeEditingName={setEditingName}
                        onCommitRename={() => handleCommitRename(layer.id)}
                        onCancelRename={handleCancelRename}
                        onDragStart={() => handleDragStart(index)}
                        onDragOver={handleDragOver}
                        onDrop={(e) => handleDrop(e, index)}
                        onDragEnd={() => setDraggedIndex(null)}
                        isDragging={draggedIndex === index}
                        isNew={layer.isNew}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          {layers.length > 1 && (
            <div className="flex-shrink-0 border-t border-border/70 px-3 py-1.5 text-[10px] text-text-muted">
              Shift 连选 · Ctrl/⌘ 增减选择 · 行内按钮仅操作本层
              {selection.some(id => !filteredLayers.some(({ layer }) => layer.id === id)) && <span className="block text-warning">选区包含筛选外图层，批量操作仍作用于全部所选。</span>}
            </div>
          )}
        </div>
      </Panel>

      <Modal
        isOpen={Boolean(pendingDelete)} isolateKeyboard
        onClose={() => setPendingDelete(null)}
        title="确认删除图层"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button variant="danger" onClick={handleConfirmDeleteLayer}>
              确认删除 {pendingDelete?.ids.length ?? 0} 个图层
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-secondary">
          将删除所选 {pendingDelete?.ids.length ?? 0} 个图层（含筛选外选区），不会删除素材库中的原始图片。可一步撤销；锁定图层或仍被引用的遮罩会阻止整组删除。
        </p>
        <ul className="mt-2 max-h-40 overflow-auto text-xs text-text-secondary">{pendingDelete?.names.map((name, index) => <li key={pendingDelete.ids[index]}>{name}</li>)}</ul>
      </Modal>
    </>
  )
}

interface LayerItemProps {
  layer: Layer
  index: number
  canReorder: boolean
  selected: boolean
  primary: boolean
  inRange: boolean
  hasAnimation: boolean
  showAnimationMenu: boolean
  showActionMenu: boolean
  thumbnailUrl: string | null
  isEditing: boolean
  editingName: string
  onClick: React.MouseEventHandler<HTMLDivElement>
  onToggleVisibility: () => void
  onToggleLock: () => void
  onDelete: () => void
  onDuplicate: () => void
  duplicateError: string | null
  onShowAnimationMenu: () => void
  onShowActionMenu: () => void
  onApplyAnimation: (preset: AnimationPreset) => void
  onCloseAnimationMenu: () => void
  onCloseActionMenu: () => void
  onStartRename: () => void
  onChangeEditingName: (name: string) => void
  onCommitRename: () => void
  onCancelRename: () => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
  isDragging: boolean
  isNew?: boolean
}

const LayerItem: React.FC<LayerItemProps> = ({
  layer,
  index,
  canReorder,
  selected,
  primary,
  inRange,
  hasAnimation,
  showAnimationMenu,
  showActionMenu,
  thumbnailUrl,
  isEditing,
  editingName,
  onClick,
  onToggleVisibility,
  onToggleLock,
  onDelete,
  onDuplicate,
  duplicateError,
  onShowAnimationMenu,
  onShowActionMenu,
  onApplyAnimation,
  onCloseAnimationMenu,
  onCloseActionMenu,
  onStartRename,
  onChangeEditingName,
  onCommitRename,
  onCancelRename,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragging,
  isNew
}) => {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const timeRange = getLayerOutputRange(layer)
  const renamed = Boolean(layer.imageKey && layer.name.trim() && layer.name.trim() !== layer.imageKey)

  React.useEffect(() => {
    if (!isEditing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [isEditing])

  const handleDragStart = (e: React.DragEvent) => {
    if (isEditing) {
      e.preventDefault()
      return
    }
    onDragStart()
  }

  return (
    <div
      className={cn(
        'group relative h-full rounded border transition-all',
        selected
          ? 'border-accent/50 bg-accent/10 shadow-[inset_2px_0_0_var(--color-accent)]'
          : 'border-border/40 bg-bg-secondary hover:border-border-light hover:bg-bg-tertiary/70',
        !inRange && 'opacity-60',
        isDragging && 'opacity-30'
      )}
      onClick={onClick}
      data-layer-id={layer.id}
      data-selected={selected}
      data-primary={primary}
      draggable={!isEditing && canReorder}
      onDragStart={handleDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <div className="flex h-full items-center gap-1.5 px-2">
        <div
          className={cn('grid h-10 w-3 flex-shrink-0 place-items-center text-text-muted transition-colors', canReorder ? 'cursor-grab group-hover:text-text-secondary' : 'opacity-30')}
          title={canReorder ? '拖拽排序' : '清除筛选后可拖拽排序'}
        >
          <Icon name="grip-vertical" size={14} />
        </div>

        <div className="relative grid h-9 w-9 flex-shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-bg-primary">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt={layer.name}
              className="h-full w-full object-contain"
              loading="lazy"
              decoding="async"
              draggable={false}
            />
          ) : layer.type === 'image' ? (
            <Icon name="image" size={18} className="text-text-muted" />
          ) : (
            <Icon name="text" size={18} className="text-text-muted" />
          )}
          {isNew && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-success" />}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            {isEditing ? (
              <input
                ref={inputRef}
                value={editingName}
                onChange={(e) => onChangeEditingName(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onBlur={onCommitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    onCommitRename()
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    onCancelRename()
                  }
                }}
                className="h-7 min-w-0 flex-1 rounded border border-accent bg-bg-primary px-2 text-xs font-medium text-text-primary outline-none ring-1 ring-accent/30"
              />
            ) : (
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-xs font-medium text-text-primary"
                title={layer.name}
                aria-pressed={selected}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  onStartRename()
                }}
              >
                {layer.name}
              </button>
            )}

            {!isEditing && hasAnimation && (
              <Icon name="animation" size={12} className="flex-shrink-0 text-accent" />
            )}
            {!isEditing && primary && (
              <span className="flex-shrink-0 rounded bg-accent/15 px-1 py-0.5 text-[9px] text-accent" title="多选中的主图层">主</span>
            )}
          </div>

          <div className="mt-1 flex min-w-0 items-center gap-1 text-[10px] text-text-muted overflow-hidden whitespace-nowrap">
            <span className="rounded bg-bg-primary px-1.5 py-0.5 font-mono uppercase">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className="uppercase">{layer.type}</span>
            <span title="输出时间范围（从第 1 帧开始）">{timeRange.startFrame + 1}–{timeRange.endFrame}</span>
            {getLayerTimeOffset(layer) !== 0 && <span className="text-accent" title="相对源动画的时间偏移">{getLayerTimeOffset(layer) > 0 ? '+' : ''}{getLayerTimeOffset(layer)}F</span>}
            {renamed && <span className="truncate text-accent">已改名</span>}
            {!layer.visible && <span>隐藏</span>}
            {layer.locked && <span className="text-warning">锁定</span>}
          </div>
        </div>

        <div className="flex w-[72px] flex-shrink-0 items-center justify-end">
          <IconButton
            title={layer.visible ? '隐藏' : '显示'}
            active={layer.visible}
            onClick={onToggleVisibility}
          >
            <Icon
              name={layer.visible ? 'eye-open' : 'eye-closed'}
              size={14}
              className={layer.visible ? 'text-text-secondary' : 'text-text-muted'}
            />
          </IconButton>
          <IconButton
            title={layer.locked ? '解锁' : '锁定'}
            active={layer.locked}
            onClick={onToggleLock}
          >
            <Icon
              name={layer.locked ? 'lock' : 'unlock'}
              size={14}
              className={layer.locked ? 'text-warning' : 'text-text-muted'}
            />
          </IconButton>
          <IconButton title="更多操作" active={showActionMenu} onClick={onShowActionMenu}>
            <Icon name="more-vertical" size={14} className="text-text-muted" />
          </IconButton>
        </div>
      </div>

      {showActionMenu && (
        <div
          className="absolute right-2 top-[58px] z-30 w-36 rounded border border-border bg-bg-secondary py-1 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <MenuActionButton
            icon="edit"
            label="重命名"
            onClick={() => {
              onCloseActionMenu()
              onStartRename()
            }}
          />
          <MenuActionButton
            icon="sparkles"
            label="添加动画"
            onClick={() => {
              onCloseActionMenu()
              onShowAnimationMenu()
            }}
          />
          <MenuActionButton
            icon="copy"
            label="复制图层"
            disabled={!!duplicateError}
            title={duplicateError || '复制原逐帧动画与编辑关键帧'}
            onClick={() => {
              onCloseActionMenu()
              onDuplicate()
            }}
          />
          <div className="my-1 border-t border-border/70" />
          <MenuActionButton
            icon="trash"
            label="删除图层"
            danger
            onClick={() => {
              onCloseActionMenu()
              onDelete()
            }}
          />
        </div>
      )}

      {showAnimationMenu && (
        <div className="absolute left-2 right-2 top-[calc(100%-2px)] z-20 rounded border border-border bg-bg-secondary p-2 shadow-xl">
          <div className="mb-2 flex items-center justify-between px-1 text-xs">
            <span className="text-text-secondary">动画预设</span>
            <button
              type="button"
              className="grid h-6 w-6 place-items-center rounded text-text-muted hover:bg-white/10 hover:text-text-primary"
              onClick={(e) => {
                e.stopPropagation()
                onCloseAnimationMenu()
              }}
              title="关闭"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1">
            {ANIMATION_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="flex min-w-0 items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-text-secondary hover:bg-accent/15 hover:text-text-primary"
                onClick={(e) => {
                  e.stopPropagation()
                  onApplyAnimation(preset)
                }}
              >
                <Icon
                  name={
                    preset.category === 'entrance'
                      ? 'login'
                      : preset.category === 'exit'
                        ? 'logout'
                        : preset.category === 'emphasis'
                          ? 'star'
                          : 'animation'
                  }
                  size={12}
                  className="flex-shrink-0 text-accent"
                />
                <span className="truncate">{preset.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

interface IconButtonProps {
  title: string
  children: React.ReactNode
  active?: boolean
  danger?: boolean
  onClick: () => void
}

interface MenuActionButtonProps {
  icon: string
  label: string
  danger?: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
}

const MenuActionButton: React.FC<MenuActionButtonProps> = ({
  icon,
  label,
  danger = false,
  disabled = false,
  title,
  onClick
}) => {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      className={cn(
        'flex h-8 w-full items-center gap-2 px-3 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        danger
          ? 'text-error hover:bg-error/15'
          : 'text-text-secondary hover:bg-accent/15 hover:text-text-primary'
      )}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      <Icon name={icon} size={14} className="flex-shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  )
}

const IconButton: React.FC<IconButtonProps> = ({
  title,
  children,
  active = false,
  danger = false,
  onClick
}) => {
  return (
    <button
      type="button"
      title={title}
      className={cn(
        'grid h-7 w-6 place-items-center rounded transition-colors',
        active ? 'bg-white/5' : 'hover:bg-white/10',
        danger ? 'hover:bg-error/15' : 'hover:text-text-primary'
      )}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}
