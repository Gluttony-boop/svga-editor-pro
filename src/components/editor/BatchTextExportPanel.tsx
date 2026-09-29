import React from 'react'
import { Button } from '@/components/ui'
import type { BatchTextResult } from '@/core/batch-text-export'
import type { useBatchTextExport } from './use-batch-text-export'

type ExportController = ReturnType<typeof useBatchTextExport>
const labels = { queued: '待执行', running: '生成中', succeeded: '已生成', failed: '失败', cancelled: '已停止' }

function Preview({ blob, label }: { blob: Blob; label: string }) {
  const [url, setUrl] = React.useState('')
  React.useEffect(() => { const value = URL.createObjectURL(blob); setUrl(value); return () => URL.revokeObjectURL(value) }, [blob])
  return <figure className="min-w-0"><img src={url || undefined} alt={label} className="h-36 w-full rounded border border-border bg-bg-tertiary object-contain" /><figcaption className="mt-1 text-xs">{label}</figcaption></figure>
}

export function BatchExportPreview({ result }: { result: BatchTextResult }) {
  return <div className="space-y-2">
    <div className="grid grid-cols-2 gap-3"><Preview blob={result.previews.actual} label={result.restored ? '保存的实际产物预览' : '实际 SVGA 回读'} /><Preview blob={result.previews.design} label={result.restored ? '保存的设计模拟图' : '设计模拟参考'} /></div>
    <p className="text-[11px] text-text-muted">第 {result.previewFrame + 1} 帧；不是全帧或目标 SDK 验收。动态模式左图不会叠加所选文案；右图包含模拟文字。</p>
    {result.restored ? <p role="alert" className="text-xs text-warning">这是任务文件内保存的旧预览和旧交付包，仅核对了存储摘要；本次未重新渲染、回读 SVGA 或验证内嵌报告。SHA-256 不是签名，请仅使用可信来源的任务。</p> :
      <details className="text-xs text-text-secondary"><summary className="cursor-pointer">优化提醒与未测项</summary><ul className="mt-2 space-y-1">{result.checks.filter(check => check.status !== 'passed').map(check => <li key={check.id}>{check.title}：{check.detail}</li>)}</ul></details>}
  </div>
}

