import JSZip from 'jszip'
import pako from 'pako'
import protobuf from 'protobufjs'
import type { AudioResource, ImageResource, Layer, MovieEntity, SlotConfig } from '@/types'
import type { ProjectDocument } from '@/types/project'
import { PROJECT_FORMAT } from '@/types/project'
import SVGA_PROTO_JSON from './svga-proto'
import { generateZipArchive } from './zip-generation'
import {
  MAX_PROJECT_BYTES, MAX_PROJECT_ENTRIES, MAX_PROJECT_MANIFEST_BYTES, MAX_PROJECT_UNPACKED_BYTES,
  isProjectAssetPath, projectError, validateProjectManifest,
  type JsonRecord, type ProjectAssetRef, type ProjectManifest,
} from './project-validation'

export { MAX_PROJECT_BYTES } from './project-validation'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const CHUNK_BYTES = 64 * 1024
const MAX_ORIGINAL_BYTES = 128 * 1024 * 1024
const MAX_PROTO_FIELDS = 2_000_000
const MAX_JSON_NODES = 1_000_000
const imageMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function bytes(value: unknown, name: string): Uint8Array {
  if (value instanceof ArrayBuffer && value.byteLength <= MAX_PROJECT_BYTES) return new Uint8Array(value.slice(0))
  if (value instanceof Uint8Array && value.byteLength <= MAX_PROJECT_BYTES) return new Uint8Array(value)
  if (Array.isArray(value) && value.length <= MAX_PROJECT_BYTES && value.every(item => Number.isInteger(item) && item >= 0 && item <= 255)) return new Uint8Array(value)
  return projectError(`${name} 缺少有效二进制数据`)
}

/** 显式复制可持久化数据，拒绝非有限数、循环引用和运行时对象。 */
function jsonCopy(value: unknown, path = 'document', depth = 0, seen = new Set<object>(), budget = { nodes: 0 }): unknown {
  if (depth > 32) return projectError(`${path} 嵌套过深`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return projectError(`${path} 包含非有限数`)
    return value
  }
  if (value === undefined) return undefined
  if (typeof value !== 'object' || seen.has(value)) return projectError(`${path} 包含循环或不可保存的数据`)
  if (++budget.nodes > MAX_JSON_NODES) return projectError('工程 JSON 结构数量超过安全上限')
  seen.add(value)
  try {
    if (Array.isArray(value)) return Array.from(value, (item, index) => jsonCopy(item, `${path}[${index}]`, depth + 1, seen, budget) ?? null)
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return projectError(`${path} 包含运行时对象`)
    const result: JsonRecord = Object.create(null)
    for (const [key, item] of Object.entries(value)) if (item !== undefined) result[key] = jsonCopy(item, `${path}.${key}`, depth + 1, seen, budget)
    return result
  } finally { seen.delete(value) }
}

/** 在 JSON.parse 分配对象之前限制结构总量，字符串中的括号不参与计数。 */
function assertJsonBudget(data: Uint8Array): void {
  let inString = false, escaped = false, depth = 0, nodes = 0
  for (const byte of data) {
    if (inString) {
      if (escaped) escaped = false
      else if (byte === 92) escaped = true
      else if (byte === 34) inString = false
    } else if (byte === 34) inString = true
    else if (byte === 123 || byte === 91) {
      if (++depth > 32) projectError('工程 JSON 嵌套超过安全上限')
      if (++nodes > MAX_JSON_NODES) projectError('工程 JSON 结构数量超过安全上限')
    } else if (byte === 125 || byte === 93) depth--
  }
}

function parseManifest(data: Uint8Array): unknown {
  assertJsonBudget(data)
  return JSON.parse(decoder.decode(data))
}

function without(value: object, removed: string[]): JsonRecord {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !removed.includes(key)))
}

function safeName(value: string): string {
  if (typeof value !== 'string') return projectError('工程名称无效')
  return value.split(/[/\\]/).pop()!.replace(/[\x00-\x1f]/g, '').slice(0, 255) || '未命名工程'
}

async function sha256(data: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) return projectError('当前环境不支持安全摘要，请使用桌面版或 HTTPS/本机网页')
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data).buffer)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

