import type { SlotConfig, SlotTextConfig } from '@/types'

const MAX_SIDE = 8192
const MAX_PIXELS = 4_194_304
const MAX_CACHE_PIXELS = MAX_PIXELS * 4
const MAX_CACHE_ENTRIES = 64

type TextBoxConfig = Pick<SlotTextConfig, 'boxWidth' | 'boxHeight' | 'referenceWidth' | 'referenceHeight'>

function normalizeTextBox(config?: Partial<SlotTextConfig>): TextBoxConfig {
  const fields = ['boxWidth', 'boxHeight', 'referenceWidth', 'referenceHeight'] as const
  if (!fields.some(field => config?.[field] !== undefined)) return {}
  if (!fields.every(field => Number.isInteger(config?.[field]) && config![field]! >= 1 && config![field]! <= MAX_SIDE)) {
    throw new Error('文字区域及参考宽高必须同时设置为 1–8192 的整数像素。')
  }
  const { boxWidth: width, boxHeight: height, referenceWidth, referenceHeight } = config as Required<TextBoxConfig>
  if (Math.max(width, referenceWidth) * Math.max(height, referenceHeight) > MAX_PIXELS) {
    throw new Error('文字区域与原图合并后不能超过 4,194,304 像素，请减小宽度或高度。')
  }
  return { boxWidth: width, boxHeight: height, referenceWidth, referenceHeight }
}

function finiteInRange(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

/** 导入的配置也经过同一边界校验，避免不可见文字或异常大的离屏分配。 */
export function normalizeTextConfig(config?: Partial<SlotTextConfig>, value?: string | null): SlotTextConfig {
  const text = typeof config?.text === 'string' ? config.text : typeof value === 'string' ? value : ''
  const fontFamily = typeof config?.fontFamily === 'string' ? config.fontFamily.trim() : ''
  const color = typeof config?.color === 'string' ? config.color.trim() : ''
  const box = normalizeTextBox(config)
  if (config?.exportMode !== undefined && config.exportMode !== 'preview' && config.exportMode !== 'bake') {
    throw new Error('文字导出模式无效，请选择仅模拟或转图片写入 SVGA。')
  }
  if (config?.exportMode === 'bake' && box.boxWidth === undefined) {
    throw new Error('文字写入 SVGA 前需设置文字区域和参考尺寸。')
  }
  return {
    text: Array.from(text.replace(/\r\n?/g, '\n')).slice(0, 500).join(''),
    fontSize: finiteInRange(config?.fontSize, 24, 1, 512),
    color: color && color.length <= 128 && !/[;{}\r\n]/.test(color) ? color : '#ffffff',
    fontFamily: fontFamily && fontFamily.length <= 128 && !/[;{}\r\n]/.test(fontFamily) ? fontFamily : 'Arial',
    fontWeight: config?.fontWeight === 'bold' ? 'bold' : 'normal',
    textAlign: config?.textAlign === 'left' || config?.textAlign === 'right' ? config.textAlign : 'center',
    offsetX: finiteInRange(config?.offsetX, 0, -MAX_SIDE, MAX_SIDE),
    offsetY: finiteInRange(config?.offsetY, 0, -MAX_SIDE, MAX_SIDE),
    lineHeight: finiteInRange(config?.lineHeight, 1.2, 0.5, 4),
    enabled: config?.enabled !== false,
    replaceImage: config?.replaceImage === true,
    ...box,
    ...(config?.exportMode ? { exportMode: config.exportMode } : {})
  }
}

export function hasTextBox(slot?: SlotConfig): boolean {
  return slot?.textConfig?.boxWidth !== undefined
}

export function hasTextPreview(slot?: SlotConfig): boolean {
  if (!slot || (!slot.textConfig && slot.type !== 'text')) return false
  const config = normalizeTextConfig(slot.textConfig, slot.type === 'text' ? slot.value : null)
  return config.enabled !== false && config.text.trim().length > 0
}

interface PreviewSize { width: number; height: number }
interface SourceSize { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number }

export interface TextCompositionGeometry {
  sourceWidth: number
  sourceHeight: number
  textWidth: number
  textHeight: number
  width: number
  height: number
  drawWidth: number
  drawHeight: number
}

/** 固定局部参考坐标使所有引用共用同一张图；逐帧布局缩放仍按原动画变化。 */
export function getTextCompositionGeometry(
  slot: SlotConfig | undefined,
  size: PreviewSize,
  options: { includeText?: boolean } = {}
): TextCompositionGeometry | null {
  if (!slot) return null
  const textVisible = options.includeText !== false && hasTextPreview(slot)
  if (!hasTextBox(slot) && !textVisible) return null
  const config = normalizeTextConfig(slot.textConfig, slot.type === 'text' ? slot.value : null)
  if (![size.width, size.height].every(value => Number.isFinite(value) && value > 0)) return null
  const sourceWidth = config.referenceWidth ?? Math.ceil(size.width)
  const sourceHeight = config.referenceHeight ?? Math.ceil(size.height)
  const textWidth = config.boxWidth ?? sourceWidth
  const textHeight = config.boxHeight ?? sourceHeight
  const keepImage = !textVisible || !config.replaceImage
  const width = keepImage ? Math.max(sourceWidth, textWidth) : textWidth
  const height = keepImage ? Math.max(sourceHeight, textHeight) : textHeight
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) return null
  return {
    sourceWidth, sourceHeight, textWidth, textHeight, width, height,
    drawWidth: size.width * width / sourceWidth,
    drawHeight: size.height * height / sourceHeight
  }
}

