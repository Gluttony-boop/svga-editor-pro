import React from 'react'
import { Icon } from '@/components/ui'
import { cn } from '@/utils/cn'
import type { Keyframe, Layer, LayerTracks } from '@/types'
import { TRACK_LABELS, getKeyframeEditError } from '@/core/keyframe-editing'
import { getLayerTimeOffset, getLayerOutputRange } from '@/core/layer-time'
import { TIMELINE_GUTTER as GUTTER, clipRange } from '@/utils/timeline'
import { adjacentKeyframe } from '@/utils/timeline-keyframes'
import type { TimelineKeySelection } from '@/utils/timeline-keyframes'

interface CommonTrackProps {
  layer: Layer
  top: number
  rowHeight: number
  frameWidth: number
  totalFrames: number
  selected: boolean
  start: number
  end: number
}

interface TimelineLayerTrackProps extends CommonTrackProps {
  expanded: boolean
  onExpand: (id: string, expanded: boolean) => void
  onSelect: (id: string, additive?: boolean, range?: boolean) => void
}

export const TimelineLayerTrack = React.memo(({
  layer, top, rowHeight, frameWidth, totalFrames, selected, start, end, expanded, onExpand, onSelect
}: TimelineLayerTrackProps) => {
  const range = clipRange(getLayerOutputRange(layer).startFrame, layer.clip.duration, totalFrames)
  const timeOffset = getLayerTimeOffset(layer)
  const frames = React.useMemo(() => {
    const keys = [...Object.values(layer.tracks), ...Object.values(layer.animationTracks ?? {})]
      .flatMap(track => track.keyframes.map((key: Keyframe) => key.frameIndex + timeOffset))
    return Array.from(new Set<number>(keys)).sort((a, b) => a - b)
  }, [layer.tracks, layer.animationTracks, timeOffset])
  const markers: number[] = []
  let lastX = -Infinity
  for (const frame of frames) {
    if (frame < start || frame > end || frame < 0 || frame >= totalFrames) continue
    const x = frame * frameWidth
    if (x - lastX >= 8) { markers.push(frame); lastX = x }
  }

  return (
    <div data-track-layer={layer.id} className={cn('absolute left-0 right-0 border-b border-border/50', selected && 'bg-accent/5')} style={{ top, height: rowHeight }}>
      {range.end > range.start && (
        <div title={`第 ${range.start + 1}–${range.end} 帧`} className={cn('absolute h-3.5 rounded border', selected ? 'border-accent/60 bg-accent/25' : 'border-border-light bg-slate-500/20', !layer.visible && 'opacity-40')}
          style={{ top: (rowHeight - 14) / 2, left: GUTTER + range.start * frameWidth, width: Math.max(1, (range.end - range.start) * frameWidth) }} />
      )}
      {markers.map(frame => <span key={frame} title={`第 ${frame + 1} 帧 · 动画摘要；展开图层可编辑调整关键帧`} className="absolute h-1.5 w-1.5 rotate-45 bg-accent/70 pointer-events-none" style={{ top: (rowHeight - 6) / 2, left: GUTTER + frame * frameWidth - 3 }} />)}
      <div data-layer-label className={cn('sticky left-0 z-20 flex h-full items-center border-r border-border px-1', selected ? 'bg-bg-tertiary text-accent' : 'bg-bg-secondary text-text-secondary')} style={{ width: GUTTER }}>
        <button type="button" disabled={layer.type !== 'image'} aria-label={`${expanded ? '收起' : '展开'} ${layer.name} 的动画属性`} aria-expanded={expanded}
          onClick={() => onExpand(layer.id, !expanded)} title="展开位置、缩放、旋转和透明度调整轨道" className="flex h-full w-5 flex-shrink-0 items-center justify-center disabled:opacity-20 hover:text-accent">
          <Icon name="chevron-down" size={14} className={cn('transition-transform', !expanded && '-rotate-90')} />
        </button>
        <button type="button" aria-label={`选择时间轴图层：${layer.name}`} aria-pressed={selected} title={layer.name}
          onClick={event => onSelect(layer.id, event.ctrlKey || event.metaKey, event.shiftKey)} className="flex h-full min-w-0 flex-1 items-center gap-1 text-left text-xs hover:text-accent">
          <Icon name={layer.locked ? 'lock' : !layer.visible ? 'eye-closed' : 'layer'} size={11} />
          <span className="truncate">{layer.name}</span>
        </button>
      </div>
    </div>
  )
})
TimelineLayerTrack.displayName = 'TimelineLayerTrack'

interface TimelinePropertyTrackProps extends CommonTrackProps {
  track: keyof LayerTracks
  currentFrame: number
  selection: readonly TimelineKeySelection[]
  onInsert: (layerId: string, track: keyof LayerTracks) => void
  onKeySelect: (selection: TimelineKeySelection, additive?: boolean, range?: boolean) => void
  onKeyPointerDown: (event: React.PointerEvent<HTMLButtonElement>, selection: TimelineKeySelection) => void
}