interface Inflater {
  onData: (chunk: Uint8Array) => void
  push: (data: Uint8Array, last: boolean) => boolean
  err: number
  msg: string
  ended: boolean
  strm?: { avail_in: number }
}

/** 以实际输出计数；不能相信 ZIP 的 uncompressedSize，也不能先完整 inflate 再检查。 */
function inflateBounded(data: Uint8Array, limit: number, raw: boolean, label: string): Uint8Array {
  const Inflate = (pako as unknown as { Inflate: new (options: { raw: boolean; chunkSize: number }) => Inflater }).Inflate
  const inflater = new Inflate({ raw, chunkSize: CHUNK_BYTES })
  const chunks: Uint8Array[] = []
  let length = 0
  inflater.onData = chunk => {
    length += chunk.length
    if (length > limit) projectError(`${label} 实际解压大小超过安全上限`)
    chunks.push(chunk)
  }
  for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
    const end = Math.min(data.length, offset + CHUNK_BYTES)
    inflater.push(data.subarray(offset, end), end === data.length)
    if (inflater.err) projectError(`${label} 压缩数据损坏`)
    if (inflater.ended && (end !== data.length || inflater.strm?.avail_in)) projectError(`${label} 包含额外压缩数据`)
  }
  if (!inflater.ended || inflater.err) projectError(`${label} 压缩流不完整`)
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
  return result
}

/** 只验证原始数据，不重新解析成当前编辑态，避免覆盖 Key 重命名等改动。 */
function validateOriginal(data: Uint8Array, limit = MAX_ORIGINAL_BYTES): number {
  if (!data.length || data.length > MAX_PROJECT_BYTES) projectError('原始 SVGA 大小无效')
  let body = data
  let expanded = false
  if (data.length >= 4 && String.fromCharCode(...data.subarray(0, 4)) === 'SVGA') {
    if (data.length < 8 || ![1, 2].includes(data[4])) projectError('原始 SVGA 文件头无效')
    body = data[4] === 2 ? inflateBounded(data.subarray(8), limit, false, '原始 SVGA') : data.subarray(8)
    expanded = data[4] === 2
  } else if (data.length >= 2 && ((data[0] & 15) === 8 && ((data[0] << 8) + data[1]) % 31 === 0 || data[0] === 0x1f && data[1] === 0x8b)) {
    body = inflateBounded(data, limit, false, '原始 SVGA')
    expanded = true
  }
  if (body.length > MAX_ORIGINAL_BYTES) projectError('原始 SVGA 解码数据过大')
  // 先扫描 wire 结构，不构建大量 Message/帧对象，资源 bytes 字段也不复制。
  const root = protobuf.Root.fromJSON(SVGA_PROTO_JSON).resolveAll()
  const movieType = root.lookupType('com.opensource.svga.MovieEntity')
  const reader = protobuf.Reader.create(body)
  let fields = 0
  let movieParams: { viewBoxWidth?: number; viewBoxHeight?: number; fps?: number; frames?: number } | undefined
  const scan = (type: protobuf.Type, end: number, depth: number): void => {
    if (depth > 20 || end > body.length) projectError('原始 SVGA 嵌套或长度无效')
    while (reader.pos < end) {
      if (++fields > MAX_PROTO_FIELDS) projectError('原始 SVGA 字段数量超过安全上限')
      const tag = reader.uint32(), id = tag >>> 3, wire = tag & 7
      if (!id || ![0, 1, 2, 5].includes(wire)) projectError('原始 SVGA protobuf 字段无效')
      const field = type.fieldsById[id]
      if (!field) { reader.skipType(wire); continue }
      if (field.map) {
        if (wire !== 2) projectError('原始 SVGA 资源字段类型错误')
        const length = reader.uint32(), mapEnd = reader.pos + length
        if (mapEnd > end) projectError('原始 SVGA 资源字段越界')
        // map 条目只含 key 和 bytes；逐字段检查以避免把任意字节当作有效 map。
        while (reader.pos < mapEnd) {
          if (++fields > MAX_PROTO_FIELDS) projectError('原始 SVGA 字段过多')
          const mapTag = reader.uint32()
          if (![1, 2].includes(mapTag >>> 3) || (mapTag & 7) !== 2) projectError('原始 SVGA 资源条目无效')
          reader.skipType(2)
        }
        if (reader.pos !== mapEnd) projectError('原始 SVGA 资源长度不匹配')
      } else if (field.resolvedType instanceof protobuf.Type) {
        if (wire !== 2) projectError('原始 SVGA 消息字段类型错误')
        const length = reader.uint32(), nestedEnd = reader.pos + length
        if (nestedEnd > end) projectError('原始 SVGA 消息字段越界')
        if (field.name === 'params' && type === movieType) movieParams = {}
        scan(field.resolvedType, nestedEnd, depth + 1)
      } else if (field.type === 'float') {
        if (wire !== 5) projectError('原始 SVGA 浮点字段类型错误')
        const value = reader.float()
        if (!Number.isFinite(value)) projectError('原始 SVGA 包含非有限数')
        if (type.name === 'MovieParams' && movieParams) Object.defineProperty(movieParams, field.name, { value, enumerable: true, configurable: true })
      } else if (field.type === 'int32' || field.resolvedType instanceof protobuf.Enum) {
        if (wire !== 0) projectError('原始 SVGA 整数字段类型错误')
        const value = reader.int32()
        if (type.name === 'MovieParams' && movieParams) Object.defineProperty(movieParams, field.name, { value, enumerable: true, configurable: true })
      } else {
        if (wire !== 2) projectError('原始 SVGA 文本字段类型错误')
        reader.skipType(2)
      }
      if (reader.pos > end) projectError('原始 SVGA 字段超出消息边界')
    }
    if (reader.pos !== end) projectError('原始 SVGA 消息长度不匹配')
  }
  try { scan(movieType, body.length, 0) } catch (error) {
    if (error instanceof Error && error.message.startsWith('工程文件无效：')) throw error
    projectError('原始 SVGA protobuf 损坏')
  }
  if (!movieParams || ![movieParams.viewBoxWidth, movieParams.viewBoxHeight, movieParams.fps, movieParams.frames].every(value => typeof value === 'number' && value > 0)) {
    projectError('原始 SVGA 缺少有效动画参数')
  }
  return expanded ? body.byteLength : 0
}

