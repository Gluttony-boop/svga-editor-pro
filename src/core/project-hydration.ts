import type { ProjectDocument } from '@/types/project'
import type { ImageResource } from '@/types'
import { detectImageMime } from '@/utils/image-mime'
import { getSlotImageUrl } from '@/utils/slot-config'
import { MAX_PROJECT_BYTES } from './project-validation'

export const MAX_PROJECT_DECODED_PIXELS = 64 * 1024 * 1024
const MAX_IMAGE_PIXELS = 33_554_432

interface ImageDimensions { width: number; height: number }

/** 常见无损格式先检查尺寸头，避免压缩很小的超大图片先交给浏览器分配位图。 */
function imageHeaderDimensions(bytes: Uint8Array, mime: string): ImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mime === 'image/png' && bytes.byteLength >= 24
    && view.getUint32(12) === 0x49484452) {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (mime === 'image/gif' && bytes.byteLength >= 10) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  if (mime === 'image/bmp' && bytes.byteLength >= 22) {
    const headerSize = view.getUint32(14, true)
    if (headerSize === 12) return { width: view.getUint16(18, true), height: view.getUint16(20, true) }
    // Windows 信息头的负高度表示自顶向下存储，并非负尺寸。
    if (headerSize >= 40 && bytes.byteLength >= 26) return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) }
  }
  // JPEG、WebP 及未知 BMP 头暂不自行解析，仍受归档字节限制与解码后的尺寸/总像素检查约束。
  return null
}

/** 打开的工程只能使用归档还原的 Data URL；不通过 fetch 读取任何协议。 */
function slotImageBytes(url: string, key: string): Uint8Array {
  const maxBase64Length = Math.ceil(MAX_PROJECT_BYTES / 3) * 4
  if (typeof url !== 'string' || url.length > maxBase64Length + 40) throw new Error(`工程插槽“${key}”图片数据超过安全大小上限。`)
  const header = /^data:image\/(?:png|jpeg|webp|gif);base64,/i.exec(url)
  if (!header) throw new Error(`工程插槽“${key}”仅允许归档内的图片 Data URL，不能读取远端或临时地址。`)
  const encoded = url.slice(header[0].length)
  if (!encoded || encoded.length > maxBase64Length || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error(`工程插槽“${key}”图片 Base64 数据无效。`)
  let binary: string
  try { binary = atob(encoded) } catch { throw new Error(`工程插槽“${key}”图片 Base64 数据无效。`) }
  if (!binary.length || binary.length > MAX_PROJECT_BYTES) throw new Error(`工程插槽“${key}”图片数据超过安全大小上限。`)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** 仅解码工程内字节；绝不按工程中的地址下载远端素材。失败时释放本次所有 URL。 */
export async function hydrateProjectDocument(document: ProjectDocument, signal?: AbortSignal): Promise<{ document: ProjectDocument; dispose: () => void }> {
  const assertActive = () => { if (signal?.aborted) throw new DOMException('已取消工程素材准备。', 'AbortError') }
  assertActive()
  const urls = new Set<string>()
  const releaseUrl = (url: string) => { if (urls.delete(url)) URL.revokeObjectURL(url) }
  const dispose = () => { urls.forEach(releaseUrl) }
  const images: ProjectDocument['videoItem']['images'] = Object.create(null)
  const resources = new Map<string, ImageResource>()
  const sourceBytes = new Map<string, Uint8Array>()
  for (const [key, buffer] of Object.entries(document.videoItem.buffers)) sourceBytes.set(key, new Uint8Array(buffer))
  for (const [key, bytes] of Object.entries(document.videoItem.movie.images || {})) if (!sourceBytes.has(key)) sourceBytes.set(key, new Uint8Array(bytes))

  let decodedPixels = 0
  const checkDimensions = ({ width, height }: ImageDimensions, key: string) => {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
      || width > 8192 || height > 8192 || width * height > MAX_IMAGE_PIXELS) {
      throw new Error(`工程图片“${key}”尺寸过大或无效。`)
    }
    const pixels = width * height
    if (decodedPixels + pixels > MAX_PROJECT_DECODED_PIXELS) throw new Error('工程图片累计解码像素超过安全上限（64 Mi 像素），请减少图片数量或分辨率。')
    return pixels
  }

  const decode = async (bytes: Uint8Array, key: string) => {
    assertActive()
    const mime = detectImageMime(bytes)
    if (!mime.startsWith('image/')) throw new Error(`工程图片“${key}”不是可解码的图片。`)
    const headerDimensions = imageHeaderDimensions(bytes, mime)
    const headerPixels = headerDimensions ? checkDimensions(headerDimensions, key) : 0
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: mime }))
    urls.add(url)
    const image = new Image()
    image.decoding = 'async'
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => done(new Error(`工程图片“${key}”解码超时。`)), 10000)
      const onAbort = () => done(new DOMException('已取消工程素材准备。', 'AbortError'))
      const done = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort)
        image.onload = null; image.onerror = null
        if (error) { image.src = ''; reject(error) } else resolve()
      }
      image.onload = () => {
        try {
          assertActive()
          const pixels = checkDimensions({ width: image.naturalWidth, height: image.naturalHeight }, key)
          // 某些浏览器会降采样自然尺寸；预算不能小于源文件声明的位图尺寸。
          decodedPixels += Math.max(headerPixels, pixels)
          done()
        } catch (error) { done(error as Error) }
      }
      image.onerror = () => done(new Error(`工程图片“${key}”无法解码，当前工作未替换。`))
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) { onAbort(); return }
      image.src = url
    })
    assertActive()
    return { image, url }
  }

  try {
    // 顺序解码避免不可信工程同时分配大量位图；每张完成后才处理下一张。
    for (const [key, bytes] of sourceBytes) {
      assertActive()
      if (!detectImageMime(bytes).startsWith('image/')) continue
      images[key] = (await decode(bytes, key)).image
    }
    for (const [key, resource] of document.imageResources) {
      assertActive()
      const bytes = resource.data.byteLength ? resource.data : sourceBytes.get(key)
      if (!bytes?.byteLength) throw new Error(`工程缺少图片资源“${key}”。`)
      const source = sourceBytes.get(key)
      const useSource = images[key] && source && source.byteLength === bytes.byteLength && source.every((byte, index) => byte === bytes[index])
      const prepared = useSource ? { image: images[key], url: images[key].src } : await decode(bytes, key)
      resources.set(key, { ...resource, data: new Uint8Array(bytes), width: prepared.image.naturalWidth, height: prepared.image.naturalHeight, blobUrl: prepared.url, bitmap: undefined, source: undefined })
    }
    for (const [key, config] of Object.entries(document.slotConfigs)) {
      assertActive()
      // 与渲染器共享旧版文字 value 的判定，不能把昵称当成相对网络地址。
      const url = getSlotImageUrl(config)
      if (!url) continue
      const prepared = await decode(slotImageBytes(url, key), `插槽 ${key}`)
      // 保留自包含 Data URL；这里只验证可解码性，不让临时 Blob 和位图占用跟随工程存活。
      prepared.image.src = ''
      releaseUrl(prepared.url)
    }
    assertActive()
    return { document: { ...document, videoItem: { ...document.videoItem, images }, imageResources: resources }, dispose }
  } catch (error) { dispose(); throw error }
}
