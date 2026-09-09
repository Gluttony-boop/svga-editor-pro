import { describe, expect, it } from 'vitest'
import { clampFrame, frameAtPointer, rulerStep, zoomScroll, fitFrameWidth, clipRange, timelineRulerFrames } from './timeline'
describe('timeline coordinates', () => {
  it('counts horizontal scroll exactly once relative to the viewport', () => {
    expect(frameAtPointer(278, 100, 200, 10, 100)).toBe(25)
    expect(frameAtPointer(278, 100, 0, 10, 100)).toBe(5)
  })
  it('clamps seeks and invalid input', () => {
    expect(clampFrame(-5, 20)).toBe(0)
    expect(clampFrame(99, 20)).toBe(19)
    expect(clampFrame(NaN, 20)).toBe(0)
    expect(clampFrame(5, 0)).toBe(0)
  })
  it('anchors zoom and clamps near the end', () => {
    expect(zoomScroll(50, 100, 20, 400, 100)).toBe(900)
    expect(zoomScroll(90, 100, 5, 400, 100)).toBe(100)
    expect(zoomScroll(0, 100, 20, 400, 100)).toBe(0)
  })
  it('chooses readable ticks even on long movies', () => {
    expect(rulerStep(10)).toBe(10)
    expect(rulerStep(1)).toBe(100)
    expect(rulerStep(0.02)).toBe(5000)
  })
  it('fits excluding the frozen layer column', () => {
    expect(fitFrameWidth(640, 100)).toBe(5)
    expect(fitFrameWidth(640, 1)).toBe(500)
    expect(fitFrameWidth(640, 100000)*100000).toBe(500)
  })
  it('fills a wide timeline for the 10-frame screenshot case', () => {
    expect(fitFrameWidth(1143, 10) * 10).toBe(1003)
  })
  it('shows every frame for a short fitted movie, including the final frame', () => {
    expect(timelineRulerFrames(0, 9, 10, 100)).toEqual([0,1,2,3,4,5,6,7,8,9])
    expect(timelineRulerFrames(0, 0, 1, 500)).toEqual([0])
  })
  it('keeps tick count bounded and final labels separated when zoomed out', () => {
    const ticks = timelineRulerFrames(0, 99999, 100000, 0.005)
    expect(ticks[0]).toBe(0)
    expect(ticks[ticks.length - 1]).toBe(99999)
    expect(ticks.length).toBeLessThan(20)
    expect(new Set(ticks).size).toBe(ticks.length)
    expect(timelineRulerFrames(0, 0, 0, 10)).toEqual([])
  })
  it('reserves room for a right-aligned final label, even on a regular tick', () => {
    for (const total of [1000, 1001]) {
      const ticks = timelineRulerFrames(0, total - 1, total, 0.5)
      expect((ticks[ticks.length - 1] - ticks[ticks.length - 2]) * 0.5).toBeGreaterThanOrEqual(80)
    }
  })
  it('clips duration at movie boundaries', () => {
    expect(clipRange(10, 50, 40)).toEqual({start:10,end:40})
    expect(clipRange(50, 10, 40)).toEqual({start:40,end:40})
    expect(clipRange(-5, 10, 40)).toEqual({start:0,end:5})
  })
})
