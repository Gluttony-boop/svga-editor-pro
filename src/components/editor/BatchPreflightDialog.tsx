import React from 'react'
import * as Papa from 'papaparse'
import { Button, Modal } from '@/components/ui'
import { useEditorStore } from '@/stores'
import { buildSlotCatalog } from '@/utils/slot-catalog'
import { captureExportInputs, sameExportInputs } from '@/core/export-preview'
import { createSaveFileTarget } from '@/core/exporter'
import { beginBatchExportActivity } from '@/core/batch-export-activity'
import { MAX_BATCH_JSON_BYTES } from '@/core/batch-variants'
import { captureBatchProductionTemplate, importBatchProductionTemplate, prepareBatchProductionSession } from '@/core/batch-production'
import type { BatchTextSession, BatchTextSource } from '@/core/batch-text-session'
import { BatchExportPreview, BatchOutputModeSelector, BatchTextExportPanel } from './BatchTextExportPanel'
import { useBatchTextExport } from './use-batch-text-export'
import { useBatchProductionPreview } from './use-batch-production-preview'

interface Props {
  onClose: () => void
  initialKey?: string
  isOpen?: boolean
  onOpen?: () => void
  onDiscard?: () => void
}
const field = 'w-full rounded border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent'
const steps = ['选择模板', '导入数据', '核对预览', '生成结果'] as const
const PAGE_SIZE = 50

