import type { FrameData, ImageResource, Layer, SlotConfig, Sprite, VideoItem } from '@/types'
import { detectImageMime } from './image-mime'

export interface SlotCatalogEntry {
  key: string
  imageAvailable: boolean
  width: number
  height: number
  referenceLayerIds: string[]
  isMatte: boolean
  isVector: boolean
  textCandidate: boolean
  textConfigured: boolean
  canSimulateText: boolean
  reason: string
  warning?: string
}

interface Dimensions { width: number; height: number }
interface KeyUsage {
  layerIds: Set<string>
  imageLayerIds: Set<string>
  dimensions: Map<string, Dimensions>
  hasImageSource: boolean
  matte: boolean
  vector: boolean
}

function ownValue<T>(object: Record<string, T> | null | undefined, key: string): T | undefined {
  return object && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined
}

function isKey(key: unknown): key is string {
  // 空白也是 Key 的一部分，不能 trim 后再交给播放器。
  return typeof key === 'string' && key.length > 0
}

function dimensions(width: unknown, height: unknown): Dimensions | undefined {
  return typeof width === 'number' && typeof height === 'number' &&
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height } : undefined
}

/** 仅提示命名意图；SVGA 本身没有可由名称证明的独立文字 Key 类型。 */
export function isTextKeyCandidate(key: string): boolean {
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z\u4e00-\u9fff])(\d)/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter(Boolean)
  if (tokens.some(token => ['text', 'label', 'title', 'nickname', 'username', '文字', '昵称'].includes(token))) return true
  const nameIndex = tokens.indexOf('name')
  if (nameIndex < 0) return false
  if (tokens.every(token => token === 'name' || /^\d+$/.test(token))) return true
  return nameIndex > 0 && ['user', 'nick', 'display', 'player', 'sender', 'recipient'].includes(tokens[nameIndex - 1])
}

function bytesOf(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return new Uint8Array(value)
  }
  return undefined
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length))
}

function isAudioBytes(bytes: Uint8Array | undefined): boolean {
  if (!bytes) return false
  return ascii(bytes, 0, 3) === 'ID3' || ascii(bytes, 0, 4) === 'OggS' ||
    ascii(bytes, 0, 4) === 'fLaC' ||
    (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) ||
    (ascii(bytes, 4, 4) === 'ftyp' && /^M4[ABP] /.test(ascii(bytes, 8, 4)))
}

function isRasterBytes(bytes: Uint8Array | undefined): boolean {
  if (!bytes) return false
  const mime = detectImageMime(bytes)
  if (mime === 'image/png') return bytes.length >= 8 && ascii(bytes, 4, 4) === '\r\n\u001a\n'
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[2] === 0xff
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))
  if (mime === 'image/webp') return bytes.length >= 12
  if (mime === 'image/bmp') return bytes.length >= 14
  return false
}

function rasterDimensions(bytes: Uint8Array | undefined): Dimensions | undefined {
  if (!bytes || !isRasterBytes(bytes)) return undefined
  const mime = detectImageMime(bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mime === 'image/png' && bytes.length >= 24 && ascii(bytes, 12, 4) === 'IHDR') {
    return dimensions(view.getUint32(16), view.getUint32(20))
  }
  if (mime === 'image/gif' && bytes.length >= 10) return dimensions(view.getUint16(6, true), view.getUint16(8, true))
  if (mime === 'image/bmp' && bytes.length >= 26) return dimensions(view.getInt32(18, true), Math.abs(view.getInt32(22, true)))
  if (mime === 'image/webp' && bytes.length >= 30 && ascii(bytes, 12, 4) === 'VP8X') {
    return dimensions(1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16))
  }
  return undefined
}

function isImageSource(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false
  if (/^data:/i.test(value)) return /^data:image\/(?:png|jpe?g|webp|gif|bmp|avif|x-icon|vnd\.microsoft\.icon)[;,]/i.test(value)
  return !/^\s*(?:javascript|data|about):/i.test(value)
}

function originalSprite(layer: Layer, video: VideoItem | null): Sprite | undefined {
  return !layer.isNew && Number.isInteger(layer.editableIndex) && (layer.editableIndex ?? -1) >= 0
    ? video?.movie?.sprites?.[layer.editableIndex!] : undefined
}

