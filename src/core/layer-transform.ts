import type { CanvasTransform, FrameData, Layer, Transform, VideoItem } from '@/types'
import { AnimationEngine } from './animation-engine'
import { getLayerSourceFrame } from './layer-time'

export interface LayerImageSize { width: number; height: number }
export interface CanvasPoint { x: number; y: number }

const finite = (value: number | undefined, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

export function normalizeCanvasTransform(value?: Partial<CanvasTransform> | null): CanvasTransform {
  return {
    x: finite(value?.x, 0),
    y: finite(value?.y, 0),
    scaleX: finite(value?.scaleX, 1),
    scaleY: finite(value?.scaleY, 1),
    rotation: finite(value?.rotation, 0)
  }
}

export function hasCanvasTransform(value?: Partial<CanvasTransform> | null): boolean {
  const edit = normalizeCanvasTransform(value)
  return edit.x !== 0 || edit.y !== 0 || edit.scaleX !== 1 || edit.scaleY !== 1 || edit.rotation !== 0
}

/** 稀疏 protobuf 中缺少位移时保留 layout 的位置，不把缺省值误当成显式零。 */
export function getFrameTransform(frame: FrameData): Transform {
  const source = frame.transform
  const own = (key: keyof Transform, fallback: number) =>
    source && Object.prototype.hasOwnProperty.call(source, key) ? finite(source[key], fallback) : fallback
  return {
    a: own('a', 1), b: own('b', 0), c: own('c', 0), d: own('d', 1),
    tx: own('tx', finite(frame.layout?.x, 0)),
    ty: own('ty', finite(frame.layout?.y, 0))
  }
}

export function transformCanvasPoint(matrix: Transform, point: CanvasPoint): CanvasPoint {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.tx,
    y: matrix.b * point.x + matrix.d * point.y + matrix.ty
  }
}

export function getFrameImageSize(frame: FrameData, imageSize?: LayerImageSize): LayerImageSize {
  return {
    width: frame.layout?.width || imageSize?.width || 0,
    height: frame.layout?.height || imageSize?.height || 0
  }
}

export function getFrameAlpha(frame: FrameData): number {
  return Object.prototype.hasOwnProperty.call(frame, 'alpha') ? finite(frame.alpha, 1) : 1
}

/** 在原始中心周围左乘编辑矩阵，保留倾斜、镜像和每一帧已有的运动。 */
export function applyCanvasTransform(
  frame: FrameData,
  canvasTransform?: Partial<CanvasTransform> | null,
  imageSize?: LayerImageSize
): FrameData {
  if (!hasCanvasTransform(canvasTransform)) return frame
  const edit = normalizeCanvasTransform(canvasTransform)
  const source = getFrameTransform(frame)
  const { width, height } = getFrameImageSize(frame, imageSize)
  const center = transformCanvasPoint(source, { x: width / 2, y: height / 2 })
  const cos = Math.cos(edit.rotation)
  const sin = Math.sin(edit.rotation)
  const a = cos * edit.scaleX
  const b = sin * edit.scaleX
  const c = -sin * edit.scaleY
  const d = cos * edit.scaleY
  const tx = edit.x + center.x - a * center.x - c * center.y
  const ty = edit.y + center.y - b * center.x - d * center.y
  return {
    ...frame,
    transform: {
      a: a * source.a + c * source.b,
      b: b * source.a + d * source.b,
      c: a * source.c + c * source.d,
      d: b * source.c + d * source.d,
      tx: a * source.tx + c * source.ty + tx,
      ty: b * source.tx + d * source.ty + ty
    }
  }
}

/** 本函数只接收源帧；附加轨道与原动画一起排程，默认值不能覆盖原始逐帧动画。 */
export function applyImportedTrackOverlay(frame: FrameData, layer: Layer, sourceFrame: number, imageSize?: LayerImageSize): FrameData {
  if (layer.isNew || !Object.values(layer.tracks).some(track => track.keyframes.length > 0)) return frame
  const props = AnimationEngine.getLayerPropertiesAtFrame(layer, sourceFrame)
  const hasPosition = layer.tracks.position.keyframes.length > 0
  const hasScale = layer.tracks.scale.keyframes.length > 0
  const hasRotation = layer.tracks.rotation.keyframes.length > 0
  const transformed = applyCanvasTransform(frame, {
    x: hasPosition ? props.position.x : 0,
    y: hasPosition ? props.position.y : 0,
    scaleX: hasScale ? props.scale.scaleX : 1,
    scaleY: hasScale ? props.scale.scaleY : 1,
    rotation: hasRotation ? props.rotation * Math.PI / 180 : 0
  }, imageSize)
  if (!layer.tracks.alpha.keyframes.length) return transformed
  return { ...transformed, alpha: getFrameAlpha(frame) * Math.max(0, Math.min(1, finite(props.alpha, 1))) }
}

/** 接收输出帧，先映射源时间叠加关键帧，再应用整段调整；透明度只烘焙一次。 */
export function applyLayerFrameEdits(frame: FrameData, layer: Layer, frameIndex: number, imageSize?: LayerImageSize): FrameData {
  const sourceFrame = getLayerSourceFrame(layer, frameIndex)
  const tracked = applyImportedTrackOverlay(frame, layer, sourceFrame, imageSize)
  const transformed = applyCanvasTransform(tracked, layer.canvasTransform, imageSize)
  const outsideClip = sourceFrame < 0 || sourceFrame < layer.clip.startFrame || sourceFrame >= layer.clip.startFrame + layer.clip.duration
  const opacity = Math.max(0, Math.min(1, finite(layer.opacity, 1)))
  if (layer.visible !== false && !outsideClip && opacity === 1) return transformed
  const sourceAlpha = getFrameAlpha(transformed)
  return { ...transformed, alpha: layer.visible === false || outsideClip ? 0 : sourceAlpha * opacity }
}