function dataUrl(data: Uint8Array, mime: string): string {
  const parts: string[] = []
  for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) parts.push(String.fromCharCode(...data.subarray(offset, offset + CHUNK_BYTES)))
  return `data:${mime};base64,${btoa(parts.join(''))}`
}

function decodeDataUrl(url: string): { data: Uint8Array; mimeType: string } {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(url)
  if (!match || match[2].length > Math.ceil(MAX_PROJECT_BYTES / 3) * 4) return projectError('插槽图片须为受支持的本地图片 Data URL')
  let binary: string
  try { binary = atob(match[2]) } catch { return projectError('插槽图片 Base64 损坏') }
  if (!binary.length) return projectError('插槽图片数据为空')
  return { data: Uint8Array.from(binary, char => char.charCodeAt(0)), mimeType: match[1].toLowerCase() }
}

function assertArchiveActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('已取消工程快照生成。', 'AbortError')
}

async function localImage(url: string, signal?: AbortSignal): Promise<{ data: Uint8Array; mimeType: string }> {
  assertArchiveActive(signal)
  if (url.startsWith('data:')) return decodeDataUrl(url)
  if (!url.startsWith('blob:')) return projectError('工程无法保存远程图片，请先从本地选择替换图片')
  const response = await (signal ? fetch(url, { signal }) : fetch(url))
  if (!response.ok) return projectError('本地插槽图片已失效，请重新选择图片')
  const mimeType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase()
  if (!imageMimes.has(mimeType)) return projectError('插槽图片格式不受支持')
  const stream = response.body?.getReader()
  if (!stream) return projectError('无法读取本地插槽图片')
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      assertArchiveActive(signal)
      const next = await stream.read()
      if (next.done) break
      size += next.value.length
      if (size > MAX_PROJECT_BYTES) return projectError('插槽图片超过安全大小上限')
      chunks.push(next.value)
    }
  } finally { await stream.cancel().catch(() => {}); stream.releaseLock() }
  if (!size) return projectError('插槽图片数据为空')
  const data = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length }
  return { data, mimeType }
}

