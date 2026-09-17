import React from 'react'
import { Icon } from '@/components/ui'
import { getLayerGeometry, hasCanvasTransform, normalizeCanvasTransform } from '@/core/layer-transform'
import { useEditorStore } from '@/stores'
import type { CanvasTransform, Layer } from '@/types'

interface CommitNumberFieldProps {
  label: string
  accessibleLabel: string
  value: number
  unit: string
  disabled?: boolean
  min?: number
  max?: number
  context: unknown
  onStart: () => void
  onCommit: (value: number) => void
}

const formatNumber = (value: number) => String(Math.round(value * 100) / 100)

/** 输入期间保留草稿；失焦或回车只提交一次，Escape 放弃本次输入。 */
function CommitNumberField({ label, accessibleLabel, value, unit, disabled, min, max, context, onStart, onCommit }: CommitNumberFieldProps) {
  const [draft, setDraft] = React.useState(() => formatNumber(value))
  const editing = React.useRef(false)
  const changed = React.useRef(false)
  const source = React.useRef(context)

  React.useEffect(() => {
    if (source.current !== context) {
      editing.current = false
      source.current = context
    }
    if (!editing.current) setDraft(formatNumber(value))
  }, [value, context])

  return (
    <label className="block min-w-0">
      <span className="mb-1 flex items-center justify-between text-[11px] text-text-secondary">
        <span>{label}</span><span className="text-text-muted">{unit}</span>
      </span>
      <input
        type="number"
        aria-label={accessibleLabel}
        title="回车或失焦应用，Esc 取消"
        value={draft}
        min={min}
        max={max}
        step={0.1}
        disabled={disabled}
        className="w-full rounded border border-border bg-bg-tertiary px-2 py-1.5 text-xs font-mono text-text-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
        onFocus={() => {
          editing.current = true
          changed.current = false
          source.current = context
          onStart()
        }}
        onChange={event => {
          changed.current = true
          setDraft(event.target.value)
        }}
        onBlur={() => {
          if (!editing.current || source.current !== context) return
          editing.current = false
          if (disabled || !changed.current) {
            setDraft(formatNumber(value))
            return
          }
          const number = draft.trim() === '' ? NaN : Number(draft)
          if (!Number.isFinite(number)) {
            setDraft(formatNumber(value))
            return
          }
          const next = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, number))
          setDraft(formatNumber(next))
          if (next !== value) onCommit(next)
        }}
        onKeyDown={event => {
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            editing.current = false
            setDraft(formatNumber(value))
            event.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}

export function CanvasTransformInspector({ layer }: { layer: Layer }) {
  const videoItem = useEditorStore(state => state.videoItem)
  const imageResources = useEditorStore(state => state.imageResources)
  const currentFrame = useEditorStore(state => state.playback.currentFrame)
  const setPlaying = useEditorStore(state => state.setPlaying)
  const linkedScale = useEditorStore(state => state.canvasKeepRatio)
  const setLinkedScale = useEditorStore(state => state.setCanvasKeepRatio)
  const transform = normalizeCanvasTransform(layer.canvasTransform)
  const geometry = getLayerGeometry(layer, currentFrame, videoItem, imageResources)
  const unsupported = layer.type !== 'image' && layer.type !== 'shape'
  const disabled = layer.locked || !layer.visible || unsupported
  const positionDisabled = disabled || !geometry

  const getEditableLayer = () => {
    const state = useEditorStore.getState()
    if (state.videoItem !== videoItem || state.selectedLayerId !== layer.id) return null
    const latest = state.layers.find(item => item.id === layer.id)
    return latest && latest.visible && !latest.locked ? latest : null
  }

  const commitTransform = (update: Partial<CanvasTransform>) => {
    if (!getEditableLayer()) return
    setPlaying(false)
    useEditorStore.getState().updateCanvasTransform(layer.id, update)
  }

  const commitPosition = (axis: 'x' | 'y', value: number) => {
    const latest = getEditableLayer()
    if (!latest) return
    const state = useEditorStore.getState()
    const currentGeometry = getLayerGeometry(latest, state.playback.currentFrame, state.videoItem, state.imageResources)
    if (currentGeometry) commitTransform({ [axis]: value - currentGeometry.center[axis] })
  }

  const commitScale = (axis: 'scaleX' | 'scaleY', percent: number) => {
    const latest = getEditableLayer()
    if (!latest) return
    const current = normalizeCanvasTransform(latest.canvasTransform)
    const other = axis === 'scaleX' ? 'scaleY' : 'scaleX'
    const update: Partial<CanvasTransform> = { [axis]: percent / 100 }
    if (linkedScale && current[axis] !== 0) update[other] = current[other] * (percent / 100) / current[axis]
    commitTransform(update)
  }

  const fieldDefaults = {
    disabled,
    context: videoItem,
    onStart: () => setPlaying(false)
  }

  return (
    <section aria-label="图层整段变换" className="space-y-3 border-y border-border py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
          <Icon name="settings" size={13} />
          整段变换
        </div>
        <button
          type="button"
          disabled={disabled || !hasCanvasTransform(layer.canvasTransform)}
          onClick={() => commitTransform(normalizeCanvasTransform())}
          title="仅重置画布位置、缩放和旋转，保留原始动画与替换素材"
          className="text-[11px] text-accent hover:underline disabled:text-text-muted disabled:opacity-40 disabled:no-underline"
        >重置变换</button>
      </div>

      <p className="rounded border border-accent/20 bg-accent/5 px-2 py-1.5 text-[10px] leading-relaxed text-text-secondary">
        保留原始运动，调整作用于整段动画。缩放和旋转围绕每帧中心，不创建关键帧。
      </p>

      {disabled && <p className="text-[11px] text-text-muted">{layer.locked ? '图层已锁定，解锁后可调整。' : !layer.visible ? '图层已隐藏，显示后可调整。' : '此类图层暂不支持画布变换。'}</p>}

      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2 text-[10px] text-text-muted">
          <span>中心位置 · 当前帧</span>
          <span className="font-mono">{currentFrame + 1} F</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <CommitNumberField {...fieldDefaults} label="X" accessibleLabel="图层位置 X" value={(geometry?.center.x ?? 0) + transform.x} unit="px" disabled={positionDisabled} onCommit={value => commitPosition('x', value)} />
          <CommitNumberField {...fieldDefaults} label="Y" accessibleLabel="图层位置 Y" value={(geometry?.center.y ?? 0) + transform.y} unit="px" disabled={positionDisabled} onCommit={value => commitPosition('y', value)} />
        </div>
        {!geometry && !disabled && <p className="mt-1 text-[10px] text-text-muted">当前帧无可见图像，切换到可见帧后调整位置。</p>}
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between text-[10px] text-text-muted">
          <span>相对原动画缩放</span>
          <label className="flex cursor-pointer items-center gap-1">
            <input type="checkbox" checked={linkedScale} disabled={disabled} onChange={event => setLinkedScale(event.target.checked)} className="accent-accent" />
            锁定比例
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <CommitNumberField {...fieldDefaults} label="缩放 X" accessibleLabel="图层缩放 X" value={transform.scaleX * 100} min={1} max={1000} unit="%" onCommit={value => commitScale('scaleX', value)} />
          <CommitNumberField {...fieldDefaults} label="缩放 Y" accessibleLabel="图层缩放 Y" value={transform.scaleY * 100} min={1} max={1000} unit="%" onCommit={value => commitScale('scaleY', value)} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <CommitNumberField {...fieldDefaults} label="附加旋转" accessibleLabel="图层旋转" value={transform.rotation * 180 / Math.PI} unit="°" onCommit={value => commitTransform({ rotation: value * Math.PI / 180 })} />
        <CommitNumberField {...fieldDefaults} label="不透明度" accessibleLabel="图层不透明度" value={layer.opacity * 100} min={0} max={100} unit="%" onCommit={value => {
          if (!getEditableLayer()) return
          useEditorStore.getState().updateLayer(layer.id, { opacity: value / 100 })
        }} />
      </div>
      <p className="text-[10px] leading-relaxed text-text-muted">输入时暂停在当前帧；回车 / 失焦应用，Esc 取消输入。画布调整与此面板实时同步。</p>
    </section>
  )
}
