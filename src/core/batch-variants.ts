import * as Papa from 'papaparse'
import { detectImageMime } from '@/utils/image-mime'

export const BATCH_TEMPLATE_FORMAT = 'svga-editor-batch-template'
export const BATCH_QUEUE_FORMAT = 'svga-editor-batch-queue'
export const BATCH_SCHEMA_VERSION = 1 as const
export const MAX_BATCH_ROWS = 10_000
export const MAX_BATCH_COLUMNS = 128
export const MAX_BATCH_CELL_BYTES = 1024 * 1024
export const MAX_BATCH_JSON_BYTES = 8 * 1024 * 1024

export type BatchSlotKind = 'text' | 'image'
export interface BatchImageValue {
  dataUrl: string
  mimeType: string
  byteSize: number
  width: number
  height: number
}
export type BatchValue = string | BatchImageValue
export interface BatchSlotRule {
  key: string
  kind: BatchSlotKind
  required?: boolean
  maxLength?: number
  allowedMimeTypes?: string[]
  maxBytes?: number
  maxWidth?: number
  maxHeight?: number
}
export interface BatchTemplate {
  format: typeof BATCH_TEMPLATE_FORMAT
  schemaVersion: typeof BATCH_SCHEMA_VERSION
  name: string
  slotRules: BatchSlotRule[]
}
export interface BatchVariantRow {
  /** CSV 为逻辑记录序号（含表头）；JSON 为数组元素序号，均从 1 开始。 */
  row: number
  id: string
  values: Record<string, BatchValue>
}
const ISSUE_CODES = [
  'invalid-row', 'duplicate-id', 'missing-key', 'unknown-key', 'missing-value', 'wrong-type',
  'text-too-long', 'invalid-image', 'image-too-large', 'image-dimensions-too-large', 'image-not-verified',
  'export-failed', 'write-failed', 'validation-failed',
] as const
export type BatchIssueCode = typeof ISSUE_CODES[number]
export interface BatchRowIssue { code: BatchIssueCode; row: number; key?: string; message: string }
export interface BatchRowValidation { row: number; id: string; valid: boolean; issues: BatchRowIssue[] }
export interface BatchValidationReport { valid: boolean; rows: BatchRowValidation[]; issues: BatchRowIssue[] }
const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const
export type BatchItemStatus = typeof STATUSES[number]
export interface BatchArtifactRecord { fileName: string; bytes: number; sha256: string }
export interface BatchQueueItem {
  row: BatchVariantRow
  status: BatchItemStatus
  attempts: number
  artifact?: BatchArtifactRecord
  issues?: BatchRowIssue[]
}
export interface BatchQueueState {
  format: typeof BATCH_QUEUE_FORMAT
  schemaVersion: typeof BATCH_SCHEMA_VERSION
  templateName: string
  /** 规范化模板内容用于一致性比较，不是密码学签名或防篡改凭据。 */
  templateSignature: string
  template: BatchTemplate
  items: BatchQueueItem[]
}

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const bytes = (value: string) => new TextEncoder().encode(value).byteLength
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
}
function fields(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!record(value) || required.some(key => !own(value, key)) ||
    Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('批量数据字段缺失或包含未知字段。')
}
function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
function text(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}
function rowCount(rows: readonly unknown[]): void {
  if (rows.length > MAX_BATCH_ROWS) throw new Error('批量清单最多支持 10000 行。')
}
function sourceSize(source: string): void {
  if (typeof source !== 'string' || source.length > MAX_BATCH_JSON_BYTES || bytes(source) > MAX_BATCH_JSON_BYTES) throw new Error('批量清单超过 8 MiB。')
}

