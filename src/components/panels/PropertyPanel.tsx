import React from 'react'
import { Panel, NumberInput, Icon } from '@/components/ui'
import { useEditorStore, useCurrentParams } from '@/stores'
import { CanvasTransformInspector } from './CanvasTransformInspector'
import { MultiSelectionInspector } from './MultiSelectionInspector'
import { getSelectedLayerIds } from '@/utils/layer-selection'
import { LayerLayoutInspector } from './LayerLayoutInspector'
import { LayerTimingInspector } from './LayerTimingInspector'
import { AnimationKeyframeInspector } from './AnimationKeyframeInspector'

interface PropertyPanelProps {
  className?: string
  collapsible?: boolean
  defaultCollapsed?: boolean
}

export const PropertyPanel: React.FC<PropertyPanelProps> = ({ className, collapsible = true, defaultCollapsed = false }) => {
  const params = useCurrentParams()
  const customFps = useEditorStore((s) => s.customFps)
  const customFrames = useEditorStore((s) => s.customFrames)
  const setCustomFps = useEditorStore((s) => s.setCustomFps)
  const setCustomFrames = useEditorStore((s) => s.setCustomFrames)
  const videoItem = useEditorStore((s) => s.videoItem)
  const layers = useEditorStore((s) => s.layers)
  const selectedLayerId = useEditorStore((s) => s.selectedLayerId)
  const selectedLayerIds = useEditorStore((s) => s.selectedLayerIds)
  const selectLayer = useEditorStore((s) => s.selectLayer)
  const renameImageKey = useEditorStore((s) => s.renameImageKey)
  const editMode = useEditorStore(s => s.transformEditMode)
  const setEditMode = useEditorStore(s => s.setTransformEditMode)

  const selectedLayer = layers.find((l) => l.id === selectedLayerId)
  const selection = React.useMemo(
    () => getSelectedLayerIds({ layers, selectedLayerId, selectedLayerIds }),
    [layers, selectedLayerId, selectedLayerIds]
  )
  const isMultiSelection = selection.length > 1
  const selectedLayers = React.useMemo(() => {
    const ids = new Set(selection)
    return layers.filter(layer => ids.has(layer.id))
  }, [layers, selection])
  const [editingKey, setEditingKey] = React.useState(false)
  const [keyValue, setKeyValue] = React.useState('')
  const keyInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    // 切换选区时丢弃未提交的 Key 草稿，避免将旧输入应用到新的主图层。
    setEditingKey(false)
    setKeyValue('')
  }, [selectedLayerId, isMultiSelection])

  React.useEffect(() => {
    if (editingKey && keyInputRef.current) {
      keyInputRef.current.focus()
      keyInputRef.current.select()
    }
  }, [editingKey])

  const handleStartEditKey = () => {
    if (selectedLayer?.imageKey) {
      setKeyValue(selectedLayer.imageKey)
      setEditingKey(true)
    }
  }

  const handleCommitEditKey = () => {
    const trimmed = keyValue.trim()
    if (trimmed && selectedLayer && trimmed !== selectedLayer.imageKey) {
      renameImageKey(selectedLayer.id, trimmed)
    }
    setEditingKey(false)
    setKeyValue('')
  }

  const handleCancelEditKey = () => {
    setEditingKey(false)
    setKeyValue('')
  }

  if (!videoItem) {
    return (
      <Panel 
        title="属性" 
        icon={<Icon name="settings" size={16} />} 
        className={className}
        collapsible={collapsible}
        defaultCollapsed={defaultCollapsed}
      >
        <div className="text-center py-4 text-text-muted text-xs">
          <Icon name="settings" size={24} className="mx-auto mb-1 opacity-50" />
          <p>打开 SVGA 文件</p>
        </div>
      </Panel>
    )
  }

  const duration = params ? (params.frames / params.fps).toFixed(2) : '0'

  return (
    <Panel 
      title="属性" 
      icon={<Icon name="settings" size={16} />} 
      className={className}
      collapsible={collapsible}
      defaultCollapsed={defaultCollapsed}
      contentClassName="p-3"
    >
      <div className="space-y-3">
        {/* 图层 Key */}
        {!isMultiSelection && selectedLayer && selectedLayer.imageKey && (
          <div>
            <div className="text-[10px] text-text-muted uppercase tracking-wide mb-1.5">图层 Key</div>
            {editingKey ? (
              <input
                ref={keyInputRef}
                value={keyValue}
                onChange={(e) => setKeyValue(e.target.value)}
                onBlur={handleCommitEditKey}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleCommitEditKey()
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    handleCancelEditKey()
                  }
                }}
                className="w-full px-2 py-1.5 rounded bg-bg-tertiary border border-accent text-text-primary text-xs font-mono outline-none ring-1 ring-accent/30"
                placeholder="输入新的 Key 名称"
              />
            ) : (
              <button
                type="button"
                className="w-full px-2 py-1.5 rounded bg-bg-tertiary border border-border text-text-primary text-xs font-mono text-left hover:border-accent/50 transition-colors flex items-center justify-between group"
                onClick={handleStartEditKey}
                title="点击修改 Key"
              >
                <span className="truncate">{selectedLayer.imageKey}</span>
                <Icon name="edit" size={12} className="flex-shrink-0 text-text-muted group-hover:text-accent" />
              </button>
            )}
          </div>
        )}

        {selectedLayer && <div role="group" aria-label="变换编辑模式" className="grid grid-cols-2 gap-1 rounded border border-border bg-bg-primary p-1">
          {([['whole', '整段调整'], ['keyframe', '◆ 关键帧']] as const).map(([mode, label]) => <button key={mode} type="button" aria-pressed={editMode === mode} onClick={() => setEditMode(mode)}
            className={`rounded px-2 py-1.5 text-xs ${editMode === mode ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text-primary'}`}>{label}</button>)}
        </div>}

        {isMultiSelection ? (
          <MultiSelectionInspector
            layers={selectedLayers}
            primaryLayer={selectedLayer}
            onKeepPrimary={() => selectedLayer && selectLayer(selectedLayer.id)}
          />
        ) : selectedLayer && (editMode === 'keyframe'
          ? <AnimationKeyframeInspector key={selectedLayer.id} layer={selectedLayer} />
          : <CanvasTransformInspector key={selectedLayer.id} layer={selectedLayer} />)}
        {isMultiSelection && editMode === 'keyframe' && <p className="text-xs text-amber-300">时间轴可为所选图层批量插入关键帧。画布关键帧手势请仅选择一层，整组操作请切回整段调整。</p>}

        {selectedLayers.length > 0 && <>
          <LayerTimingInspector />
          <LayerLayoutInspector key={isMultiSelection ? 'multiple-layout' : 'single-layout'} />
        </>}

        {/* 尺寸信息 */}
        <div>
          <div className="text-[10px] text-text-muted uppercase tracking-wide mb-1.5">尺寸</div>
          <div className="grid grid-cols-2 gap-2">
            <NumberInput
              label="宽度"
              value={params?.viewBoxWidth || 0}
              disabled
              unit="px"
            />
            <NumberInput
              label="高度"
              value={params?.viewBoxHeight || 0}
              disabled
              unit="px"
            />
          </div>
        </div>

        {/* 时间设置 */}
        <div>
          <div className="text-[10px] text-text-muted uppercase tracking-wide mb-1.5">时间</div>
          <div className="space-y-2">
            <NumberInput
              label="帧率 (FPS)"
              value={customFps ?? params?.fps ?? 24}
              min={1}
              max={60}
              onChange={setCustomFps}
            />
            <NumberInput
              label="总帧数"
              value={customFrames ?? params?.frames ?? 0}
              min={1}
              onChange={setCustomFrames}
            />
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-muted">时长</span>
              <span className="text-text-primary font-mono">{duration}s</span>
            </div>
          </div>
        </div>

        <p className="text-xs text-text-muted">压缩配置在检查器的「导出」标签中，可选择保真、PNG 量化或 WebP。</p>
      </div>
    </Panel>
  )
}
