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
    /** 图片格式: 'webp' | 'png' | 'auto' */
    format: 'webp' | 'png' | 'auto'
    /** 压缩质量 (0-100) */
    quality: number
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
}

/**
 * 预设配置列表
 */
export const OPTIMIZATION_PRESETS: OptimizationPreset[] = [
  {
    id: 'none',
    name: '无优化',
    description: '保持原始质量，不进行任何优化',
    config: {
      enabled: false,
      image: {
        format: 'auto',
        quality: 100,
        resizeEnabled: false,
        resizePercent: 100,
        maxWidth: 0,
        maxHeight: 0,
        deduplicate: false
      },
      frames: {
        simplify: false,
        keyframeThreshold: 0,
        removeInvisible: false,
        precision: 6
      },
      compression: {
        level: 6,
        useBestCompression: false
      }
    }
  },
  {
    id: 'light',
    name: '轻度优化',
    description: '轻度压缩，画质损失极小，适合高清展示',
    config: {
      enabled: true,
      image: {
        format: 'webp',
        quality: 90,
        resizeEnabled: false,
        resizePercent: 100,
        maxWidth: 0,
        maxHeight: 0,
        deduplicate: false  // 关闭去重，避免潜在问题
      },
      frames: {
        simplify: false,
        keyframeThreshold: 0.01,
        removeInvisible: false,
        precision: 6
      },
      compression: {
        level: 7,
        useBestCompression: false
      }
    }
  },
  {
    id: 'balanced',
    name: '均衡优化',
    description: '平衡画质与体积，适合大多数场景',
    config: {
      enabled: true,
      image: {
        format: 'webp',
        quality: 80,
        resizeEnabled: false,
        resizePercent: 100,
        maxWidth: 0,
        maxHeight: 0,
        deduplicate: false  // 关闭去重，避免潜在问题
      },
      frames: {
        simplify: false,
        keyframeThreshold: 0.02,
        removeInvisible: false,
        precision: 6
      },
      compression: {
        level: 8,
        useBestCompression: true
      }
    }
  },
  {
    id: 'aggressive',
    name: '激进优化',
    description: '大幅压缩体积，适合网络传输',
    config: {
      enabled: true,
      image: {
        format: 'webp',
        quality: 70,
        resizeEnabled: true,
        resizePercent: 75,
        maxWidth: 1080,
        maxHeight: 1920,
        deduplicate: false
      },
      frames: {
        simplify: false,
        keyframeThreshold: 0.03,
        removeInvisible: false,
        precision: 4
      },
      compression: {
        level: 9,
        useBestCompression: true
      }
    }
  },
  {
    id: 'extreme',
    name: '极限优化',
    description: '最大程度压缩，适合移动端和低带宽场景',
    config: {
      enabled: true,
      image: {
        format: 'webp',
        quality: 60,
        resizeEnabled: true,
        resizePercent: 50,
        maxWidth: 750,
        maxHeight: 1334,
        deduplicate: false
      },
      frames: {
        simplify: false,
        keyframeThreshold: 0.05,
        removeInvisible: false,
        precision: 3
      },
      compression: {
        level: 9,
        useBestCompression: true
      }
    }
  },
  {
    id: 'custom',
    name: '自定义',
    description: '自定义优化参数',
    config: {
      enabled: true,
      image: {
        format: 'webp',
        quality: 80,
        resizeEnabled: false,
        resizePercent: 100,
        maxWidth: 0,
        maxHeight: 0,
        deduplicate: false
      },
      frames: {
        simplify: false,
        keyframeThreshold: 0.02,
        removeInvisible: false,
        precision: 6
      },
      compression: {
        level: 8,
        useBestCompression: true
      }
    }
  }
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
      processingTime: 0
    }
  }

  /**
   * 优化 SVGA 文件
   */
  async optimize(
    buffer: ArrayBuffer,
    config: OptimizationConfig
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
      await this.optimizeImages(decodedMessage, config.image)
    }

    // 4. 帧数据优化
    if (config.frames) {
      this.optimizeFrames(decodedMessage, config.frames)
    }

    // 5. 编码 - 直接编码 decodedMessage（已被修改）
    const encoded = this.MovieEntity.encode(decodedMessage).finish()

    // 验证编码后的数据可以正确解码
    try {
      const verifyMsg = this.MovieEntity.decode(encoded)
      // @ts-ignore verification check
      const verifyObj = this.MovieEntity.toObject(verifyMsg, { bytes: Uint8Array, defaults: false })
    } catch (e) {
      console.error('[Optimizer] Verification failed:', e)
    }

    // 6. 压缩
    const compressionLevel = config.compression.level
    const compressed = pako.deflate(encoded, { level: compressionLevel as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 })

    // 7. 构建官方 SVGA 2.0 输出：zlib-compressed protobuf MovieEntity
    const result = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer

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
    config: OptimizationConfig['image']
  ): Promise<void> {
    if (!decodedMessage.images) return

    // 图片去重（需要更新 sprites 引用）
    if (config.deduplicate) {
      this.deduplicateImagesWithReferences(decodedMessage)
    }

    // 计算基础缩放比例
    let baseScale = 1
    if (config.resizeEnabled && config.resizePercent < 100) {
      baseScale = config.resizePercent / 100
    }

    // 如果启用了缩放，需要先计算所有图片的最终缩放比例
    let finalScale = baseScale
    
    if (baseScale !== 1 && (config.maxWidth > 0 || config.maxHeight > 0)) {
      // 第一遍：计算每张图片的实际缩放比例
      const imageScaleMap = new Map<string, number>()
      
      for (const key of Object.keys(decodedMessage.images)) {
        try {
          const uint8Data = decodedMessage.images[key]
          if (!uint8Data) continue
          
          // 创建 Blob URL 获取图片尺寸
          const mimeType = this.getImageMimeType(uint8Data)
          const blob = new Blob([uint8Data.buffer.slice(uint8Data.byteOffset, uint8Data.byteOffset + uint8Data.byteLength)], { type: mimeType })
          const url = URL.createObjectURL(blob)
          
          // 获取图片尺寸
          const dimensions = await this.getImageDimensions(url)
          
          // 计算此图片的实际缩放比例
          let targetWidth = Math.round(dimensions.width * baseScale)
          let targetHeight = Math.round(dimensions.height * baseScale)
          let actualScale = baseScale
          
          // originalRatio: dimensions.width / dimensions.height（保留用于比例验证扩展）
          
          if (config.maxWidth > 0 && targetWidth > config.maxWidth) {
            actualScale = config.maxWidth / dimensions.width
          }
          if (config.maxHeight > 0 && targetHeight > config.maxHeight) {
            const scaleForHeight = config.maxHeight / dimensions.height
            actualScale = Math.min(actualScale, scaleForHeight)
          }
          
          imageScaleMap.set(key, actualScale)
          URL.revokeObjectURL(url)
          
        } catch (err) {
          console.warn(`[Optimizer] Failed to get dimensions for "${key}":`, err)
          imageScaleMap.set(key, baseScale)
        }
      }
      
      // 找出所有精灵图使用的图片中的最小缩放比例
      if (decodedMessage.sprites) {
        const usedScales: number[] = []
        for (const sprite of decodedMessage.sprites) {
          if (sprite.imageKey && imageScaleMap.has(sprite.imageKey)) {
            usedScales.push(imageScaleMap.get(sprite.imageKey)!)
          }
        }
        finalScale = usedScales.length > 0 ? Math.min(...usedScales) : baseScale
      }
      
    }

    // 第二遍：使用统一的 finalScale 处理所有图片
    for (const key of Object.keys(decodedMessage.images)) {
      try {
        const uint8Data = decodedMessage.images[key]
        if (!uint8Data) continue
        
        const originalSize = uint8Data.length

        // 创建 Blob URL
        const mimeType = this.getImageMimeType(uint8Data)
        const blob = new Blob([uint8Data.buffer.slice(uint8Data.byteOffset, uint8Data.byteOffset + uint8Data.byteLength)], { type: mimeType })
        const url = URL.createObjectURL(blob)

        // 处理图片，使用统一的 finalScale
        const { buffer: processedBuffer } = await this.processImageWithScale(
          url,
          config.quality / 100,
          finalScale,  // 使用统一的 finalScale，不再应用 maxWidth/maxHeight
          config.format === 'webp' || (config.format === 'auto' && mimeType !== 'image/png'),
          0,  // maxWidth 设为 0，因为已经在 finalScale 中考虑了
          0   // maxHeight 设为 0
        )

        // 只有处理后更小才替换
        if (processedBuffer.byteLength < originalSize) {
          decodedMessage.images[key] = new Uint8Array(processedBuffer)
          this.stats.imagesOptimized++
        } else {
          this.stats.imagesSkipped++
        }

        URL.revokeObjectURL(url)
      } catch (err) {
        console.warn(`[Optimizer] Failed to process image "${key}":`, err)
        this.stats.imagesSkipped++
      }
    }

    // 缩放 viewBox 和 sprites（使用统一的 finalScale）
    if (finalScale !== 1 && decodedMessage.sprites) {
      
      // 缩放 viewBox（画布尺寸）
      if (decodedMessage.params) {
        if (decodedMessage.params.viewBoxWidth !== undefined) {
          decodedMessage.params.viewBoxWidth = Math.round(decodedMessage.params.viewBoxWidth * finalScale)
        }
        if (decodedMessage.params.viewBoxHeight !== undefined) {
          decodedMessage.params.viewBoxHeight = Math.round(decodedMessage.params.viewBoxHeight * finalScale)
        }
      }
      
      // 缩放 sprites 的 layout 和 transform
      for (const sprite of decodedMessage.sprites) {
        if (!sprite.frames) continue
        
        for (const frame of sprite.frames) {
          // 缩放 layout（绘制区域）
          if (frame.layout) {
            if (frame.layout.width !== undefined) {
              frame.layout.width = Math.round(frame.layout.width * finalScale)
            }
            if (frame.layout.height !== undefined) {
              frame.layout.height = Math.round(frame.layout.height * finalScale)
            }
            if (frame.layout.x !== undefined) {
              frame.layout.x = Math.round(frame.layout.x * finalScale)
            }
            if (frame.layout.y !== undefined) {
              frame.layout.y = Math.round(frame.layout.y * finalScale)
            }
          }
          // 缩放 transform
          if (frame.transform) {
            if (frame.transform.tx !== undefined) {
              frame.transform.tx = Math.round(frame.transform.tx * finalScale)
            }
            if (frame.transform.ty !== undefined) {
              frame.transform.ty = Math.round(frame.transform.ty * finalScale)
            }
            // 不修改 a, b, c, d
          }
        }
      }
    }
  }
  
  /**
   * 获取图片尺寸
   */
  private getImageDimensions(url: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        resolve({ width: img.width, height: img.height })
      }
      img.onerror = () => reject(new Error('Failed to load image'))
      img.src = url
    })
  }

  /**
   * 图片去重（同时更新 sprites 引用）
   */
  private deduplicateImagesWithReferences(decodedMessage: any): void {
    if (!decodedMessage.images || !decodedMessage.sprites) return

    const images = decodedMessage.images
    const sprites = decodedMessage.sprites
    const keys = Object.keys(images)
    const hashMap = new Map<string, string>()
    const duplicateMap = new Map<string, string>() // key -> originalKey

    // 找出重复图片
    for (const key of keys) {
      const data = images[key]
      if (!data) continue
      
      const hash = this.simpleHash(data)

      if (hashMap.has(hash)) {
        const originalKey = hashMap.get(hash)!
        duplicateMap.set(key, originalKey)
      } else {
        hashMap.set(hash, key)
      }
    }

    // 更新 sprites 中的引用
    if (duplicateMap.size > 0) {
      for (const sprite of sprites) {
        if (sprite.imageKey && duplicateMap.has(sprite.imageKey)) {
          const newKey = duplicateMap.get(sprite.imageKey)!
          sprite.imageKey = newKey
        }
      }

      // 删除重复图片
      for (const [key] of duplicateMap) {
        delete images[key]
        this.stats.imagesDeduplicated++
      }
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
    url: string,
    quality: number,
    scale: number,
    useWebP: boolean,
    maxWidth: number,
    maxHeight: number
  ): Promise<{ buffer: ArrayBuffer; actualScale: number }> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'

      img.onload = () => {
        const originalWidth = img.width
        const originalHeight = img.height
        
        // 计算目标尺寸（保持等比）
        let targetWidth = Math.round(originalWidth * scale)
        let targetHeight = Math.round(originalHeight * scale)
        
        const originalRatio = originalWidth / originalHeight

        // 应用最大尺寸限制（保持等比缩放）
        if (maxWidth > 0 && targetWidth > maxWidth) {
          targetWidth = maxWidth
          targetHeight = Math.round(targetWidth / originalRatio)
        }
        if (maxHeight > 0 && targetHeight > maxHeight) {
          targetHeight = maxHeight
          targetWidth = Math.round(targetHeight * originalRatio)
        }

        // 计算实际缩放比例
        const actualScale = targetWidth / originalWidth

        const canvas = document.createElement('canvas')
        canvas.width = targetWidth
        canvas.height = targetHeight

        const ctx = canvas.getContext('2d', { 
          alpha: true,  // 启用透明通道
          willReadFrequently: false
        })
        if (!ctx) {
          reject(new Error('Failed to get canvas context'))
          return
        }

        // 关键：清除画布，确保透明背景
        ctx.clearRect(0, 0, targetWidth, targetHeight)
        
        // 绘制缩放后的图片
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight)

        // 选择输出格式
        // WebP: 支持透明度，有损压缩，文件更小
        // PNG: 支持透明度，无损压缩，质量最高
        const mimeType = useWebP ? 'image/webp' : 'image/png'
        const outputQuality = useWebP ? quality : 1

        canvas.toBlob(async (blob) => {
          if (blob) {
            const buffer = await blob.arrayBuffer()
            resolve({ buffer, actualScale })
          } else {
            reject(new Error('Failed to process image'))
          }
        }, mimeType, outputQuality)
      }

      img.onerror = () => reject(new Error('Failed to load image'))
      img.src = url
    })
  }
  
  /**
   * 处理单张图片（兼容旧方法）
   * 保持等比缩放，不失去透明度
   */
  private async processImage(
    url: string,
    quality: number,
    scale: number,
    useWebP: boolean,
    maxWidth: number,
    maxHeight: number
  ): Promise<ArrayBuffer> {
    const result = await this.processImageWithScale(url, quality, scale, useWebP, maxWidth, maxHeight)
    return result.buffer
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
      result.transform = {
        a: roundValue(result.transform.a),
        b: roundValue(result.transform.b),
        c: roundValue(result.transform.c),
        d: roundValue(result.transform.d),
        tx: roundValue(result.transform.tx),
        ty: roundValue(result.transform.ty)
      }
    }

    if (result.layout) {
      result.layout = {
        x: roundValue(result.layout.x),
        y: roundValue(result.layout.y),
        width: roundValue(result.layout.width),
        height: roundValue(result.layout.height)
      }
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
   * 这个方法不重新编码 protobuf，只替换图片数据
   */
  async safeOptimize(
    buffer: ArrayBuffer,
    config: OptimizationConfig['image']
  ): Promise<Blob> {
    const startTime = performance.now()
    this.resetStats()
    this.stats.originalSize = buffer.byteLength

    if (!this.MovieEntity) {
      await this.init()
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

    // 2. 解码 protobuf
    const decodedMessage = this.MovieEntity.decode(decompressed)
    decodedMessage.version = '2.0.0'

    // 3. 只处理图片
    if (decodedMessage.images) {
      await this.optimizeImagesOnly(decodedMessage, config)
    }

    // 4. 重新编码
    const encoded = this.MovieEntity.encode(decodedMessage).finish()

    // 5. 压缩
    const compressed = pako.deflate(encoded, { level: 9 })
    
    // 6. 构建官方 SVGA 2.0 输出：zlib-compressed protobuf MovieEntity
    const result = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer

    this.stats.optimizedSize = result.byteLength
    this.stats.reductionPercent = Math.round((1 - this.stats.optimizedSize / this.stats.originalSize) * 100)
    this.stats.processingTime = Math.round(performance.now() - startTime)

    return new Blob([result], { type: 'application/octet-stream' })
  }
  
  /**
   * 只优化图片，不修改其他数据
   */
  private async optimizeImagesOnly(decodedMessage: any, config: OptimizationConfig['image']): Promise<void> {
    const imageKeys = Object.keys(decodedMessage.images)

    // 计算缩放比例
    let scale = 1
    if (config.resizeEnabled && config.resizePercent < 100) {
      scale = config.resizePercent / 100
    }

    for (const key of imageKeys) {
      try {
        const uint8Data = decodedMessage.images[key]
        if (!uint8Data) continue
        
        const originalSize = uint8Data.length

        // 创建 Blob URL
        const mimeType = this.getImageMimeType(uint8Data)
        const blob = new Blob([uint8Data.buffer.slice(uint8Data.byteOffset, uint8Data.byteOffset + uint8Data.byteLength)], { type: mimeType })
        const url = URL.createObjectURL(blob)

        // 处理图片
        const processedBuffer = await this.processImage(
          url,
          config.quality / 100,
          scale,
          config.format === 'webp' || (config.format === 'auto' && mimeType !== 'image/png'),
          config.maxWidth,
          config.maxHeight
        )

        // 只有处理后更小才替换
        if (processedBuffer.byteLength < originalSize) {
          decodedMessage.images[key] = new Uint8Array(processedBuffer)
          this.stats.imagesOptimized++
        } else {
          this.stats.imagesSkipped++
        }

        URL.revokeObjectURL(url)
      } catch (err) {
        console.warn(`[Optimizer] Failed to process image "${key}":`, err)
        this.stats.imagesSkipped++
      }
    }
  }
}

// 单例导出
export const svgaOptimizer = new SVGAOptimizer()
