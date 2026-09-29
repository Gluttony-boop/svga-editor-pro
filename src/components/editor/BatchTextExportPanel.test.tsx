import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BATCH_TEMPLATE_FORMAT, createBatchQueue } from '@/core/batch-variants'
import { BatchTextExportPanel } from './BatchTextExportPanel'
import type { useBatchTextExport } from './use-batch-text-export'

type Controller = ReturnType<typeof useBatchTextExport>
const controller = (overrides: Partial<Controller> = {}): Controller => ({
  mode: 'bake', setMode: vi.fn(), view: null, busy: false, phase: '', execute: vi.fn(async () => {}), save: vi.fn(async () => {}),
  clear: vi.fn(), openTask: vi.fn(async () => false), saveTask: vi.fn(async () => {}), restored: false,
  isBusy: () => false, canDiscard: () => true, cancel: vi.fn(), canCancel: false, stale: false, ready: true,
  selectedId: null, select: vi.fn(), selected: undefined, ...overrides,
})
const button = (html: string, label: string) => html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(value => value.includes(label))

describe('批量生产结果页门槛（SSR）', () => {
  it('尚未确认真实样本不能直接生成，即使模板数据已经通过', () => {
    const html = renderToStaticMarkup(<BatchTextExportPanel controller={controller()} showSetup={false} generationAllowed={false} />)
    expect(button(html, '生成批量交付')).toContain('disabled=""')
    expect(html).toContain('4. 生成结果')
    expect(html).toContain('固定字形 · 文字写入 SVGA 图片')
    expect(html).not.toContain('name="batch-output-mode"')
  })
  it('完成核对后允许生成，模式仍明确展示', () => {
    const html = renderToStaticMarkup(<BatchTextExportPanel controller={controller({ mode: 'dynamic' })} showSetup={false} generationAllowed />)
    expect(button(html, '生成批量交付')).not.toContain('disabled=""')
    expect(html).toContain('动态接入 · 文案交给开发，SVGA 不写入所选字形')
    expect(html).toContain('所选模板')
  })
  it('恢复的冻结队列不受当前向导空输入阻塞，仍可继续和保存任务', () => {
    const queue = createBatchQueue({ format: BATCH_TEMPLATE_FORMAT, schemaVersion: 1, name: '冻结模板', slotRules: [{ key: 'title', kind: 'text' }] }, [{ row: 2, id: '001', values: { title: '保存文案' } }])
    const html = renderToStaticMarkup(<BatchTextExportPanel controller={controller({ restored: true, ready: false, view: { queue, mode: 'bake', sourceRevision: 'a'.repeat(64), bytes: 0, busy: false } })} showSetup={false} generationAllowed={false} />)
    expect(button(html, '继续待执行项')).not.toContain('disabled=""')
    expect(button(html, '保存任务文件（可继续）')).not.toContain('disabled=""')
    expect(html).toContain('保存文案')
    expect(html).toContain('当前画布不属于此任务')
  })
})