/** 当前图层决定可调用 Key；未引用资源和孤立配置保留在列表，但不能模拟文字。 */
export function buildSlotCatalog(
  video: VideoItem | null,
  layers: readonly Layer[],
  resources: ReadonlyMap<string, ImageResource>,
  configs: Record<string, SlotConfig>,
): SlotCatalogEntry[] {
  const usages = new Map<string, KeyUsage>()
  const keys = new Set<string>()
  const audioKeys = new Set<string>()
  const ensureUsage = (key: string): KeyUsage => {
    keys.add(key)
    let usage = usages.get(key)
    if (!usage) {
      usage = { layerIds: new Set(), imageLayerIds: new Set(), dimensions: new Map(), hasImageSource: false, matte: false, vector: false }
      usages.set(key, usage)
    }
    return usage
  }
  for (const audio of video?.movie?.audios ?? []) {
    // 兼容原始 protobuf 的 audioKey 和编辑态的 key，不以扩展名猜测音频。
    const raw = audio as unknown as { key?: unknown; audioKey?: unknown } | null
    for (const key of [raw?.key, raw?.audioKey]) if (isKey(key)) audioKeys.add(key)
  }
  for (const layer of layers) {
    if (layer.type === 'audio') {
      if (isKey(layer.audioKey)) audioKeys.add(layer.audioKey)
      continue
    }
    const original = originalSprite(layer, video)
    const sprite = layer.sprites ?? original
    const key = layer.imageKey ?? sprite?.imageKey
    if (isKey(key)) {
      const usage = ensureUsage(key)
      usage.layerIds.add(layer.id)
      if (layer.type === 'image') usage.imageLayerIds.add(layer.id)
      const frames: FrameData[] = Array.isArray(sprite?.frames) ? sprite.frames : []
      usage.vector ||= layer.type === 'shape' || frames.some(frame => (frame?.shapes?.length ?? 0) > 0)
      usage.hasImageSource ||= isImageSource(layer.imageSource?.value)
      for (const frame of frames) {
        const size = dimensions(frame?.layout?.width, frame?.layout?.height)
        if (size) usage.dimensions.set(size.width + ':' + size.height, size)
      }
    }
    // 拥有 matteKey 的内容层仍可模拟；只有被作为遮罩引用的 Key 才禁止。
    const matteKey = original?.matteKey ?? sprite?.matteKey
    if (isKey(matteKey)) {
      const usage = ensureUsage(matteKey)
      usage.layerIds.add(layer.id)
      usage.matte = true
    }
  }
  for (const map of [video?.movie?.images, video?.buffers, video?.images]) {
    for (const key of Object.keys(map ?? {})) if (isKey(key)) keys.add(key)
  }
  for (const key of resources.keys()) if (isKey(key)) keys.add(key)
  for (const key of Object.keys(configs ?? {})) if (isKey(key)) keys.add(key)

  const result: SlotCatalogEntry[] = []
  for (const key of keys) {
    const resource = resources.get(key)
    const image = ownValue(video?.images, key)
    const byteSources = [bytesOf(resource?.data), bytesOf(ownValue(video?.movie?.images, key)), bytesOf(ownValue(video?.buffers, key))]
    if (audioKeys.has(key) || byteSources.some(isAudioBytes)) continue
    const usage = usages.get(key)
    const config = ownValue(configs, key)
    const textConfigured = config?.type === 'text' || config?.textConfig != null
    const textCandidate = isTextKeyCandidate(key)
    const isMatte = !!usage?.matte || /\.matte$/i.test(key)
    const isVector = !!usage?.vector || /\.vector$/i.test(key)
    const imageSize = dimensions(image?.naturalWidth, image?.naturalHeight) ?? dimensions(image?.width, image?.height)
    const bitmapSize = dimensions(resource?.bitmap?.width, resource?.bitmap?.height)
    const imageAvailable = !isVector && (!!bitmapSize || isImageSource(image?.currentSrc || image?.src) ||
      isImageSource(resource?.blobUrl) || isImageSource(resource?.source?.value) ||
      !!usage?.hasImageSource || byteSources.some(isRasterBytes))
    // 和文字渲染器一致，优先用原始帧布局，图片像素尺寸仅作为回退。
    const sizes = [...(usage?.dimensions.values() ?? []), imageSize, bitmapSize,
      dimensions(resource?.width, resource?.height), ...byteSources.map(rasterDimensions)]
      .filter((size): size is Dimensions => !!size)
    const size = sizes[0]
    const imageReferences = usage?.imageLayerIds.size ?? 0
    const withinPreviewLimit = !!size && Math.ceil(size.width) <= 8192 && Math.ceil(size.height) <= 8192 && Math.ceil(size.width) * Math.ceil(size.height) <= 4_194_304
    const canSimulateText = imageReferences > 0 && withinPreviewLimit && !isMatte && !isVector
    const warnings: string[] = []
    if (sizes.some(candidate => size && (candidate.width !== size.width || candidate.height !== size.height))) {
      warnings.push('资源尺寸与图层布局尺寸不一致或多个引用尺寸不同；列表显示首个有效布局，预览以当前帧布局为准。')
    }
    if (canSimulateText && !imageAvailable) warnings.push('没有可用位图，按图层布局尺寸显示文字。')
    if (imageReferences > 1) warnings.push('此 Key 被 ' + imageReferences + ' 个图片图层共用，文字模拟会同时作用于这些图层。')
    const reason = isMatte ? '遮罩 Key 仅供查看，不支持文字模拟。'
      : isVector ? '包含矢量图形的 Key 仅供查看，不支持文字模拟。'
      : imageReferences === 0 ? (textConfigured ? '已配置文字，但当前没有图片图层引用此 Key。' : '当前没有图片图层引用此 Key。')
      : !size ? '缺少有效资源尺寸或图层布局尺寸，不能模拟文字。'
      : !withinPreviewLimit ? '预览区域尺寸超限：单边最多 8192 像素，总像素最多 4,194,304。'
      : textConfigured ? '已配置文字模拟；文字使用此精确 imageKey 绑定。'
      : textCandidate ? '名称疑似文字用途，仅为命名推测，可配置文字模拟。'
      : '图片 Key，可绑定文字模拟；SVGA 不区分独立文字 Key。'
    result.push({
      key, imageAvailable, width: size?.width ?? 0, height: size?.height ?? 0,
      referenceLayerIds: [...(usage?.layerIds ?? [])], isMatte, isVector,
      textCandidate, textConfigured, canSimulateText, reason,
      ...(warnings.length ? { warning: warnings.join(' ') } : {}),
    })
  }
  return result
}
