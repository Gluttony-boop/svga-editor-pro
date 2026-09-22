import type { FrameData, Layer, SlotConfig } from '@/types'
import { detectImageMime } from '@/utils/image-mime'
import { findOriginalLayer } from './layer-transform'
import { applyLayerNamesToMovie, findLayerForSpriteIndex } from './layer-name-sync'
import {
  applyTextFrameLayout,
  getTextCompositionGeometry,
  hasTextBox,
  hasTextPreview,
  normalizeTextConfig,
  TextPreviewCache
} from './text-preview'

interface TextExportSprite {
  imageKey?: string | null
  matteKey?: string | null
  frames?: FrameData[]
}

interface TextExportMovie {
  images?: Record<string, Uint8Array | number[]> | null
  sprites?: TextExportSprite[] | null
}

const MAX_EXPORT_PIXELS = 64 * 1024 * 1024
const MAX_EXPORT_BYTES = 128 * 1024 * 1024
const MAX_SOURCE_IMAGE_PIXELS = 32 * 1024 * 1024
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
interface ImageDimensions { width: number; height: number }
interface DecodeBudget { pixels: number }

function needsTextExport(slot: SlotConfig): boolean {
  const text = slot.textConfig
  return !!text && (hasTextBox(slot) || text.exportMode !== undefined && text.exportMode !== 'preview' ||
    text.boxHeight !== undefined || text.referenceWidth !== undefined || text.referenceHeight !== undefined)
}

/** 常见压缩图片先检查头尺寸；其他格式仍需通过解码后的尺寸与累计像素检查。 */
function imageHeaderDimensions(bytes: Uint8Array): ImageDimensions | null {
  const mime = detectImageMime(bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mime === 'image/png' && bytes.length >= 24 && view.getUint32(12) === 0x49484452) {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (mime === 'image/gif' && bytes.length >= 10) return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  if (mime === 'image/bmp' && bytes.length >= 22) {
    const header = view.getUint32(14, true)
    if (header === 12) return { width: view.getUint16(18, true), height: view.getUint16(20, true) }
    if (header >= 40 && bytes.length >= 26) return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) }
  }
  if (mime === 'image/webp' && bytes.length >= 25) {
    const type = String.fromCharCode(...bytes.subarray(12, 16))
    if (type === 'VP8X' && bytes.length >= 30) {
      return { width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16) }
    }
    if (type === 'VP8L' && bytes[20] === 0x2f) {
      const packed = view.getUint32(21, true)
      return { width: 1 + (packed & 0x3fff), height: 1 + ((packed >>> 14) & 0x3fff) }
    }
    if (type === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    }
  }
  return null
}

function checkedPixels(size: ImageDimensions, key: string, budget: DecodeBudget): number {
  const { width, height } = size
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192) || width * height > MAX_SOURCE_IMAGE_PIXELS) {
    throw new Error(`文字容器“${key}”的底图尺寸过大或无效（单边最多 8192、最多 32 Mi 像素）`)
  }
  const pixels = width * height
  if (budget.pixels + pixels > MAX_EXPORT_PIXELS) throw new Error('文字底图累计解码像素超过 64 Mi，请压缩图片或分批导出')
  return pixels
}

/** 编辑器可能已重命名 Key，而输入 protobuf 仍引用旧 Key；先在源图片表中定位插槽。 */
export function mapSlotsToSourceImages(
  slots: Record<string, SlotConfig> | undefined,
  sprites: TextExportSprite[] | null | undefined,
  layers: Layer[] | undefined
): Record<string, SlotConfig> {
  for (const [key, slot] of Object.entries(slots || {})) {
    if (needsTextExport(slot) && /\.(matte|vector)$/i.test(key)) {
      throw new Error(`“${key}”是遮罩或矢量 Key，不能扩展文字容器或烘焙文字`)
    }
  }
  const result: Record<string, SlotConfig> = Object.assign(Object.create(null), slots)
  const referencedKeys = new Set(sprites?.map(sprite => sprite.imageKey).filter(Boolean))
  sprites?.forEach((sprite, index) => {
    const layerKey = findOriginalLayer(layers || [], index)?.imageKey
    if (!layerKey || !sprite.imageKey || !slots || !hasOwn(slots, layerKey)) return
    result[sprite.imageKey] = slots[layerKey]
    if (layerKey !== sprite.imageKey && !referencedKeys.has(layerKey)) delete result[layerKey]
  })
  return result
}

