import type { EasingType, Keyframe, Layer, LayerTracks, PropertyTrack } from '@/types'
import { createAnimationTracks, getKeyframeEditError, isEditableTrack, isSupportedEasing, isValidAnimationValue } from './keyframe-editing'
import type { AnimationValue } from './keyframe-editing'
import { getLayerTimeOffset } from './layer-time'

export interface AnimationKeyReference {
  layerId: string
  track: keyof LayerTracks
  keyId: string
}

export interface ClipboardAnimationKey {
  layerId: string
  layerName: string
  track: keyof LayerTracks
  relativeFrame: number
  value: AnimationValue
  easing: EasingType
  bezierControlPoints?: Keyframe['bezierControlPoints']
}

/** 仅保存在本机会话，按合成帧保存间距，不携带原动画的逐帧数据。 */
export interface KeyframeClipboard {
  version: 1
  keys: ClipboardAnimationKey[]
}

export interface KeyframeSelectionPlan {
  layers: Layer[]
  selection: AnimationKeyReference[]
  error?: string
}

export const MAX_CLIPBOARD_KEYS = 10000

export const animationKeyIdentity = (key: AnimationKeyReference) => JSON.stringify([key.layerId, key.track, key.keyId])
const copyValue = (value: AnimationValue): AnimationValue => typeof value === 'object' ? { ...value } : value
const copyCurve = (curve: Keyframe['bezierControlPoints']) => curve ? { ...curve } : undefined
const validCurve = (curve: Keyframe['bezierControlPoints']) => curve === undefined || (!!curve && ['x1', 'y1', 'x2', 'y2'].every(key => Number.isFinite(curve[key as keyof typeof curve])))
const failure = (layers: Layer[], error: string): KeyframeSelectionPlan => ({ layers, selection: [], error })

function selectedKeys(layers: readonly Layer[], selection: readonly AnimationKeyReference[], totalFrames: number) {
  if (!selection.length) return { error: '请先选择调整轨道上的关键帧。' }
  if (selection.length > MAX_CLIPBOARD_KEYS) return { error: `一次最多操作 ${MAX_CLIPBOARD_KEYS} 个关键帧。` }
  const identities = new Set<string>()
  const layerById = new Map(layers.map(layer => [layer.id, layer]))
  const trackKeys = new Map<string, Map<string, Keyframe<AnimationValue>>>()
  const found: { reference: AnimationKeyReference; layer: Layer; key: Keyframe<AnimationValue>; outputFrame: number }[] = []
  for (const reference of selection) {
    if (!isEditableTrack(reference.track)) return { error: '不支持的动画属性。' }
    const identity = animationKeyIdentity(reference)
    if (identities.has(identity)) continue
    identities.add(identity)
    const layer = layerById.get(reference.layerId)
    const trackIdentity = JSON.stringify([reference.layerId, reference.track])
    if (!trackKeys.has(trackIdentity)) trackKeys.set(trackIdentity, new Map((layer?.animationTracks?.[reference.track].keyframes ?? []).map(key => [key.id, key])))
    const key = trackKeys.get(trackIdentity)!.get(reference.keyId)
    if (!layer || !key) return { error: '所选关键帧已不存在，请重新选择。' }
    const outputFrame = key.frameIndex + getLayerTimeOffset(layer)
    const error = getKeyframeEditError(layer, outputFrame, totalFrames)
    if (error) return { error: `${layer.name}：${error}` }
    found.push({ reference, layer, key, outputFrame })
  }
  return { found }
}

/** 复制值和控制点，之后修改原关键帧不会改变剪贴板。 */
export function copyAnimationKeyframes(
  layers: readonly Layer[], selection: readonly AnimationKeyReference[], totalFrames: number
): { clipboard?: KeyframeClipboard; error?: string } {
  const result = selectedKeys(layers, selection, totalFrames)
  if (result.error || !result.found) return { error: result.error }
  if (result.found.some(({ reference, key }) => !isValidAnimationValue(reference.track, key.value) || !isSupportedEasing(key.easing) || !validCurve(key.bezierControlPoints))) {
    return { error: '所选关键帧含无效属性值或缓动曲线，未更改剪贴板。' }
  }
  const firstFrame = Math.min(...result.found.map(item => item.outputFrame))
  return { clipboard: { version: 1, keys: result.found.map(({ reference, layer, key, outputFrame }) => ({
    layerId: layer.id, layerName: layer.name, track: reference.track, relativeFrame: outputFrame - firstFrame,
    value: copyValue(key.value), easing: key.easing, bezierControlPoints: copyCurve(key.bezierControlPoints)
  })) } }
}

