/**
 * SVGA 优化器
 * 提供图片压缩、帧数据精简、智能优化等功能
 */

import pako from 'pako'
import protobuf from 'protobufjs'
import SVGA_PROTO_JSON from './svga-proto'

/**
 * 优化预设配置
 */
export interface OptimizationPreset {
  id: string
  name: string
  description: string
  config: OptimizationConfig
}

/**
 * 优化配置
 */
export interface OptimizationConfig {
  /** 是否启用优化 */
  enabled: boolean
  
  /** 图片优化 */
  image: {
    /** 图片格式: 'webp' | 'png' | 'auto'. PNG is the safest choice for legacy SVGA players. */
    format: 'webp' | 'png' | 'auto'
    /** 压缩质量 (0-100) */
    quality: number
    /** 0 = full colour, 64/128/256 = lossy RGBA palette quantization. */
    pngColors?: 0 | 64 | 128 | 256
    /** 是否启用缩放 */
    resizeEnabled: boolean
    /** 缩放百分比 (1-100) */
    resizePercent: number
    /** 最大宽度限制 (0 表示不限制) */
    maxWidth: number
    /** 最大高度限制 (0 表示不限制) */
    maxHeight: number
    /** 是否去重相同图片 */
    deduplicate: boolean
  }
  
  /** 帧数据优化 */
  frames: {
    /** 是否启用帧数据精简 */
    simplify: boolean
    /** 关键帧精简阈值 (0-1, 相邻帧差异小于此值时合并) */
    keyframeThreshold: number
    /** 是否移除不可见帧的数据 */
    removeInvisible: boolean
    /** 数值精度 (小数位数) */
    precision: number
  }
  
  /** 压缩优化 */
  compression: {
    /** zlib 压缩级别 (1-9) */
    level: number
    /** 是否使用更高效的压缩算法 */
    useBestCompression: boolean
  }
}

/**
 * 优化统计信息
 */
export interface OptimizationStats {
  originalSize: number
  optimizedSize: number
  reductionPercent: number
  
  imagesOptimized: number
  imagesSkipped: number
  imagesDeduplicated: number
  
  framesSimplified: number
  framesRemoved: number
  
  processingTime: number
  imagesFailed?: number
  warnings?: string[]
}

/**
 * 预设配置列表
 */
const makePreset = (id: string, name: string, description: string, pngColors: 0 | 64 | 128 | 256, resizePercent = 100): OptimizationPreset => ({
  id, name, description,
  config: {
    enabled: id !== 'none',
    image: { format: 'png', quality: 85, pngColors, resizeEnabled: resizePercent < 100, resizePercent, maxWidth: 0, maxHeight: 0, deduplicate: false },
    frames: { simplify: false, keyframeThreshold: 0.01, removeInvisible: false, precision: 6 },
    compression: { level: 9, useBestCompression: true }
  }
})

export const OPTIMIZATION_PRESETS: OptimizationPreset[] = [
  makePreset('none', '无优化', '仅应用编辑，不压缩素材，保留当前质量。', 0),
  makePreset('light', '保真 PNG', '全彩 PNG，不缩图、不精简动画；更小才替换，压缩收益可能有限。', 0),
  makePreset('balanced', '均衡 PNG · 256 色', 'PNG 调色板量化，不改变画布尺寸；渐变、半透明可能有轻微损失，请先预览。', 256),
  makePreset('aggressive', '高压缩 PNG · 128 色', '128 色量化，图片分辨率降至 75%，画布和动画坐标不变。', 128, 75),
  makePreset('extreme', '极限 PNG · 64 色', '64 色量化，图片分辨率降至 50%；明显有损，务必对比画面。', 64, 50),
  { ...makePreset('webp', 'WebP · 兼容性自检', '有损 WebP，保留画布与动画。必须在目标 SVGA 播放器验证支持情况。', 0),
    config: { ...makePreset('webp', '', '', 0).config, image: { ...makePreset('webp', '', '', 0).config.image, format: 'webp', quality: 85 } } },
  makePreset('custom', '自定义', '按实际图片格式选择色数或质量；尺寸设置只改变图片分辨率。', 0)
]

/**
 * 获取预设配置
 */