export function BatchTextExportPanel({ controller: c, disabled = false }: { controller: ExportController; disabled?: boolean }) {
  const items = c.view?.queue.items ?? []
  const successes = items.filter(item => item.status === 'succeeded').length
  const failures = items.filter(item => item.status === 'failed').length
  const stopped = items.filter(item => item.status === 'cancelled').length
  const queued = items.filter(item => item.status === 'queued').length
  const taskInput = React.useRef<HTMLInputElement>(null)
  return <section aria-label="批量文字交付" className="space-y-3 rounded border border-border p-3" aria-busy={c.busy}>
    <h3 className="text-sm font-medium">3. 批量文字交付</h3>
    <p className="text-xs text-text-secondary">最多 100 条，逐条生成实际 SVGA、Key 清单、双预览与检查报告。所有行须通过预检；不修改画布、工程和撤销历史，不上传素材。</p>
    <div className="flex flex-wrap gap-2">
      <Button disabled={disabled || c.busy} onClick={() => taskInput.current?.click()}>打开任务文件…</Button>
      {c.view && <Button disabled={disabled || c.busy} onClick={() => void c.saveTask()}>保存任务文件（可继续）</Button>}
      <input ref={taskInput} type="file" accept=".svgabatch" aria-label="打开批量任务文件" className="hidden" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (file) void c.openTask(file)
      }} />
    </div>
    <p className="text-[11px] text-text-muted">任务文件 .svgabatch 包含可编辑源快照、原始文案和成功产物，不是客户交付 ZIP，请勿直接分享。打开任务不需预先导入原 SVGA，续跑不会混入当前画布。</p>
    <fieldset disabled={disabled || c.busy || !!c.view} className="space-y-2 text-xs">
      <legend className="mb-2">明确选择本批所选 Key 的输出方式</legend>
      <label className="flex gap-2"><input type="radio" name="batch-output-mode" checked={c.mode === 'dynamic'} onChange={() => c.setMode('dynamic')} />动态接入：文案交给开发，SVGA 不写入所选字形</label>
      <label className="flex gap-2"><input type="radio" name="batch-output-mode" checked={c.mode === 'bake'} onChange={() => c.setMode('bake')} />固定字形：文字写入 SVGA 图片，播放器不可动态改字</label>
    </fieldset>
    <p className="text-[11px] text-text-muted">{c.view ? '沿用任务快照中的' : '沿用当前'}字体、显示范围、图片和优化设置，关闭跨 Key 去重。其他 Key 保持原设置；长文案仍可能裁切，请抽样核对。</p>
    <div className="flex flex-wrap gap-2">
      {!c.view && <Button disabled={disabled || c.busy || !c.ready || !c.mode} onClick={() => void c.execute('start')}>生成批量交付</Button>}
      {!!failures && <Button disabled={disabled || c.busy} onClick={() => void c.execute('retry-failed')}>仅重试失败项</Button>}
      {!!stopped && <Button disabled={disabled || c.busy} onClick={() => void c.execute('resume-cancelled')}>继续已停止项</Button>}
      {!!queued && !stopped && <Button disabled={disabled || c.busy} onClick={() => void c.execute('start')}>继续待执行项</Button>}
      {c.canCancel && <Button onClick={c.cancel}>停止当前任务</Button>}
      {!!successes && <Button variant="primary" disabled={disabled || c.busy} onClick={() => void c.save()}>保存已完成 ZIP（{successes}）</Button>}
      {c.view && <Button disabled={disabled || c.busy} onClick={c.clear}>释放结果 / 新建任务</Button>}
    </div>
    {c.phase && <p role="status" className="text-xs text-warning">{c.phase}</p>}
    {c.view && <>
      <p className="text-xs">{items.length} 条 · {successes} 已生成 · {failures} 失败 · {stopped} 已停止</p>
      <p className="break-all text-[11px] text-text-muted">源快照 SHA-256：{c.view.sourceRevision.slice(0, 16)}… · {c.view.mode === 'bake' ? '固定字形' : '动态接入'} · 重试沿用此快照，不混入后续修改。</p>
      {c.restored && <p className="text-xs text-warning">独立恢复的任务：上方清单输入与当前画布不属于此任务，继续生成使用文件中保存的文案、模式和源工程。字体仍依赖本机安装，跨设备续跑请核对字体。</p>}
      {c.stale && <p role="alert" className="text-xs text-warning">当前工程或清单已变化，以下结果属于此前快照。可保存旧结果；需要新编辑内容时请释放结果、重新预检并生成。</p>}
      <div className="max-h-56 overflow-auto"><table className="w-full text-left text-xs"><thead><tr><th className="p-1">记录 / 编号</th><th className="p-1">状态</th><th className="p-1">核对</th></tr></thead><tbody>
        {items.map(item => <tr key={item.row.id} className="border-t border-border"><td className="max-w-40 break-all p-1">{item.row.row} / {item.row.id}
          <details><summary className="cursor-pointer text-text-muted">任务文案</summary><dl>{Object.entries(item.row.values).map(([key, value]) => <React.Fragment key={key}><dt className="whitespace-pre-wrap font-mono text-accent">{key}</dt><dd className="whitespace-pre-wrap">{typeof value === 'string' ? value : '（非文字）'}</dd></React.Fragment>)}</dl></details>
        </td><td className="max-w-80 break-all p-1">{labels[item.status]} · {item.attempts} 次{item.issues?.map((issue, i) => <p key={i} className="text-warning">{issue.message}</p>)}</td><td className="p-1"><Button size="sm" disabled={c.busy || item.status !== 'succeeded'} onClick={() => c.select(item.row.id)}>查看产物</Button></td></tr>)}
      </tbody></table></div>
      {c.selected && <div className="space-y-2"><p className="break-all text-xs">核对编号：{c.selectedId}</p><BatchExportPreview result={c.selected} /><Button size="sm" disabled={c.busy || disabled} onClick={() => void c.save(c.selectedId!)}>保存此条交付 ZIP</Button></div>}
    </>}
    <p className="text-[11px] text-text-muted">未保存的任务暂存内存；刷新、关闭程序或丢弃清单会丢失，尚不支持崩溃恢复。需要下次继续，请先停止生成并保存任务文件；恢复点仅到上次手动保存。交付 ZIP 不能恢复任务，部分成功不会冒充全部完成。</p>
  </section>
}
