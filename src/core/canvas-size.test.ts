import { describe, expect, it } from 'vitest'
import type { MovieParams } from '@/types'
import { getCanvasSizeError, getCanvasSizeFromParams, replaceCanvasSize } from './canvas-size'

describe('画布尺寸校验', () => {
  it('接受有效整数和边界尺寸', () => {
    expect(getCanvasSizeError({ width: 1, height: 1 })).toBeNull()
    expect(getCanvasSizeError({ width: 8192, height: 512 })).toBeNull()
    expect(getCanvasSizeError({ width: 2048, height: 2048 })).toBeNull()
  })

  it.each([
    [{ width: 0, height: 100 }, '至少'],
    [{ width: 100.5, height: 100 }, '整数'],
    [{ width: 8193, height: 1 }, '单边'],
    [{ width: 2049, height: 2048 }, '像素'],
    [{ width: Number.NaN, height: 100 }, '整数'],
    [{ width: Number.POSITIVE_INFINITY, height: 100 }, '整数']
  ] as const)('拒绝非法尺寸 %#', (size, message) => {
    expect(getCanvasSizeError(size)).toContain(message)
  })

  it('替换尺寸保留帧率和帧数且不修改原参数', () => {
    const original: MovieParams = { viewBoxWidth: 100, viewBoxHeight: 80, fps: 30, frames: 42 }
    const next = replaceCanvasSize(original, { width: 320, height: 240 })
    expect(next).toEqual({ viewBoxWidth: 320, viewBoxHeight: 240, fps: 30, frames: 42 })
    expect(original).toEqual({ viewBoxWidth: 100, viewBoxHeight: 80, fps: 30, frames: 42 })
    expect(getCanvasSizeFromParams(null)).toBeNull()
    expect(getCanvasSizeFromParams(original)).toEqual({ width: 100, height: 80 })
  })
})
