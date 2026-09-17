import { describe, expect, it } from 'vitest'
import { canvasPoint, pointInFrame } from './canvas-selection'
import type { FrameData } from '@/types'

describe('画布坐标与命中', () => {
  it('缩放和平移后正确还原画布坐标', () => {
    expect(canvasPoint({ x: 390, y: 280 }, { left: 100, top: 50, width: 400, height: 300 }, { width: 720, height: 760 }, 0.5, { x: 40, y: 30 })).toEqual({ x: 460, y: 480 })
  })
  it('使用倾斜矩阵而不是轴对齐包围框命中', () => {
    const frame = { transform: { a: 1, b: 0, c: 1, d: 1, tx: 100, ty: 100 } } as FrameData
    expect(pointInFrame({ x: 200, y: 150 }, frame, 100, 100)).toBe(true)
    expect(pointInFrame({ x: 101, y: 190 }, frame, 100, 100)).toBe(false)
  })
  it('接受镜像，拒绝零行列式矩阵', () => {
    const frame = { transform: { a: -1, b: 0, c: 0, d: 1, tx: 100, ty: 0 } } as FrameData
    expect(pointInFrame({ x: 50, y: 50 }, frame, 100, 100)).toBe(true)
    expect(pointInFrame({ x: -10, y: 50 }, frame, 100, 100)).toBe(false)
    expect(pointInFrame({ x: 0, y: 0 }, { ...frame, transform: { ...frame.transform, a: 0 } }, 100, 100)).toBe(false)
  })
})
