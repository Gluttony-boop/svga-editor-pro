import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskStarter, StarterTaskGuide } from './TaskStarter'

afterEach(() => { vi.unstubAllGlobals() })
describe('首页任务入口', () => {
  it('首次展示四个任务、原创授权、直接打开与跳过', () => {
    const html = renderToStaticMarkup(<TaskStarter onStart={vi.fn()} />)
    for (const text of ['换头像昵称', '压缩到指定大小', '批量生成', '检查交付', 'CC0', '打开动画 / 工程', '跳过任务入口']) expect(html).toContain(text)
  })
  it('记住跳过，但保留找回入口且不自动加载示例', () => {
    const start = vi.fn()
    vi.stubGlobal('localStorage', { getItem: () => 'true' })
    const html = renderToStaticMarkup(<TaskStarter onStart={start} />)
    expect(html).toContain('显示任务入口')
    expect(html).not.toContain('示例：')
    expect(start).not.toHaveBeenCalled()
  })
  it('禁用本地存储也能显示入口', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') } })
    expect(renderToStaticMarkup(<TaskStarter onStart={vi.fn()} />)).toContain('先完成一件事')
  })
  it('任务指引说明压缩不自动保证达标、交付需目标设备实测', () => {
    expect(renderToStaticMarkup(<StarterTaskGuide task="compress" onContinue={vi.fn()} onClose={vi.fn()} />)).toContain('不会自动保证达标')
    expect(renderToStaticMarkup(<StarterTaskGuide task="delivery" onContinue={vi.fn()} onClose={vi.fn()} />)).toContain('不代替目标设备实测')
  })
})
