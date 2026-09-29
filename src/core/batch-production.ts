import type { ProjectDocument } from '@/types/project'
import { buildSlotCatalog } from '@/utils/slot-catalog'
import { captureExportInputs } from './export-preview'
import { prepareDeliverySnapshot, restoreDeliverySnapshot, assertDeliveryActive } from './project-revision'
import { MAX_PROJECT_BYTES } from './project-archive'
import { BATCH_TEMPLATE_FORMAT, parseVariantCsv, parseVariantJson, validateBatchRows, type BatchTemplate } from './batch-variants'
import { batchTextSessionDocument, isBatchTextSessionCurrent, type BatchTextSession, type BatchTextSource } from './batch-text-session'
import { createBatchTextExportTask, MAX_BATCH_EXPORT_ITEMS, type BatchTextOutputMode, type BatchTextResult } from './batch-text-export'

export async function captureBatchProductionTemplate(document: ProjectDocument, editorInputs: readonly unknown[], signal?: AbortSignal): Promise<BatchTextSource> {
  const snapshot = await prepareDeliverySnapshot(document, signal)
  return { document: snapshot.document, sourceRevision: snapshot.sourceRevision, name: snapshot.document.name || '当前工程', origin: 'current', editorInputs }
}

export async function importBatchProductionTemplate(file: Blob & { name: string }, signal?: AbortSignal): Promise<BatchTextSource> {
  if (!/\.svgaproj$/i.test(file.name) || !file.size || file.size > MAX_PROJECT_BYTES) throw new Error('请选择不超过 128 MiB 的 .svgaproj 工程模板。')
  const snapshot = await restoreDeliverySnapshot(file, signal)
  return { document: snapshot.document, sourceRevision: snapshot.sourceRevision, name: file.name, origin: 'file' }
}

export function prepareBatchProductionSession(source: BatchTextSource, data: { format: 'csv' | 'json'; content: string; keys: string[]; limit: number }): BatchTextSession {
  if (!data.keys.length || data.keys.length > 128 || new Set(data.keys).size !== data.keys.length) throw new Error('请选择 1–128 个不重复的文字 Key。')
  if (!Number.isInteger(data.limit) || data.limit < 1 || data.limit > 500) throw new Error('文案上限须为 1–500 个 Unicode 码点。')
  const rows = data.format === 'csv' ? parseVariantCsv(data.content) : parseVariantJson(data.content)
  if (!rows.length) throw new Error('清单没有数据记录，请在表头后添加文案。')
  if (rows.length > MAX_BATCH_EXPORT_ITEMS) throw new Error('单次批量生产最多 100 条，请拆分清单。')
  const template: BatchTemplate = { format: BATCH_TEMPLATE_FORMAT, schemaVersion: 1, name: source.name,
    slotRules: data.keys.map(key => ({ key, kind: 'text' as const, required: true, maxLength: data.limit })) }
  const document = source.document
  const available = new Set(buildSlotCatalog(document.videoItem, document.layers, document.imageResources, document.slotConfigs).filter(entry => entry.canSimulateText).map(entry => entry.key))
  return { source, inputs: captureExportInputs(document), rows, template, report: validateBatchRows(template, rows, available) }
}

export interface BatchProductionPreview {
  session: BatchTextSession
  row: number
  mode: BatchTextOutputMode
  result: BatchTextResult
}

/** 抽样也走正式交付管线；单条任务仅留在本函数内，不会占用正式队列。 */
export async function previewBatchProduction(session: BatchTextSession, record: number, mode: BatchTextOutputMode, signal?: AbortSignal): Promise<BatchProductionPreview> {
  assertDeliveryActive(signal)
  if (!isBatchTextSessionCurrent(session)) throw new Error('工程已变化，请重新核对数据。')
  const document = batchTextSessionDocument(session)
  const available = new Set(buildSlotCatalog(document.videoItem, document.layers, document.imageResources, document.slotConfigs).filter(entry => entry.canSimulateText).map(entry => entry.key))
  // 先重检完整清单，不能用一个成功样本绕过重复编号或其他失败记录。
  const report = validateBatchRows(session.template, session.rows, available)
  if (!report.valid || !session.rows.length || session.rows.length > MAX_BATCH_EXPORT_ITEMS) throw new Error('请先修正全部数据问题，再生成抽样预览。')
  const row = session.rows.find(value => value.row === record)
  if (!row) throw new Error('未找到这条抽样记录。')
  const task = await createBatchTextExportTask(document, session.template, [row], mode, signal)
  await task.run('start', { signal })
  assertDeliveryActive(signal)
  if (!isBatchTextSessionCurrent(session)) throw new Error('预览期间工程已变化，请重新核对。')
  const result = task.result(row.id)
  if (!result) throw new Error(task.view().queue.items[0]?.issues?.map(issue => issue.message).join('；') || '抽样预览未生成，请检查模板与字体。')
  return { session, row: record, mode, result }
}
