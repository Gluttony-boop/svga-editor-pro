import JSZip from 'jszip'

export interface ResourceDownload {
  key: string
  load: () => Promise<Blob>
}

export async function loadResourceImage(source: {
  data?: Uint8Array
  buffer?: ArrayBuffer
  mimeType: string
  replacementUrl?: string
}): Promise<Blob> {
  if (source.replacementUrl) {
    const url = source.replacementUrl
    // Decode data URLs locally: a CSP may allow them in img-src but not connect-src.
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',')
      if (comma < 0) throw new Error('替换图片数据地址无效')
      const header = url.slice(5, comma)
      const payload = url.slice(comma + 1)
      const bytes = /;base64$/i.test(header)
        ? Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
        : new TextEncoder().encode(decodeURIComponent(payload))
      return new Blob([bytes], { type: header.split(';')[0] })
    }
    const response = await fetch(url)
    if (!response.ok) throw new Error(`读取替换图片失败 (${response.status})`)
    return response.blob()
  }
  if (source.data?.byteLength) return new Blob([new Uint8Array(source.data).buffer], { type: source.mimeType })
  if (source.buffer?.byteLength) return new Blob([source.buffer], { type: source.mimeType })
  throw new Error('没有可提取的图片数据')
}

export function getResourceExtension(bytes: Uint8Array, mimeType: string): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif'
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'webp'
  const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/avif': 'avif' }
  const extension = extensions[mimeType.split(';')[0].toLowerCase()]
  if (!extension) throw new Error('无法识别图片格式')
  return extension
}

export function getResourceFileName(key: string, extension: string, usedNames = new Set<string>()): string {
  let base = key.replace(/\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i, '')
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120)
  if (!base) base = 'image'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `_${base}`
  let name = `${base}.${extension}`
  let suffix = 2
  while (usedNames.has(name.toLowerCase())) name = `${base}_${suffix++}.${extension}`
  usedNames.add(name.toLowerCase())
  return name
}

export async function createResourceArchive(resources: readonly ResourceDownload[], onProgress?: (completed: number, total: number) => void): Promise<Blob> {
  if (!resources.length) throw new Error('没有可提取的图片')
  const zip = new JSZip()
  const usedNames = new Set<string>()
  const manifest: { key: string; file: string; bytes: number }[] = []
  for (const resource of resources) {
    try {
      const blob = await resource.load()
      if (!blob.size) throw new Error('图片数据为空')
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const file = getResourceFileName(resource.key, getResourceExtension(bytes, blob.type), usedNames)
      zip.file(file, bytes)
      manifest.push({ key: resource.key, file, bytes: bytes.byteLength })
      onProgress?.(manifest.length, resources.length)
    } catch (error) {
      throw new Error(`提取“${resource.key}”失败：${(error as Error).message}`)
    }
  }
  zip.file('manifest.json', JSON.stringify({ resources: manifest }, null, 2))
  // Images are already compressed; STORE avoids expensive redundant compression.
  return new Blob([await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' })], { type: 'application/zip' })
}