/** 生成自包含工程；来源路径、DOM、Blob URL、解码缓存都不写入归档。 */
export async function createProjectArchive(document: ProjectDocument, options: { signal?: AbortSignal } = {}): Promise<Blob> {
  assertArchiveActive(options.signal)
  const binaries = new Map<string, Uint8Array>()
  const binaryBuckets = new Map<string, string[]>()
  let totalSize = 0
  const add = (value: unknown, name: string): ProjectAssetRef => {
    const data = bytes(value, name)
    const fingerprint = `${data.length}:${crc32(data)}`
    const candidates = binaryBuckets.get(fingerprint) || []
    // 摘要只缩小候选集；必须逐字节相等才复用，不能靠碰撞概率决定是否丢弃素材。
    const previous = candidates.find(path => data.every((byte, index) => binaries.get(path)![index] === byte))
    if (previous) return { asset: previous }
    if (data.byteLength > MAX_PROJECT_BYTES || totalSize + data.byteLength > MAX_PROJECT_UNPACKED_BYTES || binaries.size >= MAX_PROJECT_ENTRIES - 1) projectError('工程资源超过安全大小或数量上限')
    const asset = `assets/${String(binaries.size + 1).padStart(5, '0')}.bin`
    binaries.set(asset, data)
    binaryBuckets.set(fingerprint, [...candidates, asset])
    totalSize += data.byteLength
    return { asset }
  }
  const originalBuffer = add(document.originalBuffer, '原始 SVGA')
  const originalExpandedBytes = validateOriginal(binaries.get(originalBuffer.asset)!)
  const movie = without(document.videoItem.movie, ['images'])
  if (movie.version === undefined) movie.version = (document.videoItem as unknown as JsonRecord).version ?? '2.0.0'
  if (Array.isArray(movie.audios)) movie.audios = movie.audios.map((audio: JsonRecord) => ({ ...audio, ...(audio.data !== undefined ? { data: add(audio.data, '原始音频') } : {}) }))
  const videoData = new Map<string, Uint8Array>()
  for (const [key, value] of Object.entries(document.videoItem.movie.images || {})) videoData.set(key, bytes(value, `movie.images[${key}]`))
  for (const [key, value] of Object.entries(document.videoItem.buffers || {})) {
    const data = bytes(value, `video.buffers[${key}]`), previous = videoData.get(key)
    if (previous?.length && (data.length !== previous.length || data.some((byte, index) => byte !== previous[index]))) projectError(`资源 ${key} 的 movie 与 buffers 内容不一致，请重新载入后保存`)
    videoData.set(key, data)
  }
  const bufferEntries = Array.from(videoData, ([key, data]) => ({ key, data: add(data, `图片 ${key}`) }))
  const imageResources = Array.from(document.imageResources, ([key, resource]) => {
    if (key !== resource.key) projectError(`图片资源索引与 Key 不匹配：${key}`)
    const data = resource.data?.byteLength ? resource.data : videoData.get(key)
    if (!data?.byteLength) projectError(`图片 ${key} 缺少原始字节，不能生成完整工程`)
    return { ...without(resource, ['data', 'source', 'blobUrl', 'bitmap']), data: add(data, `图片资源 ${key}`) }
  })
  const audioResources = Array.from(document.audioResources, ([key, resource]) => {
    if (key !== resource.key) projectError(`音频资源索引与 Key 不匹配：${key}`)
    const data = resource.data?.byteLength ? resource.data : videoData.get(key)
    if (!data?.byteLength) projectError(`音频 ${key} 缺少原始字节，不能生成完整工程`)
    return { ...without(resource, ['data', 'source', 'blobUrl', 'audioBuffer']), data: add(data, `音频资源 ${key}`) }
  })
  const pendingImages: Array<{ slotIndex: number; field: 'imageConfig' | 'value'; url: string }> = []
  const slotConfigs = Object.entries(document.slotConfigs).map(([key, config], slotIndex) => {
    const copy = without(config, ['imageConfig'])
    const url = config.imageConfig?.url
    if (url) {
      const image = { ...without(config.imageConfig || {}, ['url']), scaleMode: config.imageConfig?.scaleMode || 'fit' }
      copy.imageConfig = image
      pendingImages.push({ slotIndex, field: 'imageConfig', url })
    } else if (config.imageConfig) projectError(`插槽 ${key} 的图片地址为空`)
    if (config.type === 'image' && config.value && ((!url && !config.textConfig) || /^(?:data:|blob:|https?:|file:)/i.test(config.value))) {
      copy.value = {}
      pendingImages.push({ slotIndex, field: 'value', url: config.value })
    }
    return { key, config: copy }
  })
  const serial = jsonCopy({
    ...without(document, ['originalBuffer', 'videoItem', 'layers', 'imageResources', 'audioResources', 'slotConfigs']),
    name: safeName(document.name), originalBuffer,
    videoItem: { movie, buffers: bufferEntries },
    layers: document.layers.map(layer => without(layer, ['imageSource', 'audioSource'])),
    imageResources, audioResources, slotConfigs,
  }) as ProjectManifest['document']
  // 在首次 await 前复制编辑数据；异步读取 Blob 时用户继续操作不会混入另一版快照。
  for (let index = 0; index < pendingImages.length; index++) {
    assertArchiveActive(options.signal)
    const pending = pendingImages[index], image = await localImage(pending.url, options.signal)
    const config = serial.slotConfigs[pending.slotIndex].config[pending.field] as JsonRecord
    config.asset = add(image.data, '插槽图片')
    config.mimeType = image.mimeType
  }
  const assets = []
  for (const [path, data] of binaries) {
    assertArchiveActive(options.signal)
    assets.push({ path, size: data.length, sha256: await sha256(data) })
  }
  assertArchiveActive(options.signal)
  const manifest: ProjectManifest = { format: PROJECT_FORMAT, formatVersion: 1, assets, document: serial }
  validateProjectManifest(manifest)
  const encoded = encoder.encode(JSON.stringify(manifest))
  if (encoded.byteLength > MAX_PROJECT_MANIFEST_BYTES || totalSize + encoded.byteLength + originalExpandedBytes > MAX_PROJECT_UNPACKED_BYTES) projectError('工程编辑数据超过安全大小上限')
  assertJsonBudget(encoded)
  const zip = new JSZip()
  zip.file('manifest.json', encoded)
  for (const [path, data] of binaries) zip.file(path, data, { createFolders: false })
  const output = await generateZipArchive(zip, { compression: 'DEFLATE', compressionLevel: 6, maxBytes: MAX_PROJECT_BYTES, signal: options.signal })
  assertArchiveActive(options.signal)
  return new Blob([output], { type: 'application/x-svga-editor-project' })
}

