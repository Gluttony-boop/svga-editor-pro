import type { MovieParams } from '@/types'

/** SVGA 播放器和浏览器 Canvas 都能安全处理的尺寸上限。 */
export const MAX_CANVAS_DIMENSION = 8192
export const MAX_CANVAS_PIXELS = 4_194_304

export interface CanvasSize {
  width: number
  height: number
}

export function getCanvasSizeError(size: CanvasSize): string | null {
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)) return '画布宽度和高度必须是整数。'
  if (size.width < 1 || size.height < 1) return '画布宽度和高度必须至少为 1 px。'
  if (size.width > MAX_CANVAS_DIMENSION || size.height > MAX_CANVAS_DIMENSION) {
    return `画布单边不能超过 ${MAX_CANVAS_DIMENSION} px。`
  }
  if (size.width * size.height > MAX_CANVAS_PIXELS) {
    return `画布像素总数不能超过 ${MAX_CANVAS_PIXELS.toLocaleString()}。`
  }
  return null
}

export function getCanvasSizeFromParams(params?: MovieParams | null): CanvasSize | null {
  if (!params) return null
  return { width: params.viewBoxWidth, height: params.viewBoxHeight }
}

/** 保留帧率和帧数，只替换 SVGA viewBox 尺寸。 */
export function replaceCanvasSize(params: MovieParams, size: CanvasSize): MovieParams {
  return { ...params, viewBoxWidth: size.width, viewBoxHeight: size.height }
}