/** 先完成原图层变换，再扩展绘制范围，避免宽度改变导致缩放/旋转中心漂移。 */
export function applyTextFrameLayout<T extends { layout?: Partial<PreviewSize> | null }>(
  frame: T, slot: SlotConfig | undefined, original?: SourceSize | null, includeText = true
): T {
  if (!hasTextBox(slot)) return frame
  const geometry = getTextCompositionGeometry(slot, getTextPreviewSize(frame.layout, original), { includeText })
  if (!geometry) return frame
  return {
    ...frame,
    layout: { ...frame.layout, width: geometry.drawWidth, height: geometry.drawHeight }
  }
}

/** 布局来自原始帧，不使用替换图片的像素大小，保证改图后文字位置不跳动。 */
export function getTextPreviewSize(layout: Partial<PreviewSize> | null | undefined, original?: SourceSize | null): PreviewSize {
  const dimension = (layoutValue: number | undefined, sourceValue: number | undefined) => (
    typeof layoutValue === 'number' && Number.isFinite(layoutValue) && layoutValue > 0 ? layoutValue : sourceValue || 0
  )
  return {
    width: dimension(layout?.width, original?.naturalWidth || original?.width),
    height: dimension(layout?.height, original?.naturalHeight || original?.height)
  }
}

interface TextCacheEntry {
  signature: string
  image: CanvasImageSource | null
  canvas: HTMLCanvasElement
  pixels: number
}

/** 共享预览与显式导出的文字位图；不修改传入资源，帧运动与遮罩由调用者保留。 */
export class TextPreviewCache {
  private entries = new Map<string, TextCacheEntry>()
  private pixels = 0

  compose<T extends CanvasImageSource>(
    key: string,
    slot: SlotConfig | undefined,
    image: T | null,
    size: PreviewSize,
    options: { includeText?: boolean } = {}
  ): T | HTMLCanvasElement | null {
    const geometry = getTextCompositionGeometry(slot, size, options)
    if (!geometry) return image
    const { width, height, sourceWidth, sourceHeight, textWidth, textHeight } = geometry
    const textVisible = options.includeText !== false && hasTextPreview(slot)
    const config = normalizeTextConfig(slot!.textConfig, slot!.type === 'text' ? slot!.value : null)
    const signature = JSON.stringify([width, height, sourceWidth, sourceHeight, config, textVisible])
    const cacheKey = JSON.stringify([key, width, height])
    const cached = this.entries.get(cacheKey)
    if (cached && cached.signature === signature && cached.image === image) {
      this.entries.delete(cacheKey)
      this.entries.set(cacheKey, cached)
      return cached.canvas
    }
    if (cached) this.remove(cacheKey)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return image
    if (image && (!textVisible || !config.replaceImage)) ctx.drawImage(image, 0, 0, sourceWidth, sourceHeight)

    if (textVisible) {
      ctx.save()
      if (hasTextBox(slot)) {
        // 文字框可小于保留的底图；只裁文字，不裁底图或原动画的 clipPath。
        ctx.beginPath(); ctx.rect(0, 0, textWidth, textHeight); ctx.clip()
      }
      ctx.font = `${config.fontWeight} ${config.fontSize}px ${config.fontFamily}`
      // Canvas 忽略无效颜色赋值；先放入确定的默认值，避免继承旧样式。
      ctx.fillStyle = '#ffffff'
      ctx.fillStyle = config.color
      ctx.textAlign = config.textAlign!
      ctx.textBaseline = 'middle'
      const lines = config.text.split('\n')
      const spacing = config.fontSize * config.lineHeight!
      const baseX = config.textAlign === 'left' ? 0 : config.textAlign === 'right' ? textWidth : textWidth / 2
      const baseY = textHeight / 2 - (lines.length - 1) * spacing / 2
      lines.forEach((line, index) => {
        ctx.fillText(line, baseX + config.offsetX!, baseY + config.offsetY! + index * spacing)
      })
      ctx.restore()
    }

    const pixels = width * height
    while (this.entries.size >= MAX_CACHE_ENTRIES || this.pixels + pixels > MAX_CACHE_PIXELS) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.remove(oldest)
    }
    this.entries.set(cacheKey, { signature, image, canvas, pixels })
    this.pixels += pixels
    return canvas
  }

  private remove(key: string): void {
    const entry = this.entries.get(key)
    if (entry) this.pixels -= entry.pixels
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
    this.pixels = 0
  }
}
