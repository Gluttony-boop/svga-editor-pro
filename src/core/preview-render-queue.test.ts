import { describe, expect, it, vi } from 'vitest'
import { PreviewRenderQueue } from './preview-render-queue'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('实时预览请求队列', () => {
  it('替换图加载期间仅保留最新帧，旧图解码完成不能覆盖新状态', async () => {
    const load = deferred()
    const painted: number[] = []
    const started: number[] = []
    const queue = new PreviewRenderQueue<number>(async (frame, isCurrent) => {
      started.push(frame)
      if (frame === 1) await load.promise
      if (isCurrent()) painted.push(frame)
    })
    queue.request(1)
    queue.request(2)
    queue.request(3)
    expect(started).toEqual([1])
    load.resolve()
    await vi.waitFor(() => expect(painted).toEqual([3]))
    expect(started).toEqual([1, 3])
  })

  it('切文件、开始播放或卸载时使进行中任务与排队任务失效', async () => {
    const load = deferred()
    const painted: number[] = []
    const queue = new PreviewRenderQueue<number>(async (frame, isCurrent) => {
      await load.promise
      if (isCurrent()) painted.push(frame)
    })
    queue.request(1)
    queue.request(2)
    queue.invalidate()
    load.resolve()
    await load.promise
    await Promise.resolve()
    expect(painted).toEqual([])
    queue.request(5)
    await vi.waitFor(() => expect(painted).toEqual([5]))
  })

  it('过期任务失败不报错，也不阻塞最新任务', async () => {
    const load = deferred()
    const onError = vi.fn()
    const painted: number[] = []
    const queue = new PreviewRenderQueue<number>(async (frame) => {
      if (frame === 1) { await load.promise; throw new Error('旧图片失效') }
      painted.push(frame)
    }, onError)
    queue.request(1)
    queue.request(2)
    load.resolve()
    await vi.waitFor(() => expect(painted).toEqual([2]))
    expect(onError).not.toHaveBeenCalled()
  })

  it('当前请求失败可报告原因，之后仍可渲染', async () => {
    const onError = vi.fn()
    const painted: number[] = []
    const queue = new PreviewRenderQueue<number>(async (frame) => {
      if (frame === 1) throw new Error('图片读取失败')
      painted.push(frame)
    }, onError)
    queue.request(1)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
    queue.request(2)
    await vi.waitFor(() => expect(painted).toEqual([2]))
  })
})