export function getPreset(id: string): OptimizationPreset | undefined {
  return OPTIMIZATION_PRESETS.find(p => p.id === id)
}

/**
 * SVGA 优化器类
 */
export class SVGAOptimizer {
  private MovieEntity: any = null
  private stats: OptimizationStats = {
    originalSize: 0,
    optimizedSize: 0,
    reductionPercent: 0,
    imagesOptimized: 0,
    imagesSkipped: 0,
    imagesDeduplicated: 0,
    framesSimplified: 0,
    framesRemoved: 0,
    processingTime: 0
  }

  async init(): Promise<void> {
    const root = protobuf.Root.fromJSON(SVGA_PROTO_JSON)
    this.MovieEntity = root.lookupType('com.opensource.svga.MovieEntity')
  }

  /**
   * 获取优化统计信息
   */
  getStats(): OptimizationStats {
    return { ...this.stats }
  }

  /**
   * 重置统计信息
   */
  private resetStats(): void {
    this.stats = {
      originalSize: 0,
      optimizedSize: 0,
      reductionPercent: 0,
      imagesOptimized: 0,
      imagesSkipped: 0,
      imagesDeduplicated: 0,
      framesSimplified: 0,
      framesRemoved: 0,
      processingTime: 0,
      imagesFailed: 0,
      warnings: []
    }
  }

  /**
   * 优化 SVGA 文件
   */
  async optimize(
    buffer: ArrayBuffer,
    config: OptimizationConfig,
    onProgress?: (completed: number, total: number) => void
  ): Promise<Blob> {
    const startTime = performance.now()
    this.resetStats()
    this.stats.originalSize = buffer.byteLength

    if (!this.MovieEntity) {
      await this.init()
    }


    // 如果优化未启用，直接返回原始文件
    if (!config.enabled) {
      this.stats.optimizedSize = buffer.byteLength
      this.stats.reductionPercent = 0
      this.stats.processingTime = Math.round(performance.now() - startTime)
      return new Blob([buffer], { type: 'application/octet-stream' })
    }

    if (!Number.isFinite(config.image.quality) || config.image.quality < 0 || config.image.quality > 100
      || ![0,64,128,256].includes(config.image.pngColors ?? 0)
      || !Number.isFinite(config.image.resizePercent) || config.image.resizePercent < 1 || config.image.resizePercent > 100
      || ![config.image.maxWidth, config.image.maxHeight].every(value => Number.isFinite(value) && value >= 0)
      || !Number.isInteger(config.compression.level) || config.compression.level < 1 || config.compression.level > 9) {
      throw new Error('压缩参数无效，请重新选择一个预设')
    }

    // 1. 解压 SVGA 数据
    const data = new Uint8Array(buffer)
    let decompressed: Uint8Array
    let svgaVersion = 0x02

    const magic = String.fromCharCode(...data.slice(0, 4))
    if (magic === 'SVGA') {
      svgaVersion = data[4]
      if (svgaVersion === 0x02) {
        decompressed = pako.inflate(data.slice(8))
      } else {
        decompressed = data.slice(8)
      }
    } else {
      try {
        decompressed = pako.inflate(data)
      } catch {
        decompressed = data
      }
    }


    // 2. 解码 protobuf - 关键：不使用 toObject，直接操作 decodedMessage
    const decodedMessage = this.MovieEntity.decode(decompressed)
    decodedMessage.version = '2.0.0'

    // 3. 图片优化（包含去重和更新引用）
    // 直接修改 decodedMessage，不创建新对象
    if (config.image) {
      await this.optimizeImages(decodedMessage, config.image, onProgress)
    }

    // 4. 帧数据优化
    if (config.frames) {
      this.optimizeFrames(decodedMessage, config.frames)
    }

    // 5. 编码 - 直接编码 decodedMessage（已被修改）
    const encoded = this.MovieEntity.encode(decodedMessage).finish()

    // 验证编码后的数据可以正确解码
    this.MovieEntity.decode(encoded)

    // 6. 压缩
    const compressionLevel = config.compression.level
    const compressed = pako.deflate(encoded, { level: compressionLevel as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 })

    // 7. 构建官方 SVGA 2.0 输出：zlib-compressed protobuf MovieEntity
    let result = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer
    if (result.byteLength > buffer.byteLength) {
      result = buffer.slice(0)
      this.stats.imagesOptimized = 0
      this.stats.imagesDeduplicated = 0
      this.stats.framesSimplified = 0
      this.stats.framesRemoved = 0
      this.stats.warnings?.push('整包优化未减小体积，已保留优化前的编辑副本。')
    }

    // 更新统计
    this.stats.optimizedSize = result.byteLength
    this.stats.reductionPercent = Math.round((1 - this.stats.optimizedSize / this.stats.originalSize) * 100)
    this.stats.processingTime = Math.round(performance.now() - startTime)

    return new Blob([result], { type: 'application/octet-stream' })
  }

