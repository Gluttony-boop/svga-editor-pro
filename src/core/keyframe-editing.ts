import type { CanvasTransform, EasingType, Keyframe, Layer, LayerTracks, PropertyTrack, VideoItem } from '@/types'
import { AnimationEngine, numberInterpolator, point2DInterpolator, scaleInterpolator } from './animation-engine'
import { getLayerSourceFrame, getLayerTimeOffset } from './layer-time'

export const EDITABLE_TRACKS = ['position', 'scale', 'rotation', 'alpha'] as const
export const TRACK_LABELS: Record<keyof LayerTracks, string> = {
  position: '位置', scale: '缩放', rotation: '旋转', alpha: '不透明度'
}

export type AnimationValues = {
  position: { x: number; y: number }
  scale: { scaleX: number; scaleY: number }
  rotation: number
  alpha: number
}
export type AnimationValue = AnimationValues[keyof AnimationValues]
export type KeyframeEditResult = { changed: boolean; error?: string }

const finite = (value: number | undefined, fallback: number) => Number.isFinite(value) ? value! : fallback
const clampAlpha = (value: number) => Math.max(0, Math.min(1, finite(value, 1)))
const makeTrack = <T,>(value: T): PropertyTrack<T> => ({
  keyframes: [], currentValue: typeof value === 'object' ? { ...value } : value,
  defaultValue: typeof value === 'object' ? { ...value } : value
})

export function createAnimationTracks(): LayerTracks {
  return {
    position: makeTrack({ x: 0, y: 0 }), scale: makeTrack({ scaleX: 1, scaleY: 1 }),
    rotation: makeTrack(0), alpha: makeTrack(1)
  }
}

/** 历史和复制必须隔离对象值、曲线控制点；复制图层可另外分配关键帧身份。 */
export function cloneAnimationTracks(tracks: LayerTracks, makeId?: () => string): LayerTracks {
  const cloneTrack = <T,>(track: PropertyTrack<T>): PropertyTrack<T> => ({
    ...track,
    currentValue: typeof track.currentValue === 'object' ? { ...track.currentValue } : track.currentValue,
    defaultValue: typeof track.defaultValue === 'object' ? { ...track.defaultValue } : track.defaultValue,
    keyframes: track.keyframes.map(key => ({
      ...key, id: makeId ? makeId() : key.id,
      value: typeof key.value === 'object' ? { ...key.value } : key.value,
      bezierControlPoints: key.bezierControlPoints ? { ...key.bezierControlPoints } : undefined
    }))
  })
  return {
    position: cloneTrack(tracks.position), scale: cloneTrack(tracks.scale),
    rotation: cloneTrack(tracks.rotation), alpha: cloneTrack(tracks.alpha)
  }
}

export function sampleAnimationValues(layer: Layer, outputFrame: number): AnimationValues {
  const tracks = layer.animationTracks
  if (!tracks) return { position: { x: 0, y: 0 }, scale: { scaleX: 1, scaleY: 1 }, rotation: 0, alpha: 1 }
  const sourceFrame = getLayerSourceFrame(layer, outputFrame)
  const position = AnimationEngine.interpolateProperty(tracks.position.keyframes, sourceFrame, { x: 0, y: 0 }, point2DInterpolator)
  const scale = AnimationEngine.interpolateProperty(tracks.scale.keyframes, sourceFrame, { scaleX: 1, scaleY: 1 }, scaleInterpolator)
  return {
    position: { x: finite(position.x, 0), y: finite(position.y, 0) },
    scale: { scaleX: finite(scale.scaleX, 1), scaleY: finite(scale.scaleY, 1) },
    rotation: finite(AnimationEngine.interpolateProperty(tracks.rotation.keyframes, sourceFrame, 0, numberInterpolator), 0),
    alpha: clampAlpha(AnimationEngine.interpolateProperty(tracks.alpha.keyframes, sourceFrame, 1, numberInterpolator))
  }
}

/** 不依赖矩阵模块，避免编辑值解析与几何合成形成循环依赖。 */
export function resolveCanvasTransform(layer: Layer, outputFrame: number): CanvasTransform {
  const values = sampleAnimationValues(layer, outputFrame)
  const base = layer.canvasTransform
  return {
    x: finite(base?.x, 0) + values.position.x,
    y: finite(base?.y, 0) + values.position.y,
    scaleX: finite(base?.scaleX, 1) * values.scale.scaleX,
    scaleY: finite(base?.scaleY, 1) * values.scale.scaleY,
    rotation: finite(base?.rotation, 0) + values.rotation * Math.PI / 180
  }
}

export function resolveLayerOpacity(layer: Layer, outputFrame: number): number {
  return clampAlpha(layer.opacity) * sampleAnimationValues(layer, outputFrame).alpha
}

