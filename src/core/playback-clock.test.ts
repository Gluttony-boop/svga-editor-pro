import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startPlaybackClock } from './playback-clock'

describe('预览播放时钟', () => {
  let nextFrame: FrameRequestCallback | null
  let hidden: boolean
  let cancelFrame: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    nextFrame = null
    hidden = false
    cancelFrame = vi.fn()
    vi.stubGlobal('document', { get hidden() { return hidden } })
    vi.stubGlobal('window', {
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => { nextFrame = callback; return 1 }),
      cancelAnimationFrame: cancelFrame,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('模块 Worker 同步创建失败仍可前台播放，后台使用定时器兜底', () => {
    vi.stubGlobal('Worker', vi.fn(() => { throw new Error('SecurityError') }))
    const tick = vi.fn()
    const stop = startPlaybackClock(tick)
    expect(tick).toHaveBeenCalledTimes(1)
    nextFrame?.(16)
    expect(tick).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(32)
    expect(tick).toHaveBeenCalledTimes(2)
    hidden = true
    vi.advanceTimersByTime(32)
    expect(tick).toHaveBeenCalledTimes(4)
    stop()
    stop()
    vi.advanceTimersByTime(32)
    expect(tick).toHaveBeenCalledTimes(4)
    expect(cancelFrame).toHaveBeenCalledOnce()
  })

  it('模块 Worker 异步启动失败自动回退，不影响 RAF', () => {
    const terminate = vi.fn()
    const worker = { onmessage: null as (() => void) | null, onerror: null as ((event: { preventDefault: () => void }) => void) | null, postMessage: vi.fn(), terminate }
    const WorkerMock = vi.fn(() => worker)
    vi.stubGlobal('Worker', WorkerMock)
    const tick = vi.fn()
    const stop = startPlaybackClock(tick)
    expect(WorkerMock.mock.calls[0]).toEqual([expect.any(URL), { type: 'module', name: 'svga-playback-clock' }])
    expect(String((WorkerMock.mock.calls[0] as unknown[])[0])).not.toContain('blob:')
    hidden = true
    worker.onmessage?.()
    expect(tick).toHaveBeenCalledTimes(2)
    worker.onerror?.({ preventDefault: vi.fn() })
    expect(terminate).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(16)
    expect(tick).toHaveBeenCalledTimes(3)
    nextFrame?.(16)
    expect(tick).toHaveBeenCalledTimes(4)
    stop()
  })

  it('关闭 Worker 时仍可播放，停止后不再响应旧回调', () => {
    const WorkerMock = vi.fn()
    vi.stubGlobal('Worker', WorkerMock)
    const tick = vi.fn()
    const stop = startPlaybackClock(tick, false)
    expect(WorkerMock).not.toHaveBeenCalled()
    stop()
    nextFrame?.(16)
    expect(tick).toHaveBeenCalledOnce()
  })
})