/** 文字在最终命名上合成，避免旧protobuf名称与当前Key的类型语义不一致。 */
export function applyTextExportLayerNames(
  movie: TextExportMovie,
  slots: Record<string, SlotConfig> | undefined,
  layers: Layer[] | undefined,
  imageSizes: ReadonlyMap<string, ImageDimensions>
): { slots: Record<string, SlotConfig>; imageSizes: Map<string, ImageDimensions> } {
  const sizes = new Map(imageSizes)
  if (!layers?.length) return { slots: Object.assign(Object.create(null), slots), imageSizes: sizes }
  const sourceKeys = new Map<string, string>()
  movie.sprites?.forEach((sprite, index) => {
    const layer = findLayerForSpriteIndex(layers, index)
    if (layer && sprite.imageKey) sourceKeys.set(layer.id, sprite.imageKey)
  })
  applyLayerNamesToMovie(movie, layers)
  const aliases = new Map<string, string>()
  movie.sprites?.forEach((sprite, index) => {
    const layer = findLayerForSpriteIndex(layers, index)
    if (!layer || !sprite.imageKey) return
    aliases.set(layer.id, sprite.imageKey)
    const size = sizes.get(layer.imageKey || '') || sizes.get(sourceKeys.get(layer.id) || '')
    if (size) sizes.set(sprite.imageKey, size)
  })
  return { slots: mapSlotsToExportImages(slots, layers, aliases, sourceKeys), imageSizes: sizes }
}

/** 同一源 Key 可导出为多个设计师命名；每个别名都必须沿用同一文字设置。 */
export function findExportSlotSourceKey(
  slots: Record<string, SlotConfig> | undefined,
  layer: Pick<Layer, 'imageKey'> | undefined,
  sourceKey?: string | null,
  exportKey?: string | null
): string | null {
  if (!slots) return null
  return [layer?.imageKey, sourceKey, exportKey].find(key => !!key && hasOwn(slots, key)) || null
}

/** 来源记录与实际文字/换图处理共用同一优先级，不能用图层显示名称推测 Key。 */
export function mapSlotsToExportImages(
  slots: Record<string, SlotConfig> | undefined,
  layers: Layer[],
  imageAliases: ReadonlyMap<string, string>,
  sourceKeys: ReadonlyMap<string, string> = new Map()
): Record<string, SlotConfig> {
  const result: Record<string, SlotConfig> = Object.assign(Object.create(null), slots)
  const mappedKeys = new Set<string>()
  const exportKeys = new Set(imageAliases.values())
  for (const layer of layers) {
    const exportKey = imageAliases.get(layer.id)
    if (!exportKey || !slots) continue
    const sourceKey = sourceKeys.get(layer.id)
    const slotKey = findExportSlotSourceKey(slots, layer, sourceKey, exportKey)
    if (slotKey) {
      result[exportKey] = slots[slotKey]
      mappedKeys.add(slotKey)
    }
  }
  for (const key of mappedKeys) if (!exportKeys.has(key)) delete result[key]
  return result
}