/** 在 JSON.parse 分配大对象之前限制嵌套、字段数量并拒绝重复 Key，避免静默覆盖文案。 */
function parseJson(source: string): unknown {
  sourceSize(source)
  source = source.replace(/^\uFEFF/, '')
  const stack: Array<Set<string>> = []
  let nodes = 0
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (char === '"') {
      const start = i++
      for (; i < source.length && source[i] !== '"'; i++) if (source[i] === '\\') i++
      let next = i + 1
      while (/\s/.test(source[next] ?? '') && next < source.length) next++
      if (source[next] === ':' && stack.length) {
        let key: string
        try { key = JSON.parse(source.slice(start, i + 1)) } catch { throw new Error('JSON 清单格式无效。') }
        const keys = stack[stack.length - 1]
        if (keys.has(key)) throw new Error('JSON 包含重复 Key，已拒绝导入。')
        keys.add(key)
        if (++nodes > 100_000) throw new Error('JSON 字段数量超过安全上限。')
      }
    } else if (char === '{' || char === '[') {
      stack.push(new Set())
      if (stack.length > 16 || ++nodes > 100_000) throw new Error('JSON 嵌套或结构数量超过安全上限。')
    } else if (char === '}' || char === ']') stack.pop()
  }
  try { return JSON.parse(source) } catch { throw new Error('JSON 清单格式无效。') }
}

/** 编号列默认只认 id；传 null 可把 id 也当作普通 SVGA Key。空格和前导零不被改写。 */
export function parseVariantCsv(source: string, options: { idColumn?: string | null } = {}): BatchVariantRow[] {
  sourceSize(source)
  source = source.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let error = ''
  // 分步限量，避免一个很小但含百万空行的文件先创建巨量记录。
  Papa.parse<string[]>(source, {
    header: false, delimiter: ',', dynamicTyping: false, skipEmptyLines: false, worker: false,
    step(result, parser) {
      if (result.errors.length) error = 'CSV 引号或记录格式无效。'
      else if (result.data.length > MAX_BATCH_COLUMNS) error = 'CSV 最多支持 128 列。'
      else if (result.data.some(value => bytes(value) > MAX_BATCH_CELL_BYTES)) error = 'CSV 单元格超过 1 MiB。'
      else if (rows.length >= MAX_BATCH_ROWS + 2) error = '批量清单最多支持 10000 行。'
      if (error) parser.abort()
      else rows.push(result.data)
    },
  })
  if (error) throw new Error(error)
  // 只移除结束换行产生的空记录；保留显式空字符串和中间空行供预检定位。
  const last = rows[rows.length - 1]
  if (/[\r\n]$/.test(source) && last?.length === 1 && last[0] === '') rows.pop()
  const headers = rows.shift()
  if (!headers?.length || headers.some(key => !key.length)) throw new Error('CSV 表头为空。')
  if (new Set(headers).size !== headers.length) throw new Error('CSV 表头重复，不能安全映射。')
  rowCount(rows)
  const idHeader = options.idColumn === undefined ? (headers.includes('id') ? 'id' : null) : options.idColumn
  if (idHeader !== null && !headers.includes(idHeader)) throw new Error('指定的编号列不存在。')
  return rows.map((cells, index) => {
    if (cells.length > headers.length) throw new Error('CSV 第 ' + (index + 2) + ' 条记录多出列，不能安全映射。')
    const values: Record<string, BatchValue> = Object.create(null)
    headers.forEach((key, column) => { if (key !== idHeader) values[key] = cells[column] ?? '' })
    return { row: index + 2, id: idHeader === null ? 'row-' + (index + 2) : cells[headers.indexOf(idHeader)]?.trim() ?? '', values }
  })
}

function parseValue(value: unknown): BatchValue {
  if (typeof value === 'string') {
    if (bytes(value) > MAX_BATCH_CELL_BYTES) throw new Error('批量单元格超过 1 MiB。')
    return value
  }
  fields(value, ['dataUrl', 'mimeType', 'byteSize', 'width', 'height'])
  if (!text(value.dataUrl, MAX_BATCH_JSON_BYTES) || !text(value.mimeType, 64) ||
    !integer(value.byteSize) || !integer(value.width) || !integer(value.height)) throw new Error('图片对象结构无效。')
  return { dataUrl: value.dataUrl, mimeType: value.mimeType, byteSize: value.byteSize, width: value.width, height: value.height }
}
function parseValues(value: unknown): Record<string, BatchValue> {
  if (!record(value) || Object.keys(value).length > MAX_BATCH_COLUMNS) throw new Error('批量 values 必须是最多 128 个 Key 的对象。')
  const result: Record<string, BatchValue> = Object.create(null)
  for (const [key, item] of Object.entries(value)) {
    if (!text(key)) throw new Error('批量 Key 为空或过长。')
    // null 原型承载合法的 constructor/__proto__ 等精确资源名。
    result[key] = parseValue(item)
  }
  return result
}

