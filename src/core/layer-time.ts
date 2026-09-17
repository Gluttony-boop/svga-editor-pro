import type { Layer } from '@/types'

/** 旧工程无偏移；无效偏移不能把取帧索引变成小数或 NaN。 */
export function getLayerTimeOffset(layer: Pick<Layer, 'timeOffsetFrames'>): number {
  return Number.isSafeInteger(layer.timeOffsetFrames) ? layer.timeOffsetFrames! : 0
}

export function getLayerSourceFrame(layer: Pick<Layer, 'timeOffsetFrames'>, outputFrame: number): number {
  return Math.floor(outputFrame) - getLayerTimeOffset(layer)
}

/** 结束帧为排他边界，便于直接用于时间轴宽度和可见性判断。 */
export function getLayerOutputRange(layer: Pick<Layer, 'clip' | 'timeOffsetFrames'>): { startFrame: number; endFrame: number } {
  const startFrame = layer.clip.startFrame + getLayerTimeOffset(layer)
  return { startFrame, endFrame: startFrame + layer.clip.duration }
}
