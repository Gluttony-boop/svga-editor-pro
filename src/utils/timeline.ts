export const TIMELINE_GUTTER = 128
export function clampFrame(frame: number, total: number): number {
  return Math.max(0, Math.min(Math.max(0, Math.floor(total) - 1), Number.isFinite(frame) ? Math.floor(frame) : 0))
}
export function frameAtPointer(clientX: number, viewportLeft: number, scrollLeft: number, frameWidth: number, total: number): number {
  return clampFrame((clientX - viewportLeft - TIMELINE_GUTTER + scrollLeft) / frameWidth, total)
}
export function rulerStep(frameWidth: number, total?: number): number {
  const labelWidth = total === undefined ? 64 : Math.max(24, String(Math.max(1, total)).length * 7 + 12)
  const target = labelWidth / Math.max(0.000001, frameWidth)
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, target)))
  return [1, 2, 5, 10].map(value => value * magnitude).find(value => value >= target) || magnitude * 10
}
export function zoomScroll(anchorFrame: number, anchorX: number, newFrameWidth: number, viewportWidth: number, total: number): number {
  return Math.max(0, Math.min(Math.max(0, total * newFrameWidth - viewportWidth), anchorFrame * newFrameWidth - anchorX))
}
export function fitFrameWidth(viewportWidth: number, total: number): number {
  return Math.max(0.000001, Math.max(1, viewportWidth - TIMELINE_GUTTER - 12) / Math.max(1, total))
}
export function timelineRulerFrames(start: number, end: number, total: number, frameWidth: number): number[] {
  if (total < 1 || !Number.isFinite(total) || !Number.isFinite(frameWidth) || frameWidth <= 0) return []
  const step = rulerStep(frameWidth, total), ticks: number[] = []
  const last = Math.floor(total) - 1
  for (let frame = Math.ceil(Math.max(0, start) / step) * step; frame <= Math.min(end, last); frame += step) ticks.push(frame)
  if (last >= start && last <= end) {
    const gap = Math.max(24, String(total).length * 7 + 12)
    if (ticks[ticks.length - 1] === last) ticks.pop()
    // The final label aligns left of its tick when columns are too narrow.
    const requiredGap = frameWidth < gap ? gap * 2 : gap
    while (ticks.length > 1 && (last - ticks[ticks.length - 1]) * frameWidth < requiredGap) ticks.pop()
    ticks.push(last)
  }
  return ticks
}
export function clipRange(start: number, duration: number, total: number) {
  const left = Math.max(0, Math.min(total, start))
  return { start: left, end: Math.max(left, Math.min(total, start + Math.max(0, duration))) }
}