/** 推荐 {id, values}；嵌套 values 中的 id/name/values 均是合法的精确资源 Key。 */
export function parseVariantJson(source: string): BatchVariantRow[] {
  const parsed = parseJson(source)
  if (!Array.isArray(parsed)) fields(parsed, ['rows'])
  const rows = Array.isArray(parsed) ? parsed : parsed.rows
  if (!Array.isArray(rows)) throw new Error('JSON 清单必须是数组或包含 rows 数组的对象。')
  rowCount(rows)
  return rows.map((raw, index) => {
    if (!record(raw)) throw new Error('JSON 第 ' + (index + 1) + ' 行不是对象。')
    const nested = own(raw, 'values')
    if (nested) fields(raw, ['values'], ['id'])
    const id = own(raw, 'id') ? raw.id : 'row-' + (index + 1)
    if (typeof id !== 'string') throw new Error('变体 id 必须是文本；数字编号请加引号以保留前导零。')
    const rawValues = nested ? raw.values : Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'id'))
    return { row: index + 1, id: id.trim(), values: parseValues(rawValues) }
  })
}

function checkedTemplate(value: unknown): BatchTemplate {
  fields(value, ['format', 'schemaVersion', 'name', 'slotRules'])
  if (value.format !== BATCH_TEMPLATE_FORMAT || value.schemaVersion !== BATCH_SCHEMA_VERSION ||
    !text(value.name, 200) || !value.name.trim() || !Array.isArray(value.slotRules) ||
    !value.slotRules.length || value.slotRules.length > MAX_BATCH_COLUMNS) throw new Error('批量模板格式无效。')
  const keys = new Set<string>()
  const slotRules: BatchSlotRule[] = value.slotRules.map(raw => {
    fields(raw, ['key', 'kind'], ['required', 'maxLength', 'allowedMimeTypes', 'maxBytes', 'maxWidth', 'maxHeight'])
    if (!text(raw.key) || keys.has(raw.key) || !['text', 'image'].includes(String(raw.kind))) throw new Error('批量模板包含重复或无效 Key。')
    keys.add(raw.key)
    if (raw.required !== undefined && typeof raw.required !== 'boolean') throw new Error('模板 required 必须为布尔值。')
    for (const field of ['maxLength', 'maxBytes', 'maxWidth', 'maxHeight']) if (raw[field] !== undefined && !integer(raw[field])) throw new Error('模板限制必须是正整数。')
    if (raw.allowedMimeTypes !== undefined && (!Array.isArray(raw.allowedMimeTypes) || raw.allowedMimeTypes.length > 10 ||
      raw.allowedMimeTypes.some(mime => typeof mime !== 'string' || !/^image\/(?:png|jpeg|gif|webp)$/.test(mime)))) throw new Error('模板图片格式限制无效。')
    return { ...raw } as unknown as BatchSlotRule
  })
  return { format: BATCH_TEMPLATE_FORMAT, schemaVersion: BATCH_SCHEMA_VERSION, name: value.name, slotRules }
}
function templateSignature(template: BatchTemplate): string {
  return JSON.stringify([template.name, template.slotRules.map(rule => [
    rule.key, rule.kind, rule.required !== false, rule.maxLength ?? null,
    [...(rule.allowedMimeTypes ?? [])].sort(), rule.maxBytes ?? null, rule.maxWidth ?? null, rule.maxHeight ?? null,
  ]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0)])
}
function issue(row: number, code: BatchIssueCode, message: string, key?: string): BatchRowIssue {
  return { row, code, message, ...(key === undefined ? {} : { key }) }
}

