import { useEditorStore } from '@/stores'
import { buildSlotCatalog } from '@/utils/slot-catalog'
import { captureExportInputs, sameExportInputs } from './export-preview'
import { validateBatchRows, type BatchTemplate, type BatchValidationReport, type BatchVariantRow } from './batch-variants'
import type { ProjectDocument } from '@/types/project'

/** 模板是独立快照；切换画布或工程不会把新内容混入批量生产。 */
export interface BatchTextSource {
  document: ProjectDocument
  name: string
  origin: 'current' | 'file'
  sourceRevision: string
  editorInputs?: readonly unknown[]
}

export interface BatchTextSession {
  inputs: readonly unknown[]
  report: BatchValidationReport
  template: BatchTemplate
  rows: BatchVariantRow[]
  source?: BatchTextSource
}

export function isBatchTextSessionCurrent(session: BatchTextSession): boolean {
  return !!session.source || sameExportInputs(session.inputs, captureExportInputs(useEditorStore.getState()))
}

export function batchTextSessionDocument(session: BatchTextSession): ProjectDocument {
  if (session.source) return session.source.document
  if (!isBatchTextSessionCurrent(session)) throw new Error('工程已变化，请重新核对数据。')
  const document = useEditorStore.getState().captureProjectRecovery()
  if (!document) throw new Error('请先结束文字或画布编辑，并打开完整的 SVGA 工程。')
  return document
}

/** 会话只接纳自己的同步写入；撤销、手动编辑等外部变化必须重新预检。 */
export function applyBatchTextRow(session: BatchTextSession, record: number): BatchTextSession {
  if (session.source) throw new Error('独立批量模板不能写回当前画布，请在批量生产中核对预览。')
  const current = useEditorStore.getState()
  if (!sameExportInputs(session.inputs, captureExportInputs(current))) {
    throw new Error('工程内容已变化，请重新预检后应用。')
  }
  const available = new Set(buildSlotCatalog(current.videoItem, current.layers, current.imageResources, current.slotConfigs)
    .filter(entry => entry.canSimulateText).map(entry => entry.key))
  // 对完整清单重检，不能单独校验一行而漏掉重复编号。
  const report = validateBatchRows(session.template, session.rows, available)
  const row = session.rows.find(item => item.row === record)
  if (!row || !report.rows.find(item => item.row === record)?.valid) throw new Error('该记录未通过预检，未修改动画。')
  const entries = Object.entries(row.values)
  if (entries.some(([, value]) => typeof value !== 'string')) throw new Error('当前仅支持应用文字清单。')
  const result = current.applySlotTextValues(Object.fromEntries(entries) as Record<string, string>, session.inputs)
  if (result.error) throw new Error(result.error)
  return { ...session, inputs: captureExportInputs(useEditorStore.getState()), report }
}
