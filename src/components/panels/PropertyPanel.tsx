import React from 'react'
import { Panel, NumberInput, Slider, Icon } from '@/components/ui'
import { useEditorStore, useCurrentParams } from '@/stores'
import { cn } from '@/utils/cn'
import type { LayerTracks } from '@/types'

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
  const compressionConfig = useEditorStore((s) => s.compressionConfig)
  const setCompressionConfig = useEditorStore((s) => s.setCompressionConfig)
  const videoItem = useEditorStore((s) => s.videoItem)
  const layers = useEditorStore((s) => s.layers)
  const selectedLayerId = useEditorStore((s) => s.selectedLayerId)
  const renameImageKey = useEditorStore((s) => s.renameImageKey)
  const updateLayerTrackDefaultValue = useEditorStore((s) => s.updateLayerTrackDefaultValue)
  const imageResources = useEditorStore((s) => s.imageResources)

  const selectedLayer = layers.find((l) => l.id === selectedLayerId)
  const [editingKey, setEditingKey] = React.useState(false)
  const [keyValue, setKeyValue] = React.useState('')
  const keyInputRef = React.useRef<HTMLInputElement>(null)

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
        {selectedLayer && selectedLayer.imageKey && (
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

        {/* 图层属性 */}
        {selectedLayer && (
          <div className="space-y-3">
            {/* 分隔线 */}
            <div className="border-t border-border" />

            {/* 位置 */}
            <div>
              <div className="text-[10px] text-text-muted uppercase tracking-wide mb-1.5">位置</div>
              <div className="grid grid-cols-2 gap-2">
                <NumberInput
                  label="X"
                  value={Math.round(selectedLayer.tracks.position.defaultValue.x)}
                  step={1}
                  unit="px"
                  onChange={(v) => {
                    updateLayerTrackDefaultValue(selectedLayer.id, 'position', {
                      ...selectedLayer.tracks.position.defaultValue,
                      x: v
                    })
                  }}
                />
                <NumberInput
                  label="Y"
                  value={Math.round(selectedLayer.tracks.position.defaultValue.y)}
                  step={1}
                  unit="px"
                  onChange={(v) => {
                    updateLayerTrackDefaultValue(selectedLayer.id, 'position', {
                      ...selectedLayer.tracks.position.defaultValue,
                      y: v
                    })
                  }}
                />
              </div>
            </div>

            {/* 尺寸 */}
            {(() => {
              const imgRes = selectedLayer.imageKey ? imageResources.get(selectedLayer.imageKey) : undefined
              const origW = imgRes?.width ?? 0
              const origH = imgRes?.height ?? 0
              const scaleX = selectedLayer.tracks.scale.defaultValue.scaleX
              const scaleY = selectedLayer.tracks.scale.defaultValue.scaleY
              const displayW = Math.round(origW * scaleX)
              const displayH = Math.round(origH * scaleY)
              const hasOrigSize = origW > 0 && origH > 0

              return (
                <div>
                  <div className="text-[10px] text-text-muted uppercase tracking-wide mb-1.5">尺寸</div>
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <NumberInput
                        label="宽度"
                        value={displayW}
                        disabled={!hasOrigSize}
                        step={1}
                        unit="px"
                        onChange={(v) => {
                          if (!hasOrigSize) return
                          const newScaleX = v / origW
                          updateLayerTrackDefaultValue(selectedLayer.id, 'scale', {
                            ...selectedLayer.tracks.scale.defaultValue,
                            scaleX: newScaleX
                          })
                        }}
                      />
                      <NumberInput
                        label="高度"
                        value={displayH}
                        disabled={!hasOrigSize}
                        step={1}
                        unit="px"
                        onChange={(v) => {
                          if (!hasOrigSize) return
                          const newScaleY = v / origH
                          updateLayerTrackDefaultValue(selectedLayer.id, 'scale', {
                            ...selectedLayer.tracks.scale.defaultValue,
                            scaleY: newScaleY
                          })
                        }}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <NumberInput
                        label="缩放 X"
                        value={Math.round(scaleX * 100)}
                        min={1}
                        max={500}
                        step={1}
                        unit="%"
                        onChange={(v) => {
                          updateLayerTrackDefaultValue(selectedLayer.id, 'scale', {
                            ...selectedLayer.tracks.scale.defaultValue,
                            scaleX: v / 100
                          })
                        }}
                      />
                      <NumberInput
                        label="缩放 Y"
                        value={Math.round(scaleY * 100)}
                        min={1}
                        max={500}
                        step={1}
                        unit="%"
                        onChange={(v) => {
                          updateLayerTrackDefaultValue(selectedLayer.id, 'scale', {
                            ...selectedLayer.tracks.scale.defaultValue,
                            scaleY: v / 100
                          })
                        }}
                      />
                    </div>
                  </div>
                </div>
              )
            })()}

            {/* 旋转 */}
            {(() => {
              const radToDeg = (rad: number) => ((rad * 180 / Math.PI) % 360 + 360) % 360
              const degToRad = (deg: number) => deg * Math.PI / 180
              const rotationDeg = Math.round(radToDeg(selectedLayer.tracks.rotation.defaultValue))

              return (
                <div>
                  <div className="text-[10px] text-text-muted uppercase tracking-wide mb-1.5">旋转</div>
                  <Slider
                    value={rotationDeg}
                    min={0}
                    max={360}
                    step={1}
                    unit="°"
                    onChange={(v) => {
                      updateLayerTrackDefaultValue(selectedLayer.id, 'rotation', degToRad(v))
                    }}
                  />
                </div>
              )
            })()}

            {/* 透明度 */}
            {(() => {
              const alpha = selectedLayer.tracks.alpha.defaultValue
              const alphaPct = Math.round(alpha * 100)

              return (
                <div>
                  <div className="text-[10px] text-text-muted uppercase tracking-wide mb-1.5">透明度</div>
                  <Slider
                    value={alphaPct}
                    min={0}
                    max={100}
                    step={1}
                    unit="%"
                    onChange={(v) => {
                      updateLayerTrackDefaultValue(selectedLayer.id, 'alpha', v / 100)
                    }}
                  />
                </div>
              )
            })()}
          </div>
        )}

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

        {/* 图片压缩 */}
        <div>
          <div className="text-[10px] text-text-muted uppercase tracking-wide mb-1.5">压缩</div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-primary">启用压缩</span>
              <button
                className={cn(
                  'w-9 h-5 rounded-full transition-colors relative flex-shrink-0',
                  compressionConfig.enabled ? 'bg-accent' : 'bg-border'
                )}
                onClick={() => setCompressionConfig({ enabled: !compressionConfig.enabled })}
              >
                <span
                  className={cn(
                    'absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform',
                    compressionConfig.enabled ? 'translate-x-4.5' : 'translate-x-0.5'
                  )}
                />
              </button>
            </div>

            {compressionConfig.enabled && (
              <>
                <select
                  value={compressionConfig.mode}
                  onChange={(e) => setCompressionConfig({ mode: e.target.value as any })}
                  className="w-full px-2 py-1.5 rounded bg-bg-tertiary border border-border text-text-primary text-xs"
                >
                  <option value="smart">智能压缩</option>
                  <option value="webp">WebP</option>
                  <option value="png256">PNG 256色</option>
                </select>

                <Slider
                  label="质量"
                  value={compressionConfig.quality}
                  min={10}
                  max={100}
                  unit="%"
                  onChange={(v) => setCompressionConfig({ quality: v })}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </Panel>
  )
}
