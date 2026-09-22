import JSZip from 'jszip'
import type { DeliveryBundleResult, DeliveryCheck, DeliveryFile, DeliveryManifest, DeliveryOptions, DeliveryReport, DeliverySlot, DeliverySlotSource } from '@/types/delivery'
import type { ExportSpriteBinding } from '@/types/export-artifact'
import type { ProjectDocument } from '@/types/project'
import type { SlotConfig, VideoItem } from '@/types'
import type { ValidationResult } from '@/utils/svga-validator'
import { detectImageMime } from '@/utils/image-mime'
import { isTextKeyCandidate } from '@/utils/slot-catalog'
import { getSlotImageUrl } from '@/utils/slot-config'
import type { OptimizationConfig } from './optimizer'
import { sha256Bytes } from './content-hash'
import { normalizeTextConfig } from './text-preview'
import { generateZipArchive } from './zip-generation'

export const MAX_DELIVERY_FILE_BYTES = 128 * 1024 * 1024
export const MAX_DELIVERY_BYTES = 256 * 1024 * 1024
export const MAX_DELIVERY_ENTRIES = 5000
const MAX_TARGET_BUDGET = 1024 * 1024 * 1024 * 1024
const ZIP_DATE = new Date('2000-01-01T00:00:00.000Z')
const platformLabels = { unspecified: '未指定', web: 'Web', android: 'Android', ios: 'iOS', other: '其他' }
const own = <T>(object: Record<string, T>, key: string): T | undefined => Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined
const utf8 = (value: string) => new TextEncoder().encode(value)

export interface DeliveryArchiveInput {
  document: ProjectDocument
  options: DeliveryOptions
  sourceRevision: string
  animation: Blob
  output: VideoItem
  bindings: ExportSpriteBinding[]
  actualPreview: Blob
  designPreview: Blob
  projectArchive?: Blob
  optimization: OptimizationConfig
  warnings: string[]
  validation: ValidationResult
}

export interface DeliveryArchiveJob {
  signal?: AbortSignal
  onPhase?: (message: string) => void
}

function checkedLabel(value: unknown, field: string, required = false): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error(`${field}不能包含控制字符，且必须是文字`)
  const trimmed = value.trim()
  if (Array.from(trimmed).length > 120) throw new Error(`${field}最多为 120 个字符`)
  if (required && !trimmed) throw new Error(`${field}不能为空`)
  return trimmed
}

/** 预算只是团队约束，不会被误写成平台已经通过的兼容性证据。 */
export function normalizeDeliveryOptions(options: DeliveryOptions): DeliveryOptions {
  if (!options || !options.target || typeof options.includeProject !== 'boolean') throw new Error('交付设置不完整')
  const platform = options.target.platform
  if (!['unspecified', 'web', 'android', 'ios', 'other'].includes(platform)) throw new Error('交付目标平台无效')
  const budget = (value: number | null, name: string) => {
    if (value === null) return null
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TARGET_BUDGET) throw new Error(`${name}必须为空或不超过 1 TiB 的正整数（字节）`)
    return value
  }
  return {
    title: checkedLabel(options.title, '交付名称', true),
    includeProject: options.includeProject,
    target: {
      platform,
      player: checkedLabel(options.target.player, '播放器名称'),
      version: checkedLabel(options.target.version, '播放器版本'),
      maxFileBytes: budget(options.target.maxFileBytes, '文件体积预算'),
      maxDecodedImageBytes: budget(options.target.maxDecodedImageBytes, '图片解码预算')
    }
  }
}

function assertActive(job: DeliveryArchiveJob): void {
  if (job.signal?.aborted) throw new DOMException('已取消交付包生成', 'AbortError')
}

function phase(job: DeliveryArchiveJob, message: string): void {
  assertActive(job)
  job.onPhase?.(message)
  assertActive(job)
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

function sourceBytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return new Uint8Array(value)
  throw new Error('交付 SVGA 包含无效的资源字节')
}

function collectBytes(output: VideoItem): Map<string, Uint8Array> {
  const resources = new Map<string, Uint8Array>()
  for (const entries of [Object.entries(output.movie.images || {}), Object.entries(output.buffers || {})]) {
    for (const [key, value] of entries) {
      const bytes = sourceBytes(value)
      const previous = resources.get(key)
      if (previous && !bytesEqual(previous, bytes)) throw new Error(`资源“${key}”的 SVGA 字节与回读缓存不一致`)
      resources.set(key, bytes)
    }
  }
  return resources
}

interface ImageSize { width: number; height: number }
const ascii = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length))
const sizeOf = (width: number, height: number): ImageSize | null => Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 ? { width, height } : null

