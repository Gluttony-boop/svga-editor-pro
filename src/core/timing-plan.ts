import type { Layer, Sprite, VideoItem } from '@/types'
import { getLayerOutputRange, getLayerTimeOffset } from './layer-time'
import { getOriginalLayerIndex } from './layer-transform'

export interface TimingRequest {
  mode: 'shift' | 'stagger' | 'reset'
  frames: number
  extendDuration: boolean
}

export type LayerTimingPlan =
  | { offsets: Record<string, number>; totalFrames: number; changed: boolean }
  | { error: string }

const MAX_EXTENDED_FRAMES = 10000

function sourceSprite(layer: Layer, video: VideoItem): Sprite | undefined {
  if (layer.isNew) return undefined
  if (layer.sprites) return layer.sprites
  const index = getOriginalLayerIndex(layer)
  return index !== null && Number.isSafeInteger(index) && index >= 0 ? video.movie.sprites?.[index] : undefined
}

interface MatteRelations {
  neighbours: Map<string, Set<string>>
  involved: Set<string>
  unresolved: Set<string>
}

/** 共享素材本身不连接时间；只有真实遮罩引用才要求整个关联组件同步移动。 */
function matteRelations(layers: readonly Layer[], video: VideoItem): MatteRelations {
  // 复制出的新增层可能仍携带原始遮罩信息，不能因 isNew 就放松时间同步保护。
  const sprites = new Map(layers.map(layer => [layer.id, layer.sprites || sourceSprite(layer, video)]))
  const byImageKey = new Map<string, Set<string>>()
  for (const layer of layers) {
    const keys = [layer.imageKey, sprites.get(layer.id)?.imageKey]
    for (const key of keys) {
      if (!key) continue
      const ids = byImageKey.get(key) || new Set<string>()
      ids.add(layer.id)
      byImageKey.set(key, ids)
    }
  }

  const neighbours = new Map<string, Set<string>>()
  const involved = new Set<string>()
  const unresolved = new Set<string>()
  const connect = (from: string, to: string) => {
    const ids = neighbours.get(from) || new Set<string>()
    ids.add(to)
    neighbours.set(from, ids)
  }
  for (const layer of layers) {
    const matteKey = sprites.get(layer.id)?.matteKey
    if (!matteKey) continue
    involved.add(layer.id)
    const masks = byImageKey.get(matteKey)
    if (!masks?.size) {
      unresolved.add(layer.id)
      continue
    }
    for (const maskId of masks) {
      involved.add(maskId)
      connect(layer.id, maskId)
      connect(maskId, layer.id)
    }
  }
  return { neighbours, involved, unresolved }
}

function validTiming(layer: Layer): boolean {
  const { startFrame, duration } = layer.clip
  if (!Number.isSafeInteger(startFrame) || startFrame < 0 || !Number.isSafeInteger(duration) || duration <= 0 ||
    !Number.isSafeInteger(startFrame + duration)) return false
  if (layer.timeOffsetFrames !== undefined && !Number.isSafeInteger(layer.timeOffsetFrames)) return false
  const range = getLayerOutputRange(layer)
  return Number.isSafeInteger(range.startFrame) && Number.isSafeInteger(range.endFrame)
}

/** 仅规划输出时间偏移，不改源 clip、关键帧或音频，也不因复位自动缩短整部动画。 */
export function planLayerTiming(
  allLayers: readonly Layer[],
  selectedIds: readonly string[],
  video: VideoItem | null,
  totalFrames: number,
  request: TimingRequest
): LayerTimingPlan {
  if (!video) return { error: '请先打开动画，再调整图层时间。' }
  if (!Number.isSafeInteger(totalFrames) || totalFrames <= 0) return { error: '动画总帧数无效，无法调整时间。' }
  if (!['shift', 'stagger', 'reset'].includes(request.mode)) return { error: '不支持的时间调整操作。' }
  if (!Number.isSafeInteger(request.frames) || (request.mode === 'stagger' && request.frames < 0)) {
    return { error: request.mode === 'stagger' ? '错峰间隔必须是非负整数帧。' : '时间偏移必须是安全整数帧。' }
  }
  if (typeof request.extendDuration !== 'boolean') return { error: '延长动画选项无效。' }

  const selected = new Set(selectedIds)
  if (!selected.size) return { error: '请先选择需要调整时间的图层。' }
  const byId = new Map<string, Layer>()
  for (const layer of allLayers) {
    if (byId.has(layer.id)) return { error: '存在重复的图层标识，无法安全调整时间。' }
    byId.set(layer.id, layer)
  }
  for (const id of selected) {
    if (!byId.has(id)) return { error: '选区包含已不存在的图层，请重新选择。' }
  }
  const layers = allLayers.filter(layer => selected.has(layer.id))
  if (request.mode === 'stagger' && layers.length < 2) return { error: '错峰至少需要选择 2 个图层。' }
  for (const layer of layers) {
    if (layer.locked || !layer.visible || layer.type !== 'image') {
      return { error: `“${layer.name}”已锁定、隐藏或不是图片图层，本次时间调整未应用。` }
    }
    if (!validTiming(layer)) return { error: `“${layer.name}”的时间范围或偏移无效，本次时间调整未应用。` }
    if (!layer.isNew && !sourceSprite(layer, video)) {
      return { error: `无法确认“${layer.name}”的原始图层及遮罩关系，本次时间调整未应用。` }
    }
  }

  const relations = matteRelations(allLayers, video)
  if (request.mode === 'stagger' && layers.some(layer => relations.involved.has(layer.id))) {
    return { error: '选区涉及遮罩关联，不能错峰；请整组选中后统一提前或延后。' }
  }
  for (const layer of layers) {
    if (relations.unresolved.has(layer.id)) return { error: '关联遮罩图层缺失，无法安全调整时间。' }
    for (const relatedId of relations.neighbours.get(layer.id) || []) {
      if (!selected.has(relatedId)) return { error: '请同时选择整个遮罩关联组的内容与遮罩图层，再统一调整时间。' }
    }
  }

  const firstStart = getLayerOutputRange(layers[0]).startFrame
  const entries: Array<[string, number]> = []
  let nextTotalFrames = totalFrames
  let changed = false
  for (const [index, layer] of layers.entries()) {
    const currentOffset = getLayerTimeOffset(layer)
    const offset = request.mode === 'reset' ? 0
      : request.mode === 'shift' ? currentOffset + request.frames
        : firstStart + index * request.frames - layer.clip.startFrame
    const start = layer.clip.startFrame + offset
    const end = start + layer.clip.duration
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      return { error: '时间调整超出安全整数范围，本次时间调整未应用。' }
    }
    if (start < 0) return { error: `“${layer.name}”将早于第 1 帧，已取消本次时间调整。` }
    if (end > totalFrames && !request.extendDuration) {
      return { error: '调整后超出动画末尾；请启用“延长总帧数以保留尾部”，或减小时间偏移。' }
    }
    nextTotalFrames = Math.max(nextTotalFrames, end)
    entries.push([layer.id, offset])
    changed ||= currentOffset !== offset
  }
  if (nextTotalFrames > Math.max(totalFrames, MAX_EXTENDED_FRAMES)) {
    return { error: `自动延长最多支持 ${MAX_EXTENDED_FRAMES} 帧，已取消本次时间调整。` }
  }
  return { offsets: Object.fromEntries(entries), totalFrames: nextTotalFrames, changed: changed || nextTotalFrames !== totalFrames }
}
