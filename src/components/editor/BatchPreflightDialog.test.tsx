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

describe('批量文案预检入口与只读边界（SSR）', () => {
  it('未打开工程不能开始检查或导出', () => {
    const html = render()
    expect(button(html, '开始预检')).toContain('disabled=""')
    expect(button(html, '导出预检报告 JSON')).toContain('disabled=""')
    expect(button(html, '生成批量交付')).toContain('disabled=""')
    expect(html).toContain('当前没有可用的文字 Key')
    expect(button(html, '打开任务文件…')).not.toContain('disabled=""')
  })
  it('展示精确 Key、排除遮罩并支持初始化选中', () => {
    open()
    const html = render('title$')
    expect(html).toContain('aria-label="预检 Key：title$" checked=""')
    expect(html).not.toContain('aria-label="预检 Key：mask.matte"')
    expect(html).toContain('批量清单内容')
    expect(html).toContain('填入示例')
  })
  it('不把预检当作导出、像素溢出或自动恢复验收', () => {
    open()
    const before = useEditorStore.getState()
    const html = render('title$')
    expect(html).toContain('不修改动画、不上传素材、不生成 SVGA')
    expect(html).toContain('通过预检不代表文字不会裁切')
    expect(html).toContain('图片批量处理尚未开放')
    expect(html).toContain('动态接入：文案交给开发')
    expect(html).toContain('固定字形：文字写入 SVGA 图片')
    expect(html).toContain('尚不支持崩溃恢复')
    expect(html).toContain('任务文件 .svgabatch 包含可编辑源快照')
    expect(html).toContain('请勿直接分享')
    expect(html).not.toContain('name="batch-output-mode" checked')
    expect(useEditorStore.getState()).toBe(before)
  })
  it('收起显示会话入口，不留下遮挡画布的模态框', () => {
    open()
    const html = renderToStaticMarkup(<BatchPreflightDialog isOpen={false} onClose={() => {}} onOpen={() => {}} onDiscard={() => {}} />)
    expect(html).toContain('批量文案会话')
    expect(html).not.toContain('role="dialog"')
    expect(html).toContain('展开清单')
    expect(html).toContain('丢弃清单')
    expect(html).toContain('丢弃清单不撤销已应用文案')
    expect(button(html, '上一条文案')).toContain('disabled=""')
    expect(button(html, '应用首条文案')).toContain('disabled=""')
  })
})