/** 共享图片不能作为图层身份；删除或重排后只按稳定的原始索引匹配。 */
export function getOriginalLayerIndex(layer: Layer): number | null {
  if (layer.isNew) return null
  if (Number.isInteger(layer.editableIndex) && (layer.editableIndex ?? -1) >= 0) return layer.editableIndex!
  const index = /^\d+$/.test(layer.id) ? Number(layer.id) : NaN
  return Number.isSafeInteger(index) ? index : null
}

export function findOriginalLayer(layers: Layer[], spriteIndex: number): Layer | undefined {
  return layers.find(layer => getOriginalLayerIndex(layer) === spriteIndex)
}

export function getLayerImageSize(
  layer: Layer,
  videoItem?: VideoItem | null,
  imageResources?: ReadonlyMap<string, LayerImageSize>
): LayerImageSize {
  const key = layer.imageKey || layer.sprites?.imageKey || ''
  const resource = imageResources?.get(key)
  const image = videoItem?.images?.[key]
  return {
    width: resource?.width || image?.naturalWidth || image?.width || 0,
    height: resource?.height || image?.naturalHeight || image?.height || 0
  }
}

export function getLayerBaseFrame(
  layer: Layer,
  frameIndex: number,
  videoItem?: VideoItem | null,
  imageResources?: ReadonlyMap<string, LayerImageSize>
): FrameData | null {
  if (layer.type !== 'image' && layer.type !== 'shape') return null
  if (!Number.isFinite(frameIndex) || frameIndex < 0) return null
  const index = getLayerSourceFrame(layer, frameIndex)
  if (index < 0 || index < layer.clip.startFrame || index >= layer.clip.startFrame + layer.clip.duration) return null
  if (!layer.isNew) {
    const spriteIndex = getOriginalLayerIndex(layer)
    const sprite = layer.sprites || (spriteIndex === null ? undefined : videoItem?.movie.sprites?.[spriteIndex])
    if (!sprite?.frames?.length) return null
    const frame = sprite.frames[index]
    return frame ? applyImportedTrackOverlay(frame, layer, index, getLayerImageSize(layer, videoItem, imageResources)) : null
  }
  const props = AnimationEngine.getLayerPropertiesAtFrame(layer, index)
  const { width, height } = getLayerImageSize(layer, videoItem, imageResources)
  if (width <= 0 || height <= 0) return null
  const radians = props.rotation * Math.PI / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    alpha: props.alpha,
    layout: { x: 0, y: 0, width, height },
    transform: {
      a: props.scale.scaleX * cos, b: props.scale.scaleX * sin,
      c: -props.scale.scaleY * sin, d: props.scale.scaleY * cos,
      tx: props.position.x, ty: props.position.y
    },
    clipPath: null
  }
}

export function getLayerGeometry(
  layer: Layer,
  frameIndex: number,
  videoItem?: VideoItem | null,
  imageResources?: ReadonlyMap<string, LayerImageSize>
) {
  if (!layer.visible || layer.opacity <= 0) return null
  const baseFrame = getLayerBaseFrame(layer, frameIndex, videoItem, imageResources)
  if (!baseFrame || (baseFrame.alpha ?? 1) <= 0) return null
  const size = getFrameImageSize(baseFrame, getLayerImageSize(layer, videoItem, imageResources))
  const { width, height } = size
  if (!(width > 0 && height > 0)) return null
  const corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }]
  const baseMatrix = getFrameTransform(baseFrame)
  const baseQuad = corners.map(point => transformCanvasPoint(baseMatrix, point))
  const xs = baseQuad.map(point => point.x)
  const ys = baseQuad.map(point => point.y)
  const frame = applyCanvasTransform(baseFrame, layer.canvasTransform, size)
  const matrix = getFrameTransform(frame)
  return {
    baseBounds: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
    center: transformCanvasPoint(baseMatrix, { x: width / 2, y: height / 2 }),
    frame,
    width,
    height,
    quad: corners.map(point => transformCanvasPoint(matrix, point))
  }
}

/** 源时间外使用透明帧，不延长末帧；每次生成独立对象供后续兼容导出缩放。 */
export function createEmptyLayerFrame(): FrameData {
  return { alpha: 0, layout: null, transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, clipPath: null }
}

export function bakeLayerFrames(
  frames: FrameData[],
  layer: Layer,
  frameCount: number,
  imageSize?: LayerImageSize
): FrameData[] {
  return Array.from({ length: frameCount }, (_, outputFrame) => {
    const sourceFrame = getLayerSourceFrame(layer, outputFrame)
    const frame = sourceFrame >= 0 ? frames[sourceFrame] : undefined
    return frame ? applyLayerFrameEdits(frame, layer, outputFrame, imageSize) : createEmptyLayerFrame()
  })
}

/** 对普通对象和 protobuf 消息都只替换帧数组，不就地改写原始帧。 */
export function applyCanvasTransformsToMovie(
  movie: { sprites?: Array<{ frames: FrameData[] }> },
  layers?: Layer[],
  imageResources?: ReadonlyMap<string, LayerImageSize>,
  frameCount?: number
): void {
  if (!layers?.length) return
  movie.sprites?.forEach((sprite, index) => {
    const layer = findOriginalLayer(layers, index)
    if (!layer) return
    const size = getLayerImageSize(layer, undefined, imageResources)
    const totalFrames = Number.isSafeInteger(frameCount) && frameCount! > 0 ? frameCount! : sprite.frames.length
    sprite.frames = bakeLayerFrames(sprite.frames, layer, totalFrames, size)
  })
}
