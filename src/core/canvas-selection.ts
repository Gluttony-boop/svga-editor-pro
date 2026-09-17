import type { FrameData } from '@/types'
import { getFrameTransform } from './layer-transform'

/** 命中使用完整仿射矩阵求逆，保留导入动画中的倾斜和镜像。 */
export function pointInFrame(point: { x: number; y: number }, frame: FrameData, width: number, height: number): boolean {
  const m = getFrameTransform(frame)
  const det = m.a * m.d - m.b * m.c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-10) return false
  const px = point.x - m.tx, py = point.y - m.ty
  const x = (m.d * px - m.c * py) / det, y = (-m.b * px + m.a * py) / det
  return x >= 0 && x <= width && y >= 0 && y <= height
}

export function canvasPoint(client: { x: number; y: number }, rect: { left: number; top: number; width: number; height: number }, size: { width: number; height: number }, zoom: number, offset: { x: number; y: number }) {
  return { x: (client.x - rect.left - rect.width / 2 - offset.x) / zoom + size.width / 2,
    y: (client.y - rect.top - rect.height / 2 - offset.y) / zoom + size.height / 2 }
}
