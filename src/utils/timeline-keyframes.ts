import type { Keyframe, Layer, LayerTracks } from '@/types'
import { EDITABLE_TRACKS, getKeyframeEditError } from '@/core/keyframe-editing'
import { getLayerTimeOffset } from '@/core/layer-time'
import { animationKeyIdentity } from '@/core/keyframe-clipboard'
import type { AnimationKeyReference } from '@/core/keyframe-clipboard'

export type TimelineTrackFilter = 'all' | 'animated' | keyof LayerTracks

export type TimelineKeySelection = AnimationKeyReference

/** Shift 仅扩展同一属性轨道；Ctrl/Cmd 切换单个关键帧，不影响图层数据。 */
export function selectTimelineKeys(
  layers: readonly Layer[], selected: readonly TimelineKeySelection[], target: TimelineKeySelection,
  anchor: TimelineKeySelection | null, additive = false, range = false
): { selection: TimelineKeySelection[]; anchor: TimelineKeySelection | null } {
  const found = findTimelineKey(layers, target)
  if (!found) return { selection: [...selected], anchor }
  if (range && anchor?.layerId === target.layerId && anchor.track === target.track) {
    const from = findTimelineKey(layers, anchor)
    if (from) {
      const start = Math.min(from.keyframe.frameIndex, found.keyframe.frameIndex)
      const end = Math.max(from.keyframe.frameIndex, found.keyframe.frameIndex)
      const interval = found.layer.animationTracks![target.track].keyframes
        .filter(key => key.frameIndex >= start && key.frameIndex <= end)
        .sort((a, b) => a.frameIndex - b.frameIndex)
        .map(key => ({ layerId: target.layerId, track: target.track, keyId: key.id }))
      const selection = additive ? [...selected] : []
      const used = new Set(selection.map(animationKeyIdentity))
      for (const key of interval) if (!used.has(animationKeyIdentity(key))) selection.push(key)
      return { selection, anchor }
    }
  }
  const identity = animationKeyIdentity(target)
  const selection = additive ? selected.some(key => animationKeyIdentity(key) === identity)
    ? selected.filter(key => animationKeyIdentity(key) !== identity) : [...selected, target] : [target]
  return { selection, anchor: selection.some(key => animationKeyIdentity(key) === identity) ? target : selection[selection.length - 1] ?? null }
}

export interface TimelineRow {
  key: string
  layer: Layer
  track?: keyof LayerTracks
  expanded: boolean
}

/** 与批量插帧保持相同的整组校验，不跳过锁定、隐藏或越界图层。 */
export function timelineInsertionError(
  layers: readonly Layer[],
  layerIds: readonly string[],
  outputFrame: number,
  totalFrames: number
): string | null {
  if (!layerIds.length) return '请先选择图片图层'
  for (const id of new Set(layerIds)) {
    const layer = layers.find(item => item.id === id)
    if (!layer) return '所选图层已不存在，请重新选择。'
    const error = getKeyframeEditError(layer, outputFrame, totalFrames)
    if (error) return `${layer.name}：${error}`
  }
  return null
}

/** 虚拟列表以实际显示行计算索引，展开属性时不会覆盖后续图层。 */
export function buildTimelineRows(
  layers: readonly Layer[],
  selectedLayerId: string | null,
  expansion: Readonly<Record<string, boolean>>,
  filter: TimelineTrackFilter,
  onlySelected: boolean,
  selectedIds: readonly string[]
): TimelineRow[] {
  const rows: TimelineRow[] = []
  for (const layer of layers) {
    if (onlySelected && !selectedIds.includes(layer.id)) continue
    const expanded = layer.type === 'image' && (expansion[layer.id] ?? (filter !== 'all' && layer.id === selectedLayerId))
    rows.push({ key: layer.id, layer, expanded })
    if (!expanded) continue
    for (const track of EDITABLE_TRACKS) {
      if (filter === 'animated' && !layer.animationTracks?.[track].keyframes.length) continue
      if (filter !== 'all' && filter !== 'animated' && filter !== track) continue
      rows.push({ key: `${layer.id}:${track}`, layer, track, expanded })
    }
  }
  return rows
}

export function findTimelineKey(
  layers: readonly Layer[],
  selection: TimelineKeySelection | null
): { layer: Layer; keyframe: Keyframe; outputFrame: number } | null {
  if (!selection) return null
  const layer = layers.find(item => item.id === selection.layerId)
  const keyframe = layer?.animationTracks?.[selection.track].keyframes.find(key => key.id === selection.keyId)
  if (!layer || !keyframe) return null
  return { layer, keyframe, outputFrame: keyframe.frameIndex + getLayerTimeOffset(layer) }
}

/** 拖动使用相对位移，保留按下位置，滚动量只累计一次。 */
export function keyframeAtDrag(
  originalFrame: number,
  deltaX: number,
  deltaScroll: number,
  frameWidth: number
): number {
  if (!Number.isFinite(frameWidth) || frameWidth <= 0) return originalFrame
  return originalFrame + Math.round((deltaX + deltaScroll) / frameWidth)
}

export function keyframeMoveError(
  layer: Layer,
  track: keyof LayerTracks,
  keyId: string,
  outputFrame: number,
  totalFrames: number
): string | null {
  const error = getKeyframeEditError(layer, outputFrame, totalFrames)
  if (error) return error
  const keys = layer.animationTracks?.[track].keyframes ?? []
  if (!keys.some(key => key.id === keyId)) return '关键帧已不存在，请重新选择。'
  const sourceFrame = outputFrame - getLayerTimeOffset(layer)
  if (keys.some(key => key.id !== keyId && key.frameIndex === sourceFrame)) {
    return '目标帧已有关键帧，请选择空帧；不会覆盖已有动画。'
  }
  return null
}

export function adjacentKeyframe(
  layer: Layer,
  track: keyof LayerTracks,
  frame: number,
  direction: -1 | 1
): Keyframe | null {
  const sourceFrame = frame - getLayerTimeOffset(layer)
  const keys = layer.animationTracks?.[track].keyframes ?? []
  let result: Keyframe | null = null
  for (const key of keys) {
    if (direction < 0 && key.frameIndex < sourceFrame && (!result || key.frameIndex > result.frameIndex)) result = key
    if (direction > 0 && key.frameIndex > sourceFrame && (!result || key.frameIndex < result.frameIndex)) result = key
  }
  return result
}