function imageIssues(row: number, key: string, raw: unknown, rule: BatchSlotRule): BatchRowIssue[] {
  const invalid = () => [issue(row, 'invalid-image', '图片必须为有效的内嵌图片对象，不能读取路径或远端 URL。', key)]
  let value: BatchValue
  try { value = parseValue(raw) } catch { return invalid() }
  if (typeof value === 'string') return invalid()
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.dataUrl)
  if (!match || value.mimeType !== match[1]) return invalid()
  let binary: string
  try { binary = atob(match[2]) } catch { return invalid() }
  if (btoa(binary) !== match[2] || binary.length !== value.byteSize) return invalid()
  if (detectImageMime(Uint8Array.from(binary.slice(0, 16), c => c.charCodeAt(0))) !== value.mimeType) return invalid()
  const issues: BatchRowIssue[] = []
  if (rule.allowedMimeTypes?.length && !rule.allowedMimeTypes.includes(value.mimeType)) issues.push(issue(row, 'invalid-image', '图片格式不在模板允许范围内。', key))
  if (value.byteSize > (rule.maxBytes ?? MAX_BATCH_JSON_BYTES)) issues.push(issue(row, 'image-too-large', '图片真实字节大小超过限制。', key))
  if (value.width > Math.min(rule.maxWidth ?? 8192, 8192) || value.height > Math.min(rule.maxHeight ?? 8192, 8192) ||
    value.width * value.height > 4_194_304) issues.push(issue(row, 'image-dimensions-too-large', '图片声明尺寸超过限制。', key))
  // 元数据不能证明实际解码尺寸。首版纯数据预检绝不放行图片执行，待真实解码适配层验收后扩展。
  issues.push(issue(row, 'image-not-verified', '图片尚未进行真实解码校验；本版只开放批量文案预检。', key))
  return issues
}

export function validateBatchRows(template: BatchTemplate, rows: readonly BatchVariantRow[], availableKeys?: ReadonlySet<string>): BatchValidationReport {
  template = checkedTemplate(template)
  rowCount(rows)
  const rules = new Map(template.slotRules.map(rule => [rule.key, rule]))
  const counts = new Map<string, number>()
  const positions = new Map<number, number>()
  for (const row of rows) {
    if (typeof row?.id === 'string') counts.set(row.id.trim(), (counts.get(row.id.trim()) ?? 0) + 1)
    if (integer(row?.row)) positions.set(row.row, (positions.get(row.row) ?? 0) + 1)
  }
  const results = rows.map(row => {
    const issues: BatchRowIssue[] = []
    if (!record(row) || !integer(row.row) || !text(row.id, 200) || !row.id.trim() || row.id !== row.id.trim() ||
      !record(row.values) || Object.keys(row.values).length > MAX_BATCH_COLUMNS || (positions.get(row.row) ?? 0) > 1) {
      return { row: integer(row?.row) ? row.row : 0, id: typeof row?.id === 'string' ? row.id : '', valid: false,
        issues: [issue(integer(row?.row) ? row.row : 0, 'invalid-row', '行号、编号或 values 无效，或记录序号重复。')] }
    }
    if ((counts.get(row.id) ?? 0) > 1) issues.push(issue(row.row, 'duplicate-id', '变体编号重复，请为每条记录指定唯一编号。'))
    for (const key of Object.keys(row.values)) if (!rules.has(key)) issues.push(issue(row.row, 'unknown-key', '清单 Key 不在所选模板中。', key))
    for (const rule of template.slotRules) {
      if (availableKeys && !availableKeys.has(rule.key)) {
        issues.push(issue(row.row, 'missing-key', '当前工程没有可用的目标 Key。', rule.key)); continue
      }
      const value = own(row.values, rule.key) ? row.values[rule.key] : undefined
      if (value === undefined || typeof value === 'string' && !value.trim()) {
        if (rule.required !== false) issues.push(issue(row.row, 'missing-value', '必填值为空。', rule.key))
      } else if (rule.kind === 'image') issues.push(...imageIssues(row.row, rule.key, value, rule))
      else if (typeof value !== 'string') issues.push(issue(row.row, 'wrong-type', '该 Key 需要文字值。', rule.key))
      else if (bytes(value) > MAX_BATCH_CELL_BYTES || Array.from(value).length > Math.min(rule.maxLength ?? 500, 500)) {
        issues.push(issue(row.row, 'text-too-long', '文字长度超过 ' + Math.min(rule.maxLength ?? 500, 500) + ' 个 Unicode 码点。', rule.key))
      }
    }
    return { row: row.row, id: row.id, valid: !issues.length, issues }
  })
  return { valid: !!results.length && results.every(row => row.valid), rows: results, issues: results.flatMap(row => row.issues) }
}