function decodeImage(bytes: Uint8Array | number[], key: string, budget: DecodeBudget): Promise<HTMLImageElement> {
  const data = new Uint8Array(bytes)
  const header = imageHeaderDimensions(data)
  const headerPixels = header ? checkedPixels(header, key, budget) : 0
  const image = new Image()
  const url = URL.createObjectURL(new Blob([data], { type: detectImageMime(data) }))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finish()
      reject(new Error(`文字容器“${key}”的底图解码超时，请重新选择图片`))
    }, 10000)
    const finish = () => { clearTimeout(timer); image.onload = null; image.onerror = null; URL.revokeObjectURL(url) }
    image.onload = () => {
      finish()
      try {
        const pixels = checkedPixels({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height }, key, budget)
        budget.pixels += Math.max(pixels, headerPixels)
        resolve(image)
      } catch (error) { reject(error) }
    }
    image.onerror = () => { finish(); reject(new Error(`文字容器“${key}”的底图解码失败，请重新选择图片`)) }
    try { image.src = url } catch {
      finish()
      reject(new Error(`文字容器“${key}”的底图读取失败，请重新选择图片`))
    }
  })
}

/** 替换图之前捕获原始天然尺寸；缺layout的帧与编辑预览必须使用同一回退宽高。 */
export async function resolveTextExportImageSizes(
  movie: TextExportMovie,
  slots: Record<string, SlotConfig>,
  knownSizes: ReadonlyMap<string, ImageDimensions> = new Map(),
  layers: Layer[] = []
): Promise<Map<string, ImageDimensions>> {
  const result = new Map(knownSizes)
  const budget = { pixels: 0 }
  for (const [key, slot] of Object.entries(slots)) {
    if (!needsTextExport(slot)) continue
    const normalized = normalizeTextConfig(slot.textConfig, slot.type === 'text' ? slot.value : null)
    const currentKeys = (movie.sprites || []).flatMap((sprite, index) => {
      const layerKey = sprite.imageKey === key ? findOriginalLayer(layers, index)?.imageKey : undefined
      return layerKey ? [layerKey] : []
    })
    let size = [result.get(key), ...currentKeys.map(current => result.get(current))].find(value => value && value.width > 0 && value.height > 0)
    if (!size) {
      const source = movie.images && hasOwn(movie.images, key) ? movie.images[key] : undefined
      if (source?.length) {
        const header = imageHeaderDimensions(new Uint8Array(source))
        if (header) { checkedPixels(header, key, budget); size = header }
        else {
          const image = await decodeImage(source, key, budget)
          size = { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height }
        }
      }
    }
    size ??= { width: normalized.referenceWidth!, height: normalized.referenceHeight! }
    result.set(key, size)
    for (const current of currentKeys) result.set(current, size)
  }
  return result
}

function encodePng(canvas: HTMLCanvasElement, key: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(blob => {
        if (!blob || blob.type && blob.type !== 'image/png') {
          reject(new Error(`文字容器“${key}”PNG 编码失败`))
          return
        }
        blob.arrayBuffer().then(buffer => resolve(new Uint8Array(buffer)), reject)
      }, 'image/png')
    } catch {
      reject(new Error(`文字容器“${key}”无法写入 PNG，请检查图片跨域权限`))
    }
  })
}

async function waitForFont(slot: SlotConfig, key: string): Promise<void> {
  const config = normalizeTextConfig(slot.textConfig, slot.type === 'text' ? slot.value : null)
  if (!document.fonts) return
  try {
    await document.fonts.ready
    await document.fonts.load(`${config.fontWeight} ${config.fontSize}px ${config.fontFamily}`, config.text)
  } catch {
    throw new Error(`文字“${key}”的字体加载失败，请选择本机可用字体后重试`)
  }
}

/**
 * 必须先烘焙原图层变换再调用：仅扩大局部布局，不改变运动矩阵与原始旋转中心。
 * 返回独立副本，预览模式只扩展透明底图；只有明确 bake 才把当前字形写入图片。
 */
