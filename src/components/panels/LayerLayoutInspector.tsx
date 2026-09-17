import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@/components/ui'
import { OperationStatus, type OperationStatusValue } from '@/components/ui/OperationStatus'
import { useEditorStore } from '@/stores'
import { planLayerLayout, type LayoutOperation } from '@/core/layer-layout'
import { getSelectedLayerIds } from '@/utils/layer-selection'
import { LAYOUT_LABELS } from '@/utils/layout-labels'

const ALIGN_OPERATIONS: LayoutOperation[] = ['align-left', 'align-center-x', 'align-right', 'align-top', 'align-center-y', 'align-bottom']
const DISTRIBUTE_OPERATIONS: LayoutOperation[] = ['distribute-x', 'distribute-y']

/** 排版直接复用画布变换，不维护第二套位置状态或破坏原动画。 */
export function LayerLayoutInspector() {
  const layers = useEditorStore(state => state.layers)
  const selectedLayerId = useEditorStore(state => state.selectedLayerId)
  const selectedLayerIds = useEditorStore(state => state.selectedLayerIds)
  const video = useEditorStore(state => state.videoItem)
  const resources = useEditorStore(state => state.imageResources)
  const frame = useEditorStore(state => state.playback.currentFrame)
  const ids = useMemo(() => getSelectedLayerIds({ layers, selectedLayerId, selectedLayerIds }), [layers, selectedLayerId, selectedLayerIds])
  const selected = useMemo(() => layers.filter(layer => ids.includes(layer.id)), [layers, ids])
  const [reference, setReference] = useState<'selection' | 'canvas'>(() => selected.length > 1 ? 'selection' : 'canvas')
  const [status, setStatus] = useState<OperationStatusValue | null>(null)
  const feedbackFrame = useRef(frame)
  const selectionSignature = ids.join('\u0000')
  useEffect(() => { setStatus(null) }, [selectionSignature, reference, video])
  useEffect(() => { if (feedbackFrame.current !== frame) setStatus(null) }, [frame])

  const plans = useMemo(() => Object.fromEntries([...ALIGN_OPERATIONS, ...DISTRIBUTE_OPERATIONS].map(operation => [
    operation, planLayerLayout(selected, frame, video, resources, operation, reference)
  ])) as Record<LayoutOperation, ReturnType<typeof planLayerLayout>>, [selected, frame, video, resources, reference])
  const alignmentError = 'error' in plans['align-left'] ? plans['align-left'].error : null

  const execute = (operation: LayoutOperation) => {
    const result = useEditorStore.getState().arrangeLayers(operation, reference)
    feedbackFrame.current = useEditorStore.getState().playback.currentFrame
    if ('error' in result) { setStatus({ kind: 'error', message: result.error }); return }
    setStatus({
      kind: result.warning ? 'warning' : result.changed ? 'success' : 'ready',
      message: result.changed
        ? `已${LAYOUT_LABELS[operation]}，可一次撤销。${result.warning || ''}`
        : `已满足${LAYOUT_LABELS[operation]}，未修改文件。${result.warning || ''}`
    })
  }

  const operationButton = (operation: LayoutOperation) => {
    const plan = plans[operation]
    const reason = 'error' in plan ? plan.error : plan.warning
    return <button key={operation} type="button" disabled={'error' in plan} aria-label={LAYOUT_LABELS[operation]} title={reason || `${LAYOUT_LABELS[operation]}到${reference === 'canvas' ? '画布边界' : '当前选区边界'}`} onClick={() => execute(operation)}
      className="min-h-8 rounded border border-border bg-bg-tertiary px-1.5 py-1 text-[11px] text-text-primary hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-35">
      {LAYOUT_LABELS[operation]}
    </button>
  }

  return <section aria-label="对齐与分布" className="space-y-2.5 rounded border border-border p-3">
    <div className="flex items-center gap-1.5 text-xs font-medium text-text-primary"><Icon name="settings" size={13} />对齐与分布<span className="ml-auto text-[10px] font-normal text-text-muted">{selected.length} 层 · 第 {frame + 1} 帧</span></div>
    <label className="flex items-center gap-2 text-[11px] text-text-secondary">
      <span className="shrink-0">参考范围</span>
      <select aria-label="对齐参考范围" value={reference} onChange={event => setReference(event.target.value as 'selection' | 'canvas')} className="h-8 min-w-0 flex-1 rounded border border-border bg-bg-tertiary px-2 text-xs text-text-primary">
        <option value="selection" disabled={selected.length < 2}>当前选区</option><option value="canvas">画布边界</option>
      </select>
    </label>
    <div role="group" aria-label="图层对齐" className="grid grid-cols-3 gap-1.5">{ALIGN_OPERATIONS.map(operationButton)}</div>
    <div role="group" aria-label="图层等间距分布" className="grid grid-cols-2 gap-1.5">{DISTRIBUTE_OPERATIONS.map(operationButton)}</div>
    {alignmentError && <p className="text-[10px] leading-relaxed text-warning">{alignmentError}</p>}
    {!alignmentError && selected.length < 3 && <p className="text-[10px] text-text-muted">等间距分布至少需要 3 个可编辑图层。</p>}
    <p className="text-[10px] leading-relaxed text-text-muted">按当前帧素材外接矩形排版，只移动位置，保留缩放、角度和原动画。等间距按边缘计算；空间不足时会提示重叠，不按透明像素轮廓判断。</p>
    <OperationStatus status={status} />
  </section>
}