/** 仅解析尺寸头，不解码或执行资源；预算还会与本次回读的实际解码尺寸取较大值。 */
function imageSize(bytes: Uint8Array, mime: string): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mime === 'image/png' && bytes.length >= 24 && ascii(bytes, 4, 4) === '\r\n\u001a\n' && ascii(bytes, 12, 4) === 'IHDR') return sizeOf(view.getUint32(16), view.getUint32(20))
  if (mime === 'image/gif' && bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) return sizeOf(view.getUint16(6, true), view.getUint16(8, true))
  if (mime === 'image/bmp' && bytes.length >= 22) {
    const header = view.getUint32(14, true)
    if (header === 12) return sizeOf(view.getUint16(18, true), view.getUint16(20, true))
    if (header >= 40 && bytes.length >= 26) return sizeOf(view.getInt32(18, true), Math.abs(view.getInt32(22, true)))
  }
  if (mime === 'image/webp') {
    const codec = ascii(bytes, 12, 4)
    if (codec === 'VP8X' && bytes.length >= 30) return sizeOf(1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16))
    if (codec === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const packed = view.getUint32(21, true)
      return sizeOf(1 + (packed & 0x3fff), 1 + ((packed >>> 14) & 0x3fff))
    }
    if (codec === 'VP8 ' && bytes.length >= 30 && ascii(bytes, 23, 3) === '\u009d\u0001\u002a') return sizeOf(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff)
  }
  if (mime === 'image/jpeg') {
    let offset = 2
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 0xff) return null
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (marker === 0xd9 || marker === 0xda) break
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
      if (offset + 1 >= bytes.length) break
      const length = view.getUint16(offset)
      if (length < 2 || offset + length > bytes.length) return null
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) return sizeOf(view.getUint16(offset + 5), view.getUint16(offset + 3))
      offset += length
    }
  }
  return null
}