export function createBatchQueue(template: BatchTemplate, rows: readonly BatchVariantRow[], availableKeys?: ReadonlySet<string>): BatchQueueState {
  template = checkedTemplate(template)
  if (!validateBatchRows(template, rows, availableKeys).valid) throw new Error('清单为空或未通过预检，不能创建队列。')
  return structuredClone({ format: BATCH_QUEUE_FORMAT, schemaVersion: BATCH_SCHEMA_VERSION, templateName: template.name,
    templateSignature: templateSignature(template), template, items: rows.map(row => ({ row, status: 'queued', attempts: 0 })) })
}

function artifactRecord(raw: unknown): BatchArtifactRecord {
  fields(raw, ['fileName', 'bytes', 'sha256'])
  if (!text(raw.fileName, 180) || !/\.svga$/i.test(raw.fileName) || /[<>:"/\\|?*\u0000-\u001f]/.test(raw.fileName) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(raw.fileName) || raw.fileName.startsWith('.') ||
    raw.fileName !== raw.fileName.trim() || !integer(raw.bytes) || !text(raw.sha256, 64) || !/^[a-f0-9]{64}$/i.test(raw.sha256)) throw new Error('批量产物文件名、大小或摘要无效。')
  return { fileName: raw.fileName, bytes: raw.bytes, sha256: raw.sha256.toLowerCase() }
}
function checkedIssues(raw: unknown, row: BatchVariantRow): BatchRowIssue[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_BATCH_COLUMNS * 2) throw new Error('失败项目必须有有限的定位信息。')
  return raw.map(value => {
    fields(value, ['code', 'row', 'message'], ['key'])
    if (!(ISSUE_CODES as readonly unknown[]).includes(value.code) || value.row !== row.row || !text(value.message) ||
      value.key !== undefined && !text(value.key)) throw new Error('问题类别、行号或 Key 无效。')
    return { code: value.code as BatchIssueCode, row: row.row, message: value.message, ...(value.key === undefined ? {} : { key: value.key as string }) }
  })
}
function checkedQueue(raw: unknown): BatchQueueState {
  fields(raw, ['format', 'schemaVersion', 'templateName', 'templateSignature', 'template', 'items'])
  if (raw.format !== BATCH_QUEUE_FORMAT || raw.schemaVersion !== BATCH_SCHEMA_VERSION || !Array.isArray(raw.items) || !raw.items.length) throw new Error('批量队列版本或结构不支持。')
  rowCount(raw.items)
  const template = checkedTemplate(raw.template)
  if (raw.templateName !== template.name || raw.templateSignature !== templateSignature(template)) throw new Error('批量队列模板内容不一致。')
  const ids = new Set<string>(), positions = new Set<number>(), names = new Set<string>()
  let running = 0
  const items: BatchQueueItem[] = raw.items.map(value => {
    fields(value, ['row', 'status', 'attempts'], ['artifact', 'issues'])
    fields(value.row, ['row', 'id', 'values'])
    if (!integer(value.row.row) || !text(value.row.id, 200) || value.row.id !== value.row.id.trim() ||
      !value.row.id.trim() || ids.has(value.row.id) || positions.has(value.row.row) ||
      !(STATUSES as readonly unknown[]).includes(value.status) || !integer(value.attempts, 0)) throw new Error('队列行、状态或尝试次数无效。')
    ids.add(value.row.id); positions.add(value.row.row)
    const row = { row: value.row.row, id: value.row.id, values: parseValues(value.row.values) }
    const status = value.status as BatchItemStatus
    if (status === 'running' && ++running > 1) throw new Error('串行队列不能同时执行多项。')
    if (['running', 'failed', 'succeeded'].includes(status) && !value.attempts) throw new Error('已执行项目缺少尝试次数。')
    const item: BatchQueueItem = { row, status, attempts: value.attempts }
    if (status === 'succeeded') {
      item.artifact = artifactRecord(value.artifact)
      const name = item.artifact.fileName.normalize('NFC').toLowerCase()
      if (names.has(name)) throw new Error('队列产物文件名重复。')
      names.add(name)
    } else if (value.artifact !== undefined) throw new Error('未成功的项目不能携带成功产物。')
    if (status === 'failed') item.issues = checkedIssues(value.issues, row)
    else if (value.issues !== undefined) throw new Error('非失败项目不能携带失败记录。')
    return item
  })
  const executable = items.filter(item => item.status === 'queued' || item.status === 'running')
  if (executable.length && !validateBatchRows(template, executable.map(item => item.row)).valid) throw new Error('队列包含未通过预检的待执行行。')
  return { format: BATCH_QUEUE_FORMAT, schemaVersion: BATCH_SCHEMA_VERSION, templateName: template.name,
    templateSignature: templateSignature(template), template, items }
}

