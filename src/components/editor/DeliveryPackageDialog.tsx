import React from 'react'
import { Button, Icon, Modal } from '@/components/ui'
import { OperationStatus, type OperationStatusValue } from '@/components/ui/OperationStatus'
import { useEditorStore } from '@/stores'
import { createSaveFileTarget } from '@/core/exporter'
import { captureExportInputs } from '@/core/export-preview'
import { generateDeliveryBundle } from '@/core/delivery'
import type { DeliveryBundleResult, DeliveryCheck, DeliveryTarget } from '@/types/delivery'
import { formatResourceBytes } from '@/utils/resource-catalog'
import { createDeliveryForm, deliveryFormKey, isDeliverySnapshotCurrent, patchDeliveryForm, readDeliveryOptions, type DeliveryForm } from './delivery-package-state'

interface DeliveryPackageDialogProps {
  isOpen: boolean
  onClose: () => void
}

interface PreparedDelivery {
  inputs: readonly unknown[]
  optionsKey: string
  optionsChanged: boolean
  result: DeliveryBundleResult
}

interface DeliveryJob {
  token: number
  controller: AbortController
  kind: 'generating' | 'saving'
}

const inputClassName = 'mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent disabled:opacity-60'
const checkLabels: Record<DeliveryCheck['status'], string> = { passed: '通过', failed: '未通过', warning: '需注意', 'not-tested': '未实测' }
const checkColors: Record<DeliveryCheck['status'], string> = {
  passed: 'border-success/30 bg-success/5 text-success',
  failed: 'border-error/30 bg-error/5 text-error',
  warning: 'border-warning/30 bg-warning/5 text-warning',
  'not-tested': 'border-border bg-bg-tertiary text-text-secondary',
}
const platformLabels: Record<DeliveryTarget['platform'], string> = { unspecified: '未指定平台', web: 'Web', android: 'Android', ios: 'iOS', other: '其他平台' }

class DeliveryInputsChangedError extends Error {
  constructor() {
    super('编辑内容、导出配置或交付设置已变化，此结果不能用于当前交付。请重新生成。')
    this.name = 'DeliveryInputsChangedError'
  }
}

function cancelled(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
}

export function DeliverySettingsSummary({ form, expanded, disabled, settingsId, onToggle }: {
  form: DeliveryForm
  expanded: boolean
  disabled: boolean
  settingsId: string
  onToggle: () => void
}) {
  return <section aria-label="交付设置摘要" className="rounded-lg border border-border bg-bg-tertiary p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-text-primary" title={form.title}>{form.title}</p>
        <p className="mt-1 break-words text-[11px] text-text-secondary">{platformLabels[form.platform]} · {form.player.trim() || '播放器未指定'}{form.version.trim() ? ` ${form.version.trim()}` : ''} · {form.includeProject ? '附带源工程' : '不附带源工程'}</p>
        <p className="mt-1 text-[11px] text-text-muted">预算：SVGA {form.maxFileMiB.trim() ? `${form.maxFileMiB.trim()} MiB` : '不限'} · 图片解码 {form.maxDecodedImageMiB.trim() ? `${form.maxDecodedImageMiB.trim()} MiB` : '不限'}</p>
      </div>
      <Button size="sm" disabled={disabled} aria-expanded={expanded} aria-controls={settingsId} aria-label={expanded ? '收起交付设置' : '修改交付设置'} icon={<Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={14} />} onClick={onToggle}>{expanded ? '收起交付设置' : '修改交付设置'}</Button>
    </div>
    <p className="mt-2 text-[11px] leading-relaxed text-text-muted">即使不附工程，SVGA 本体也可能保留未引用素材，请核对资源清单。</p>
  </section>
}

function DeliveryPreview({ blob, title, description }: { blob: Blob; title: string; description: string }) {
  const [url, setUrl] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    let nextUrl: string | null = null
    setError(null)
    try {
      nextUrl = URL.createObjectURL(blob)
      setUrl(nextUrl)
    } catch {
      setUrl(null)
      setError('无法显示预览图片，仍可下载 ZIP 检查原图。')
    }
    return () => { if (nextUrl) URL.revokeObjectURL(nextUrl) }
  }, [blob])
  return <figure className="min-w-0 space-y-2">
    <figcaption className="text-sm font-medium text-text-primary">{title}</figcaption>
    <div className="flex h-48 items-center justify-center overflow-hidden rounded-lg border border-border" style={{
      backgroundColor: '#d1d5db',
      backgroundImage: 'conic-gradient(#f3f4f6 25%, transparent 0 50%, #f3f4f6 0 75%, transparent 0)',
      backgroundSize: '20px 20px',
    }}>
      <img src={url ?? undefined} alt={title} className="max-h-full max-w-full object-contain" onError={() => setError('预览图片读取失败，请下载 ZIP 检查原图。')} />
    </div>
    <p className="text-xs leading-relaxed text-text-muted">{description}</p>
    {error && <p role="alert" className="text-xs text-warning">{error}</p>}
  </figure>
}

