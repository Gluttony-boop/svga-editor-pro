import React, { useEffect, useRef, useState } from 'react'
import type { EasingType, Keyframe, Layer, LayerTracks } from '@/types'
import { TRACK_LABELS } from '@/core/keyframe-editing'
import { Icon } from '@/components/ui'

interface TimelineKeyframeInspectorProps {
  layer: Layer
  track: keyof LayerTracks
  keyframe: Keyframe
  outputFrame: number
  totalFrames: number
  disabled: boolean
  onMove: (frame: number) => void
  onEasing: (easing: EasingType) => void
  onDelete: () => void
}

export const TimelineKeyframeInspector: React.FC<TimelineKeyframeInspectorProps> = ({
  layer, track, keyframe, outputFrame, totalFrames, disabled, onMove, onEasing, onDelete
}) => {
  const [frameValue, setFrameValue] = useState(String(outputFrame + 1))
  const cancelRef = useRef(false)
  useEffect(() => { setFrameValue(String(outputFrame + 1)) }, [outputFrame, keyframe.id, layer.id, track])

  const commit = () => {
    if (cancelRef.current || disabled) { cancelRef.current = false; return }
    const frame = frameValue.trim() ? Number(frameValue) - 1 : NaN
    if (frame !== outputFrame) onMove(frame)
    // 无效输入恢复到真实位置；错误说明由时间轴统一展示。
    setFrameValue(String(outputFrame + 1))
  }

  return (
    <div data-testid="timeline-keyframe-inspector" className="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-accent/5 px-3 py-1 text-[11px]">
      <span className="max-w-[210px] truncate text-accent" title={`${layer.name} · ${TRACK_LABELS[track]}`}>◆ {layer.name} · {TRACK_LABELS[track]}</span>
      <label className="flex items-center gap-1 text-text-muted">关键帧位置
        <input type="number" min={1} max={totalFrames} step={1} aria-label="所选关键帧位置" disabled={disabled} value={frameValue}
          onChange={event => setFrameValue(event.target.value)} onBlur={commit}
          onKeyDown={event => {
            event.stopPropagation()
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
            if (event.key === 'Escape') { cancelRef.current = true; setFrameValue(String(outputFrame + 1)); event.currentTarget.blur() }
          }} className="w-16 rounded border border-border bg-bg-primary px-1 py-0.5 text-text-primary disabled:opacity-50" />
      </label>
      <label className="flex items-center gap-1 text-text-muted">出段缓动
        <select aria-label="所选关键帧缓动" disabled={disabled} value={keyframe.easing} onChange={event => onEasing(event.target.value as EasingType)}
          className="rounded border border-border bg-bg-primary px-1 py-0.5 text-text-primary disabled:opacity-50">
          <option value="linear">线性</option>
          <option value="easeIn">缓入</option>
          <option value="easeOut">缓出</option>
          <option value="easeInOut">缓入缓出（F9）</option>
          <option value="hold">保持</option>
          {keyframe.easing === 'bezier' && <option value="bezier">贝塞尔（保留原曲线）</option>}
        </select>
      </label>
      <button type="button" disabled={disabled} aria-label="删除所选关键帧" title="删除关键帧（Delete），可撤销" onClick={onDelete}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-text-muted hover:bg-error/10 hover:text-error disabled:opacity-40"><Icon name="trash" size={12} />删除</button>
      {disabled && <span className="text-text-muted">锁定或隐藏图层只读</span>}
    </div>
  )
}
