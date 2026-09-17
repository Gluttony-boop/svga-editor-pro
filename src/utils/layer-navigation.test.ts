import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listenForLayerReveal, requestLayerReveal } from './layer-navigation'

class TestCustomEvent<T> extends Event {
  readonly detail: T

  constructor(type: string, init: CustomEventInit<T> = {}) {
    super(type, init)
    this.detail = init.detail as T
  }
}

describe('跨面板图层定位', () => {
  beforeEach(() => {
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('CustomEvent', TestCustomEvent)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('派发包含图层 ID 的事件并同步通知订阅者', () => {
    const onReveal = vi.fn()
    const onEvent = vi.fn()
    const cleanup = listenForLayerReveal(onReveal)
    window.addEventListener('svga-reveal-layer', onEvent)

    requestLayerReveal('layer-avatar')

    expect(onReveal).toHaveBeenCalledOnce()
    expect(onReveal).toHaveBeenCalledWith('layer-avatar')
    expect(onEvent).toHaveBeenCalledOnce()
    expect(onEvent.mock.calls[0][0].detail).toEqual({ id: 'layer-avatar' })
    cleanup()
  })

  it('忽略缺少合法字符串 ID 的事件', () => {
    const onReveal = vi.fn()
    const cleanup = listenForLayerReveal(onReveal)

    window.dispatchEvent(new Event('svga-reveal-layer'))
    for (const detail of [undefined, null, {}, { id: null }, { id: 1 }, { id: {} }]) {
      window.dispatchEvent(new CustomEvent('svga-reveal-layer', { detail }))
    }
    window.dispatchEvent(new CustomEvent('another-event', { detail: { id: 'ignored' } }))

    expect(onReveal).not.toHaveBeenCalled()
    cleanup()
  })

  it('清理可重复执行，只移除自身监听器，不影响其他订阅者', () => {
    const first = vi.fn()
    const second = vi.fn()
    const cleanupFirst = listenForLayerReveal(first)
    const cleanupSecond = listenForLayerReveal(second)

    requestLayerReveal('before-cleanup')
    cleanupFirst()
    cleanupFirst()
    requestLayerReveal('after-cleanup')

    expect(first).toHaveBeenCalledOnce()
    expect(first).toHaveBeenCalledWith('before-cleanup')
    expect(second.mock.calls).toEqual([['before-cleanup'], ['after-cleanup']])
    cleanupSecond()
    requestLayerReveal('after-all-cleanup')
    expect(second).toHaveBeenCalledTimes(2)
  })
})