export const TimelinePropertyTrack = React.memo(({
  layer, track, top, rowHeight, frameWidth, totalFrames, selected, start, end, currentFrame,
  selection, onInsert, onKeySelect, onKeyPointerDown
}: TimelinePropertyTrackProps) => {
  const keys = layer.animationTracks?.[track].keyframes ?? []
  const offset = getLayerTimeOffset(layer)
  const range = clipRange(getLayerOutputRange(layer).startFrame, layer.clip.duration, totalFrames)
  const before = adjacentKeyframe(layer, track, currentFrame, -1)
  const after = adjacentKeyframe(layer, track, currentFrame, 1)
  const currentKey = keys.find(key => key.frameIndex + offset === currentFrame)
  const editError = getKeyframeEditError(layer, currentFrame, totalFrames)
  const keyRef = (key: Keyframe): TimelineKeySelection => ({ layerId: layer.id, track, keyId: key.id })

  return (
    <div data-track-layer={layer.id} data-property-track={track} className={cn('absolute left-0 right-0 border-b border-border/30', selected && 'bg-accent/[0.025]')} style={{ top, height: rowHeight }}>
      {range.end > range.start && <div className="absolute top-0 bottom-0 bg-bg-tertiary/30 pointer-events-none" style={{ left: GUTTER + range.start * frameWidth, width: (range.end - range.start) * frameWidth }} />}
      {keys.filter(key => key.frameIndex + offset >= start && key.frameIndex + offset <= end).map(key => {
        const outputFrame = key.frameIndex + offset
        if (outputFrame < 0 || outputFrame >= totalFrames) return null
        const isSelected = selection.some(selectedKey => selectedKey.layerId === layer.id && selectedKey.track === track && selectedKey.keyId === key.id)
        return (
          <button key={key.id} type="button" data-timeline-key={key.id} aria-label={`${layer.name} ${TRACK_LABELS[track]} 第 ${outputFrame + 1} 帧关键帧`} aria-pressed={isSelected}
            title={`第 ${outputFrame + 1} 帧 · ${TRACK_LABELS[track]} · ${layer.locked || !layer.visible ? '只读' : '单选拖动调整时间 · Ctrl/Cmd 点选多选 · Shift 同轨区间 · F9 缓入缓出'}`}
            onPointerDown={event => onKeyPointerDown(event, keyRef(key))}
            onClick={event => { if (event.detail === 0) onKeySelect(keyRef(key), event.ctrlKey || event.metaKey, event.shiftKey) }}
            className={cn('absolute z-[11] flex h-5 w-4 items-center justify-center rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-accent', isSelected ? 'text-accent' : 'text-slate-400 hover:text-accent', !layer.visible && 'opacity-50', layer.locked || !layer.visible ? 'cursor-default' : 'cursor-ew-resize')}
            style={{ top: (rowHeight - 20) / 2, left: GUTTER + outputFrame * frameWidth - 8 }}>
            <span className={cn('h-2 w-2 border border-current', key.easing !== 'hold' && 'rotate-45', isSelected ? 'bg-accent shadow-[0_0_0_2px_rgba(0,0,0,0.45)]' : 'bg-bg-tertiary')} />
          </button>
        )
      })}
      <div data-layer-label className={cn('sticky left-0 z-20 flex h-full items-center gap-0.5 border-r border-border pl-3 pr-1 text-[11px]', selected ? 'bg-bg-secondary text-text-secondary' : 'bg-bg-primary text-text-muted')} style={{ width: GUTTER }}>
        <span className="mr-auto truncate" title={`${TRACK_LABELS[track]} · 调整轨道，不改写原始逐帧动画`}>{TRACK_LABELS[track]}</span>
        <button type="button" disabled={!before} aria-label={`${layer.name} ${TRACK_LABELS[track]} 上一个关键帧`} title="上一个关键帧" onClick={() => before && onKeySelect(keyRef(before))}
          className="flex h-5 w-4 flex-shrink-0 items-center justify-center rounded hover:bg-bg-tertiary disabled:opacity-25">‹</button>
        <button type="button" disabled={!!editError} aria-label={`${layer.name} ${TRACK_LABELS[track]} 插入关键帧`} aria-pressed={!!currentKey}
          title={editError ?? (currentKey ? '当前帧已有关键帧，单击选中' : '在播放头插入关键帧；使用当前动画采样值')}
          onClick={() => currentKey ? onKeySelect(keyRef(currentKey)) : onInsert(layer.id, track)}
          className={cn('flex h-5 w-4 flex-shrink-0 items-center justify-center rounded hover:bg-bg-tertiary disabled:opacity-25', currentKey && 'text-accent')}>◆</button>
        <button type="button" disabled={!after} aria-label={`${layer.name} ${TRACK_LABELS[track]} 下一个关键帧`} title="下一个关键帧" onClick={() => after && onKeySelect(keyRef(after))}
          className="flex h-5 w-4 flex-shrink-0 items-center justify-center rounded hover:bg-bg-tertiary disabled:opacity-25">›</button>
      </div>
    </div>
  )
})
TimelinePropertyTrack.displayName = 'TimelinePropertyTrack'