function resourceType(bytes: Uint8Array): { mimeType: string; extension: string } {
  const mimeType = detectImageMime(bytes)
  const images: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' }
  if (images[mimeType]) return { mimeType, extension: images[mimeType] }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return { mimeType: 'audio/aac', extension: 'aac' }
  if (ascii(bytes, 0, 3) === 'ID3' || bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return { mimeType: 'audio/mpeg', extension: 'mp3' }
  if (ascii(bytes, 0, 4) === 'OggS') return { mimeType: 'audio/ogg', extension: 'ogg' }
  if (ascii(bytes, 0, 4) === 'fLaC') return { mimeType: 'audio/flac', extension: 'flac' }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return { mimeType: 'audio/wav', extension: 'wav' }
  if (ascii(bytes, 4, 4) === 'ftyp' && /^M4[ABP] /.test(ascii(bytes, 8, 4))) return { mimeType: 'audio/mp4', extension: 'm4a' }
  return { mimeType: 'application/octet-stream', extension: 'bin' }
}

function textSource(slot?: SlotConfig): Pick<DeliverySlotSource, 'textEffect' | 'text'> {
  if (!slot || !slot.textConfig && slot.type !== 'text') return { textEffect: 'none', text: null }
  const text = normalizeTextConfig(slot.textConfig, slot.type === 'text' ? slot.value : null)
  return {
    text,
    textEffect: text.enabled === false ? 'disabled' : !text.text.trim() ? 'empty' : text.exportMode === 'bake' ? 'baked' : 'dynamic'
  }
}

function collectSources(input: DeliveryArchiveInput): DeliverySlotSource[] {
  const { document, output, bindings } = input
  if (bindings.length !== output.movie.sprites.length) throw new Error('交付图层来源数量与实际 SVGA 不一致')
  const layers = new Map(document.layers.map(layer => [layer.id, layer]))
  if (layers.size !== document.layers.length) throw new Error('工程包含重复的图层身份，无法证明交付来源')
  return bindings.map((binding, index) => {
    const actualKey = output.movie.sprites[index].imageKey || null
    if (binding.spriteIndex !== index || binding.baselineImageKey !== actualKey) throw new Error(`交付 sprite ${index} 的来源顺序或实际 Key 不一致`)
    const layer = binding.layerId === null ? undefined : layers.get(binding.layerId)
    if (binding.layerId !== null && !layer) throw new Error(`交付 sprite ${index} 缺少声明的来源图层`)
    if (binding.originalSpriteIndex !== null && (!Number.isInteger(binding.originalSpriteIndex) || binding.originalSpriteIndex < 0 || binding.originalSpriteIndex >= document.videoItem.movie.sprites.length)) throw new Error(`交付 sprite ${index} 的原始来源索引无效`)
    const slot = binding.sourceSlotKey === null ? undefined : own(document.slotConfigs, binding.sourceSlotKey)
    if (binding.sourceSlotKey !== null && !slot) throw new Error(`交付 sprite ${index} 缺少声明的来源插槽`)
    return { ...binding, layerName: layer?.name ?? null, currentImageKey: layer?.imageKey ?? null, ...textSource(slot) }
  })
}

function html(value: unknown): string {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

const stateLabel = { passed: '通过', failed: '失败', warning: '注意', 'not-tested': '未实测' }
const textLabel = { none: '未配置文字', dynamic: '动态文字示例（需要接入）', baked: '字形已写入图片（勿重复叠字）', disabled: '文字已关闭', empty: '文案为空' }

function reportHtml(manifest: Pick<DeliveryManifest, 'title' | 'target' | 'sourceRevision' | 'params'>, slots: DeliverySlot[], report: DeliveryReport): string {
  const rows = slots.map(slot => `<tr><td><code>${html(slot.key)}</code></td><td>${html(slot.role)} / ${html(slot.state)}</td><td>${slot.resource ? `${html(slot.resource.path)}<br>${slot.resource.bytes} 字节；${slot.resource.width ?? '未知'} × ${slot.resource.height ?? '未知'}<br><code>${html(slot.resource.sha256)}</code>` : '无独立二进制资源'}</td><td>sprite: ${html(slot.spriteIndices.join(', ') || '无')}<br>matte 引用: ${html(slot.matteForSpriteIndices.join(', ') || '无')}</td><td>${slot.sources.map(source => `${html(source.layerName ?? '未关联编辑图层')}<br>来源 Key：<code>${html(source.sourceImageKey ?? '无')}</code>；插槽：<code>${html(source.sourceSlotKey ?? '无')}</code><br>${textLabel[source.textEffect]}${source.text ? `<pre>${html(source.text.text)}</pre><small>${html(source.text.fontFamily)} / ${source.text.fontSize}px</small>` : ''}`).join('<hr>') || '无对应 sprite 来源'}</td></tr>`).join('')
  const failures = report.checks.filter(check => check.status === 'failed').length
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; media-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(manifest.title)} — 交付检查</title>
<style>body{font:15px/1.65 system-ui,sans-serif;max-width:1320px;margin:36px auto;padding:0 24px;color:#dce5f0;background:#131923}h1,h2{color:#fff}code,pre{overflow-wrap:anywhere;white-space:pre-wrap}code{font-size:12px}.notice{padding:16px;border:1px solid #547197;background:#1d2a3d}.preview{display:flex;gap:20px;flex-wrap:wrap}figure{flex:1 1 300px;margin:0}img{max-width:100%;max-height:500px;object-fit:contain;background:repeating-conic-gradient(#263447 0% 25%,#182332 0% 50%) 50%/20px 20px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #364459;padding:10px;vertical-align:top;text-align:left;overflow-wrap:anywhere}li{margin:10px 0}.failed{color:#ffb4b4}.warning{color:#ffdb97}.passed{color:#91e3c6}small{color:#b2c0d3}</style></head><body>
<h1>${html(manifest.title)}</h1><p class="notice">${failures ? `诊断包：${failures} 项失败，不应作为已验收交付。` : '编辑器检查已完成；目标播放器与真机仍未实测。'} 文件摘要用于核对一致性，不是数字签名。</p>
<p>画布 ${manifest.params.viewBoxWidth} × ${manifest.params.viewBoxHeight}；${manifest.params.fps} fps；${manifest.params.frames} 帧。目标：${html(platformLabels[manifest.target.platform])} / ${html(manifest.target.player || '未指定')} / ${html(manifest.target.version || '未指定')}。上述目标是填写的接入要求，不代表测试证据。</p>
<h2>当前帧对照（第 ${report.previewFrame + 1} 帧，数据索引 ${report.previewFrame}）</h2><p>两张图均为本编辑器当前帧静态预览，不是动画或工程，不含音频试听；不能证明全帧正确、手机 SDK 兼容性、真机内存或播放性能。</p><div class="preview"><figure><img src="previews/actual.png" alt="实际导出 SVGA 回读预览"><figcaption>实际交付 SVGA：已回读，不叠加仅模拟文字</figcaption></figure><figure><img src="previews/design.png" alt="设计稿含模拟文字预览"><figcaption>设计稿：包含当前文字模拟。仅模拟的文案需要业务端接入。</figcaption></figure></div>
<h2>检查结果</h2><ul>${report.checks.map(check => `<li class="${check.status}"><strong>${stateLabel[check.status]} · ${html(check.title)}</strong><br>${html(check.detail)}${check.key !== undefined ? `<br>Key：<code>${html(check.key)}</code>` : ''}</li>`).join('')}</ul>
<h2>真实资源与 Key</h2><p>Key 大小写、空格和符号原样保留；资源用安全序号命名，接入时从 slots.json 查询映射，不可用文件名推测 Key。RGBA 估算：${report.decodedImageBytesEstimate} 字节，不包含 GPU 副本、帧缓存、音频或解码器开销。</p><table><thead><tr><th>输出 Key</th><th>角色 / 状态</th><th>资源、尺寸与 SHA-256</th><th>实际引用（从 0 开始）</th><th>精确来源与文字</th></tr></thead><tbody>${rows}</tbody></table>
<h2>接入边界</h2><p>已写入图片的固定字形不得再按 slots.json 叠字。dynamic 仅是中立配置，必须适配目标播放器 API；SVGA 没有本工具专属的动态文字协议。字体不随包分发，业务端需自行取得字体授权与文件，布局可能跨端不同。共享 Key 会同时影响多个 sprite；遮罩、矢量、音频不能作为普通图片替换。</p><p>先在目标 SDK 和设备验收全帧、遮罩、动态替换、文字裁剪、字体、音画同步和性能。完整说明在 README.md，机器可读数据在 manifest.json、slots.json、report.json。</p><p>源快照摘要：<code>${html(manifest.sourceRevision.value)}</code>（不是签名或防篡改授权）。</p></body></html>`
}

function guide(includeProject: boolean): string {
  return `# SVGA 交付包接入说明

1. animation.svga 是实际交付动画。请先阅读 README.html / report.json；存在 failed 时本包仅作诊断，不是验收通过的成品。
2. slots.json 的数组记录真实输出 Key、二进制路径、实际 sprite/matte 引用和每个编辑来源。Key 必须逐字保留（包括大小写、空白与特殊符号）；不要用图层显示名或 resources 文件名推测 Key。
3. sources[].textEffect=baked 表示固定字形已经成为 SVGA 图片，不要再次叠字；以后改字请修改原工程再导出。disabled / empty 不代表已烘焙。
4. sources[].textEffect=dynamic 仅提供中立的文字配置示例，不是任一 SVGA SDK 可以直接调用的接口。需要将该配置适配目标播放器 API，并检查文字区域、换行、对齐、偏移、替换底图、裁剪和字体。SVGA 本身没有本工具专属的动态文字协议。
5. 同一个输出 Key 可能含多个来源，不能只选第一个。若配置冲突，先修正工程或确认 SDK 接入策略；共享 Key 的动态替换会影响多个 sprite。遮罩、矢量与音频不能当普通图片插槽。
6. 跨 Key 图片去重固定关闭，保留独立动态替换身份。文件中可能仍有共享 Key 或未引用资源，检查报告会注明；重复内容的不同 Key 不会因此合并。
7. previews/actual.png 是实际输出 SVGA 回读的当前帧；previews/design.png 是同一帧的设计参考（可含仅模拟文案）。两者不是动画、工程或全帧验证，不含音频试听。它们不能证明目标 SDK 兼容、手机性能或实际内存。
8. target.platform / player / version 都是填写的目标要求，始终未实测；需在目标设备上验收全帧、遮罩、混合、动态替换、音画同步、性能和内存。RGBA 估算不含 GPU 副本、缓存、音频或解码器开销。
9. 本包不分发字体文件；动态文字的字体授权、安装和跨端差异由接入方确认。固定字形反映导出时本机字体，字体许可仍须自行核实。
10. checksums.sha256 覆盖除自身以外的每个 ZIP 文件；manifest.files 不包含 manifest.json 和 checksums.sha256，以避免摘要自引用。请用可信的交付渠道比对摘要；sourceRevision 与 SHA-256 均不是签名、加密或授权保护，攻击者可一起替换文件和摘要。
11. ${includeProject ? 'project.svgaproj 包含可编辑源工程，可能含未交付素材和文案；分享前请确认有权交付。仅需播放器时不要将源工程作为业务资源部署。' : '本包默认不含原始工程，避免意外分享未交付素材。请设计师自行妥善保留 .svgaproj，SVGA 与预览图不能完整替代源工程。'}

README.html 是可离线打开的静态报告，无脚本、无远程字体、无网络请求；无需上传资源到服务器。
`
}

function safeArchiveName(title: string): string {
  let base = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 100).replace(/[.\s]+$/g, '') || 'SVGA-delivery'
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `_${base}`
  return `${base}.delivery.zip`
}

/** 只发布全部生成并校验过的 ZIP；任何取消、损坏或超出安全上限都不返回部分产物。 */
export async function createDeliveryArchive(input: DeliveryArchiveInput, job: DeliveryArchiveJob = {}): Promise<DeliveryBundleResult> {
  phase(job, '检查交付快照与来源')
  const options = normalizeDeliveryOptions(input.options)
  if (!/^[a-f0-9]{64}$/i.test(input.sourceRevision)) throw new Error('源快照 SHA-256 无效')
  if (input.optimization.image.deduplicate !== false) throw new Error('交付包必须关闭跨 Key 图片去重，保留独立动态插槽')
  if (!input.validation.isValid || input.validation.errors.length) throw new Error(`交付 SVGA 结构校验失败：${input.validation.errors.join('；') || '无有效结构'}`)
  const params = input.output.movie.params
  if (!params || ![params.viewBoxWidth, params.viewBoxHeight, params.fps, params.frames].every(value => Number.isFinite(value) && value > 0) || !Number.isSafeInteger(params.frames) || !Number.isSafeInteger(params.fps)) throw new Error('交付 SVGA 动画参数无效')
  if (!Number.isInteger(input.document.currentFrame) || input.document.currentFrame < 0 || input.document.currentFrame >= params.frames) throw new Error('交付预览帧不在实际输出范围内')
  if (!input.animation.size) throw new Error('交付 SVGA 内容为空')
  if (options.includeProject && !input.projectArchive?.size) throw new Error('选择了附带源工程，但没有生成源工程归档')
  const sources = collectSources(input)
  const resources = collectBytes(input.output)
  if (input.validation.info.spritesCount !== input.output.movie.sprites.length || input.validation.info.imagesCount !== resources.size) throw new Error('交付结构校验与回读资源数量不一致')
  if (input.validation.info.params && Object.entries(params).some(([key, value]) => input.validation.info.params![key as keyof typeof params] !== value)) throw new Error('交付结构校验与回读动画参数不一致')
  if (resources.size + 9 + Number(options.includeProject) > MAX_DELIVERY_ENTRIES) throw new Error('交付 ZIP 条目数量超过 5000 个安全上限')

  const zip = new JSZip()
  const files: DeliveryFile[] = []
  const checksums: Array<{ path: string; sha256: string }> = []
  let total = 0
  let entryCount = 0
  const add = async (path: string, value: Blob | Uint8Array | string, role: DeliveryFile['role'] | null) => {
    assertActive(job)
    const length = typeof value === 'string' ? utf8(value).length : value instanceof Blob ? value.size : value.byteLength
    if (length > MAX_DELIVERY_FILE_BYTES) throw new Error(`交付条目 ${path} 超过单项 128 MiB 安全上限`)
    if (total + length > MAX_DELIVERY_BYTES) throw new Error('交付包未压缩载荷超过 256 MiB 安全上限')
    if (++entryCount > MAX_DELIVERY_ENTRIES) throw new Error('交付 ZIP 条目数量超过 5000 个安全上限')
    total += length
    const bytes = typeof value === 'string' ? utf8(value) : value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value
    assertActive(job)
    const sha256 = await sha256Bytes(bytes)
    assertActive(job)
    zip.file(path, bytes, { date: ZIP_DATE, createFolders: false, compression: 'STORE' })
    checksums.push({ path, sha256 })
    const file = { path, bytes: length, sha256, role: role ?? 'report' as const }
    if (role) files.push(file)
    return file
  }

  await add('animation.svga', input.animation, 'animation')
  for (const [path, preview] of [['previews/actual.png', input.actualPreview], ['previews/design.png', input.designPreview]] as const) {
    if (!preview.size || preview.size > MAX_DELIVERY_FILE_BYTES) throw new Error('交付预览为空或超过安全大小上限')
    const header = new Uint8Array(await preview.slice(0, 24).arrayBuffer())
    if (detectImageMime(header) !== 'image/png' || !imageSize(header, 'image/png')) throw new Error('交付预览必须是有效尺寸的 PNG')
    await add(path, preview, 'preview')
  }
  if (options.includeProject) await add('project.svgaproj', input.projectArchive!, 'project')

  phase(job, '核对真实 Key、文字状态与资源摘要')
  const checks: DeliveryCheck[] = [{ id: 'structure', title: 'SVGA 结构回读', status: 'passed', detail: '已解压、解码并核对本次输出的动画参数、资源数量与 sprite 来源。结构通过不等于所有画面或目标 SDK 通过。' }]
  const check = (value: DeliveryCheck) => checks.push(value)
  const audioIndices = new Map<string, number[]>()
  ;(input.output.movie.audios || []).forEach((audio, index) => {
    const raw = audio as unknown as { audioKey?: string; key?: string }
    const key = raw.audioKey || raw.key
    if (typeof key !== 'string' || !key.length) throw new Error('交付 SVGA 包含无有效 Key 的音轨')
    audioIndices.set(key, [...(audioIndices.get(key) || []), index])
  })
  const byKey = new Map<string, DeliverySlot>()
  const ensureSlot = (key: string): DeliverySlot => {
    let slot = byKey.get(key)
    if (!slot) { slot = { key, role: 'unknown', state: 'unreferenced', resource: null, spriteIndices: [], matteForSpriteIndices: [], sources: [] }; byKey.set(key, slot) }
    return slot
  }
  input.output.movie.sprites.forEach((sprite, index) => {
    const slot = ensureSlot(sprite.imageKey || '')
    slot.spriteIndices.push(index)
    slot.sources.push(sources[index])
    if (!sprite.imageKey) check({ id: `empty-key-${index}`, title: '无动态 Key 的图层', status: 'warning', detail: `sprite ${index} 没有图片 Key，已用空字符串原样记录；不能当作命名插槽动态替换。` })
    if (sprite.matteKey) ensureSlot(sprite.matteKey).matteForSpriteIndices.push(index)
  })
  for (const key of audioIndices.keys()) ensureSlot(key)
  let decodedImageBytesEstimate = 0
  let dimensionsIncomplete = false
  let resourceIndex = 0
  for (const [key, bytes] of resources) {
    assertActive(job)
    const slot = ensureSlot(key)
    const { mimeType, extension } = resourceType(bytes)
    const file = await add(`resources/${String(++resourceIndex).padStart(5, '0')}.${extension}`, bytes, 'resource')
    const headerSize = imageSize(bytes, mimeType)
    const decoded = own(input.output.images || {}, key)
    const decodedSize = decoded ? sizeOf(decoded.naturalWidth || decoded.width, decoded.naturalHeight || decoded.height) : null
    const actualSize = headerSize || decodedSize
    slot.resource = { path: file.path, bytes: file.bytes, sha256: file.sha256, mimeType, width: actualSize?.width ?? null, height: actualSize?.height ?? null }
    if (mimeType.startsWith('image/') && !audioIndices.has(key)) {
      const pixels = Math.max(headerSize ? headerSize.width * headerSize.height : 0, decodedSize ? decodedSize.width * decodedSize.height : 0)
      if (!Number.isSafeInteger(pixels * 4) || !Number.isSafeInteger(decodedImageBytesEstimate + pixels * 4)) throw new Error(`资源“${key}”声明了无法安全估算的图片尺寸`)
      decodedImageBytesEstimate += pixels * 4
      if (!actualSize) dimensionsIncomplete = true
      if (!decodedSize) check({ id: `decode-${resourceIndex}`, title: '图片解码失败', status: 'failed', key, detail: '实际输出回读后没有可用位图。尺寸头不代表图片能完整解码，需修复资源后重新导出。' })
      if (headerSize && decodedSize && (headerSize.width !== decodedSize.width || headerSize.height !== decodedSize.height)) check({ id: `dimensions-${resourceIndex}`, title: '图片解码尺寸差异', status: 'warning', key, detail: `图片声明 ${headerSize.width}×${headerSize.height}，本机解码 ${decodedSize.width}×${decodedSize.height}；预算按较大像素估算，须在目标端检查。` })
    }
  }

  for (const [key, slot] of byKey) {
    const audio = audioIndices.has(key) || slot.resource?.mimeType.startsWith('audio/') === true
    const vector = slot.spriteIndices.length > 0 && slot.spriteIndices.every(index => input.output.movie.sprites[index].frames.some(frame => frame.shapes?.some(shape => shape.type !== 'KEEP')))
    const raster = slot.resource?.mimeType.startsWith('image/') === true
    slot.role = audio ? 'audio' : slot.matteForSpriteIndices.length ? 'matte' : !raster && vector ? 'vector' : raster ? 'image' : 'unknown'
    const referenced = slot.spriteIndices.length > 0 || slot.matteForSpriteIndices.length > 0 || audioIndices.has(key)
    const hasMatteSource = slot.matteForSpriteIndices.length === 0 || slot.spriteIndices.length > 0
    slot.state = referenced ? slot.resource?.bytes || vector ? 'referenced' : 'missing' : 'unreferenced'
    if (slot.state === 'missing') check({ id: `missing-${checks.length}`, title: '引用资源缺失', status: 'failed', key, detail: '输出 sprite、遮罩或音轨引用此 Key，但交付文件内没有对应的有效二进制资源或矢量内容。' })
    if (!hasMatteSource) check({ id: `matte-${checks.length}`, title: '缺少遮罩 sprite', status: 'failed', key, detail: 'matteKey 被引用，但没有携带该 Key 的输出 sprite；仅存在同名图片不能证明遮罩能正常工作。' })
    if (audio && (slot.spriteIndices.length || slot.matteForSpriteIndices.length)) check({ id: `role-${checks.length}`, title: '音频与图片 Key 冲突', status: 'failed', key, detail: '同一 Key 同时被音轨/音频资源和画面引用，不能安全作为动态图片交付。' })
    if (audioIndices.has(key) && raster) check({ id: `audio-bytes-${checks.length}`, title: '音轨引用了图片字节', status: 'failed', key, detail: '实际音轨引用的资源识别为图片，而非音频。静态画面不能证明声音有效，需修复源音轨后重新导出。' })
    if (audioIndices.has(key)) check({ id: `audio-${checks.length}`, title: '音轨参考', status: 'not-tested', key, detail: `实际音轨索引：${audioIndices.get(key)!.join(', ')}。静态预览不播放音频，音画同步及音频解码须在目标端实测。` })
    if (!audio && !raster && !vector && slot.resource?.bytes) { dimensionsIncomplete = true; check({ id: `unknown-${checks.length}`, title: '无法识别的画面资源', status: 'failed', key, detail: '资源不是已识别的图片，且没有可绘制的矢量内容，无法证明可见结果或估算其解码内存。' }) }
    if (slot.state === 'unreferenced') check({ id: `unused-${checks.length}`, title: '未引用资源', status: 'warning', key, detail: '实际 SVGA 内含此资源，但没有 sprite、遮罩或音轨引用；它仍计入交付体积，不应误认为可见插槽。' })
    if (key && slot.spriteIndices.length > 1) check({ id: `shared-${checks.length}`, title: '共享动态 Key', status: 'warning', key, detail: `该 Key 被 ${slot.spriteIndices.length} 个 sprite 共用。按 Key 替换会同时影响这些引用，所有来源已保留在 slots.json。` })
    if (slot.sources.some(source => source.sourceImageKey !== null && source.sourceImageKey !== key)) check({ id: `renamed-${checks.length}`, title: 'Key 已重命名', status: 'warning', key, detail: '实际输出 Key 与至少一个源图片 Key 不同；业务端必须使用这里的实际输出 Key，不能沿用原始名称。' })
    const signatures = new Set(slot.sources.map(source => JSON.stringify([source.textEffect, source.text])))
    if (key && signatures.size > 1) check({ id: `conflict-${checks.length}`, title: '共享 Key 的文字配置冲突', status: 'failed', key, detail: '多个精确来源对同一实际 Key 配置了不同文字状态或样式。不能任取第一个配置接入，请拆分 Key 或统一配置。' })
    const imageConfigs = slot.sources.map(source => source.sourceSlotKey === null ? undefined : own(input.document.slotConfigs, source.sourceSlotKey))
    if (key && imageConfigs.some(config => getSlotImageUrl(config) !== getSlotImageUrl(imageConfigs[0]) || (config?.imageConfig?.scaleMode || 'fit') !== (imageConfigs[0]?.imageConfig?.scaleMode || 'fit'))) check({ id: `image-conflict-${checks.length}`, title: '共享 Key 的图片配置冲突', status: 'failed', key, detail: '多个来源对同一实际 Key 配置了不同的替换图片或缩放模式，但输出只能保存一份该 Key 的图片。不能任取一个来源解释结果，请拆分 Key 或统一配置。' })
    const dynamic = slot.sources.some(source => source.textEffect === 'dynamic')
    if (dynamic) check({ id: `dynamic-${checks.length}`, title: '动态文字尚未接入', status: 'warning', key, detail: '文字仅在设计预览模拟，不在实际 SVGA 字形中。需将中立 schema 适配目标播放器，并检查字体、裁剪、排版和底图替换；字体文件未打包。' })
    if (slot.sources.some(source => source.textEffect === 'baked')) check({ id: `baked-${checks.length}`, title: '固定字形已写入', status: 'warning', key, detail: '文案已栅格化为 SVGA 图片的一部分，接入时不得再次叠字。此模式不支持直接通过动态文字 API 改回原字形；请修改工程重新导出。' })
    if ((isTextKeyCandidate(key) || slot.sources.some(source => isTextKeyCandidate(source.sourceImageKey || ''))) && !slot.sources.some(source => source.textEffect === 'dynamic' || source.textEffect === 'baked')) check({ id: `text-${checks.length}`, title: '文字候选尚无有效文案', status: 'warning', key, detail: '命名只提示可能用于文字，并不能证明 SVGA 有独立文字类型。当前来源未配置可见文案，或文案已关闭/为空，请与接入方确认用途。' })
    if (slot.resource?.mimeType === 'image/webp') check({ id: `webp-${checks.length}`, title: 'WebP 播放器兼容性', status: 'not-tested', key, detail: '实际输出含 WebP。编辑器能解码不代表目标 SDK 支持，必须在目标播放器版本实测。' })
  }

  for (const [key, slot] of Object.entries(input.document.slotConfigs)) {
    if ((slot.textConfig || slot.type === 'text') && !sources.some(source => source.sourceSlotKey === key)) check({ id: `orphan-text-${checks.length}`, title: '未交付的文字配置', status: 'warning', key, detail: '工程有此文字配置，但本次输出 sprite 没有对应来源；不能将该配置当作可接入的交付 Key。' })
  }
  if (input.document.audioResources.size || input.document.layers.some(layer => layer.type === 'audio')) {
    check({ id: 'source-audio-edits', title: '工程音频编辑范围', status: 'not-tested', detail: '当前 SVGA 编码保留原始 protobuf 音轨，不保证应用工程新增/修改的音频数据、音频图层和时间编排。下列音轨及资源仅以实际输出回读为准；源工程中的音频不等于已交付，静态预览不验证声音。' })
    for (const [key, resource] of input.document.audioResources) {
      const actual = resources.get(key)
      if (!audioIndices.has(key) || !actual || !bytesEqual(resource.data, actual)) check({ id: `source-audio-${checks.length}`, title: '源工程音频未完全写入', status: 'warning', key, detail: '该编辑音频在实际交付音轨中不存在，或数据与编辑素材不同。不能将源工程的音频承诺为已交付内容；需要核对原始音轨并在目标播放器试听。' })
    }
    for (const layer of input.document.layers.filter(layer => layer.type === 'audio' && layer.isNew)) check({ id: `new-audio-layer-${checks.length}`, title: '新增音频图层尚未验收', status: 'warning', ...(layer.audioKey ? { key: layer.audioKey } : {}), detail: `工程新增音频图层“${layer.name}”不属于 sprite 来源记录，也不能证明已编码为实际音轨，请以输出音轨清单和目标端试听为准。` })
  }
  const fileBudget = options.target.maxFileBytes
  check({ id: 'file-budget', title: '动画文件体积预算', status: fileBudget === null ? 'not-tested' : input.animation.size > fileBudget ? 'failed' : 'passed', detail: `animation.svga：${input.animation.size} 字节；${fileBudget === null ? '未设置预算。' : `预算 ${fileBudget} 字节。`} 此项不限制整个 ZIP 的大小。` })
  const imageBudget = options.target.maxDecodedImageBytes
  check({ id: 'image-budget', title: '图片 RGBA 解码预算', status: dimensionsIncomplete ? 'failed' : imageBudget === null ? 'not-tested' : decodedImageBytesEstimate > imageBudget ? 'failed' : 'passed', detail: `${dimensionsIncomplete ? '资源尺寸不完整，以下只是已知部分：' : ''}${decodedImageBytesEstimate} 字节；${imageBudget === null ? '未设置预算。' : `预算 ${imageBudget} 字节。`} 按所有实际图片的最大声明/解码像素 × 4 累加；不含 GPU 副本、帧缓存、音频或解码器开销，不是设备实测内存。` })
  check({ id: 'independent-keys', title: '独立 Key 保留', status: 'passed', detail: '本次交付强制关闭跨 Key 图片去重；内容相同的不同 Key 不会自动合并。既有共享 Key 仍保持共享。' })
  check({ id: 'target-runtime', title: '目标播放器与设备', status: 'not-tested', detail: `目标为 ${platformLabels[options.target.platform]} / ${options.target.player || '未指定播放器'} / ${options.target.version || '未指定版本'}。这里只记录要求，没有目标 SDK、操作系统或真机运行证据。` })
  check({ id: 'preview-scope', title: '预览与性能范围', status: 'not-tested', detail: `两张预览只覆盖第 ${input.document.currentFrame + 1} 帧（数据索引 ${input.document.currentFrame}），不含音频。全帧、裁剪、遮罩、音画同步、FPS、CPU/GPU 与真机内存仍需实测。` })
  if (sources.some(source => source.text)) check({ id: 'font-license', title: '字体交付与跨端排版', status: 'warning', detail: '本包不附带任何字体文件。固定字形使用导出时本机字体；动态文字会受目标端字体与排版差异影响。请核对字体使用许可，并在目标端验证。' })
  // 旧通用校验器把纯矢量 sprite 当作缺图；仅消除已经由实际形状证明的这一条特定误报。
  const vectorFalseWarnings = new Set(input.output.movie.sprites.flatMap((sprite, index) => {
    const slot = byKey.get(sprite.imageKey || '')
    return slot?.state === 'referenced' && !slot.resource && sprite.frames.some(frame => frame.shapes?.some(shape => shape.type !== 'KEEP'))
      ? [`精灵 ${index} 引用了不存在的图片: ${sprite.imageKey}`] : []
  }))
  const upstreamWarnings = [...new Set([...input.warnings, ...input.validation.warnings])].filter(warning => !vectorFalseWarnings.has(warning))
  upstreamWarnings.forEach((warning, index) => check({ id: `export-warning-${index}`, title: '导出器 / 结构校验提示', status: 'warning', detail: warning }))

  phase(job, '生成离线报告与完整性清单')
  const report: DeliveryReport = { format: 'svga-editor-delivery-report', schemaVersion: 1, checks, decodedImageBytesEstimate, previewFrame: input.document.currentFrame }
  const manifest: DeliveryManifest = {
    format: 'svga-editor-delivery', schemaVersion: 1, createdAt: new Date().toISOString(), title: options.title,
    sourceRevision: { schemaVersion: 1, algorithm: 'sha256', value: input.sourceRevision.toLowerCase() },
    params: { ...params }, target: options.target, previewFrame: input.document.currentFrame,
    optimization: structuredClone(input.optimization), independentKeysPreserved: true, includesProject: options.includeProject, files
  }
  const slots = [...byKey.values()]
  await add('slots.json', JSON.stringify({ format: 'svga-editor-delivery-slots', schemaVersion: 1, slots }, null, 2), 'slots')
  await add('report.json', JSON.stringify(report, null, 2), 'report')
  await add('README.html', reportHtml(manifest, slots, report), 'report')
  await add('README.md', guide(options.includeProject), 'guide')
  await add('manifest.json', JSON.stringify(manifest, null, 2), null)
  const checksumText = checksums.map(file => `${file.sha256}  ${file.path}\n`).join('')
  // checksums 不计算自己的摘要；manifest 的摘要在此列出，避免循环依赖。
  await add('checksums.sha256', checksumText, null)
  phase(job, '封装交付 ZIP')
  const blob = await generateZipArchive(zip, { compression: 'STORE', maxBytes: MAX_DELIVERY_BYTES + 1024 * 1024, signal: job.signal })
  assertActive(job)
  return { blob, fileName: safeArchiveName(options.title), manifest, slots, report, previews: { actual: input.actualPreview, design: input.designPreview } }
}
