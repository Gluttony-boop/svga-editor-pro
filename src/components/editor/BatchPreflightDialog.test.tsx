import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEditorStore } from '@/stores'
import { BatchPreflightDialog } from './BatchPreflightDialog'

vi.mock('@/stores', async () => {
  const actual = await vi.importActual<typeof import('@/stores')>('@/stores')
  return { ...actual, useEditorStore: Object.assign(() => actual.useEditorStore.getState(), actual.useEditorStore) }
})
const render = (initialKey?: string) => renderToStaticMarkup(<BatchPreflightDialog initialKey={initialKey} onClose={() => {}} />)
const button = (html: string, label: string) => html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(value => value.includes(label))
const frame = () => ({ alpha: 1, transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, clipPath: null, layout: { x: 0, y: 0, width: 100, height: 40 } })
const open = () => {
  useEditorStore.getState().setVideoItem({
    movie: { version: '2.0', params: { viewBoxWidth: 100, viewBoxHeight: 40, frames: 1, fps: 24 }, images: {}, sprites: [
      { imageKey: 'title$', matteKey: null, frames: [frame()] },
      { imageKey: 'mask.matte', matteKey: null, frames: [frame()] },
    ] }, buffers: {}, images: {},
  })
}
afterEach(() => useEditorStore.getState().reset())

describe('批量生产入口与只读边界（SSR）', () => {
  it('无当前工程也能选择独立模板或恢复任务，不能跳过准备流程', () => {
    const html = render()
    expect(button(html, '使用当前工程作为模板')).toContain('disabled=""')
    expect(button(html, '下一步：导入数据')).toContain('disabled=""')
    expect(button(html, '选择 .svgaproj 模板…')).not.toContain('disabled=""')
    expect(button(html, '恢复生产任务…')).not.toContain('disabled=""')
    expect(html).not.toContain('生成批量交付')
    expect(html).toContain('没有打开动画也可以导入模板或恢复任务')
  })
  it('展示完整四步流程，打开工程也要明确选择模板', () => {
    open()
    const html = render('title$')
    expect(html).toContain('aria-label="批量生产"')
    expect(html).toContain('aria-label="批量生产步骤"')
    for (const step of ['选择模板', '导入数据', '核对预览', '生成结果']) expect(html).toContain(step)
    expect(button(html, '使用当前工程作为模板')).not.toContain('disabled=""')
    expect(html).not.toContain('aria-label="批量清单内容"')
    expect(html).toContain('aria-current="step"')
  })
  it('不把预检当作导出、像素溢出或自动恢复验收', () => {
    open()
    const before = useEditorStore.getState()
    const html = render('title$')
    expect(html).toContain('全部在本机处理，不上传素材')
    expect(html).toContain('原工程及撤销历史不变')
    expect(html).toContain('尚不支持崩溃恢复')
    expect(html).toContain('任务文件 .svgabatch 包含可编辑源快照')
    expect(html).toContain('请勿直接分享')
    expect(html).not.toContain('name="batch-output-mode" checked')
    expect(useEditorStore.getState()).toBe(before)
  })
  it('收起显示会话入口，不留下遮挡画布的模态框', () => {
    open()
    const html = renderToStaticMarkup(<BatchPreflightDialog isOpen={false} onClose={() => {}} onOpen={() => {}} onDiscard={() => {}} />)
    expect(html).toContain('批量生产会话')
    expect(html).not.toContain('role="dialog"')
    expect(html).toContain('继续批量生产')
    expect(html).toContain('丢弃批量会话')
    expect(html).toContain('不改变当前画布')
    expect(html).not.toContain('应用首条文案')
  })
})