export function getAnimationLayerError(layer: Layer): string | null {
  if (layer.type !== 'image') return '仅支持图片图层的变换关键帧'
  if (layer.locked) return '请先解锁图层'
  if (!layer.visible) return '请先显示图层'
  if (!Number.isSafeInteger(layer.clip.startFrame) || layer.clip.startFrame < 0 ||
      !Number.isSafeInteger(layer.clip.duration) || layer.clip.duration <= 0 ||
      !Number.isSafeInteger(layer.clip.startFrame + layer.clip.duration) ||
      (layer.timeOffsetFrames !== undefined && !Number.isSafeInteger(layer.timeOffsetFrames))) return '图层时间范围无效'
  return null
}

export function getKeyframeEditError(layer: Layer, outputFrame: number, totalFrames: number): string | null {
  const error = getAnimationLayerError(layer)
  if (error) return error
  if (!Number.isSafeInteger(totalFrames) || totalFrames <= 0 || !Number.isSafeInteger(outputFrame) ||
      outputFrame < 0 || outputFrame >= totalFrames) return '关键帧必须位于动画的有效整数帧内'
  const sourceFrame = getLayerSourceFrame(layer, outputFrame)
  if (!Number.isSafeInteger(sourceFrame) || sourceFrame < layer.clip.startFrame ||
      sourceFrame >= layer.clip.startFrame + layer.clip.duration) return '当前帧不在该图层的时间范围内'
  if (layer.sprites && !layer.sprites.frames[sourceFrame]) return '当前帧没有可编辑的源图层画面'
  return null
}

/** 当前只能独立复制普通图层；单独复制遮罩组件会改变合成结果，必须先阻止。 */
export function getLayerDuplicateError(layer: Layer, layers: Layer[], videoItem?: VideoItem | null): string | null {
  const key = layer.imageKey || layer.sprites?.imageKey
  const linkedAsMask = !!key && (layers.some(item => item.sprites?.matteKey === key) ||
    !!videoItem?.movie.sprites.some(sprite => sprite.matteKey === key))
  if (layer.sprites?.matteKey?.trim() || linkedAsMask) return '此图层参与遮罩合成，暂不支持单独复制遮罩组成员'
  return null
}

export function isEditableTrack(track: string): track is keyof LayerTracks {
  return (EDITABLE_TRACKS as readonly string[]).includes(track)
}

export function isValidAnimationValue(track: keyof LayerTracks, value: unknown): value is AnimationValue {
  if (track === 'position') {
    const point = value as AnimationValues['position'] | null
    return !!point && Number.isFinite(point.x) && Number.isFinite(point.y)
  }
  if (track === 'scale') {
    const scale = value as AnimationValues['scale'] | null
    return !!scale && Number.isFinite(scale.scaleX) && Number.isFinite(scale.scaleY) && scale.scaleX >= 0 && scale.scaleY >= 0
  }
  return typeof value === 'number' && Number.isFinite(value) && (track !== 'alpha' || (value >= 0 && value <= 1))
}

export function isSupportedEasing(easing: string): easing is EasingType {
  return ['linear', 'easeIn', 'easeOut', 'easeInOut', 'bezier', 'hold'].includes(easing)
}

/** 首次直接修改后续帧时补中性起点；显式插帧保持 AE 的首尾停留语义。 */
export function upsertAnimationValue(
  layer: Layer, track: keyof LayerTracks, value: AnimationValue, outputFrame: number,
  makeId: () => string, anchorFirstEdit: boolean
): Layer {
  const sourceFrame = getLayerSourceFrame(layer, outputFrame)
  const tracks = layer.animationTracks ?? createAnimationTracks()
  const sourceTrack = tracks[track] as PropertyTrack<AnimationValue>
  const existing = sourceTrack.keyframes.find(key => key.frameIndex === sourceFrame)
  if (existing && JSON.stringify(existing.value) === JSON.stringify(value)) return layer
  const copyValue = (item: AnimationValue) => typeof item === 'object' ? { ...item } : item
  const keyframes: Keyframe<AnimationValue>[] = [...sourceTrack.keyframes]
  const startFrame = Math.max(layer.clip.startFrame, -getLayerTimeOffset(layer))
  if (anchorFirstEdit && !keyframes.length && sourceFrame > startFrame) {
    keyframes.push({ id: makeId(), frameIndex: startFrame, value: copyValue(createAnimationTracks()[track].defaultValue), easing: 'linear' })
  }
  if (existing) {
    keyframes[keyframes.indexOf(existing)] = { ...existing, value: copyValue(value) }
  } else {
    keyframes.push({ id: makeId(), frameIndex: sourceFrame, value: copyValue(value), easing: 'linear' })
  }
  keyframes.sort((a, b) => a.frameIndex - b.frameIndex)
  return { ...layer, animationTracks: { ...tracks, [track]: { ...sourceTrack, keyframes } } }
}