interface ZipEntry { name: string; start: number; compressedSize: number; size: number; method: number; crc: number }

const crcTable = Uint32Array.from({ length: 256 }, (_, initial) => {
  let value = initial
  for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
})

function crc32(data: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of data) value = value >>> 8 ^ crcTable[(value ^ byte) & 0xff]
  return (value ^ 0xffffffff) >>> 0
}

/** 先检查中央目录与本地头，拒绝重复名、路径清洗歧义、加密/ZIP64、隐藏条目。 */
function zipEntries(buffer: ArrayBuffer): Map<string, ZipEntry> {
  const data = new Uint8Array(buffer), view = new DataView(buffer)
  const u16 = (at: number) => view.getUint16(at, true), u32 = (at: number) => view.getUint32(at, true)
  if (data.length < 22 || u32(0) !== 0x04034b50) return projectError('不是有效工程 ZIP')
  let end = -1
  for (let index = data.length - 22; index >= Math.max(0, data.length - 65557); index--) {
    if (u32(index) === 0x06054b50 && index + 22 + u16(index + 20) === data.length) { end = index; break }
  }
  if (end < 0 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) return projectError('ZIP 中央目录无效')
  const count = u16(end + 10), centralSize = u32(end + 12), centralStart = u32(end + 16)
  if (!count || count > MAX_PROJECT_ENTRIES || count === 0xffff || centralStart + centralSize !== end) return projectError('ZIP 条目数量或目录范围无效')
  const entries = new Map<string, ZipEntry>()
  const intervals: Array<{ start: number; end: number }> = []
  let at = centralStart, totalSize = 0
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || u32(at) !== 0x02014b50) return projectError('ZIP 条目头损坏')
    const flags = u16(at + 8), method = u16(at + 10), crc = u32(at + 16), compressedSize = u32(at + 20), size = u32(at + 24)
    const nameSize = u16(at + 28), extraSize = u16(at + 30), commentSize = u16(at + 32), disk = u16(at + 34), external = u32(at + 38), local = u32(at + 42)
    if (flags & ~0x0808 || ![0, 8].includes(method) || disk || compressedSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff || (external >>> 16 & 0xf000) === 0xa000 || (external & 0x10)) projectError('ZIP 使用了不受支持的条目格式')
    if (at + 46 + nameSize + extraSize + commentSize > end) return projectError('ZIP 文件名或扩展越界')
    const name = decoder.decode(data.subarray(at + 46, at + 46 + nameSize))
    if (name !== 'manifest.json' && !isProjectAssetPath(name)) return projectError('ZIP 包含不安全路径或未声明条目')
    if (entries.has(name)) return projectError('ZIP 包含重复条目')
    if (local + 30 > centralStart || u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method) return projectError('ZIP 本地文件头不匹配')
    const localNameSize = u16(local + 26), localExtraSize = u16(local + 28)
    const start = local + 30 + localNameSize + localExtraSize
    if (start > centralStart || decoder.decode(data.subarray(local + 30, local + 30 + localNameSize)) !== name) return projectError('ZIP 本地文件名不匹配')
    if (!(flags & 8) && (u32(local + 14) !== crc || u32(local + 18) !== compressedSize || u32(local + 22) !== size)) return projectError('ZIP 本地条目大小不匹配')
    let entryEnd = start + compressedSize
    if (entryEnd > centralStart) return projectError('ZIP 压缩数据越界')
    if (flags & 8) {
      const signature = entryEnd + 4 <= centralStart && u32(entryEnd) === 0x08074b50
      const descriptor = entryEnd + (signature ? 4 : 0)
      if (descriptor + 12 > centralStart || u32(descriptor) !== crc || u32(descriptor + 4) !== compressedSize || u32(descriptor + 8) !== size) return projectError('ZIP 数据描述符不匹配')
      entryEnd = descriptor + 12
    }
    totalSize += size
    if (totalSize > MAX_PROJECT_UNPACKED_BYTES || size > (name === 'manifest.json' ? MAX_PROJECT_MANIFEST_BYTES : MAX_PROJECT_BYTES)) projectError('ZIP 解压声明超过安全上限')
    intervals.push({ start: local, end: entryEnd })
    entries.set(name, { name, start, compressedSize, size, method, crc })
    at += 46 + nameSize + extraSize + commentSize
  }
  if (at !== end || !entries.has('manifest.json')) return projectError('ZIP 工程清单缺失或中央目录尾部无效')
  intervals.sort((a, b) => a.start - b.start)
  let previousEnd = 0
  for (const interval of intervals) {
    if (interval.start !== previousEnd) return projectError('ZIP 存在重叠或未声明的隐藏数据')
    previousEnd = interval.end
  }
  if (previousEnd !== centralStart) return projectError('ZIP 包含未声明的本地条目')
  return entries
}

