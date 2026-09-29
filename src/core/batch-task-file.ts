import { MAX_PROJECT_BYTES } from './project-validation'
import { assertDeliveryActive } from './project-revision'
import { sha256Bytes } from './content-hash'
import { getCanvasSizeError } from './canvas-size'
import { parseBatchJson, parseBatchQueue, serializeBatchQueue, type BatchQueueState } from './batch-variants'

export type BatchTextOutputMode = 'dynamic' | 'bake'
export const MAX_BATCH_EXPORT_ITEMS = 100
export const MAX_BATCH_EXPORT_BYTES = 256 * 1024 * 1024
const MAX_HEADER_BYTES = 9 * 1024 * 1024
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024
const MAGIC = 'SVGABT01'
const PREFIX_BYTES = 76
export const MAX_BATCH_TASK_BYTES = PREFIX_BYTES + MAX_HEADER_BYTES + MAX_PROJECT_BYTES + MAX_BATCH_EXPORT_BYTES

export interface SavedBatchResult {
  blob: Blob
  previews: { actual: Blob; design: Blob }
  previewFrame: number
}
export interface BatchTaskData {
  mode: BatchTextOutputMode
  sourceRevision: string
  sourceArchive: Blob
  queue: BatchQueueState
  results: Map<string, SavedBatchResult>
}
interface Segment { bytes: number; sha256: string }
interface ResultEntry { index: number; previewFrame: number; bundle: Segment; actual: Segment; design: Segment }
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
function fail(reason: string): never { throw new Error(`批量任务文件无效：${reason}`) }
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max

function fields(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) fail('字段缺失或存在未知字段。')
}
function segment(value: unknown, limit: number): Segment {
  fields(value, ['bytes', 'sha256'])
  if (!integer(value.bytes, 1, limit) || !digest(value.sha256)) return fail('载荷大小或 SHA-256 无效。')
  return { bytes: value.bytes, sha256: value.sha256 }
}

/** 只显示静态 PNG，不解压内嵌报告；限制画布像素与块数量，拒绝 APNG 和尾随数据。 */
async function checkPreview(blob: Blob, signal?: AbortSignal) {
  assertDeliveryActive(signal)
  if (!blob.size || blob.size > MAX_PREVIEW_BYTES) fail('预览超过 32 MiB。')
  const raw = new Uint8Array(await blob.arrayBuffer())
  assertDeliveryActive(signal)
  if (raw.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => raw[index] === value)) fail('预览不是 PNG。')
  const view = new DataView(raw.buffer)
  let offset = 8, count = 0, hasImage = false
  const width = view.getUint32(16), height = view.getUint32(20)
  if (getCanvasSizeError({ width, height })) fail('预览尺寸超过画布安全上限。')
  while (offset + 12 <= raw.length && ++count <= 4096) {
    const size = view.getUint32(offset)
    const kind = String.fromCharCode(...raw.subarray(offset + 4, offset + 8))
    if (size > raw.length - offset - 12 || !/^[A-Za-z]{4}$/.test(kind)) fail('预览 PNG 块越界。')
    if (count === 1 && (kind !== 'IHDR' || size !== 13) || count !== 1 && kind === 'IHDR' || ['acTL', 'fcTL', 'fdAT'].includes(kind)) fail('预览必须是单一静态 PNG。')
    if (kind === 'IDAT') hasImage = true
    offset += size + 12
    if (kind === 'IEND') {
      if (size || offset !== raw.length || !hasImage) fail('预览 PNG 不完整。')
      return { width, height }
    }
  }
  return fail('预览 PNG 未正常结束。')
}

/** 不使用 ZIP 外壳，按固定顺序切片读取有界载荷，避免额外的归档解压攻击面。 */
export async function writeBatchTaskFile(data: BatchTaskData, signal?: AbortSignal): Promise<Blob> {
  assertDeliveryActive(signal)
  const queue = serializeBatchQueue(data.queue)
  if (data.queue.items.length > MAX_BATCH_EXPORT_ITEMS || data.queue.items.some(item => item.status === 'running')) fail('请停止任务后再保存，且最多 100 条。')
  if (!digest(data.sourceRevision) || !['dynamic', 'bake'].includes(data.mode)) fail('模式或工程修订无效。')
  const parts: Blob[] = []
  const describe = async (blob: Blob, limit: number) => {
    assertDeliveryActive(signal)
    if (!blob.size || blob.size > limit) fail('载荷超过大小上限。')
    const sha256 = await sha256Bytes(new Uint8Array(await blob.arrayBuffer()))
    assertDeliveryActive(signal)
    parts.push(blob)
    return { bytes: blob.size, sha256 }
  }
  const source = await describe(data.sourceArchive, MAX_PROJECT_BYTES)
  const results: ResultEntry[] = []
  let retained = 0
  for (const [index, item] of data.queue.items.entries()) {
    if (item.status !== 'succeeded') continue
    const stored = data.results.get(item.row.id)
    if (!stored || !integer(stored.previewFrame, 0, Number.MAX_SAFE_INTEGER)) fail('成功记录缺少产物或预览帧。')
    retained += stored.blob.size + stored.previews.actual.size + stored.previews.design.size
    if (retained > MAX_BATCH_EXPORT_BYTES) fail('结果累计超过 256 MiB。')
    const bundle = await describe(stored.blob, MAX_BATCH_EXPORT_BYTES)
    if (bundle.bytes !== item.artifact?.bytes || bundle.sha256 !== item.artifact.sha256 || item.artifact.fileName !== `${String(index + 1).padStart(5, '0')}.zip`) fail('成功队列与产物不一致。')
    await checkPreview(stored.previews.actual, signal)
    await checkPreview(stored.previews.design, signal)
    results.push({ index, previewFrame: stored.previewFrame, bundle,
      actual: await describe(stored.previews.actual, MAX_PREVIEW_BYTES), design: await describe(stored.previews.design, MAX_PREVIEW_BYTES) })
  }
  if (results.length !== data.results.size) fail('存在未绑定到成功记录的产物。')
  const header = encoder.encode(JSON.stringify({ format: 'svga-editor-batch-task', schemaVersion: 1,
    mode: data.mode, sourceRevision: data.sourceRevision, queue, source, results }))
  if (header.length > MAX_HEADER_BYTES) fail('清单超过 9 MiB。')
  const prefix = new Uint8Array(PREFIX_BYTES)
  prefix.set(encoder.encode(MAGIC))
  new DataView(prefix.buffer).setUint32(8, header.length, true)
  prefix.set(encoder.encode(await sha256Bytes(header)), 12)
  assertDeliveryActive(signal)
  return new Blob([prefix, header, ...parts], { type: 'application/octet-stream' })
}

