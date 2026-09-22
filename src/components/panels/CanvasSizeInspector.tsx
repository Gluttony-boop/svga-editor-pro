import React from 'react'
import { Icon } from '@/components/ui'
import { CommitNumberField } from '@/components/ui/CommitNumberField'
import { getCanvasSizeError, MAX_CANVAS_DIMENSION } from '@/core/canvas-size'
import { useEditorStore } from '@/stores'

const round = (value: number) => Math.max(1, Math.round(value))

/** 画布尺寸只改 viewBox，不偷偷缩放图层；这样坐标和动画语义与 AE 的合成尺寸一致。 */
export function CanvasSizeInspector() {
  const params = useEditorStore(state => state.params)
  const setPlaying = useEditorStore(state => state.setPlaying)
  const setCanvasSize = useEditorStore(state => state.setCanvasSize)
  const [lockAspect, setLockAspect] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const context = React.useMemo(() => params, [params])

  if (!params) return null

  const commit = (axis: 'width' | 'height', value: number) => {
    const current = useEditorStore.getState().params
    if (!current) return
    const ratio = current.viewBoxWidth / current.viewBoxHeight
    const size = axis === 'width'
      ? { width: round(value), height: lockAspect ? round(value / ratio) : current.viewBoxHeight }
      : { width: lockAspect ? round(value * ratio) : current.viewBoxWidth, height: round(value) }
    const validation = getCanvasSizeError(size)
    if (validation) {
      setError(validation)
      return
    }
    const result = setCanvasSize(size.width, size.height)
    setError(result.error ?? null)
  }

  const fieldDefaults = {
    context,
    min: 1,
    max: MAX_CANVAS_DIMENSION,
    onStart: () => { setError(null); setPlaying(false) }
  }

  return (
    <section aria-label="画布尺寸" className="space-y-2 rounded border border-border bg-bg-secondary/60 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
          <Icon name="fit" size={13} />
          画布尺寸
        </div>
        <label className="flex cursor-pointer items-center gap-1 text-[10px] text-text-muted" title="修改一边时按当前比例计算另一边">
          <input type="checkbox" checked={lockAspect} onChange={event => setLockAspect(event.target.checked)} className="accent-accent" />
          锁定比例
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <CommitNumberField {...fieldDefaults} label="宽度" accessibleLabel="画布宽度" value={params.viewBoxWidth} unit="px" onCommit={value => commit('width', value)} />
        <CommitNumberField {...fieldDefaults} label="高度" accessibleLabel="画布高度" value={params.viewBoxHeight} unit="px" onCommit={value => commit('height', value)} />
      </div>
      {error && <p role="status" className="text-[11px] leading-relaxed text-error">{error}</p>}
      <p className="text-[10px] leading-relaxed text-text-muted">改变 viewBox，不自动缩放图层；超出新边界的内容会在预览和导出中被裁切。输入按 Enter / 失焦应用，Esc 取消。</p>
    </section>
  )
}