function updateItem(state: BatchQueueState, id: string, fn: (item: BatchQueueItem) => BatchQueueItem): BatchQueueState {
  const checked = checkedQueue(state)
  if (!checked.items.some(item => item.row.id === id)) throw new Error('队列中不存在此变体。')
  return checkedQueue({ ...checked, items: checked.items.map(item => item.row.id === id ? fn(item) : item) })
}
export function startBatchItem(state: BatchQueueState, id: string): BatchQueueState {
  if (state.items.some(item => item.status === 'running')) throw new Error('请先完成正在执行的项目。')
  return updateItem(state, id, item => {
    if (item.status !== 'queued') throw new Error('当前项目不能开始执行。')
    return { row: item.row, status: 'running', attempts: item.attempts + 1 }
  })
}
export function succeedBatchItem(state: BatchQueueState, id: string, artifact: BatchArtifactRecord): BatchQueueState {
  return updateItem(state, id, item => {
    if (item.status !== 'running') throw new Error('项目不在执行状态。')
    return { ...item, status: 'succeeded', artifact: artifactRecord(artifact) }
  })
}
export function failBatchItem(state: BatchQueueState, id: string, issues: readonly BatchRowIssue[]): BatchQueueState {
  return updateItem(state, id, item => {
    if (item.status !== 'running') throw new Error('项目不在执行状态。')
    return { ...item, status: 'failed', issues: checkedIssues(issues, item.row) }
  })
}
export function cancelQueuedBatchItems(state: BatchQueueState): BatchQueueState {
  const checked = checkedQueue(state)
  return { ...checked, items: checked.items.map(item => item.status === 'queued' ? { ...item, status: 'cancelled' } : item) }
}
export function recoverBatchQueue(state: BatchQueueState): BatchQueueState {
  const checked = checkedQueue(state)
  return { ...checked, items: checked.items.map(item => item.status === 'running' ? { ...item, status: 'queued' } : item) }
}
export function retryFailedBatchItems(state: BatchQueueState): BatchQueueState {
  const checked = checkedQueue(state)
  return checkedQueue({ ...checked, items: checked.items.map(item =>
    item.status === 'failed' ? { row: item.row, status: 'queued', attempts: item.attempts } : item) })
}
export function nextBatchItem(state: BatchQueueState): BatchQueueItem | undefined {
  const checked = checkedQueue(state)
  return checked.items.some(item => item.status === 'running') ? undefined : checked.items.find(item => item.status === 'queued')
}
export function serializeBatchQueue(state: BatchQueueState): string {
  const serialized = JSON.stringify(checkedQueue(state))
  sourceSize(serialized)
  return serialized
}
/** 只恢复任务记录；上层仍须校验真实产物文件和源工程修订，不能凭 JSON 宣称文件存在。 */
export function parseBatchQueue(source: string, template?: BatchTemplate): BatchQueueState {
  const state = checkedQueue(parseJson(source))
  if (template && templateSignature(checkedTemplate(template)) !== state.templateSignature) throw new Error('批量队列使用的模板与当前模板不一致。')
  return recoverBatchQueue(state)
}