/** 先完整校验，再创建副本；任意冲突或越界都不得留下半组关键帧。 */
export function prepareKeyframePaste(
  layers: Layer[], clipboard: KeyframeClipboard, outputFrame: number, totalFrames: number,
  makeId: () => string, targetLayerId?: string
): KeyframeSelectionPlan {
  if (!clipboard || clipboard.version !== 1 || !Array.isArray(clipboard.keys) || !clipboard.keys.length || clipboard.keys.length > MAX_CLIPBOARD_KEYS) {
    return failure(layers, '关键帧剪贴板为空或格式不受支持。')
  }
  const keys = clipboard.keys
  if (keys.some(key => !key || typeof key.layerId !== 'string' || !key.layerId || !isEditableTrack(key.track) ||
    !Number.isSafeInteger(key.relativeFrame) || key.relativeFrame < 0 || !isValidAnimationValue(key.track, key.value) ||
    !isSupportedEasing(key.easing) || !validCurve(key.bezierControlPoints)) || !keys.some(key => key.relativeFrame === 0)) {
    return failure(layers, '关键帧剪贴板包含无效位置、属性值或缓动曲线。')
  }
  if (targetLayerId !== undefined && new Set(keys.map(key => key.layerId)).size !== 1) {
    return failure(layers, '跨图层复制请粘贴回原图层；仅单一来源图层可粘贴到当前图层。')
  }
  const destinations = new Set<string>()
  const layerById = new Map(layers.map(layer => [layer.id, layer]))
  const occupiedFrames = new Map<string, Set<number>>()
  const pending: { layer: Layer; item: ClipboardAnimationKey; frameIndex: number }[] = []
  for (const item of keys) {
    const layer = layerById.get(targetLayerId ?? item.layerId)
    if (!layer) return failure(layers, `目标图层“${item.layerName || item.layerId}”已不存在；未粘贴任何关键帧。`)
    const frame = outputFrame + item.relativeFrame
    const error = getKeyframeEditError(layer, frame, totalFrames)
    if (error) return failure(layers, `${layer.name}：${error}；未粘贴任何关键帧。`)
    const frameIndex = frame - getLayerTimeOffset(layer)
    const trackIdentity = JSON.stringify([layer.id, item.track])
    if (!occupiedFrames.has(trackIdentity)) occupiedFrames.set(trackIdentity, new Set(layer.animationTracks?.[item.track].keyframes.map(key => key.frameIndex)))
    const destination = JSON.stringify([layer.id, item.track, frameIndex])
    if (destinations.has(destination) || occupiedFrames.get(trackIdentity)!.has(frameIndex)) {
      return failure(layers, `${layer.name} 第 ${frame + 1} 帧已有关键帧；不会覆盖，整组粘贴已取消。`)
    }
    destinations.add(destination)
    pending.push({ layer, item, frameIndex })
  }
  const usedIds = new Set(layers.flatMap(layer => [...Object.values(layer.tracks), ...Object.values(layer.animationTracks ?? {})]
    .flatMap(track => (track as PropertyTrack<AnimationValue>).keyframes.map(key => key.id))))
  const additions = new Map<string, Map<keyof LayerTracks, Keyframe<AnimationValue>[]>>()
  const selection: AnimationKeyReference[] = []
  for (const { layer, item, frameIndex } of pending) {
    const id = makeId()
    if (!id || typeof id !== 'string' || usedIds.has(id)) return failure(layers, '无法分配独立关键帧标识；未粘贴任何关键帧。')
    usedIds.add(id)
    const key: Keyframe<AnimationValue> = { id, frameIndex, value: copyValue(item.value), easing: item.easing, bezierControlPoints: copyCurve(item.bezierControlPoints) }
    if (!additions.has(layer.id)) additions.set(layer.id, new Map())
    const tracks = additions.get(layer.id)!
    if (!tracks.has(item.track)) tracks.set(item.track, [])
    tracks.get(item.track)!.push(key)
    selection.push({ layerId: layer.id, track: item.track, keyId: id })
  }
  return { layers: layers.map(layer => {
    const added = additions.get(layer.id)
    if (!added) return layer
    const tracks = { ...(layer.animationTracks ?? createAnimationTracks()) }
    for (const [name, keys] of added) {
      const track = tracks[name] as PropertyTrack<AnimationValue>
      // 每个轨道只复制和排序一次，避免大选区按关键帧反复构造整条轨道。
      Object.assign(tracks, { [name]: { ...track, keyframes: [...track.keyframes, ...keys].sort((a, b) => a.frameIndex - b.frameIndex) } })
    }
    return { ...layer, animationTracks: tracks }
  }), selection }
}

/** 批量删除、缓动先校验整组选区，避免一个锁定层导致部分写入。 */
export function prepareSelectedKeyframeEdit(
  layers: Layer[], selection: readonly AnimationKeyReference[], totalFrames: number,
  action: { type: 'delete' } | { type: 'easing'; easing: EasingType }
): KeyframeSelectionPlan {
  const selected = selectedKeys(layers, selection, totalFrames)
  if (selected.error || !selected.found) return failure(layers, selected.error ?? '关键帧选区无效。')
  if (action.type === 'easing' && !isSupportedEasing(action.easing)) return failure(layers, '不支持的缓动类型。')
  const selectedByTrack = new Map<string, Map<keyof LayerTracks, Set<string>>>()
  for (const { reference, layer, key } of selected.found) {
    if (action.type === 'easing' && key.easing === action.easing) continue
    if (!selectedByTrack.has(layer.id)) selectedByTrack.set(layer.id, new Map())
    const tracks = selectedByTrack.get(layer.id)!
    if (!tracks.has(reference.track)) tracks.set(reference.track, new Set())
    tracks.get(reference.track)!.add(key.id)
  }
  return { layers: selectedByTrack.size ? layers.map(layer => {
    const selected = selectedByTrack.get(layer.id)
    if (!selected) return layer
    const tracks = { ...layer.animationTracks! }
    for (const [name, ids] of selected) {
      const track = tracks[name] as PropertyTrack<AnimationValue>
      const keyframes = action.type === 'delete' ? track.keyframes.filter(key => !ids.has(key.id))
        : track.keyframes.map(key => ids.has(key.id) ? { ...key, easing: action.easing } : key)
      Object.assign(tracks, { [name]: { ...track, keyframes } })
    }
    return { ...layer, animationTracks: tracks }
  }) : layers,
    selection: action.type === 'delete' ? [] : selected.found.map(item => ({ ...item.reference })) }
}