/** 保留原模块名以兼容懒加载入口；界面和执行语义已升级为独立模板生产流程。 */
export function BatchPreflightDialog({ onClose, initialKey, isOpen = true, onOpen, onDiscard }: Props) {
  const editor = useEditorStore()
  const [step, setStep] = React.useState(1)
  const [template, setTemplate] = React.useState<BatchTextSource | null>(null)
  const document = template?.document
  const catalog = React.useMemo(() => document ? buildSlotCatalog(document.videoItem, document.layers, document.imageResources, document.slotConfigs) : [], [document])
  const eligible = catalog.filter(entry => entry.canSimulateText)
  const [selected, setSelected] = React.useState<string[]>([])
  const [limit, setLimit] = React.useState('20')
  const [format, setFormat] = React.useState<'csv' | 'json'>('csv')
  const [source, setSource] = React.useState('')
  const [prepared, setPrepared] = React.useState<BatchTextSession | null>(null)
  const [notice, setNotice] = React.useState('')
  const [reading, setReading] = React.useState(false)
  const [reportSaving, setReportSaving] = React.useState(false)
  const [page, setPage] = React.useState(0)
  const [onlyIssues, setOnlyIssues] = React.useState(false)
  const [previewRow, setPreviewRow] = React.useState<number | null>(null)
  const batchExport = useBatchTextExport(prepared)
  const preview = useBatchProductionPreview(prepared, previewRow, batchExport.mode)
  const busy = reading || reportSaving || batchExport.busy || preview.busy
  const readJob = React.useRef<AbortController | null>(null)
  const mounted = React.useRef(true)
  const savingRef = React.useRef(false)
  const dataInput = React.useRef<HTMLInputElement>(null)
  const templateInput = React.useRef<HTMLInputElement>(null)
  const taskInput = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; readJob.current?.abort() }
  }, [])
  const isBusy = () => !!readJob.current || savingRef.current || batchExport.isBusy() || preview.isBusy()
  const changedCanvas = !!template?.editorInputs && !sameExportInputs(template.editorInputs, captureExportInputs(editor))
  const canCheck = !!template && !!source.trim() && selected.length > 0 && Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 500 && !busy
  const invalidate = () => { setPrepared(null); setPreviewRow(null); setNotice(''); setPage(0) }
  const close = () => { if (!isBusy()) onClose() }

  const chooseTemplate = async (file?: File) => {
    if (isBusy()) return
    const controller = new AbortController()
    readJob.current = controller
    const finish = beginBatchExportActivity()
    setReading(true); setNotice(file ? '正在安全读取独立模板，当前画布保持不变…' : '正在冻结当前工程为本批模板…')
    try {
      let next: BatchTextSource
      if (file) next = await importBatchProductionTemplate(file, controller.signal)
      else {
        const current = useEditorStore.getState()
        const inputs = captureExportInputs(current)
        const snapshot = current.captureProjectRecovery()
        if (!snapshot) throw new Error('请先打开完整 SVGA，并结束正在进行的文字或画布编辑。')
        next = await captureBatchProductionTemplate(snapshot, inputs, controller.signal)
        if (!sameExportInputs(inputs, captureExportInputs(useEditorStore.getState()))) throw new Error('冻结期间工程已变化，请重新选择当前工程。')
      }
      if (!mounted.current) return
      if (controller.signal.aborted) { setNotice('已取消模板读取，原模板、清单与成果保留。'); return }
      const keys = buildSlotCatalog(next.document.videoItem, next.document.layers, next.document.imageResources, next.document.slotConfigs).filter(entry => entry.canSimulateText)
      const preferred = keys.filter(entry => entry.textConfigured || entry.key === initialKey)
      setTemplate(next); setSelected((preferred.length ? preferred : keys.slice(0, 1)).slice(0, 128).map(entry => entry.key))
      invalidate(); setStep(2)
      setNotice('模板已独立冻结，请按此模板核对 Key。' + (batchExport.view ? '原有清单和第 4 步的旧成果仍保留。' : '下一步导入清单，或填入示例快速体验。'))
    } catch (error) {
      if (mounted.current) setNotice(controller.signal.aborted ? '已取消读取，原模板、清单与成果保留。' : '模板未更换：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      finish(); if (readJob.current === controller) readJob.current = null
      if (mounted.current) setReading(false)
    }
  }
  const readData = async (file: File) => {
    if (isBusy()) return
    if (!/\.(csv|json)$/i.test(file.name) || file.size > MAX_BATCH_JSON_BYTES) { setNotice('请选择不超过 8 MiB 的 UTF-8 CSV 或 JSON 文件；原清单保留。'); return }
    const controller = new AbortController()
    readJob.current = controller; setReading(true)
    try {
      const value = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      if (!mounted.current) return
      if (controller.signal.aborted) { setNotice('已取消清单读取，原清单与成果保留。'); return }
      invalidate(); setFormat(/\.json$/i.test(file.name) ? 'json' : 'csv'); setSource(value)
      setNotice('清单已在本机读取，请核对 Key 后继续。')
    } catch (error) {
      if (mounted.current) setNotice('清单未更换：' + (error instanceof Error ? error.message : String(error)))
    } finally { if (readJob.current === controller) readJob.current = null; if (mounted.current) setReading(false) }
  }
  const sample = () => {
    if (isBusy()) return
    const columns = selected.length ? selected : eligible.slice(0, 1).map(entry => entry.key)
    if (!columns.length) return
    invalidate(); setSelected(columns)
    const values = Object.fromEntries(columns.map(key => [key, '设计师昵称']))
    // 精确 Key 为 id 时改用嵌套 JSON，不让编号列占用真实文字 Key。
    if (format === 'json' || columns.includes('id')) {
      setFormat('json'); setSource(JSON.stringify([{ id: '001', values }, { id: '002', values: Object.fromEntries(columns.map(key => [key, '2222222222222'])) }], null, 2))
    } else setSource(Papa.unparse([['id', ...columns], ['001', ...columns.map(() => '设计师昵称')], ['002', ...columns.map(() => '2222222222222')]]))
  }
  const check = () => {
    if (!template || !canCheck || isBusy()) return
    setNotice(''); setPage(0)
    try {
      const session = prepareBatchProductionSession(template, { format, content: source, keys: selected, limit: Number(limit) })
      setPrepared(session); setPreviewRow(session.rows[0]?.row ?? null)
      if (session.report.valid) { setStep(3); setNotice('数据规则全部通过，请先抽样核对实际效果。') }
      else setNotice('请修正下方问题后重新核对；不会自动跳过失败记录。')
    } catch (error) { setPrepared(null); setNotice(error instanceof Error ? error.message : String(error)) }
  }
  const saveReport = async () => {
    if (!prepared || isBusy()) return
    savingRef.current = true; setReportSaving(true); setNotice('')
    const finish = beginBatchExportActivity()
    try {
      const target = await createSaveFileTarget('batch-text-preflight.json')
      if (!target) { if (mounted.current) setNotice('已取消报告保存。'); return }
      if (!mounted.current) return
      await target(new Blob([JSON.stringify({ format: 'svga-editor-batch-preflight', schemaVersion: 1,
        scope: '仅文案结构、Key、必填和 Unicode 码点长度；未检查像素溢出、字体或目标播放器。',
        sourceRevision: prepared.source?.sourceRevision, template: prepared.template, ...prepared.report }, null, 2)], { type: 'application/json' }))
      if (mounted.current) setNotice('规则报告已交给保存接口；报告不是交付包，也不能恢复清单。')
    } catch (error) { if (mounted.current) setNotice('报告未保存：' + (error instanceof Error ? error.message : String(error))) }
    finally { finish(); savingRef.current = false; if (mounted.current) setReportSaving(false) }
  }
  const openTask = async (file: File) => {
    if (isBusy()) return
    if (await batchExport.openTask(file) && mounted.current) { setStep(4); setNotice('') }
  }
  const reportRows = prepared?.report.rows.filter(row => !onlyIssues || !row.valid) ?? []
  const currentPage = Math.min(page, Math.max(0, Math.ceil(reportRows.length / PAGE_SIZE) - 1))
  const stepAvailable = (value: number) => value === 1 || value === 2 && !!template || value === 3 && !!prepared?.report.valid || value === 4 && (!!batchExport.view || preview.confirmed)

  if (!isOpen) return <section aria-label="批量生产会话" className="rounded border border-border bg-bg-tertiary p-2 space-y-2">
    <p className="text-xs">批量生产 · {batchExport.view ? `${batchExport.view.queue.items.length} 条任务` : prepared ? `${prepared.rows.length} 条数据` : template ? '已选择模板' : '尚未选择模板'}</p>
    {template && <p className="break-all text-xs text-text-secondary">独立模板：{template.name}，不受当前画布切换影响。</p>}
    <div className="flex flex-wrap gap-1"><Button size="sm" onClick={onOpen}>继续批量生产</Button><Button size="sm" disabled={busy} onClick={() => { if (!isBusy() && batchExport.canDiscard()) onDiscard?.() }}>丢弃批量会话</Button></div>
    <p className="text-[11px] text-text-muted">未保存的数据和结果仅保留在内存。需要下次继续，请在生成结果中保存 .svgabatch 任务文件；不改变当前画布。</p>
  </section>

  return <Modal isOpen isolateKeyboard onClose={close} title="批量生产" className="!max-w-4xl" footer={
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <Button disabled={busy} onClick={close}>收起并保留任务</Button>
      <div className="flex gap-2">
        {step > 1 && <Button disabled={busy} onClick={() => setStep(stepAvailable(step - 1) ? step - 1 : 1)}>上一步</Button>}
        {step === 1 && <Button variant="primary" disabled={!template || busy} onClick={() => setStep(2)}>下一步：导入数据</Button>}
        {step === 2 && <Button variant="primary" disabled={!canCheck} onClick={check}>核对数据并预览</Button>}
        {step === 3 && <Button variant="primary" disabled={!preview.confirmed || busy} onClick={() => setStep(4)}>下一步：生成结果</Button>}
      </div>
    </div>
  }>
    <div className="space-y-4">
      <nav aria-label="批量生产步骤" className="grid grid-cols-4 gap-2">
        {steps.map((label, index) => <button key={label} type="button" disabled={busy || !stepAvailable(index + 1)} onClick={() => setStep(index + 1)} aria-current={step === index + 1 ? 'step' : undefined}
          className={'rounded border p-2 text-left text-xs disabled:opacity-40 ' + (step === index + 1 ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary')}>
          <span className="block text-[10px]">步骤 {index + 1}</span>{label}
        </button>)}
      </nav>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-text-secondary">模板与生产独立于画布，全部在本机处理，不上传素材。</p>
        <Button size="sm" disabled={busy} onClick={() => taskInput.current?.click()}>恢复生产任务…</Button>
        <input ref={taskInput} type="file" accept=".svgabatch" aria-label="恢复批量生产任务" className="hidden" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void openTask(file) }} />
      </div>
      {notice && <p role="status" className="text-xs text-warning">{notice}</p>}
      {reading && <Button size="sm" onClick={() => readJob.current?.abort()}>取消读取</Button>}
      {batchExport.phase && step !== 4 && <p role="status" className="text-xs text-warning">{batchExport.phase}</p>}
      {batchExport.canCancel && step !== 4 && <Button size="sm" onClick={batchExport.cancel}>停止当前任务</Button>}
      {changedCanvas && <p className="text-xs text-warning">当前画布已变化；本批仍使用已选模板快照。需要新编辑时，回第 1 步重新选择当前工程。</p>}
      {batchExport.view && step !== 4 && <p className="text-xs text-warning">已有生产任务和成果保留在第 4 步。要使用新模板或新数据生成另一批，请先保存并释放旧结果。</p>}
      {template && step > 1 && step < 4 && <p className="break-all text-[11px] text-text-muted">模板：{template.name} · {template.document.params.viewBoxWidth} × {template.document.params.viewBoxHeight} · 快照 {template.sourceRevision.slice(0, 12)}</p>}

      {step === 1 && <section aria-label="选择批量模板" className="space-y-3">
        <h3 className="text-sm font-medium">1. 选择模板</h3>
        <p className="text-xs text-text-secondary">模板保存图片、文字样式、文字显示范围、动画和导出配置。可使用当前工程，也可直接导入之前保存的 .svgaproj，不必替换当前画布。</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded border border-border p-3 space-y-2"><p className="text-sm">当前工程</p><p className="text-xs text-text-muted">按当前设置创建独立快照；原工程及撤销历史不变。</p><Button disabled={!editor.videoItem || busy} onClick={() => void chooseTemplate()}>使用当前工程作为模板</Button></div>
          <div className="rounded border border-border p-3 space-y-2"><p className="text-sm">本地工程模板</p><p className="text-xs text-text-muted">选择不超过 128 MiB 的 .svgaproj，安全校验后使用。</p><Button disabled={busy} onClick={() => templateInput.current?.click()}>选择 .svgaproj 模板…</Button><input ref={templateInput} type="file" accept=".svgaproj" aria-label="选择批量工程模板" className="hidden" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void chooseTemplate(file) }} /></div>
        </div>
        {template && <p role="status" className="break-all text-xs text-success">已选：{template.name} · {eligible.length} 个可用文字 Key · 可返回下一步保留原清单。</p>}
        {!editor.videoItem && <p className="text-xs text-text-muted">没有打开动画也可以导入模板或恢复任务。新用户可先使用首页“批量生成”示例。</p>}
      </section>}

      {step === 2 && <section aria-label="导入批量数据" className="space-y-3">
        <h3 className="text-sm font-medium">2. 导入数据</h3>
        <p className="text-xs text-text-secondary">一行生成一份交付包，本批最多 100 条。先选择文字 Key，再使用同名列填写文案。</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset disabled={busy} className="min-w-0 space-y-2">
            <legend className="mb-2 text-xs">要替换的文字 Key（最多 128 个）</legend>
            <div className="max-h-36 overflow-auto rounded border border-border p-2 space-y-1">
              {eligible.map(entry => <label key={entry.key} className="flex items-start gap-2 text-xs"><input type="checkbox" aria-label={'预检 Key：' + entry.key} checked={selected.includes(entry.key)} disabled={!selected.includes(entry.key) && selected.length >= 128}
                onChange={event => { invalidate(); setSelected(previous => event.target.checked ? [...previous, entry.key] : previous.filter(key => key !== entry.key)) }} /><span className="whitespace-pre-wrap break-all font-mono">{entry.key}</span></label>)}
              {!eligible.length && <p className="text-xs text-text-muted">模板没有可用文字 Key；遮罩、矢量或无有效尺寸的资源不开放。</p>}
            </div>
            <p className="text-[11px] text-text-muted">列名与精确 Key 一一对应（含空格）；未选择的列会报错，不会静默忽略。</p>
            <label className="block text-xs">每条文案上限（Unicode 码点，1–500）<input aria-label="文案长度上限" className={field + ' mt-1'} type="number" min={1} max={500} value={limit} onChange={event => { invalidate(); setLimit(event.target.value) }} /></label>
          </fieldset>
          <fieldset disabled={busy} className="min-w-0 space-y-2">
            <legend className="mb-2 text-xs">UTF-8 清单</legend>
            <div className="flex flex-wrap gap-2"><select aria-label="批量清单格式" className={field + ' !w-auto'} value={format} onChange={event => { invalidate(); setFormat(event.target.value as 'csv' | 'json') }}><option value="csv">CSV</option><option value="json">JSON</option></select>
              <Button size="sm" onClick={() => dataInput.current?.click()}>选择清单文件…</Button><input ref={dataInput} type="file" accept=".csv,.json" aria-label="选择批量数据文件" className="hidden" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void readData(file) }} />
              <Button size="sm" disabled={!eligible.length} onClick={sample}>填入示例</Button></div>
            <p className="text-[11px] text-text-muted">CSV 用 id 列表示编号；JSON 推荐 {'{id, values: {精确Key: 文案}}'}。图片批量处理尚未开放。</p>
            <p className="text-[11px] text-text-muted">这一步只检查数据规则，不修改动画、不生成 SVGA。通过规则不代表文字不会裁切，下一步会生成真实样本。</p>
          </fieldset>
        </div>
        <label className="block text-xs">清单内容<textarea aria-label="批量清单内容" className={field + ' mt-1 min-h-36 font-mono'} rows={6} value={source} disabled={busy} onChange={event => { invalidate(); setSource(event.target.value) }} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) event.stopPropagation() }} /></label>
        {prepared && <section aria-label="批量预检结果" className="space-y-2">
          <p role="status" className="text-sm">{prepared.report.rows.length} 条记录 · {prepared.report.rows.filter(row => row.valid).length} 条通过 · {prepared.report.rows.filter(row => !row.valid).length} 条有问题（仅规则检查）</p>
          <div className="flex items-center justify-between gap-2"><label className="flex gap-2 text-xs"><input type="checkbox" checked={onlyIssues} onChange={event => { setOnlyIssues(event.target.checked); setPage(0) }} />只看问题行</label><Button size="sm" disabled={busy} onClick={() => void saveReport()}>导出预检报告 JSON</Button></div>
          <div className="max-h-48 overflow-auto rounded border border-border"><table className="w-full text-left text-xs"><thead className="bg-bg-tertiary"><tr><th className="p-2">记录 / 编号</th><th className="p-2">结果 / 精确 Key</th></tr></thead><tbody>
            {reportRows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(row => <tr key={row.row} className="border-t border-border"><td className="max-w-40 break-all p-2 align-top">{row.row} / {row.id || '（空编号）'}</td><td className="p-2">{row.valid ? <span className="text-success">规则通过</span> : row.issues.map((item, index) => <p key={index} className="mb-1 break-all text-warning">{item.key !== undefined && <code className="whitespace-pre-wrap">{JSON.stringify(item.key)}：</code>}{item.message}</p>)}</td></tr>)}
          </tbody></table></div>
          {reportRows.length > PAGE_SIZE && <div className="flex items-center gap-3 text-xs"><Button size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button><span>第 {currentPage + 1} / {Math.ceil(reportRows.length / PAGE_SIZE)} 页</span><Button size="sm" disabled={(currentPage + 1) * PAGE_SIZE >= reportRows.length} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>}
          <p className="text-[11px] text-text-muted">CSV 记录号含表头，多行单元格算一条；JSON 从第 1 个元素计数。规则报告不包含原文案，不能恢复任务。</p>
        </section>}
      </section>}

      {step === 3 && prepared && <section aria-label="核对批量预览" className="space-y-3">
        <h3 className="text-sm font-medium">3. 核对预览</h3>
        <p className="text-xs text-text-secondary">{prepared.rows.length} 条规则通过。抽样会生成一份真实交付样本并回读 SVGA，不修改画布或增加撤销记录，也不会提前运行整批任务。</p>
        <BatchOutputModeSelector controller={batchExport} disabled={busy} />
        <div className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 text-xs">抽样记录<select aria-label="抽样记录" className={field + ' mt-1'} value={previewRow ?? ''} disabled={busy} onChange={event => setPreviewRow(Number(event.target.value))}>{prepared.rows.map(row => <option key={row.id} value={row.row}>{row.row} / {row.id}</option>)}</select></label>
          <Button disabled={busy || !batchExport.mode} onClick={() => void preview.generate()}>生成此条双预览</Button>{preview.busy && <Button onClick={preview.cancel}>取消抽样</Button>}</div>
        <dl className="max-h-28 overflow-auto rounded border border-border p-2 text-xs">{Object.entries(prepared.rows.find(row => row.row === previewRow)?.values ?? {}).map(([key, value]) => <React.Fragment key={key}><dt className="whitespace-pre-wrap break-all font-mono text-accent">{key}</dt><dd className="mb-1 whitespace-pre-wrap break-all">{typeof value === 'string' ? value : '（非文字）'}</dd></React.Fragment>)}</dl>
        {preview.notice && <p role="status" className="text-xs text-warning">{preview.notice}</p>}
        {preview.value && <div className="space-y-2">{!preview.current && <p role="alert" className="text-xs text-warning">下方是之前的样本，输入已变化或本次抽样未完成；请重新生成，不能据此确认新批次。</p>}<BatchExportPreview result={preview.value.result} /></div>}
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" aria-label="确认抽样效果与输出方式" disabled={!preview.current || busy} checked={preview.confirmed} onChange={event => preview.confirm(event.target.checked)} /><span>我已核对当前样本及输出方式；其他长文案、字体、遮罩和目标播放器仍需抽检。</span></label>
        <p className="text-[11px] text-text-muted">如需调整文字范围或样式，请回到编辑器修改并重新选择模板；此处不会静默修改源工程。</p>
      </section>}

      {step === 4 && <BatchTextExportPanel controller={batchExport} disabled={reading || reportSaving || preview.busy} showSetup={false} generationAllowed={preview.confirmed} />}
      <p className="text-[11px] text-text-muted">任务文件 .svgabatch 包含可编辑源快照、原始文案和成功产物，不是客户交付 ZIP，请勿直接分享。未保存的会话仅在内存中保留，尚不支持崩溃恢复。</p>
    </div>
  </Modal>
}
