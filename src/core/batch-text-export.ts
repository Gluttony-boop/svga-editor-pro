import JSZip from 'jszip'
import type { ProjectDocument } from '@/types/project'
import type { DeliveryBundleResult } from '@/types/delivery'
import { buildSlotCatalog } from '@/utils/slot-catalog'
import { mergeSlotTextConfig } from '@/utils/slot-config'
import { normalizeTextConfig } from './text-preview'
import { generateDeliveryBundle } from './delivery'
import { prepareDeliverySnapshot, assertDeliveryActive } from './project-revision'
import { sha256Bytes } from './content-hash'
import { generateZipArchive } from './zip-generation'
import {
  createBatchQueue, startBatchItem, succeedBatchItem, failBatchItem, nextBatchItem,
  cancelQueuedBatchItems, recoverBatchQueue, retryFailedBatchItems,
  type BatchTemplate, type BatchVariantRow, type BatchQueueState,
} from './batch-variants'

export type BatchTextOutputMode = 'dynamic' | 'bake'
export const MAX_BATCH_EXPORT_ITEMS = 100
export const MAX_BATCH_EXPORT_BYTES = 256 * 1024 * 1024
const ZIP_DATE = new Date('2000-01-01T00:00:00Z')
const ownSlot = (source: ProjectDocument, key: string) => Object.prototype.hasOwnProperty.call(source.slotConfigs, key) ? source.slotConfigs[key] : undefined

/** 仅替换指定 Key；图片、文字样式及显示范围保留，模式选择不写回编辑工程。 */
export function batchTextDocument(source: ProjectDocument, row: BatchVariantRow, mode: BatchTextOutputMode): ProjectDocument {
  if (mode !== 'dynamic' && mode !== 'bake') throw new Error('请明确选择动态接入或固定字形写入。')
  const slots = Object.fromEntries(Object.entries(source.slotConfigs))
  const catalog = new Map(buildSlotCatalog(source.videoItem, source.layers, source.imageResources, source.slotConfigs).map(entry => [entry.key, entry]))
  for (const [key, value] of Object.entries(row.values)) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('批量导出仅支持非空文字。')
    const existing = ownSlot(source, key)
    const text = normalizeTextConfig(existing?.textConfig, existing?.type === 'text' ? existing.value : null)
    const entry = catalog.get(key)
    if (!entry?.canSimulateText) throw new Error(`文字 Key“${key}”不可用。`)
    // 与插槽面板首次开启写入的语义一致：固定参考尺寸，不能只改 exportMode。
    const box = mode === 'bake' && text.boxWidth === undefined ? {
      boxWidth: Math.ceil(entry.width), boxHeight: Math.ceil(entry.height),
      referenceWidth: Math.ceil(entry.width), referenceHeight: Math.ceil(entry.height),
    } : {}
    const nextText = normalizeTextConfig({ ...text, ...box, text: value, enabled: true, exportMode: mode === 'bake' ? 'bake' : 'preview' })
    Object.defineProperty(slots, key, { enumerable: true, configurable: true, writable: true,
      value: mergeSlotTextConfig(existing, key, nextText) })
  }
  return { ...source, slotConfigs: slots }
}

interface StoredResult {
  result: DeliveryBundleResult
  sha256: string
  fileName: string
}
export interface BatchTextExportView {
  queue: BatchQueueState
  mode: BatchTextOutputMode
  sourceRevision: string
  bytes: number
  busy: boolean
}
export interface BatchTextExportJob {
  signal?: AbortSignal
  onChange?: (view: BatchTextExportView, phase: string) => void
}
export interface BatchTextExportTask {
  view: () => BatchTextExportView
  result: (id: string) => DeliveryBundleResult | undefined
  run: (action: 'start' | 'retry-failed' | 'resume-cancelled', job?: BatchTextExportJob) => Promise<void>
  archive: (signal?: AbortSignal) => Promise<Blob>
}