/** 仅展示已生成包中的证据，不将编辑器截图推断为目标播放器兼容性。 */
export function DeliveryPackageSummary({ result }: { result: DeliveryBundleResult }) {
  const failed = result.report.checks.filter(check => check.status === 'failed')
  const animation = result.manifest.files.find(file => file.role === 'animation')
  const dynamicKeys = result.slots.filter(slot => slot.sources.some(source => source.textEffect === 'dynamic')).length
  const bakedKeys = result.slots.filter(slot => slot.sources.some(source => source.textEffect === 'baked')).length
  const frame = result.manifest.previewFrame + 1
  return <section aria-label="交付包结果" className="space-y-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h4 className="break-all text-sm font-medium text-text-primary">{result.fileName}</h4>
        <p className="mt-1 break-all font-mono text-[11px] text-text-muted" title={result.manifest.sourceRevision.value}>输入摘要 SHA-256：{result.manifest.sourceRevision.value.slice(0, 16)}…</p>
      </div>
      <p className="text-xs text-text-muted">快照第 {frame} 帧 / {result.manifest.params.frames} 帧</p>
    </div>
    {failed.length > 0 && <p role="alert" className="rounded-lg border border-error/40 bg-error/5 p-3 text-xs leading-relaxed text-error">{failed.length} 项检查未通过，本包不符合当前交付目标。仍可保存诊断 ZIP，不能将它标为验收通过。</p>}
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {[
        ['ZIP 文件', formatResourceBytes(result.blob.size)],
        ['实际 SVGA', animation ? formatResourceBytes(animation.bytes) : '未记录'],
        ['实际资源 Key', String(result.slots.length)],
        ['图片解码估算', formatResourceBytes(result.report.decodedImageBytesEstimate)],
      ].map(([label, value]) => <div key={label} className="rounded-lg bg-bg-tertiary p-3"><p className="text-[11px] text-text-muted">{label}</p><p className="mt-1 font-mono text-sm text-text-primary">{value}</p></div>)}
    </div>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <DeliveryPreview blob={result.previews.actual} title={`实际 SVGA · 第 ${frame} 帧`} description="重新解码包内 SVGA，不叠加仅模拟的动态文案。此图用于核对实际文件。" />
      <DeliveryPreview blob={result.previews.design} title={`设计模拟 · 第 ${frame} 帧`} description="含设计师设置的模拟文字，用于说明预期接入效果；不代表文案已写入 SVGA。" />
    </div>
    <p className="text-xs leading-relaxed text-text-secondary">动态文字 Key：{dynamicKeys} · 固定字形 Key：{bakedKeys}。按实际输出 Key 计数，同一 Key 可有不同文字来源。动态文案仅为接入说明及设计预览，需开发端按清单设置；固定字形已成为 SVGA 图片，不能由播放器动态改字。</p>
    <p className="text-xs leading-relaxed text-text-muted">截图固定为生成时的第 {frame} 帧。移动播放游标不会改变此包；如需其他帧请重新生成。下方是编辑器对当前输出帧的检查，不代表整段动画或目标 SDK / 真机实测。</p>
    <section aria-label="交付检查结果" className="space-y-2">
      <h5 className="text-sm font-medium text-text-primary">交付检查</h5>
      <p className="text-xs leading-relaxed text-text-muted">平台、播放器和版本仅记录目标信息，不执行该播放器。内存仅估算图片解码，不包括纹理、缓存、画布及运行时开销。</p>
      <ul className="space-y-2">
        {result.report.checks.map((check, index) => <li key={`${check.id}-${index}`} data-check-status={check.status} className="rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center gap-2"><span className={`rounded border px-1.5 py-0.5 text-[11px] ${checkColors[check.status]}`}>{checkLabels[check.status]}</span><span className="text-xs font-medium text-text-primary">{check.title}</span></div>
          <p className="mt-1 break-words text-xs leading-relaxed text-text-secondary">{check.detail}</p>
          {check.key !== undefined && <p className="mt-1 break-all font-mono text-[11px] text-text-muted">Key：{check.key}</p>}
        </li>)}
      </ul>
    </section>
    <details className="rounded-lg border border-border p-3 text-xs">
      <summary className="cursor-pointer text-text-secondary">包内文件与摘要（{result.manifest.files.length} 个载荷文件）</summary>
      <ul className="mt-3 space-y-2 text-text-muted">{result.manifest.files.map(file => <li key={file.path} className="break-all"><span className="font-mono text-text-secondary">{file.path}</span> · {formatResourceBytes(file.bytes)}<span className="mt-0.5 block font-mono text-[10px]" title={file.sha256}>SHA-256 {file.sha256.slice(0, 16)}…</span></li>)}</ul>
    </details>
    {result.manifest.includesProject && <p className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs leading-relaxed text-warning">此包附带可编辑 .svgaproj 工程，包含原始数据及可能未交付的素材。分享前请确认这些源数据可以对外提供。</p>}
  </section>
}

export function DeliveryPackageDialog({ isOpen, onClose }: DeliveryPackageDialogProps) {
  const editor = useEditorStore()
  const [form, setForm] = React.useState<DeliveryForm>(() => createDeliveryForm(editor.projectName || editor.currentSource))
  const formRef = React.useRef(form)
  const [prepared, setPrepared] = React.useState<PreparedDelivery | null>(null)
  const [settingsExpanded, setSettingsExpanded] = React.useState(true)
  const [status, setStatus] = React.useState<OperationStatusValue | null>(null)
  const [busy, setBusy] = React.useState<DeliveryJob['kind'] | null>(null)
  const mountedRef = React.useRef(true)
  const openRef = React.useRef(isOpen)
  const jobRef = React.useRef<DeliveryJob | null>(null)
  const jobTokenRef = React.useRef(0)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const settingsId = React.useId()
  const result = prepared?.result
  openRef.current = isOpen

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      jobRef.current?.controller.abort()
      jobRef.current = null
    }
  }, [])
  React.useEffect(() => {
    if (isOpen) return
    jobRef.current?.controller.abort()
    jobRef.current = null
    setBusy(null)
    setPrepared(null)
    setSettingsExpanded(true)
    setStatus(null)
  }, [isOpen])
  React.useEffect(() => {
    // 生成前可能已滚到表单底部；结果就绪后回到弹窗顶部，直接看到双预览与主要指标。
    if (result && contentRef.current?.parentElement) contentRef.current.parentElement.scrollTop = 0
  }, [result])

  let optionsError: string | null = null
  try { readDeliveryOptions(form) } catch (error) { optionsError = error instanceof Error ? error.message : '交付设置无效。' }
  const stale = !!prepared && !isDeliverySnapshotCurrent(prepared, captureExportInputs(editor), form)
  const ready = !!prepared && !stale
  const failed = prepared?.result.report.checks.some(check => check.status === 'failed') ?? false
  const canGenerate = !!editor.videoItem && !!editor.originalBuffer && !!editor.params && !optionsError

  const updateForm = (patch: Partial<DeliveryForm>) => {
    if (jobRef.current) return
    const next = patchDeliveryForm(formRef.current, patch)
    if (next === formRef.current) return
    formRef.current = next
    setForm(next)
    setPrepared(previous => previous ? { ...previous, optionsChanged: true } : null)
  }

  const active = (job: DeliveryJob) => mountedRef.current && openRef.current && jobRef.current?.token === job.token
  const assertCurrent = (job: DeliveryJob, inputs: readonly unknown[], optionsKey: string) => {
    if (!active(job) || job.controller.signal.aborted) throw new DOMException('交付包任务已取消', 'AbortError')
    if (!isDeliverySnapshotCurrent({ inputs, optionsKey }, captureExportInputs(useEditorStore.getState()), formRef.current)) throw new DeliveryInputsChangedError()
  }
  const finish = (job: DeliveryJob) => {
    if (jobRef.current?.token !== job.token) return
    jobRef.current = null
    if (mountedRef.current) setBusy(null)
  }

  const generate = async () => {
    if (!isOpen || jobRef.current) return
    const job: DeliveryJob = { token: ++jobTokenRef.current, controller: new AbortController(), kind: 'generating' }
    jobRef.current = job
    setBusy('generating')
    setPrepared(null)
    setStatus({ kind: 'processing', message: '正在冻结当前编辑并生成交付包…' })
    try {
      const options = readDeliveryOptions(formRef.current)
      const optionsKey = deliveryFormKey(formRef.current)
      // 先提交输入并暂停到真实绘制帧，再取引用令牌；后续编码只使用独立文档快照。
      const document = useEditorStore.getState().captureProjectDocument()
      const inputs = captureExportInputs(useEditorStore.getState())
      const result = await generateDeliveryBundle(document, options, {
        signal: job.controller.signal,
        onPhase: message => {
          assertCurrent(job, inputs, optionsKey)
          setStatus({ kind: 'processing', message })
        },
      })
      assertCurrent(job, inputs, optionsKey)
      setPrepared({ inputs, optionsKey, optionsChanged: false, result })
      setSettingsExpanded(false)
      setStatus(result.report.checks.some(check => check.status === 'failed')
        ? { kind: 'warning', message: '诊断包已生成，但有检查未通过。可以下载用于排查；当前尚未保存文件。' }
        : { kind: 'ready', message: '交付包已生成，尚未保存。请核对画面和检查结果，再点击保存 ZIP。' })
    } catch (error) {
      if (active(job)) setStatus(cancelled(error) || job.controller.signal.aborted
        ? { kind: 'cancelled', message: '已取消生成，没有保存交付文件。' }
        : error instanceof DeliveryInputsChangedError
          ? { kind: 'stale', message: error.message }
          : { kind: 'error', message: `生成失败：${error instanceof Error ? error.message : String(error)}。没有生成可保存的交付包。` })
    } finally { finish(job) }
  }

  const save = async () => {
    if (!isOpen || jobRef.current || !prepared || prepared.optionsChanged) return
    const job: DeliveryJob = { token: ++jobTokenRef.current, controller: new AbortController(), kind: 'saving' }
    jobRef.current = job
    setBusy('saving')
    try {
      assertCurrent(job, prepared.inputs, prepared.optionsKey)
      setStatus({ kind: 'processing', message: '请选择 ZIP 保存位置…' })
      // 保留保存按钮的用户手势，选择位置之前不执行异步编码或重新读取素材。
      const target = await createSaveFileTarget(prepared.result.fileName)
      assertCurrent(job, prepared.inputs, prepared.optionsKey)
      if (!target) {
        setStatus({ kind: 'cancelled', message: '已取消保存，生成结果仍保留，可以重试。' })
        return
      }
      setStatus({ kind: 'processing', message: '正在写入或下载 ZIP，请稍候…' })
      await target(prepared.result.blob)
      if (active(job)) setStatus({
        kind: 'ready',
        message: '已执行 ZIP 保存或下载，请检查目标位置或浏览器下载列表。生成结果仍可再次保存；工程未保存状态不会改变。',
      })
    } catch (error) {
      if (active(job)) setStatus(cancelled(error) || job.controller.signal.aborted
        ? { kind: 'cancelled', message: '已取消保存，生成结果仍保留，可以重试。' }
        : error instanceof DeliveryInputsChangedError
          ? { kind: 'stale', message: error.message }
          : { kind: 'error', message: `保存未完成：${error instanceof Error ? error.message : String(error)}。生成结果仍保留，可重试保存。` })
    } finally { finish(job) }
  }

  const requestClose = () => {
    // 文件写入接口不能撤回已经开始的写入，保存期间不把关闭伪装成取消。
    if (jobRef.current?.kind === 'saving') return
    openRef.current = false
    jobRef.current?.controller.abort()
    jobRef.current = null
    setBusy(null)
    setPrepared(null)
    setSettingsExpanded(true)
    setStatus(null)
    onClose()
  }

  return <Modal isolateKeyboard isOpen={isOpen} onClose={requestClose} title="专业交付包" className="!max-w-4xl" footer={<div className="flex w-full flex-wrap items-center justify-end gap-2">
    <Button variant="ghost" disabled={busy === 'saving'} onClick={requestClose} aria-label="关闭专业交付包">关闭</Button>
    {busy === 'generating' ? <Button onClick={() => { jobRef.current?.controller.abort(); setStatus({ kind: 'processing', message: '正在取消生成，请稍候…' }) }} aria-label="取消生成交付包">取消生成</Button>
      : <Button disabled={!!busy || !canGenerate} onClick={() => { void generate() }} aria-label="生成专业交付包">{prepared ? '重新生成' : '生成交付包'}</Button>}
    <Button variant="primary" disabled={!!busy || !ready} loading={busy === 'saving'} onClick={() => { void save() }} aria-label={failed ? '保存诊断 ZIP' : '保存交付 ZIP'} icon={<Icon name="download" size={16} />}>{failed ? '保存诊断 ZIP' : '保存 ZIP'}</Button>
  </div>}>
    <div ref={contentRef} className="space-y-4" aria-busy={!!busy}>
      {stale && <p role="alert" className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs leading-relaxed text-warning">编辑内容、导出配置或交付设置已变化，以下是过期结果，不能保存。请重新生成交付包。</p>}
      <OperationStatus status={stale && !busy ? null : status} />
      {busy === 'saving' && <p className="text-[11px] text-text-muted">保存完成前暂不能关闭弹窗；取消系统保存对话框会保留生成结果。</p>}
      {prepared ? <DeliverySettingsSummary form={form} expanded={settingsExpanded} disabled={!!busy} settingsId={settingsId} onToggle={() => setSettingsExpanded(previous => !previous)} /> : <>
        <p className="text-sm leading-relaxed text-text-secondary">把实际 SVGA、图片 Key / 文字接入清单、资源文件、当前帧的实际与设计预览、检查报告和摘要指纹打成一个 ZIP，方便设计师与开发团队核对交付。</p>
        <p className="rounded-lg border border-border bg-bg-tertiary p-3 text-xs leading-relaxed text-text-secondary">使用右侧当前优化配置，但强制保留独立 Key、不跨 Key 去重，不改变编辑器中的压缩设置。生成时会提交当前输入并暂停动画，后续修改不会写入这份快照。导出不会代替 Ctrl+S 保存工程。</p>
      </>}
      <fieldset id={settingsId} hidden={!!prepared && !settingsExpanded} disabled={!!busy} className="space-y-3 rounded-lg border border-border p-4">
        <legend className="px-1 text-xs font-medium text-text-secondary">本次交付设置（仅保留在此弹窗）</legend>
        <label className="block text-xs text-text-secondary">交付标题<input aria-label="交付标题" className={inputClassName} maxLength={120} value={form.title} onChange={event => updateForm({ title: event.target.value })} /></label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block text-xs text-text-secondary">目标平台<select aria-label="交付目标平台" className={inputClassName} value={form.platform} onChange={event => updateForm({ platform: event.target.value as DeliveryTarget['platform'] })}>
            <option value="unspecified">未指定</option><option value="web">Web</option><option value="android">Android</option><option value="ios">iOS</option><option value="other">其他</option>
          </select></label>
          <label className="block text-xs text-text-secondary">播放器 / SDK（可选）<input aria-label="交付播放器或 SDK" className={inputClassName} maxLength={120} placeholder="例如 SVGAPlayer" value={form.player} onChange={event => updateForm({ player: event.target.value })} /></label>
          <label className="block text-xs text-text-secondary">播放器版本（可选）<input aria-label="交付播放器版本" className={inputClassName} maxLength={120} placeholder="实际接入版本" value={form.version} onChange={event => updateForm({ version: event.target.value })} /></label>
        </div>
        <p className="text-[11px] leading-relaxed text-text-muted">目标信息仅用于交付清单；本工具不会自动执行目标 SDK，不会将填写平台视为兼容性已验证。</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-xs text-text-secondary">SVGA 文件大小预算（MiB，可选）<input aria-label="SVGA 文件大小预算 MiB" className={inputClassName} type="number" min="0" step="any" placeholder="留空表示不限制" value={form.maxFileMiB} onChange={event => updateForm({ maxFileMiB: event.target.value })} /></label>
          <label className="block text-xs text-text-secondary">图片解码内存预算（MiB，可选）<input aria-label="图片解码内存预算 MiB" className={inputClassName} type="number" min="0" step="any" placeholder="不包含播放器与纹理开销" value={form.maxDecodedImageMiB} onChange={event => updateForm({ maxDecodedImageMiB: event.target.value })} /></label>
        </div>
        <label className="flex items-start gap-2 rounded-lg bg-bg-tertiary p-3 text-xs text-text-primary"><input type="checkbox" className="mt-0.5 accent-accent" aria-label="在交付包附带可编辑工程" checked={form.includeProject} onChange={event => updateForm({ includeProject: event.target.checked })} /><span>附带可编辑 .svgaproj 工程<span className="mt-1 block leading-relaxed text-warning">默认不包含。勾选会分享原始 SVGA、可编辑源数据及可能未交付的素材，请确认有权对外提供。</span></span></label>
        <p className="text-[11px] leading-relaxed text-text-muted">即使不附工程，SVGA 本体也可能保留未引用素材，请核对资源清单。</p>
      </fieldset>
      {optionsError && <p role="alert" className="text-xs text-error">{optionsError}</p>}
      {!editor.videoItem && <p className="text-xs text-text-muted">请先打开一个有效的 SVGA 或 .svgaproj 工程。</p>}
      {prepared && <DeliveryPackageSummary result={prepared.result} />}
    </div>
  </Modal>
}
