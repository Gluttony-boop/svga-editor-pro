import type { CanvasTransform, FrameData, Layer, VideoItem } from '@/types'
import { AnimationEngine } from './animation-engine'
import { getLayerSourceFrame } from './layer-time'
import { getLayerGeometry, getOriginalLayerIndex, normalizeCanvasTransform } from './layer-transform'
import type { LayerImageSize } from './layer-transform'

export type LayoutOperation =
  | 'align-left' | 'align-center-x' | 'align-right'
  | 'align-top' | 'align-center-y' | 'align-bottom'
  | 'distribute-x' | 'distribute-y'

export type LayoutTarget = 'selection' | 'canvas'

export type LayerLayoutPlan =
  | { transforms: Record<string, CanvasTransform>; changed: boolean; warning?: string }
  | { error: string }

interface Bounds { x: number; y: number; width: number; height: number }
interface LayoutMember { layer: Layer; bounds: Bounds; transform: CanvasTransform; order: number }

const EPSILON = 1e-7
const ALIGNMENTS: Record<string, { axis: 'x' | 'y'; anchor: number }> = {
  'align-left': { axis: 'x', anchor: 0 },
  'align-center-x': { axis: 'x', anchor: 0.5 },
  'align-right': { axis: 'x', anchor: 1 },
  'align-top': { axis: 'y', anchor: 0 },
  'align-center-y': { axis: 'y', anchor: 0.5 },
  'align-bottom': { axis: 'y', anchor: 1 }
}

function finiteFields(value: object | undefined | null, keys?: readonly string[]): boolean {
  if (value == null) return true
  const values = keys ? keys.map(key => (value as Record<string, unknown>)[key]) : Object.values(value)
  return values.every(number => number === undefined || Number.isFinite(number))
}

function validRawFrame(frame: FrameData | undefined): boolean {
  return !frame || (
    (frame.alpha === undefined || Number.isFinite(frame.alpha)) &&
    finiteFields(frame.layout, ['x', 'y', 'width', 'height']) &&
    finiteFields(frame.transform, ['a', 'b', 'c', 'd', 'tx', 'ty'])
  )
}

/** 几何计算为预览容错会归一化坏数值；排版写入前必须拒绝它们，不能悄悄改变排版基准。 */
function validLayerNumbers(
  layer: Layer,
  frameIndex: number,
  video: VideoItem | null,
  imageResources: ReadonlyMap<string, LayerImageSize>
): boolean {
  if (!Number.isFinite(layer.opacity) || !finiteFields(layer.clip, ['startFrame', 'duration']) ||
    !finiteFields(layer.canvasTransform, ['x', 'y', 'scaleX', 'scaleY', 'rotation'])) return false
  const imageKey = layer.imageKey || layer.sprites?.imageKey || ''
  const image = imageResources.get(imageKey)
  if (image && (!Number.isFinite(image.width) || !Number.isFinite(image.height))) return false
  const originalIndex = getOriginalLayerIndex(layer)
  const sprite = layer.sprites || (originalIndex === null ? undefined : video?.movie.sprites?.[originalIndex])
  const sourceFrame = getLayerSourceFrame(layer, frameIndex)
  if (!layer.isNew && !validRawFrame(sprite?.frames[sourceFrame])) return false

  const properties = AnimationEngine.getLayerPropertiesAtFrame(layer, sourceFrame)
  for (const key of ['position', 'scale', 'rotation', 'alpha'] as const) {
    const track = layer.tracks[key]
    if (!layer.isNew && !track.keyframes.length) continue
    if (track.keyframes.some(frame => !Number.isFinite(frame.frameIndex) || !finiteFields(frame.bezierControlPoints))) return false
    const value = properties[key]
    if (typeof value === 'number' ? !Number.isFinite(value) : !finiteFields(value)) return false
  }
  return true
}