export async function prepareTextSlotsForExport<T extends TextExportMovie>(
  movie: T,
  slots: Record<string, SlotConfig> | undefined,
  originalImageSizes?: ReadonlyMap<string, ImageDimensions>
): Promise<T> {
  const operations: Array<{ key: string; slot: SlotConfig; includeText: boolean; width: number; height: number }> = []
  const sprites = movie.sprites || []
  const maskKeys = new Set(sprites.map(sprite => sprite.matteKey).filter(Boolean))
  let totalPixels = 0
  for (const [key, slot] of Object.entries(slots || {})) {
    if (!needsTextExport(slot)) continue
    const normalized = normalizeTextConfig(slot.textConfig, slot.type === 'text' ? slot.value : null)
    const matches = sprites.filter(sprite => sprite.imageKey === key)
    if (matches.length === 0) throw new Error(`文字容器“${key}”没有对应图层，请重新选择文字 Key`)
    if (/\.(matte|vector)$/i.test(key) || maskKeys.has(key) || matches.some(sprite => sprite.frames?.some(frame => frame.shapes?.length))) {
      throw new Error(`“${key}”是遮罩或矢量 Key，不能扩展文字容器或烘焙文字`)
    }
    const includeText = normalized.exportMode === 'bake'
    const geometry = getTextCompositionGeometry(slot, {
      width: normalized.referenceWidth!, height: normalized.referenceHeight!
    }, { includeText })
    if (!geometry) throw new Error(`文字容器“${key}”的尺寸无效，请重新设置文字范围`)
    totalPixels += geometry.width * geometry.height
    if (totalPixels > MAX_EXPORT_PIXELS) throw new Error('文字容器总像素超过 64 Mi，请缩小范围或分批导出')
    operations.push({ key, slot, includeText, width: geometry.width, height: geometry.height })
  }
  if (!operations.length) return movie

  let totalBytes = Object.values(movie.images || {}).reduce((sum, data) => sum + data.length, 0)
  if (totalBytes > MAX_EXPORT_BYTES) throw new Error('文字导出的图片数据超过 128 MiB，请先压缩或减少资源')
  const output = structuredClone(movie)
  // __proto__、constructor 等也可能是合法资源 Key，不能作为对象继承属性处理。
  output.images = Object.assign(Object.create(null), output.images)
  const cache = new TextPreviewCache()
  const decodeBudget = { pixels: 0 }
  try {
    for (const { key, slot, includeText, width, height } of operations) {
      const source = hasOwn(output.images!, key) ? output.images![key] : undefined
      if (includeText && hasTextPreview(slot)) await waitForFont(slot, key)
      const image = source?.length ? await decodeImage(source, key, decodeBudget) : null
      const normalized = normalizeTextConfig(slot.textConfig, slot.type === 'text' ? slot.value : null)
      const canvas = cache.compose(key, slot, image, {
        width: normalized.referenceWidth!, height: normalized.referenceHeight!
      }, { includeText })
      if (!canvas || canvas === image || !('toBlob' in canvas) || canvas.width !== width || canvas.height !== height) {
        throw new Error(`文字容器“${key}”合成失败，未生成完整导出文件`)
      }
      const bytes = await encodePng(canvas as HTMLCanvasElement, key)
      if (!bytes.length) throw new Error(`文字容器“${key}”编码结果为空`)
      totalBytes += bytes.length - (source?.length || 0)
      if (totalBytes > MAX_EXPORT_BYTES) throw new Error('文字导出的图片数据超过 128 MiB，请缩小文字范围')
      output.images![key] = bytes
      const original = originalImageSizes?.get(key) || (image ? { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height } : {
        width: normalized.referenceWidth, height: normalized.referenceHeight
      })
      for (const sprite of output.sprites || []) {
        if (sprite.imageKey !== key) continue
        sprite.frames = sprite.frames?.map(frame => applyTextFrameLayout(frame, slot, original, includeText))
      }
      // 导出顺序编码，不累计持有上一个 Key 的解码图和局部 canvas。
      cache.clear()
    }
    return output
  } finally {
    cache.clear()
  }
}