  /**
   * 优化图片
   */
  private async optimizeImages(
    decodedMessage: any,
    config: OptimizationConfig['image'],
    onProgress?: (completed: number, total: number) => void
  ): Promise<void> {
    if (!decodedMessage.images) return
    if (config.deduplicate) this.deduplicateImagesWithReferences(decodedMessage)
    const audioKeys = new Set((decodedMessage.audios || []).map((audio: any) => audio.audioKey || audio.key))
    const keys = Object.keys(decodedMessage.images).filter(key => !audioKeys.has(key))
    const scale = config.resizeEnabled ? Math.max(0.01, Math.min(1, config.resizePercent / 100)) : 1
    let completed = 0
    for (const key of keys) {
      let url: string | undefined
      try {
        const data: Uint8Array = decodedMessage.images[key]
        if (!data?.byteLength) throw new Error('图片数据为空')
        const mime = this.getImageMimeType(data)
        url = URL.createObjectURL(new Blob([new Uint8Array(data).buffer], { type: mime }))
        const result = await this.processImageWithScale(
          url, config.quality / 100, scale,
          config.format === 'webp' || (config.format === 'auto' && mime === 'image/webp'),
          config.resizeEnabled ? config.maxWidth : 0,
          config.resizeEnabled ? config.maxHeight : 0,
          config.pngColors ?? 0
        )
        if (result.buffer.byteLength < data.byteLength) {
          decodedMessage.images[key] = new Uint8Array(result.buffer)
          this.stats.imagesOptimized++
        } else {
          this.stats.imagesSkipped++
        }
      } catch (error) {
        this.stats.imagesSkipped++
        this.stats.imagesFailed = (this.stats.imagesFailed ?? 0) + 1
        this.stats.warnings?.push(`图片“${key}”处理失败，已保留原图：${(error as Error).message}`)
      } finally {
        if (url) URL.revokeObjectURL(url)
      }
      onProgress?.(++completed, keys.length)
      // Give painting, progress and document-change checks a chance between textures.
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    // Texture resolution is independent of layout, transforms, paths and viewBox.
  }
  /**
   * 图片去重（同时更新 sprites 引用）
   */
  private deduplicateImagesWithReferences(decodedMessage: any): void {
    if (!decodedMessage.images || !decodedMessage.sprites) return
    const images = decodedMessage.images
    const protectedKeys = new Set<string>([
      ...decodedMessage.sprites.map((sprite: any) => sprite.matteKey).filter(Boolean),
      ...(decodedMessage.audios || []).map((audio: any) => audio.audioKey || audio.key).filter(Boolean)
    ])
    const buckets = new Map<string, string[]>()
    const aliases = new Map<string, string>()
    for (const key of Object.keys(images)) {
      if (protectedKeys.has(key)) continue
      const data: Uint8Array = images[key]
      const hash = this.simpleHash(data)
      const candidates = buckets.get(hash) || []
      // A hash only narrows candidates. Equality must include every byte.
      const match = candidates.find(candidate => data.length === images[candidate].length
        && data.every((byte, index) => byte === images[candidate][index]))
      if (match) aliases.set(key, match)
      else { candidates.push(key); buckets.set(hash, candidates) }
    }
    for (const sprite of decodedMessage.sprites) {
      if (aliases.has(sprite.imageKey)) sprite.imageKey = aliases.get(sprite.imageKey)
    }
    for (const key of aliases.keys()) {
      delete images[key]
      this.stats.imagesDeduplicated++
    }
  }
  /**
   * 简单哈希函数
   */
  private simpleHash(data: Uint8Array): string {
    let hash = 0
    const step = Math.max(1, Math.floor(data.length / 1000))
    for (let i = 0; i < data.length; i += step) {
      hash = ((hash << 5) - hash + data[i]) | 0
    }
    return `${data.length}-${hash}`
  }

  /**
   * 处理单张图片，返回实际缩放比例
   * 保持等比缩放，不失去透明度
   */
  private async processImageWithScale(
    url: string, quality: number, scale: number, useWebP: boolean,
    maxWidth: number, maxHeight: number, pngColors: number = 0
  ): Promise<{ buffer: ArrayBuffer; actualScale: number }> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      let canvas: HTMLCanvasElement | undefined
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        img.onload = null
        img.onerror = null
        if (canvas) { canvas.width = 0; canvas.height = 0 }
      }
      const fail = (error: unknown) => {
        if (settled) return
        settled = true; cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const timer = setTimeout(() => fail(new Error('图片处理超时')), 30000)
      img.onload = async () => {
        try {
          const width = img.naturalWidth || img.width, height = img.naturalHeight || img.height
          if (width < 1 || height < 1) throw new Error('图片尺寸无效')
          const ratio = Math.min(1, scale, maxWidth > 0 ? maxWidth / width : 1, maxHeight > 0 ? maxHeight / height : 1)
          const targetWidth = Math.max(1, Math.round(width * ratio)), targetHeight = Math.max(1, Math.round(height * ratio))
          if (targetWidth * targetHeight > 16_777_216) throw new Error('图片超过安全处理像素上限')
          canvas = document.createElement('canvas')
          canvas.width = targetWidth; canvas.height = targetHeight
          const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: pngColors > 0 })
          if (!ctx) throw new Error('无法创建压缩画布')
          ctx.clearRect(0, 0, targetWidth, targetHeight)
          ctx.drawImage(img, 0, 0, targetWidth, targetHeight)
          let buffer: ArrayBuffer
          if (!useWebP && pngColors > 0) {
            const pixels = ctx.getImageData(0, 0, targetWidth, targetHeight)
            const { compressPalettePng } = await import('./png-compressor')
            buffer = await compressPalettePng(pixels.data, targetWidth, targetHeight, pngColors)
          } else {
            const blob = await new Promise<Blob>((done, failed) => canvas!.toBlob(
              result => result ? done(result) : failed(new Error('图片编码返回空结果')),
              useWebP ? 'image/webp' : 'image/png', useWebP ? quality : 1
            ))
            buffer = await blob.arrayBuffer()
          }
          if (settled) return
          settled = true; cleanup()
          resolve({ buffer, actualScale: targetWidth / width })
        } catch (error) { fail(error) }
      }
      img.onerror = () => fail(new Error('图片解码失败'))
      img.src = url
    })
  }
  /**
   * 优化帧数据
   */
  // @ts-ignore TS6133 - 保留用于将来扩展
  private optimizeFrames(
    decodedMessage: any,
    config: OptimizationConfig['frames']
  ): void {
    if (!decodedMessage.sprites) return


    for (const sprite of decodedMessage.sprites) {
      if (!sprite.frames) continue

      const optimizedFrames: any[] = []
      let lastFrame: any = null

      for (let i = 0; i < sprite.frames.length; i++) {
        const frame = sprite.frames[i]

        // 移除不可见帧的数据
        if (config.removeInvisible && frame.alpha === 0) {
          // 保留一个最小化的不可见帧
          optimizedFrames.push({
            alpha: 0,
            layout: null,
            transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
            clipPath: null
          })
          this.stats.framesRemoved++
          continue
        }

        // 精简关键帧
        if (config.simplify && lastFrame) {
          const diff = this.calculateFrameDifference(frame, lastFrame)
          if (diff < config.keyframeThreshold) {
            // 复用上一帧数据
            optimizedFrames.push({ ...lastFrame })
            this.stats.framesSimplified++
            continue
          }
        }

        // 应用精度优化
        const precisionFrame = config.precision < 6
          ? this.applyPrecision(frame, config.precision)
          : frame

        optimizedFrames.push(precisionFrame)
        lastFrame = frame
      }

      sprite.frames = optimizedFrames
    }
  }

  /**
   * 计算帧差异
   */
  private calculateFrameDifference(frame1: any, frame2: any): number {
    // Paths, layout, shapes and field presence cannot be reduced to transform distance.
    const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key)
    for (const key of new Set([...Object.keys(frame1), ...Object.keys(frame2)])) {
      if (own(frame1, key) !== own(frame2, key)) return Infinity
      if (key !== 'alpha' && key !== 'transform' && JSON.stringify(frame1[key]) !== JSON.stringify(frame2[key])) return Infinity
    }
    if (frame1.transform && frame2.transform) {
      for (const key of ['a', 'b', 'c', 'd', 'tx', 'ty']) if (own(frame1.transform, key) !== own(frame2.transform, key)) return Infinity
    }
    let diff = 0
    let count = 0

    // 比较 alpha
    if (frame1.alpha !== undefined && frame2.alpha !== undefined) {
      diff += Math.abs(frame1.alpha - frame2.alpha)
      count++
    }

    // 比较 transform
    if (frame1.transform && frame2.transform) {
      const t1 = frame1.transform
      const t2 = frame2.transform
      diff += Math.abs(t1.a - t2.a) + Math.abs(t1.b - t2.b) +
              Math.abs(t1.c - t2.c) + Math.abs(t1.d - t2.d) +
              Math.abs(t1.tx - t2.tx) + Math.abs(t1.ty - t2.ty)
      count += 6
    }

    return count > 0 ? diff / count : 0
  }

  /**
   * 应用数值精度
   */
  private applyPrecision(frame: any, precision: number): any {
    const factor = Math.pow(10, precision)

    const roundValue = (v: number) => Math.round(v * factor) / factor

    const result = { ...frame }

    if (result.alpha !== undefined) {
      result.alpha = roundValue(result.alpha)
    }

    if (result.transform) {
      result.transform = Object.fromEntries(Object.entries(result.transform).map(([key, value]) => [key, typeof value === 'number' ? roundValue(value) : value]))
    }

    if (result.layout) {
      result.layout = Object.fromEntries(Object.entries(result.layout).map(([key, value]) => [key, typeof value === 'number' ? roundValue(value) : value]))
    }

    return result
  }

  /**
   * 获取图片 MIME 类型
   */
  private getImageMimeType(data: Uint8Array): string {
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
      return 'image/png'
    }
    if (data[0] === 0xFF && data[1] === 0xD8) {
      return 'image/jpeg'
    }
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
        data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
      return 'image/webp'
    }
    return 'image/png'
  }

  /**
   * 一键优化 - 智能选择最佳预设
   * 只进行图片压缩，不改变 SVGA 结构
   */
  async quickOptimize(buffer: ArrayBuffer): Promise<Blob> {
    // 根据文件大小智能选择预设
    const fileSize = buffer.byteLength
    
    let preset: OptimizationPreset
    if (fileSize < 100 * 1024) {
      // 小于 100KB，轻度优化
      preset = getPreset('light')!
    } else if (fileSize < 500 * 1024) {
      // 100KB - 500KB，均衡优化
      preset = getPreset('balanced')!
    } else if (fileSize < 2 * 1024 * 1024) {
      // 500KB - 2MB，激进优化
      preset = getPreset('aggressive')!
    } else {
      // 大于 2MB，极限优化
      preset = getPreset('extreme')!
    }

    return this.optimize(buffer, preset.config)
  }
  
  /**
   * 安全优化 - 只进行图片压缩，保持原始 SVGA 结构不变
   * 重新编码 protobuf，但保留布局、坐标与帧数据，不做素材去重
   */
  async safeOptimize(buffer: ArrayBuffer, config: OptimizationConfig['image']): Promise<Blob> {
    const options = structuredClone(getPreset('light')!.config)
    options.image = { ...config, deduplicate: false }
    return this.optimize(buffer, options)
  }
}

// 单例导出
export const svgaOptimizer = new SVGAOptimizer()