export async function readBatchTaskFile(file: Blob, signal?: AbortSignal): Promise<BatchTaskData> {
  assertDeliveryActive(signal)
  if (file.size < PREFIX_BYTES || file.size > MAX_BATCH_TASK_BYTES) fail('文件为空、截断或超过总大小上限。')
  const prefix = new Uint8Array(await file.slice(0, PREFIX_BYTES).arrayBuffer())
  assertDeliveryActive(signal)
  if (decoder.decode(prefix.subarray(0, 8)) !== MAGIC) fail('不是受支持的 .svgabatch 文件。')
  const length = new DataView(prefix.buffer).getUint32(8, true)
  if (!integer(length, 1, MAX_HEADER_BYTES) || PREFIX_BYTES + length >= file.size) fail('清单长度越界。')
  const header = new Uint8Array(await file.slice(PREFIX_BYTES, PREFIX_BYTES + length).arrayBuffer())
  if (await sha256Bytes(header) !== decoder.decode(prefix.subarray(12))) fail('清单摘要不匹配，文件可能损坏。')
  assertDeliveryActive(signal)
  const raw = parseBatchJson(decoder.decode(header), MAX_HEADER_BYTES)
  fields(raw, ['format', 'schemaVersion', 'mode', 'sourceRevision', 'queue', 'source', 'results'])
  if (raw.format !== 'svga-editor-batch-task' || raw.schemaVersion !== 1) fail('不支持该任务文件版本。')
  if ((raw.mode !== 'dynamic' && raw.mode !== 'bake') || !digest(raw.sourceRevision) || typeof raw.queue !== 'string' || !Array.isArray(raw.results)) fail('模式、队列或修订无效。')
  const queue = parseBatchQueue(raw.queue)
  if (queue.items.length > MAX_BATCH_EXPORT_ITEMS) fail('任务超过 100 条。')
  const source = segment(raw.source, MAX_PROJECT_BYTES)
  const successful = queue.items.map((item, index) => ({ item, index })).filter(({ item }) => item.status === 'succeeded')
  if (raw.results.length !== successful.length) fail('成功记录和产物数量不一致。')
  let retained = 0
  const entries = raw.results.map((value, position): ResultEntry => {
    fields(value, ['index', 'previewFrame', 'bundle', 'actual', 'design'])
    const { item, index } = successful[position]
    if (value.index !== index || !integer(value.previewFrame, 0, Number.MAX_SAFE_INTEGER)) return fail('产物顺序或预览帧无效。')
    const entry = { index, previewFrame: value.previewFrame, bundle: segment(value.bundle, MAX_BATCH_EXPORT_BYTES),
      actual: segment(value.actual, MAX_PREVIEW_BYTES), design: segment(value.design, MAX_PREVIEW_BYTES) }
    if (entry.bundle.bytes !== item.artifact?.bytes || entry.bundle.sha256 !== item.artifact.sha256 || item.artifact.fileName !== `${String(index + 1).padStart(5, '0')}.zip`) fail('队列与产物摘要、大小或文件名不一致。')
    retained += entry.bundle.bytes + entry.actual.bytes + entry.design.bytes
    if (retained > MAX_BATCH_EXPORT_BYTES) fail('结果累计超过 256 MiB。')
    return entry
  })
  if (PREFIX_BYTES + length + source.bytes + retained !== file.size) fail('载荷缺失或包含尾随数据。')
  let offset = PREFIX_BYTES + length
  const extract = async (entry: Segment, mimeType: string) => {
    assertDeliveryActive(signal)
    const blob = file.slice(offset, offset + entry.bytes, mimeType)
    offset += entry.bytes
    if (await sha256Bytes(new Uint8Array(await blob.arrayBuffer())) !== entry.sha256) fail('载荷摘要不匹配，文件可能损坏。')
    assertDeliveryActive(signal)
    return blob
  }
  const sourceArchive = await extract(source, 'application/zip')
  const results = new Map<string, SavedBatchResult>()
  for (const entry of entries) {
    const blob = await extract(entry.bundle, 'application/zip')
    const actual = await extract(entry.actual, 'image/png'), design = await extract(entry.design, 'image/png')
    await checkPreview(actual, signal)
    await checkPreview(design, signal)
    results.set(queue.items[entry.index].row.id, { blob, previews: { actual, design }, previewFrame: entry.previewFrame })
  }
  return { mode: raw.mode, sourceRevision: raw.sourceRevision, sourceArchive, queue, results }
}

export async function validateSavedPreview(result: SavedBatchResult, width: number, height: number, signal?: AbortSignal) {
  for (const blob of [result.previews.actual, result.previews.design]) {
    const size = await checkPreview(blob, signal)
    if (size.width !== width || size.height !== height) fail('预览尺寸与源画布不一致。')
  }
}