/** 仅读取数据，不加载图片/音频、不访问网络，也不将 ZIP 条目写到文件系统。 */
export async function readProjectArchive(buffer: ArrayBuffer): Promise<ProjectDocument> {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > MAX_PROJECT_BYTES) return projectError('工程文件超过 128 MiB 上限或数据类型无效')
  const entries = zipEntries(buffer), input = new Uint8Array(buffer)
  let unpacked = 0
  const extract = (entry: ZipEntry, limit: number): Uint8Array => {
    const compressed = input.subarray(entry.start, entry.start + entry.compressedSize)
    const bound = Math.min(limit, MAX_PROJECT_UNPACKED_BYTES - unpacked, entry.size)
    if (entry.method === 0 && compressed.length > bound) return projectError('ZIP 实际存储大小超限')
    const output = entry.method === 0 ? new Uint8Array(compressed) : inflateBounded(compressed, bound, true, entry.name)
    if (output.length !== entry.size || crc32(output) !== entry.crc) return projectError(`${entry.name} 内容校验失败`)
    unpacked += output.length
    return output
  }
  let manifest: unknown
  try { manifest = parseManifest(extract(entries.get('manifest.json')!, MAX_PROJECT_MANIFEST_BYTES)) } catch (error) {
    if (error instanceof Error && error.message.startsWith('工程文件无效：')) throw error
    return projectError('工程清单不是有效 UTF-8 JSON')
  }
  validateProjectManifest(manifest)
  if (entries.size !== manifest.assets.length + 1) projectError('ZIP 包含未声明资源')
  const assets = new Map<string, Uint8Array>()
  for (const asset of manifest.assets) {
    const entry = entries.get(asset.path)
    if (!entry || entry.size !== asset.size) projectError(`资源 ${asset.path} 缺失或大小不一致`)
    const data = extract(entry, MAX_PROJECT_BYTES)
    if (await sha256(data) !== asset.sha256) projectError(`资源 ${asset.path} SHA-256 校验失败`)
    assets.set(asset.path, data)
  }
  const resolve = (ref: unknown): Uint8Array => assets.get((ref as ProjectAssetRef).asset)!
  const doc = manifest.document
  const original = resolve(doc.originalBuffer)
  validateOriginal(original, Math.min(MAX_ORIGINAL_BYTES, MAX_PROJECT_UNPACKED_BYTES - unpacked))
  const movieImages: Record<string, Uint8Array> = Object.create(null)
  const buffers: Record<string, ArrayBuffer> = Object.create(null)
  for (const item of doc.videoItem.buffers) {
    const data = resolve(item.data)
    movieImages[item.key] = data
    buffers[item.key] = data.buffer as ArrayBuffer
  }
  const movie = { ...doc.videoItem.movie, images: movieImages }
  if (Array.isArray(doc.videoItem.movie.audios)) {
    (movie as JsonRecord).audios = doc.videoItem.movie.audios.map((audio: JsonRecord) => ({ ...audio, ...(audio.data !== undefined ? { data: resolve(audio.data) } : {}) }))
  }
  const imageResources = new Map<string, ImageResource>()
  for (const resource of doc.imageResources) {
    const data = resolve(resource.data)
    if (!data.length) projectError(`图片资源 ${resource.key} 数据为空`)
    imageResources.set(resource.key as string, { ...resource, data } as unknown as ImageResource)
  }
  const audioResources = new Map<string, AudioResource>()
  for (const resource of doc.audioResources) {
    const data = resolve(resource.data)
    if (!data.length) projectError(`音频资源 ${resource.key} 数据为空`)
    audioResources.set(resource.key as string, { ...resource, data } as unknown as AudioResource)
  }
  const slotConfigs: Record<string, SlotConfig> = Object.create(null)
  for (const item of doc.slotConfigs) {
    const config = { ...item.config }
    if (config.imageConfig) {
      const image = config.imageConfig as JsonRecord
      const url = dataUrl(resolve(image.asset), image.mimeType as string)
      config.imageConfig = { url, scaleMode: image.scaleMode }
    }
    if (config.value && typeof config.value === 'object') {
      const valueImage = config.value as JsonRecord
      config.value = dataUrl(resolve(valueImage.asset), valueImage.mimeType as string)
    }
    slotConfigs[item.key] = config as unknown as SlotConfig
  }
  return {
    ...doc, originalBuffer: original.buffer as ArrayBuffer,
    videoItem: { movie: movie as unknown as MovieEntity, images: {}, buffers },
    layers: doc.layers as unknown as Layer[], imageResources, audioResources, slotConfigs,
  }
}
