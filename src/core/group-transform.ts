import type { CanvasTransform, Layer, VideoItem } from '@/types'
import { getLayerGeometry, normalizeCanvasTransform, type CanvasPoint, type LayerImageSize } from './layer-transform'
import { sampleAnimationValues } from './keyframe-editing'

export interface GroupTransformItem {
  id: string
  baseCenter: CanvasPoint
  transform: CanvasTransform
}

export interface GroupTransformSnapshot {
  bounds: { x: number; y: number; width: number; height: number }
  center: CanvasPoint
  items: GroupTransformItem[]
}

export interface GroupTransformDelta {
  x: number
  y: number
  scale: number
  rotation: number
}

const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback
const isFinitePoint = (point: CanvasPoint) => Number.isFinite(point.x) && Number.isFinite(point.y)

/** 在手势开始时固定选区；使用变换后的四角计算世界边界，不按共享图片合并图层。 */
export function captureGroupTransform(
  layers: readonly Layer[],
  frameIndex: number,
  videoItem?: VideoItem | null,
  imageResources?: ReadonlyMap<string, LayerImageSize>
): GroupTransformSnapshot | null {
  const items: GroupTransformItem[] = []
  const ids = new Set<string>()
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const layer of layers) {
    if (layer.type !== 'image' || layer.locked || !layer.visible || ids.has(layer.id)) continue
    const geometry = getLayerGeometry(layer, frameIndex, videoItem, imageResources)
    if (!geometry || !isFinitePoint(geometry.center) || !geometry.quad.every(isFinitePoint)) continue

    ids.add(layer.id)
    const animation = sampleAnimationValues(layer, frameIndex)
    items.push({
      id: layer.id,
      // 整组操作修改基准变换，中心仍要包含当前帧的动画位置偏移。
      baseCenter: { x: geometry.center.x + animation.position.x, y: geometry.center.y + animation.position.y },
      transform: normalizeCanvasTransform(layer.canvasTransform)
    })
    for (const point of geometry.quad) {
      minX = Math.min(minX, point.x)
      minY = Math.min(minY, point.y)
      maxX = Math.max(maxX, point.x)
      maxY = Math.max(maxY, point.y)
    }
  }

  if (!items.length) return null
  const bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  if (!Object.values(bounds).every(Number.isFinite)) return null
  return {
    bounds,
    center: { x: minX + bounds.width / 2, y: minY + bounds.height / 2 },
    items
  }
}

/** 整组选区只做等比缩放，避免旋转后的非等比缩放产生现有模型无法表达的额外倾斜。 */
export function applyGroupTransform(
  snapshot: GroupTransformSnapshot,
  delta: GroupTransformDelta
): Record<string, CanvasTransform> {
  const x = finite(delta.x, 0)
  const y = finite(delta.y, 0)
  const scale = finite(delta.scale, 1)
  const rotation = finite(delta.rotation, 0)
  const identity = x === 0 && y === 0 && scale === 1 && rotation === 0
  const cos = Math.cos(rotation) * scale
  const sin = Math.sin(rotation) * scale

  return Object.fromEntries(snapshot.items.map(item => {
    const original = item.transform
    if (identity) return [item.id, { ...original }]

    const relativeX = item.baseCenter.x + original.x - snapshot.center.x
    const relativeY = item.baseCenter.y + original.y - snapshot.center.y
    return [item.id, {
      // 以原偏移加中心位移差，避免纯平移时大世界坐标相减吞掉微小偏移。
      x: original.x + (cos - 1) * relativeX - sin * relativeY + x,
      y: original.y + sin * relativeX + (cos - 1) * relativeY + y,
      scaleX: original.scaleX * scale,
      scaleY: original.scaleY * scale,
      rotation: original.rotation + rotation
    }]
  }))
}