/** 一次冻结，串行执行；成功字节与队列同时保留，重试不重新读取当前编辑器。 */
export async function createBatchTextExportTask(
  document: ProjectDocument, template: BatchTemplate, rows: readonly BatchVariantRow[],
  mode: BatchTextOutputMode, signal?: AbortSignal,
): Promise<BatchTextExportTask> {
  assertDeliveryActive(signal)
  if (mode !== 'dynamic' && mode !== 'bake') throw new Error('请明确选择动态接入或固定字形写入。')
  if (rows.length > MAX_BATCH_EXPORT_ITEMS) throw new Error('单次最多导出 100 条，请拆分清单。')
  if (template.slotRules.some(rule => rule.kind !== 'text' || rule.required === false)) throw new Error('当前批量导出只支持必填文字 Key。')
  const keys = new Set(buildSlotCatalog(document.videoItem, document.layers, document.imageResources, document.slotConfigs)
    .filter(entry => entry.canSimulateText).map(entry => entry.key))
  let queue = createBatchQueue(template, rows, keys)
  const snapshot = await prepareDeliverySnapshot(document, signal)
  assertDeliveryActive(signal)
  const results = new Map<string, StoredResult>()
  let bytes = 0
  let busy = false
  const view = (): BatchTextExportView => ({ queue: structuredClone(queue), mode, sourceRevision: snapshot.sourceRevision, bytes, busy })
  const result = (id: string) => {
    const value = results.get(id)?.result
    // Blob 不可变；元数据返回副本，避免界面或调用方篡改用于打包的证据。
    return value ? { ...value, manifest: structuredClone(value.manifest), report: structuredClone(value.report), slots: structuredClone(value.slots), previews: { ...value.previews } } : undefined
  }
  const run: BatchTextExportTask['run'] = async (action, job = {}) => {
    if (busy) throw new Error('批量任务正在生成或打包，请稍候。')
    assertDeliveryActive(job.signal)
    if (action === 'retry-failed') queue = retryFailedBatchItems(queue)
    else if (action === 'resume-cancelled') queue = { ...queue, items: queue.items.map(item => item.status === 'cancelled' ? { ...item, status: 'queued' } : item) }
    else if (action !== 'start') throw new Error('批量操作无效。')
    busy = true
    const notify = (phase: string) => job.onChange?.(view(), phase)
    try {
      let item = nextBatchItem(queue)
      while (item) {
        assertDeliveryActive(job.signal)
        queue = startBatchItem(queue, item.row.id)
        const index = queue.items.findIndex(entry => entry.row.id === item!.row.id)
        const label = `第 ${index + 1} / ${queue.items.length} 条（记录 ${item.row.row}）`
        notify(`${label}：正在生成…`)
        try {
          const source = batchTextDocument(snapshot.document, item.row, mode)
          const generated = await generateDeliveryBundle(source, {
            title: `批量变体 ${String(index + 1).padStart(5, '0')}`, includeProject: false,
            target: { platform: 'unspecified', player: '', version: '', maxFileBytes: null, maxDecodedImageBytes: null },
          }, { signal: job.signal, onPhase: phase => { assertDeliveryActive(job.signal); notify(`${label}：${phase}`) } })
          assertDeliveryActive(job.signal)
          if (generated.report.checks.some(check => check.status === 'failed')) throw new Error('实际交付检查未通过。请单独导出诊断包排查。')
          for (const key of Object.keys(item.row.values)) {
            const sources = generated.slots.flatMap(slot => slot.sources).filter(source => source.sourceSlotKey === key)
            if (!sources.length || sources.some(binding => binding.textEffect !== (mode === 'bake' ? 'baked' : 'dynamic') || binding.text?.text !== source.slotConfigs[key].textConfig?.text)) {
              throw new Error(`文字 Key“${key}”未按所选模式进入实际产物。请检查图层显隐和 Key 映射。`)
            }
          }
          const retainedBytes = generated.blob.size + generated.previews.actual.size + generated.previews.design.size
          if (!generated.blob.size || retainedBytes > MAX_BATCH_EXPORT_BYTES - bytes) throw new Error('批量结果与预览累计超过 256 MiB，请拆分清单；已有结果保留。')
          const sha256 = await sha256Bytes(new Uint8Array(await generated.blob.arrayBuffer()))
          assertDeliveryActive(job.signal)
          const fileName = `${String(index + 1).padStart(5, '0')}.zip`
          const next = succeedBatchItem(queue, item.row.id, { fileName, bytes: generated.blob.size, sha256 })
          results.set(item.row.id, { result: generated, sha256, fileName })
          bytes += retainedBytes
          queue = next
        } catch (error) {
          if (job.signal?.aborted || error instanceof DOMException && error.name === 'AbortError') throw error
          queue = failBatchItem(queue, item.row.id, [{ row: item.row.row, code: 'export-failed',
            message: (error instanceof Error ? error.message : '导出失败，请检查源工程。').slice(0, 1000) || '导出失败。' }])
        }
        notify(`${label}：已结束`)
        // 让出事件循环，使取消能在条目之间及时生效，而不是等待整个清单完成。
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        item = nextBatchItem(queue)
      }
    } finally {
      // 取消/观察回调异常也不能留下幽灵 running；成功项绝不覆盖或回滚。
      queue = cancelQueuedBatchItems(recoverBatchQueue(queue))
      busy = false
    }
  }
  const archive = async (archiveSignal?: AbortSignal) => {
    if (busy) throw new Error('批量任务正在生成或打包，请稍候。')
    if (!results.size) throw new Error('还没有可保存的成功结果。')
    assertDeliveryActive(archiveSignal)
    busy = true
    try {
      const zip = new JSZip()
      const hashes: string[] = []
      const add = async (path: string, value: Uint8Array) => {
        assertDeliveryActive(archiveSignal)
        zip.file(path, value, { date: ZIP_DATE, createFolders: false })
        hashes.push(`${await sha256Bytes(value)}  ${path}`)
      }
      for (const item of queue.items) {
        if (item.status !== 'succeeded') continue
        const stored = results.get(item.row.id)
        if (!stored || stored.sha256 !== item.artifact?.sha256 || stored.result.blob.size !== item.artifact.bytes) throw new Error('成功记录与实际产物不一致，未打包。')
        await add(`variants/${stored.fileName}`, new Uint8Array(await stored.result.blob.arrayBuffer()))
      }
      const manifest = { format: 'svga-editor-batch-delivery', schemaVersion: 1, mode, sourceRevision: snapshot.sourceRevision,
        complete: queue.items.every(item => item.status === 'succeeded'), includesProject: false,
        rows: queue.items.map(item => ({ record: item.row.row, id: item.row.id, status: item.status, attempts: item.attempts,
          ...(item.artifact ? { file: { path: `variants/${item.artifact.fileName}`, bytes: item.artifact.bytes, sha256: item.artifact.sha256 } } : {}),
          // 汇总只保存失败类别，不把异常中可能带出的本地地址或文案传播到分享报告。
          ...(item.issues ? { issues: item.issues.map(issue => ({ code: issue.code, row: issue.row })) } : {}) })) }
      await add('manifest.json', new TextEncoder().encode(JSON.stringify(manifest, null, 2)))
      await add('README.txt', new TextEncoder().encode([
        'SVGA 批量文字交付',
        '先阅读 manifest.json：complete=false 表示部分交付，失败/取消项没有文件，不能当作全部完成。',
        '编号与文件路径的对应关系见 rows；文件使用安全序号，不按客户编号/Key 命名。',
        '每个 variants/NNNNN.zip 内含 animation.svga、slots.json、实际/设计预览、检查报告与校验值。',
        mode === 'bake' ? '所选 Key 的字形已写入 SVGA 图片，接入端不要再次叠字。' : '所选 Key 为动态文字：SVGA 不含这些字形，需要按每个包内 slots.json 适配目标播放器。',
        '其余未选 Key 保持工程设置。输出模式仅作用于本批任务，不改变编辑工程。',
        '预览是导出时当前帧，不证明全帧、字体裁剪或 Android/iOS SDK 已通过；目标设备仍须验收。',
        '包内含编号、Key、文案及可能未引用的原始资源，请确认可以分享。未附源工程、清单恢复数据或字体文件。',
        'SHA-256 只用于比对内容，不是数字签名。此 ZIP 不能用于恢复编辑工程或批量执行任务。',
      ].join('\n')))
      zip.file('checksums.sha256', hashes.join('\n') + '\n', { date: ZIP_DATE, createFolders: false })
      return await generateZipArchive(zip, { compression: 'STORE', maxBytes: MAX_BATCH_EXPORT_BYTES + 4 * 1024 * 1024, signal: archiveSignal })
    } finally { busy = false }
  }
  return { view, result, run, archive }
}
