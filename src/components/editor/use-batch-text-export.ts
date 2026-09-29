import React from 'react'
import { useEditorStore } from '@/stores'
import { createSaveFileTarget } from '@/core/exporter'
import { captureExportInputs, sameExportInputs } from '@/core/export-preview'
import type { BatchTextSession } from '@/core/batch-text-session'
import { beginBatchExportActivity } from '@/core/batch-export-activity'
import { createBatchTextExportTask, type BatchTextExportTask, type BatchTextExportView, type BatchTextOutputMode } from '@/core/batch-text-export'

export function useBatchTextExport(session: BatchTextSession | null) {
  const [mode, setMode] = React.useState<BatchTextOutputMode | ''>('')
  const [view, setView] = React.useState<BatchTextExportView | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [phase, setPhase] = React.useState('')
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const task = React.useRef<BatchTextExportTask | null>(null)
  const inputs = React.useRef<readonly unknown[] | null>(null)
  const capturedSession = React.useRef<BatchTextSession | null>(null)
  const job = React.useRef<{ controller: AbortController; writing: boolean } | null>(null)
  const mounted = React.useRef(true)
  const unsaved = React.useRef(false)
  React.useEffect(() => {
    mounted.current = true
    const onUnload = (event: BeforeUnloadEvent) => {
      if (job.current || unsaved.current) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', onUnload)
    return () => { mounted.current = false; job.current?.controller.abort(); window.removeEventListener('beforeunload', onUnload) }
  }, [])

  const execute = async (action: 'start' | 'retry-failed' | 'resume-cancelled') => {
    if (job.current || !task.current && (!session || !mode)) return
    const operation = { controller: new AbortController(), writing: false }
    job.current = operation
    const finishActivity = beginBatchExportActivity()
    setBusy(true); setPhase('正在冻结工程与清单…')
    try {
      if (!task.current) {
        if (!session || !mode) return
        const current = useEditorStore.getState()
        if (!sameExportInputs(session.inputs, captureExportInputs(current))) throw new Error('工程已变化，请重新预检。')
        const document = current.captureProjectRecovery()
        if (!document) throw new Error('请先结束文字或画布编辑，并打开完整的 SVGA 工程。')
        const created = await createBatchTextExportTask(document, session.template, session.rows, mode, operation.controller.signal)
        if (!mounted.current || operation.controller.signal.aborted) return
        if (!sameExportInputs(session.inputs, captureExportInputs(useEditorStore.getState()))) throw new Error('冻结期间工程已变化，请重新预检。')
        task.current = created
        inputs.current = session.inputs
        capturedSession.current = session
      }
      await task.current.run(action, { signal: operation.controller.signal,
        onChange: (next, message) => { if (mounted.current) { setView(next); setPhase(message); unsaved.current ||= next.queue.items.some(item => item.status === 'succeeded') } } })
      if (mounted.current) setPhase(task.current.view().queue.items.some(item => item.status === 'succeeded')
        ? '本轮生成结束；结果仅保存在内存，请核对后保存 ZIP。'
        : '本轮没有成功产物，请检查下方失败原因；修改工程后需新建任务。')
    } catch (error) {
      if (mounted.current) setPhase(operation.controller.signal.aborted ? '已停止后续生成，已完成结果保留，可保存或继续未完成项。' : error instanceof Error ? error.message : '批量生成失败。')
    } finally {
      finishActivity()
      job.current = null
      if (mounted.current) { setBusy(false); setView(task.current?.view() ?? null) }
    }
  }
  const save = async (id?: string) => {
    if (job.current || !task.current) return
    const operation = { controller: new AbortController(), writing: true }
    job.current = operation
    const finishActivity = beginBatchExportActivity()
    setBusy(true); setPhase('请选择保存位置…')
    try {
      const artifact = id ? task.current.result(id) : null
      if (id && !artifact) throw new Error('该记录没有成功结果。')
      const target = await createSaveFileTarget(artifact ? `variant-${String((view?.queue.items.findIndex(item => item.row.id === id) ?? 0) + 1).padStart(5, '0')}.zip` : 'batch-text-delivery.zip')
      if (!target) { if (mounted.current) setPhase('已取消保存；结果仍保留。'); return }
      if (!mounted.current || operation.controller.signal.aborted) return
      const blob = artifact?.blob ?? await task.current.archive(operation.controller.signal)
      if (!mounted.current || operation.controller.signal.aborted) return
      await target(blob)
      if (mounted.current) {
        if (!id) unsaved.current = false
        setPhase('ZIP 已交给保存接口，请核对下载列表或目标位置；工程未保存状态不变。')
      }
    } catch (error) {
      if (mounted.current) setPhase('保存未完成，结果仍保留：' + (error instanceof Error ? error.message : '请重试。'))
    } finally { finishActivity(); job.current = null; if (mounted.current) setBusy(false) }
  }
  const clear = () => {
    if (job.current || task.current && !window.confirm('释放本次批量任务和内存中的结果？请先保存需要的 ZIP；编辑工程不会改变。')) return
    task.current = null; inputs.current = null; capturedSession.current = null; unsaved.current = false
    setView(null); setPhase(''); setSelectedId(null)
  }
  const current = useEditorStore.getState()
  return {
    mode, setMode, view, busy, phase, execute, save, clear,
    isBusy: () => !!job.current,
    canDiscard: () => !job.current && (!task.current || window.confirm('丢弃清单也会释放批量任务和内存结果，请确认需要的 ZIP 已保存。')),
    cancel: () => { if (!job.current?.writing) job.current?.controller.abort() },
    canCancel: !!job.current && !job.current.writing,
    stale: !!inputs.current && (capturedSession.current !== session || !sameExportInputs(inputs.current, captureExportInputs(current))),
    ready: !!session?.report.valid && sameExportInputs(session.inputs, captureExportInputs(current)),
    selectedId, select: setSelectedId, selected: selectedId ? task.current?.result(selectedId) : undefined,
  }
}