/** 只规划当前帧世界边界的位移；整段偏移保留原始运动、镜像、倾斜和已有旋转。 */
export function planLayerLayout(
  layers: readonly Layer[],
  frameIndex: number,
  video: VideoItem | null,
  imageResources: ReadonlyMap<string, LayerImageSize>,
  operation: LayoutOperation,
  target: LayoutTarget
): LayerLayoutPlan {
  if (!Number.isFinite(frameIndex) || frameIndex < 0) return { error: '当前帧无效，无法排版。' }
  const distribution = operation === 'distribute-x' || operation === 'distribute-y'
  const alignment = Object.prototype.hasOwnProperty.call(ALIGNMENTS, operation) ? ALIGNMENTS[operation] : undefined
  if (!distribution && !alignment) return { error: '不支持的排版操作。' }
  if (target !== 'selection' && target !== 'canvas') return { error: '排版参照无效。' }

  const seen = new Set<string>()
  const unique = layers.filter(layer => {
    if (seen.has(layer.id)) return false
    seen.add(layer.id)
    return true
  })
  if (distribution && unique.length < 3) return { error: '等间距分布至少需要选择 3 个图层。' }
  if (!unique.length || (target === 'selection' && unique.length < 2)) {
    return { error: target === 'selection' ? '相对选区对齐至少需要选择 2 个图层。' : '请先选择一个图层。' }
  }

  const members: LayoutMember[] = []
  for (const [order, layer] of unique.entries()) {
    if (layer.locked || !layer.visible || layer.type !== 'image') {
      return { error: `“${layer.name}”已锁定、隐藏或不是图片图层，本次排版未应用。` }
    }
    if (!validLayerNumbers(layer, frameIndex, video, imageResources)) {
      return { error: `“${layer.name}”含有无效数值，本次排版未应用。` }
    }
    const geometry = getLayerGeometry(layer, frameIndex, video, imageResources)
    if (!geometry || !Number.isFinite(geometry.width) || !Number.isFinite(geometry.height) ||
      geometry.quad.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      return { error: `“${layer.name}”在当前帧没有有效边界，本次排版未应用。` }
    }
    const xs = geometry.quad.map(point => point.x)
    const ys = geometry.quad.map(point => point.y)
    const bounds = {
      x: Math.min(...xs), y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys)
    }
    if (!(bounds.width > 0 && bounds.height > 0) || !finiteFields(bounds)) {
      return { error: `“${layer.name}”的边界尺寸无效，本次排版未应用。` }
    }
    members.push({ layer, bounds, transform: layer.canvasTransform || normalizeCanvasTransform(), order })
  }

  let extent: Bounds
  if (target === 'canvas') {
    const width = video?.movie.params.viewBoxWidth
    const height = video?.movie.params.viewBoxHeight
    if (!Number.isFinite(width) || !Number.isFinite(height) || !(width! > 0 && height! > 0)) {
      return { error: '画布尺寸无效，无法相对画布排版。' }
    }
    extent = { x: 0, y: 0, width: width!, height: height! }
  } else {
    const x = Math.min(...members.map(member => member.bounds.x))
    const y = Math.min(...members.map(member => member.bounds.y))
    extent = {
      x, y,
      width: Math.max(...members.map(member => member.bounds.x + member.bounds.width)) - x,
      height: Math.max(...members.map(member => member.bounds.y + member.bounds.height)) - y
    }
  }
  if (!finiteFields(extent)) return { error: '排版范围超出有效数值范围，本次排版未应用。' }

  const axis = distribution ? (operation === 'distribute-x' ? 'x' : 'y') : alignment!.axis
  const size = axis === 'x' ? 'width' : 'height'
  const ordered = distribution
    ? [...members].sort((a, b) => a.bounds[axis] - b.bounds[axis] || a.order - b.order)
    : members
  const totalSize = ordered.reduce((sum, member) => sum + member.bounds[size], 0)
  const gap = distribution ? (extent[size] - totalSize) / (ordered.length - 1) : 0
  if (!Number.isFinite(gap)) return { error: '排版间距超出有效数值范围，本次排版未应用。' }

  let cursor = extent[axis]
  let changed = false
  const entries: Array<[string, CanvasTransform]> = []
  for (const [index, member] of ordered.entries()) {
    const desired = distribution
      ? (index === ordered.length - 1 ? extent[axis] + extent[size] - member.bounds[size] : cursor)
      : extent[axis] + (extent[size] - member.bounds[size]) * alignment!.anchor
    const delta = desired - member.bounds[axis]
    const coordinate = member.transform[axis] + delta
    if (!Number.isFinite(coordinate)) return { error: '排版位置超出有效数值范围，本次排版未应用。' }
    const moved = Math.abs(delta) > EPSILON
    entries.push([member.layer.id, moved ? { ...member.transform, [axis]: coordinate } : member.transform])
    changed ||= moved
    cursor += member.bounds[size] + gap
  }

  return {
    transforms: Object.fromEntries(entries),
    changed,
    ...(gap < -EPSILON ? { warning: '可用范围不足，已按负间距均匀分布，图层边界会重叠。' } : {})
  }
}
