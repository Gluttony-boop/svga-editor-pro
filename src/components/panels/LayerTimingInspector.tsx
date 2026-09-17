import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@/components/ui'
import { OperationStatus, type OperationStatusValue } from '@/components/ui/OperationStatus'
import { useEditorStore } from '@/stores'
import { getSelectedLayerIds } from '@/utils/layer-selection'
import { planLayerTiming, type TimingRequest } from '@/core/timing-plan'
import { getLayerOutputRange, getLayerTimeOffset } from '@/core/layer-time'

type TimingAction = 'earlier' | 'later' | 'stagger' | 'reset'
const LABELS: Record<TimingAction, string> = { earlier: '提前', later: '延后', stagger: '依次错开', reset: '重置时间偏移' }

export function LayerTimingInspector() {
  const layers = useEditorStore(state => state.layers)
  const primary = useEditorStore(state => state.selectedLayerId)
  const selection = useEditorStore(state => state.selectedLayerIds)
  const video = useEditorStore(state => state.videoItem)
  const totalFrames = useEditorStore(state => state.playback.totalFrames)
  const fps = useEditorStore(state => state.playback.fps)
  const [framesText, setFramesText] = useState('6')
  const [extend, setExtend] = useState(true)
  const [status, setStatus] = useState<OperationStatusValue | null>(null)
  const ids = useMemo(() => getSelectedLayerIds({ layers, selectedLayerId: primary, selectedLayerIds: selection }), [layers, primary, selection])
  const selected = useMemo(() => layers.filter(layer => ids.includes(layer.id)), [layers, ids])
  const selectionKey = ids.join('\u0000')
  useEffect(() => { setStatus(null) }, [selectionKey, video, framesText, extend])
  const frames = framesText.trim() === '' ? NaN : Number(framesText)
  const validFrames = Number.isSafeInteger(frames) && frames >= 0 && frames <= 10000
  const request = (action: TimingAction): TimingRequest => ({
    mode: action === 'earlier' || action === 'later' ? 'shift' : action,
    frames: action === 'reset' ? 0 : validFrames ? (action === 'earlier' ? -frames : frames) : NaN,
    extendDuration: extend
  })
  const plans = Object.fromEntries((Object.keys(LABELS) as TimingAction[]).map(action => [action, planLayerTiming(layers, ids, video, totalFrames, request(action))])) as Record<TimingAction, ReturnType<typeof planLayerTiming>>
  const baseError = 'error' in plans.reset ? plans.reset.error : null

  const apply = (action: TimingAction) => {
    const before = useEditorStore.getState().playback.totalFrames
    const result = useEditorStore.getState().arrangeLayerTiming(request(action))
    if ('error' in result) { setStatus({ kind: 'error', message: result.error }); return }
    setStatus({ kind: result.changed ? 'success' : 'ready', message: result.changed
      ? `已${LABELS[action]}，可一次撤销。${result.totalFrames > before ? `总帧数已延长至 ${result.totalFrames}。` : ''}`
      : '时间位置没有变化，本次未修改文件。' })
  }
  const button = (action: TimingAction) => {
    const plan = plans[action]
    return <button key={action} type="button" aria-label={LABELS[action]} disabled={'error' in plan} title={'error' in plan ? plan.error : `${LABELS[action]}所选图片图层，不改变播放速度`} onClick={() => apply(action)}
      className="min-h-8 rounded border border-border bg-bg-tertiary px-1 py-1 text-[11px] text-text-primary hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-35">{LABELS[action]}</button>
  }
  return <section aria-label="图层时间编排" className="space-y-2.5 rounded border border-border p-3">
    <div className="flex items-center gap-1.5 text-xs font-medium text-text-primary"><Icon name="timeline" size={13} />时间编排<span className="ml-auto text-[10px] font-normal text-text-muted">{selected.length} 层 · {fps} FPS</span></div>
    <label className="flex items-center gap-2 text-[11px] text-text-secondary">
      <span className="shrink-0">位移 / 间隔</span>
      <input aria-label="时间位移帧数" type="number" min={0} max={10000} step={1} value={framesText} onChange={event => setFramesText(event.target.value)} className="h-8 min-w-0 flex-1 rounded border border-border bg-bg-tertiary px-2 font-mono text-xs text-text-primary" />
      <span>帧</span>
    </label>
    <p className="text-[10px] text-text-muted">{validFrames && fps > 0 ? `约 ${(frames / fps).toFixed(3)} 秒` : '请输入 0–10000 的整数帧数。'}</p>
    <label className="flex items-center gap-1.5 text-[11px] text-text-secondary"><input type="checkbox" checked={extend} onChange={event => setExtend(event.target.checked)} className="accent-accent" />延长总帧数以保留尾部</label>
    <div role="group" aria-label="时间编排操作" className="grid grid-cols-2 gap-1.5">{(['earlier', 'later', 'stagger', 'reset'] as const).map(button)}</div>
    {baseError && <p className="text-[10px] leading-relaxed text-warning">{baseError}</p>}
    <div className="space-y-1 text-[10px] text-text-muted" aria-label="图层输出时间范围">
      {selected.slice(0, 4).map(layer => {
        const range = getLayerOutputRange(layer)
        const offset = getLayerTimeOffset(layer)
        return <div key={layer.id} className="flex gap-2"><span className="min-w-0 flex-1 truncate" title={layer.name}>{layer.name}</span><span className="shrink-0 font-mono">{range.startFrame + 1}–{range.endFrame} F · {offset > 0 ? '+' : ''}{offset} F</span></div>
      })}
      {selected.length > 4 && <p>另有 {selected.length - 4} 层，可在时间轴查看。</p>}
    </div>
    <p className="text-[10px] leading-relaxed text-text-muted">错峰按图层列表顺序，以首层区间起点为基准；整体平移源动画和关键帧，不改变速度。范围含原始空白帧，音频不会跟随。重置偏移不自动缩短总帧数。</p>
    <OperationStatus status={status} />
  </section>
}
