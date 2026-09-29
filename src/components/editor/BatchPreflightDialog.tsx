import React from 'react'
import * as Papa from 'papaparse'
import { Button, Modal } from '@/components/ui'
import { useEditorStore } from '@/stores'
import { buildSlotCatalog } from '@/utils/slot-catalog'
import { captureExportInputs, sameExportInputs } from '@/core/export-preview'
import { createSaveFileTarget } from '@/core/exporter'
import { applyBatchTextRow, type BatchTextSession } from '@/core/batch-text-session'
import { BatchTextExportPanel } from './BatchTextExportPanel'
import { useBatchTextExport } from './use-batch-text-export'
import {
  BATCH_TEMPLATE_FORMAT, MAX_BATCH_JSON_BYTES, parseVariantCsv, parseVariantJson, validateBatchRows,
  type BatchTemplate,
} from '@/core/batch-variants'

interface Props {
  onClose: () => void
  initialKey?: string
  isOpen?: boolean
  onOpen?: () => void
  onDiscard?: () => void
}
const field = 'w-full rounded border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent'
const PAGE_SIZE = 50

export function BatchPreflightDialog({ onClose, initialKey, isOpen = true, onOpen, onDiscard }: Props) {
  const editor = useEditorStore()
  const catalog = React.useMemo(() => buildSlotCatalog(editor.videoItem, editor.layers, editor.imageResources, editor.slotConfigs),
    [editor.videoItem, editor.layers, editor.imageResources, editor.slotConfigs])
  const eligible = catalog.filter(entry => entry.canSimulateText)
  const [selected, setSelected] = React.useState<string[]>(() => eligible.filter(entry => entry.textConfigured || entry.key === initialKey).slice(0, 128).map(entry => entry.key))
  const [limit, setLimit] = React.useState('20')
  const [format, setFormat] = React.useState<'csv' | 'json'>('csv')
  const [source, setSource] = React.useState('')
  const [prepared, setPrepared] = React.useState<BatchTextSession | null>(null)
  const [notice, setNotice] = React.useState('')
  const [reading, setReading] = React.useState(false)
  const [reportSaving, setSaving] = React.useState(false)
  const batchExport = useBatchTextExport(prepared)
  const saving = reportSaving || batchExport.busy
  const [page, setPage] = React.useState(0)
  const [onlyIssues, setOnlyIssues] = React.useState(false)
  const [appliedRow, setAppliedRow] = React.useState<number | null>(null)
  const readToken = React.useRef(0)
  const mounted = React.useRef(true)
  const savingRef = React.useRef(false)
  const input = React.useRef<HTMLInputElement>(null)
  const resultRef = React.useRef<HTMLElement>(null)
  // 画布尺寸修改也会替换 videoItem，但原始文件未变，不能因此丢掉清单。
  const originalSource = React.useRef(editor.originalBuffer ?? editor.videoItem)
  React.useEffect(() => {
    const token = readToken
    mounted.current = true
    return () => { mounted.current = false; token.current++ }
  }, [])
  React.useEffect(() => {
    if (prepared && isOpen) resultRef.current?.scrollIntoView({ block: 'nearest' })
  }, [prepared, isOpen])
  const changedProject = originalSource.current !== (editor.originalBuffer ?? editor.videoItem)
  const stale = !!prepared && !sameExportInputs(prepared.inputs, captureExportInputs(editor))
  const canCheck = !!editor.videoItem && !changedProject && !!source.trim() && selected.length > 0 &&
    Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 500 && !reading && !saving
  const invalidate = () => { readToken.current++; setReading(false); setPrepared(null); setAppliedRow(null); setNotice(''); setPage(0) }
  const close = () => {
    if (savingRef.current || batchExport.isBusy()) return
    readToken.current++
    setReading(false)
    onClose()
  }
  const readFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || savingRef.current || batchExport.isBusy()) return
    invalidate()
    const token = ++readToken.current
    if (file.size > MAX_BATCH_JSON_BYTES) { setNotice('文件超过 8 MiB，未读取。'); return }
    if (!/\.(csv|json)$/i.test(file.name)) { setNotice('请选择 UTF-8 编码的 CSV 或 JSON 文件。'); return }
    setReading(true)
    try {
      const value = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      if (!mounted.current || token !== readToken.current) return
      const current = useEditorStore.getState()
      if ((current.originalBuffer ?? current.videoItem) !== originalSource.current) throw new Error('工程已切换，请重新打开预检。')
      setFormat(/\.json$/i.test(file.name) ? 'json' : 'csv')
      setSource(value)
      setNotice('清单已在本机读取，请核对 Key 后预检。')
    } catch (error) {
      if (mounted.current && token === readToken.current) setNotice('读取失败：' + (error instanceof Error ? error.message : String(error)))
    } finally { if (mounted.current && token === readToken.current) setReading(false) }
  }
  const sample = () => {
    invalidate()
    const columns = selected.length ? selected : eligible.slice(0, 1).map(entry => entry.key)
    if (!columns.length) return
    setSelected(columns)
    const values = Object.fromEntries(columns.map(key => [key, '设计师昵称']))
    // 若真实 Key 就叫 id，用嵌套 JSON 分离编号，避免 CSV 的编号列占用它。
    if (format === 'json' || columns.includes('id')) {
      setFormat('json')
      setSource(JSON.stringify([{ id: '001', values }, { id: '002', values }], null, 2))
    } else setSource(Papa.unparse([['id', ...columns], ['001', ...columns.map(() => '设计师昵称')], ['002', ...columns.map(() => '2222222222222')]]))
  }
  const check = () => {
    if (!canCheck) return
    setPrepared(null); setNotice(''); setPage(0)
    try {
      const current = useEditorStore.getState()
      if ((current.originalBuffer ?? current.videoItem) !== originalSource.current) throw new Error('工程已切换，请重新打开预检。')
      const rows = format === 'csv' ? parseVariantCsv(source) : parseVariantJson(source)
      const template: BatchTemplate = { format: BATCH_TEMPLATE_FORMAT, schemaVersion: 1, name: '当前工程文案预检',
        slotRules: selected.map(key => ({ key, kind: 'text', required: true, maxLength: Number(limit) })) }
      const available = new Set(buildSlotCatalog(current.videoItem, current.layers, current.imageResources, current.slotConfigs).filter(entry => entry.canSimulateText).map(entry => entry.key))
      const report = validateBatchRows(template, rows, available)
      if (!rows.length) { setNotice('清单没有数据记录，请在表头后添加文案。'); return }
      setPrepared({ inputs: captureExportInputs(current), template, report, rows })
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }
  const applyRow = (record: number) => {
    if (!prepared || savingRef.current || batchExport.isBusy() || changedProject) return
    try {
      setPrepared(applyBatchTextRow(prepared, record))
      setAppliedRow(record)
      setNotice('')
      close()
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }
  const save = async () => {
    if (!prepared || stale || savingRef.current || batchExport.isBusy()) return
    savingRef.current = true; setSaving(true); setNotice('')
    try {
      const target = await createSaveFileTarget('batch-text-preflight.json')
      if (!target) { if (mounted.current) setNotice('已取消报告保存。'); return }
      if (!mounted.current || !sameExportInputs(prepared.inputs, captureExportInputs(useEditorStore.getState()))) {
        throw new Error('工程内容已变化，请重新预检后保存报告。')
      }
      const report = { format: 'svga-editor-batch-preflight', schemaVersion: 1,
        scope: '仅文案结构、Key、必填和 Unicode 码点长度；未检查像素溢出、字体、图片解码或目标播放器，未生成 SVGA。',
        rowNumbering: format === 'csv' ? '逻辑记录序号，包含表头，多行单元格算一条' : 'JSON 数组元素序号，从 1 开始',
        template: prepared.template, ...prepared.report }
      await target(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }))
      if (mounted.current) setNotice('报告已交给保存接口；浏览器下载模式请确认下载完成。当前动画未改变。')
    } catch (error) {
      if (mounted.current) setNotice('报告未保存：' + (error instanceof Error ? error.message : String(error)))
    } finally { savingRef.current = false; if (mounted.current) setSaving(false) }
  }
  const reportRows = prepared?.report.rows.filter(row => !onlyIssues || !row.valid) ?? []
  const currentPage = Math.min(page, Math.max(0, Math.ceil(reportRows.length / PAGE_SIZE) - 1))
  const validRows = prepared?.report.rows.filter(row => row.valid) ?? []
  const appliedIndex = validRows.findIndex(row => row.row === appliedRow)
  const previous = appliedIndex > 0 ? validRows[appliedIndex - 1] : undefined
  const next = validRows[appliedIndex + 1]
  if (!isOpen) return <section aria-label="批量文案会话" className="rounded border border-border bg-bg-tertiary p-2 space-y-2">
    <p className="text-xs">清单保留在本次会话 · {prepared ? `${validRows.length} 条可应用` : '尚未预检'}</p>
    {appliedIndex >= 0 && <p className="break-all text-xs text-text-secondary">上次应用：{validRows[appliedIndex].id} · 记录 {appliedRow}（{appliedIndex + 1}/{validRows.length}）</p>}
    {(stale || changedProject) && <p role="alert" className="text-xs text-warning">工程已变化，请展开清单重新预检后继续。</p>}
    <div className="flex flex-wrap gap-1">
      <Button size="sm" disabled={!previous || stale || changedProject || saving} onClick={() => previous && applyRow(previous.row)}>上一条文案</Button>
      <Button size="sm" disabled={!next || stale || changedProject || saving} onClick={() => next && applyRow(next.row)}>{appliedIndex < 0 ? '应用首条文案' : '下一条文案'}</Button>
      <Button size="sm" onClick={onOpen}>展开清单</Button>
      <Button size="sm" disabled={saving} onClick={() => { if (batchExport.canDiscard()) onDiscard?.() }}>丢弃清单</Button>
    </div>
    {notice && <p role="status" className="text-xs text-warning">{notice}</p>}
    {batchExport.view && <p className="text-xs text-warning">批量结果保留在内存，展开清单可核对并保存 ZIP。</p>}
    <p className="text-[11px] text-text-muted">只切换通过行；每次应用可撤销。清单未保存到磁盘，刷新或切换工程会丢失；丢弃清单不撤销已应用文案。</p>
  </section>
  return <Modal isOpen isolateKeyboard onClose={close} title="批量文案预检" className="!max-w-4xl" footer={
    <div className="flex w-full flex-wrap justify-end gap-2">
      <Button disabled={saving} onClick={close}>收起并保留清单</Button>
      <Button disabled={!prepared || stale || saving || changedProject} onClick={() => void save()}>导出预检报告 JSON</Button>
      <Button variant="primary" disabled={!canCheck} onClick={check}>开始预检</Button>
    </div>
  }>
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-text-secondary">预检不修改动画、不上传素材、不生成 SVGA。通过预检不代表文字不会裁切；可主动将一条通过的记录应用到画布核对，再选择输出方式生成批量交付。</p>
      {changedProject && <p role="alert" className="text-sm text-warning">工程已切换，请关闭后重新打开预检。</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset disabled={saving || changedProject} className="min-w-0 space-y-2">
          <legend className="mb-2 text-sm">1. 选择要替换的文字 Key（最多 128 个）</legend>
          <div className="max-h-40 overflow-auto rounded border border-border p-2 space-y-1">
            {eligible.map(entry => <label key={entry.key} className="flex items-start gap-2 text-xs">
              <input type="checkbox" aria-label={'预检 Key：' + entry.key} checked={selected.includes(entry.key)}
                disabled={!selected.includes(entry.key) && selected.length >= 128}
                onChange={event => { invalidate(); setSelected(previous => event.target.checked ? [...previous, entry.key] : previous.filter(key => key !== entry.key)) }} />
              <span className="whitespace-pre-wrap break-all font-mono">{entry.key}</span>
            </label>)}
            {!eligible.length && <p className="text-xs text-text-muted">当前没有可用的文字 Key；遮罩、矢量或无有效尺寸的资源不开放。</p>}
          </div>
          <p className="text-[11px] text-text-muted">列名必须与所选 Key 完全一致，包括空格。未勾选的列会报告问题，不会静默忽略。</p>
          <label className="block text-xs">每条文案上限（Unicode 码点，1–500）
            <input aria-label="文案长度上限" className={field + ' mt-1'} type="number" min={1} max={500} value={limit}
              onChange={event => { invalidate(); setLimit(event.target.value) }} />
          </label>
        </fieldset>
        <fieldset disabled={saving || changedProject} className="min-w-0 space-y-2">
          <legend className="mb-2 text-sm">2. 导入或粘贴 UTF-8 清单</legend>
          <div className="flex gap-2">
            <select aria-label="批量清单格式" className={field + ' !w-auto'} value={format} onChange={event => { invalidate(); setFormat(event.target.value as 'csv' | 'json') }}>
              <option value="csv">CSV</option><option value="json">JSON</option>
            </select>
            <Button size="sm" disabled={saving} onClick={() => input.current?.click()}>{reading ? '重新选择…' : '选择清单文件…'}</Button>
            <input ref={input} type="file" accept=".csv,.json" className="hidden" onChange={event => void readFile(event)} />
            <Button size="sm" disabled={saving || !eligible.length} onClick={sample}>填入示例</Button>
          </div>
          <p className="text-[11px] text-text-muted">CSV 默认以 id 列为编号；JSON 推荐 {'{id, values: {精确Key: 文案}}'}。图片批量处理尚未开放。</p>
        </fieldset>
      </div>
      <label className="block text-xs">清单内容
        <textarea aria-label="批量清单内容" className={field + ' mt-1 min-h-36 font-mono'} rows={6} value={source} disabled={saving || changedProject}
          onChange={event => { invalidate(); setSource(event.target.value) }}
          onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) event.stopPropagation() }} />
      </label>
      {notice && <p role="status" className="text-xs text-warning">{notice}</p>}
      {prepared && <section ref={resultRef} aria-label="批量预检结果" className="space-y-2">
        {stale && <p role="alert" className="text-sm text-warning">工程已变化，此报告已过期；请重新预检。</p>}
        <p role="status" className="text-sm">{prepared.report.rows.length} 条记录 · {prepared.report.rows.filter(row => row.valid).length} 条通过 · {prepared.report.rows.filter(row => !row.valid).length} 条有问题（仅规则检查）</p>
        <label className="flex gap-2 text-xs"><input type="checkbox" checked={onlyIssues} onChange={event => { setOnlyIssues(event.target.checked); setPage(0) }} />只看问题行</label>
        <div className="max-h-60 overflow-auto rounded border border-border">
          <table className="w-full text-left text-xs"><thead className="bg-bg-tertiary"><tr><th className="p-2">记录</th><th className="p-2">编号</th><th className="p-2">结果 / 精确 Key</th><th className="p-2">画布核对</th></tr></thead>
            <tbody>{reportRows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(row => <tr key={row.row} className="border-t border-border">
              <td className="p-2 align-top">{row.row}</td><td className="max-w-32 break-all p-2 align-top">{row.id || '（空编号）'}</td>
              <td className="p-2">{row.valid ? <span className="text-success">规则通过 · 未生成文件</span> :
                row.issues.map((item, index) => <p key={index} className="mb-1 break-all text-warning">{item.key !== undefined && <code className="whitespace-pre-wrap">{JSON.stringify(item.key)}：</code>}{item.message}</p>)}</td>
              <td className="p-2 align-top"><Button size="sm" disabled={!row.valid || stale || saving || changedProject}
                aria-label={'应用记录 ' + row.row + ' 到画布并收起'} onClick={() => applyRow(row.row)}>应用并收起</Button></td>
            </tr>)}</tbody>
          </table>
        </div>
        {reportRows.length > PAGE_SIZE && <div className="flex items-center gap-3 text-xs">
          <Button size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button>
          <span>第 {currentPage + 1} / {Math.ceil(reportRows.length / PAGE_SIZE)} 页</span>
          <Button size="sm" disabled={(currentPage + 1) * PAGE_SIZE >= reportRows.length} onClick={() => setPage(currentPage + 1)}>下一页</Button>
        </div>}
        <p className="text-[11px] text-text-muted">应用会替换该记录全部 Key 的文案并启用文字显示，保留已有样式、范围、图片与导出模式；没有文字配置时使用默认样式且仅模拟。多个 Key 可一次撤销（Ctrl/Cmd+Z）。要将字形写入 SVGA，需在插槽中明确选择写入模式后导出。</p>
        <p className="text-[11px] text-text-muted">报告含编号和 Key，不含原始文案或图片。CSV 记录号包含表头，多行单元格算一条；JSON 从第 1 个元素计数。收起后可在插槽面板连续切换文案；清单仅在本次会话保留，刷新、切换工程或主动丢弃后丢失，报告不能恢复清单。</p>
      </section>}
      <BatchTextExportPanel controller={batchExport} disabled={reportSaving || changedProject || reading} />
    </div>
  </Modal>
}
