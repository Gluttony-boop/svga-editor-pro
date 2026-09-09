export type ImageFitMode = 'fit' | 'fill' | 'stretch'

export interface ImageFitRect { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number }

export function calculateImageFit(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number, mode: ImageFitMode): ImageFitRect {
  if (![sourceWidth, sourceHeight, targetWidth, targetHeight].every(Number.isFinite) || sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    throw new Error('图片尺寸必须为正数')
  }
  if (mode === 'stretch') return { sx: 0, sy: 0, sw: sourceWidth, sh: sourceHeight, dx: 0, dy: 0, dw: targetWidth, dh: targetHeight }
  const scale = mode === 'fill'
    ? Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight)
    : Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight)
  if (mode === 'fit') {
    const dw = sourceWidth * scale
    const dh = sourceHeight * scale
    return { sx: 0, sy: 0, sw: sourceWidth, sh: sourceHeight, dx: (targetWidth - dw) / 2, dy: (targetHeight - dh) / 2, dw, dh }
  }
  const sw = targetWidth / scale
  const sh = targetHeight / scale
  return { sx: (sourceWidth - sw) / 2, sy: (sourceHeight - sh) / 2, sw, sh, dx: 0, dy: 0, dw: targetWidth, dh: targetHeight }
}

export function validateReplacementSize(width: number, height: number): void {
  if (![width, height].every(value => Number.isInteger(value) && value > 0)) throw new Error('无法获取原素材的有效尺寸，不能应用替换')
  if (width > 8192 || height > 8192 || width * height > 4_194_304) throw new Error('原素材尺寸过大，替换预览最多支持 419 万像素')
}

export async function fitImageToDataUrl(url: string, targetWidth: number, targetHeight: number, mode: ImageFitMode, signal?: AbortSignal): Promise<string> {
  if (typeof document === 'undefined') throw new Error('当前环境不支持图片处理')
  validateReplacementSize(targetWidth, targetHeight)
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
  const image = new Image()
  image.decoding = 'async'
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      image.onload = null
      image.onerror = null
    }
    const onAbort = () => { cleanup(); image.src = ''; reject(new DOMException('已取消', 'AbortError')) }
    const timer = window.setTimeout(() => { cleanup(); image.src = ''; reject(new Error('图片加载超时，请换一张图片重试')) }, 8000)
    signal?.addEventListener('abort', onAbort, { once: true })
    image.onload = () => { cleanup(); resolve() }
    image.onerror = () => { cleanup(); reject(new Error('图片无法解码，请选择有效的 PNG、JPEG 或 WebP 图片')) }
    image.src = url
  })
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
  if (image.naturalWidth * image.naturalHeight > 33_554_432) throw new Error('上传图片过大，请先缩小图片')
  const canvas = document.createElement('canvas')
  try {
    canvas.width = targetWidth
    canvas.height = targetHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建图片处理画布')
    const rect = calculateImageFit(image.naturalWidth, image.naturalHeight, canvas.width, canvas.height, mode)
    ctx.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, rect.dx, rect.dy, rect.dw, rect.dh)
    return canvas.toDataURL('image/png')
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}
