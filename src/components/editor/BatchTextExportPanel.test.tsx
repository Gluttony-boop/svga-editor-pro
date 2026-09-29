import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BatchTextExportPanel, BatchExportPreview } from './BatchTextExportPanel'
import type { useBatchTextExport } from './use-batch-text-export'
import { BATCH_TEMPLATE_FORMAT, createBatchQueue } from '@/core/batch-variants'

const queue = createBatchQueue({ format: BATCH_TEMPLATE_FORMAT, schemaVersion: 1, name: '恢复', slotRules: [{ key: '<key>', kind: 'text' }] },
  [{ id: '<编号>', row: 1, values: { '<key>': '<script>非 HTML 文案</script>' } }])
const controller = (): ReturnType<typeof useBatchTextExport> => ({
  mode: 'bake', setMode: vi.fn(), view: { mode: 'bake', queue, sourceRevision: 'a'.repeat(64), busy: false, bytes: 0 },
  busy: false, phase: '', execute: vi.fn(), save: vi.fn(), clear: vi.fn(), openTask: vi.fn(), saveTask: vi.fn(), restored: true,
  isBusy: () => false, canDiscard: () => true, cancel: vi.fn(), canCancel: false, stale: false, ready: false,
  selectedId: null, select: vi.fn(), selected: undefined,
})
describe('恢复任务界面边界', () => {
  it('无当前预检仍可保存和继续恢复的队列，并显示原始任务文案而不执行 HTML', () => {
    const html = renderToStaticMarkup(<BatchTextExportPanel controller={controller()} />)
    expect(html).toContain('继续待执行项')
    expect(html).toContain('保存任务文件（可继续）')
    expect(html).toContain('独立恢复的任务')
    expect(html).toContain('字体仍依赖本机安装')
    expect(html).toContain('&lt;script&gt;非 HTML 文案&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('生成批量交付</button>')
  })
  it('恢复的检查元数据不能伪装成本次验证，预览标注为旧图', () => {
    const preview = new Blob(['png'])
    const html = renderToStaticMarkup(<BatchExportPreview result={{ blob: new Blob(['zip']), previewFrame: 0,
      previews: { actual: preview, design: preview }, restored: true,
      checks: [{ id: 'forged', title: '导入文件自称验证通过', status: 'warning', detail: '不可当作本次证据' }] }} />)
    expect(html).toContain('保存的实际产物预览')
    expect(html).toContain('本次未重新渲染、回读 SVGA 或验证内嵌报告')
    expect(html).not.toContain('导入文件自称验证通过')
  })
})
