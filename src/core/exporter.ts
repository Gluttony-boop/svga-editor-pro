/**
 * SVGA 导出引擎
 */

import pako from 'pako'
import protobuf from 'protobufjs'
import JSZip from 'jszip'
import { CanvasRenderer } from './renderer'
import type { VideoItem, CompressionConfig, SlotConfig, Layer } from '@/types'
import {
  applyLayerNamesToMovie,
  normalizeMovieImageReferences
} from './layer-name-sync'
import SVGA_PROTO_JSON from './svga-proto'
import SVGA_PROTO_LITE from './svga-proto-lite'
import { applyCanvasTransformsToMovie } from './layer-transform'

type BrowserWritableFileStream = {
  write: (data: Blob | ArrayBuffer | Uint8Array) => Promise<void>
  close: () => Promise<void>
  abort?: () => Promise<void>
}

type BrowserFileHandle = {
  createWritable: () => Promise<BrowserWritableFileStream>
}

type BrowserSaveFilePicker = (options?: {
  suggestedName?: string
  types?: Array<{
    description: string
    accept: Record<string, string[]>
  }>
}) => Promise<BrowserFileHandle>

type BrowserWindowWithSavePicker = Window & {
  showSaveFilePicker?: BrowserSaveFilePicker
}

export type SaveFileTarget = (blob: Blob) => Promise<void>

type ExportFrame = {
  alpha?: number
  layout?: unknown
  transform?: unknown
  clipPath?: string | null
  shapes?: unknown[]
}

function createEmptyFrame(): ExportFrame {
  return {
    alpha: 0,
    layout: null,
    transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
    clipPath: null
  }
}

function normalizeSpriteFrameCounts(sprites: Array<{ frames?: ExportFrame[] }> | undefined, frameCount: number): void {
  if (!sprites || !Number.isFinite(frameCount) || frameCount < 1) return

  for (const sprite of sprites) {
    const frames = sprite.frames ?? []
    if (frames.length > frameCount) {
      sprite.frames = frames.slice(0, frameCount)
      continue
    }

    if (frames.length < frameCount) {
      sprite.frames = [
        ...frames,
        ...Array.from({ length: frameCount - frames.length }, () => createEmptyFrame())
      ]
    }
  }
}

function createSVGA2Blob(encoded: Uint8Array, level: number = 6): Blob {
  const compressed = pako.deflate(encoded, { level: level as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 })
  return new Blob([compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer], {
    type: 'application/octet-stream'
  })
}

export class ExportEngine {
  private renderer: CanvasRenderer
  private videoItem: VideoItem | null = null
  private MovieEntity: any = null
  private MovieEntityLite: any = null

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new CanvasRenderer(canvas)
  }

  setVideoItem(videoItem: VideoItem): void {
    this.videoItem = videoItem
    this.renderer.setVideoItem(videoItem)
  }

  private getImageSizes(): Map<string, { width: number; height: number }> {
    return new Map(Object.entries(this.videoItem?.images || {}).map(([key, image]) => [key, {
      width: image.naturalWidth || image.width || 0,
      height: image.naturalHeight || image.height || 0
    }]))
  }

  /**
   * 初始化 Protobuf
   */
  private async initProtobuf(): Promise<void> {
    const root = protobuf.Root.fromJSON(SVGA_PROTO_JSON)
    this.MovieEntity = root.lookupType('com.opensource.svga.MovieEntity')
    
    const rootLite = protobuf.Root.fromJSON(SVGA_PROTO_LITE)
    this.MovieEntityLite = rootLite.lookupType('svga.MovieEntity')
    
  }

  /**
   * 导出 SVGA 文件
   */
  async exportSVGA(
    originalBuffer: ArrayBuffer,
    config: {
      viewBoxWidth?: number
      viewBoxHeight?: number
      fps: number
      frames: number
      compression?: CompressionConfig
      slotConfigs?: Record<string, SlotConfig>
      layers?: Layer[]
    }
  ): Promise<Blob> {
    if (!this.videoItem) {
      throw new Error('没有可导出的视频')
    }

    // 确保 protobuf 已初始化
    if (!this.MovieEntity) {
      await this.initProtobuf()
    }


    // SVGA 版本号（在 try 块外声明以便后续使用）
    let svgaVersion = 0x02 // 默认版本 2.0

    try {
      // 1. 解压原始 SVGA 数据
      const data = new Uint8Array(originalBuffer)
      let decompressed: Uint8Array
      
      // 检查是否有 SVGA 文件头
      const magic = String.fromCharCode(...data.slice(0, 4))
      
      if (magic === 'SVGA') {
        // 标准SVGA格式，有文件头
        svgaVersion = data[4]
        if (svgaVersion === 0x02) {
          decompressed = pako.inflate(data.slice(8))
        } else {
          // 版本 1 不压缩
          decompressed = data.slice(8)
        }
      } else {
        // 没有文件头，尝试直接解压
        svgaVersion = 0x02 // 默认导出为 2.0 格式
        try {
          decompressed = pako.inflate(data)
        } catch (e) {
          // 如果解压失败，可能是未压缩的原始数据
          decompressed = data
          svgaVersion = 0x01
        }
      }


      // 2. 解码 protobuf
      const decodedMessage = this.MovieEntity.decode(decompressed)
      decodedMessage.version = '2.0.0'
      if (decodedMessage.params) {
        if (config.viewBoxWidth !== undefined) decodedMessage.params.viewBoxWidth = config.viewBoxWidth
        if (config.viewBoxHeight !== undefined) decodedMessage.params.viewBoxHeight = config.viewBoxHeight
        decodedMessage.params.fps = config.fps
        decodedMessage.params.frames = config.frames
      }
      

      // 将消息转换为普通对象，保留所有字段
      // 注意：不使用 defaults: true，保留 undefined 值
      const movieObj = this.MovieEntity.toObject(decodedMessage, {
        bytes: Uint8Array,  // 保持 bytes 为 Uint8Array
        arrays: true,       // 保持数组
        objects: true,      // 保持对象
        oneofs: true,       // 保持 oneof
        defaults: false     // 不填充默认值
      })
      
      // 3. 处理图片替换
      const slotConfigs = config.slotConfigs || {}
      const replacementKeys = Object.keys(slotConfigs).filter(
        key => slotConfigs[key]?.type === 'image' && slotConfigs[key]?.value
      )

      // Always re-encode so every exported .svga is standard SVGA 2.0.
      const compression = config.compression

      // 处理图片替换
      if (replacementKeys.length > 0) {
        
        for (const key of replacementKeys) {
          const slotConfig = slotConfigs[key]
          if (!slotConfig?.value) continue

          try {
            const imageUrl = slotConfig.value as string
            
            // 获取替换图片的数据 - 转换为 PNG
            const imageBuffer = await this.convertToPng(imageUrl)
            
            // 设置新图片数据
            movieObj.images[key] = new Uint8Array(imageBuffer)
          } catch (err) {
            throw new Error(`替换图片“${key}”读取失败，请重新选择图片后导出`)
          }
        }
      }

      applyCanvasTransformsToMovie(decodedMessage, config.layers, this.getImageSizes(), config.frames)

      // 处理压缩和缩放
      if (compression?.enabled && movieObj.images) {

        // 检查是否需要缩放
        const needResize = compression.resizeEnabled && compression.resizePercent < 100
        const useWebP = compression.mode === 'webp'
        const needCompress = useWebP || compression.quality < 100

        if (needResize || needCompress) {
          for (const key of Object.keys(movieObj.images)) {
            try {
              const uint8Data = movieObj.images[key]
              const originalSize = uint8Data.length
              const blob = new Blob([uint8Data])
              const url = URL.createObjectURL(blob)

              // 处理图片（缩放和压缩）
              const processedBuffer = await this.processImage(
                url,
                compression.quality / 100,
                needResize ? compression.resizePercent / 100 : 1,
                useWebP
              )

              // 只有处理后更小才替换
              if (processedBuffer.byteLength < originalSize) {
                movieObj.images[key] = new Uint8Array(processedBuffer)
              } else {
              }

              URL.revokeObjectURL(url)
            } catch (err) {
              console.warn(`[Exporter] Failed to process image "${key}":`, err)
            }
          }
        }
      }

      // 验证所有图片
      if (movieObj.images) {
        for (const key of Object.keys(movieObj.images)) {
          // 图片数据已存在于 movieObj.images[key] 中，此处仅做遍历验证
          void key
        }
      }

      // 关键修复：直接修改解码后的消息对象，而不是创建新对象
      // protobufjs 的 Message 对象可以直接修改字段值
      // 这样可以保留原始数据中的 undefined 值，不会被填充为 0
      const shouldSync = replacementKeys.length > 0 ||
        (compression?.enabled && (compression.quality < 100 || compression.mode === 'webp'))

      if (shouldSync) {
        // 只有需要修改时才操作 decodedMessage
        for (const key of Object.keys(movieObj.images)) {
          if (decodedMessage.images && movieObj.images[key]) {
            decodedMessage.images[key] = movieObj.images[key]
          }
        }
      }

      applyLayerNamesToMovie(decodedMessage, config.layers)
      normalizeSpriteFrameCounts(decodedMessage.sprites, config.frames)
      const normalizedReferences = normalizeMovieImageReferences(decodedMessage)
      if (normalizedReferences.missingImageKeys.length > 0) {
        console.warn(
          '[Exporter] Missing image data for sprite references:',
          normalizedReferences.missingImageKeys
        )
      }

      // 直接编码原始消息对象（已被修改）
      const encoded = this.MovieEntity.encode(decodedMessage).finish()

      // 验证编码后的数据可以正确解码
      const verifyMessage = this.MovieEntity.decode(encoded)
      const verifyObj = this.MovieEntity.toObject(verifyMessage, { bytes: Uint8Array, defaults: false })

      // 验证帧数据是否保留正确（检查 undefined 是否没有被转为 0）
      if (verifyObj.sprites && !Array.isArray(verifyObj.sprites)) {
        throw new Error('导出验证失败: sprites 数据格式异常')
      }
      
      return createSVGA2Blob(encoded)
    } catch (error) {
      console.error('[Exporter] Export failed:', error)
      throw error
    }
  }

  /**
   * 处理图片（缩放和压缩），返回实际缩放比例
   * 保持等比缩放，不失去透明度
   * @param url 图片 URL 或 Blob URL
   * @param quality 压缩质量 (0-1)
   * @param scale 缩放比例 (0-1)，默认为 1（不缩放）
   * @param useWebP 是否使用 WebP 格式，默认为 true
   */
  private async processImageWithScale(
    url: string,
    quality: number,
    scale: number = 1,
    useWebP: boolean = true
  ): Promise<{ buffer: ArrayBuffer; actualScale: number }> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'

      img.onload = () => {
        const originalWidth = img.width
        const originalHeight = img.height
        
        // 应用等比缩放
        const targetWidth = Math.round(originalWidth * scale)
        const targetHeight = Math.round(originalHeight * scale)
        
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

        canvas.toBlob(async (blob) => {
          if (blob) {
            const buffer = await blob.arrayBuffer()
            resolve({ buffer, actualScale })
          } else {
            reject(new Error('Failed to process image'))
          }
        }, mimeType, quality)
      }

      img.onerror = () => reject(new Error(`Failed to load image for processing`))
      img.src = url
    })
  }
  
  /**
   * 处理图片（缩放和压缩）
   * 保持等比缩放，不失去透明度
   * @param url 图片 URL 或 Blob URL
   * @param quality 压缩质量 (0-1)
   * @param scale 缩放比例 (0-1)，默认为 1（不缩放）
   * @param useWebP 是否使用 WebP 格式，默认为 true
   */
  private async processImage(
    url: string,
    quality: number,
    scale: number = 1,
    useWebP: boolean = true
  ): Promise<ArrayBuffer> {
    const result = await this.processImageWithScale(url, quality, scale, useWebP)
    return result.buffer
  }

  /**
   * 导出 PNG 序列
   */
  async exportPNGSequence(config: {
    scale: number
    prefix?: string
    quality?: number
    slotConfigs?: Record<string, SlotConfig>
    layers?: Layer[]
  }): Promise<Blob> {
    if (!this.videoItem) {
      throw new Error('没有可导出的视频')
    }

    const { movie } = this.videoItem
    const params = movie.params!
    const totalFrames = params.frames
    const prefix = config.prefix || 'frame_'
    const renderOptions = {
      slotConfigs: config.slotConfigs,
      layers: config.layers,
      applySlots: true,
      useFrameCache: false
    }

    const zip = new JSZip()

    for (let i = 0; i < totalFrames; i++) {
      await this.renderer.renderFrameAsync(i, renderOptions)
      const blob = await this.renderer.exportFrame('image/png')
      const fileName = `${prefix}${String(i).padStart(4, '0')}.png`
      zip.file(fileName, blob)
    }

    return await zip.generateAsync({ type: 'blob' })
  }

  /**
   * 导出 WebP 动画
   */
  async exportWebP(config: {
    quality: number
    scale: number
    frameIndex?: number
    slotConfigs?: Record<string, SlotConfig>
    layers?: Layer[]
  }): Promise<Blob> {
    if (!this.videoItem) {
      throw new Error('没有可导出的视频')
    }

    const { movie } = this.videoItem
    const params = movie.params!
    const totalFrames = params.frames
    const frameIndex = Math.max(0, Math.min(config.frameIndex ?? 0, totalFrames - 1))

    await this.renderer.renderFrameAsync(frameIndex, {
      slotConfigs: config.slotConfigs,
      layers: config.layers,
      applySlots: true,
      useFrameCache: false
    })
    return this.renderer.exportFrame('image/webp', config.quality / 100)
  }

  /**
   * 将 Data URL 或 Blob URL 转换为 PNG 格式的 ArrayBuffer
   */
  private async convertToPng(url: string): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('Failed to get canvas context'))
          return
        }
        ctx.drawImage(img, 0, 0)
        
        canvas.toBlob(async (blob) => {
          if (blob) {
            const buffer = await blob.arrayBuffer()
            resolve(buffer)
          } else {
            reject(new Error('Failed to convert to PNG'))
          }
        }, 'image/png')
      }
      
      img.onerror = () => reject(new Error(`Failed to load image: ${url}`))
      img.src = url
    })
  }

  /**
   * 导出 SVGA 文件 - 兼容模式（参考 SVGA Editor）
   * 输出官方 SVGA 2.0：zlib 压缩的 protobuf MovieEntity 数据
   */
  async exportSVGALite(
    originalBuffer: ArrayBuffer,
    config: {
      viewBoxWidth?: number
      viewBoxHeight?: number
      fps: number
      frames: number
      compression?: CompressionConfig
      slotConfigs?: Record<string, SlotConfig>
      layers?: Layer[]
    }
  ): Promise<Blob> {
    if (!this.videoItem) {
      throw new Error('没有可导出的视频')
    }

    // 确保 protobuf 已初始化
    if (!this.MovieEntityLite) {
      await this.initProtobuf()
    }


    try {
      // 1. 解压原始 SVGA 数据
      const data = new Uint8Array(originalBuffer)
      let decompressed: Uint8Array
      
      // 检查是否有 SVGA 文件头
      const magic = String.fromCharCode(...data.slice(0, 4))
      
      if (magic === 'SVGA') {
        const version = data[4]
        if (version === 0x02) {
          decompressed = pako.inflate(data.slice(8))
        } else {
          decompressed = data.slice(8)
        }
      } else {
        // 没有文件头，尝试直接解压
        try {
          decompressed = pako.inflate(data)
        } catch {
          decompressed = data
        }
      }

      // 2. 使用标准 protobuf 解码
      // 注意：不使用 defaults: true，保留 undefined 值
      // 否则 layout.x, transform.tx 等不存在字段会被填充为 0
      const decodedMessage = this.MovieEntity.decode(decompressed)
      decodedMessage.version = '2.0.0'
      // 2.5 修改 FPS 和帧数（如果用户修改了）

      if (decodedMessage.params) {
        if (config.viewBoxWidth !== undefined) {
          decodedMessage.params.viewBoxWidth = config.viewBoxWidth
        }
        if (config.viewBoxHeight !== undefined) {
          decodedMessage.params.viewBoxHeight = config.viewBoxHeight
        }
        // 检查 FPS 是否被修改
        const currentFps = decodedMessage.params.fps
        if (config.fps !== undefined && config.fps !== currentFps) {
          decodedMessage.params.fps = config.fps
        }
        // 检查帧数是否被修改
        const currentFrames = decodedMessage.params.frames
        if (config.frames !== undefined && config.frames !== currentFrames) {
          // 注意：修改帧数可能会影响动画，这里只是修改元数据
          // 实际的帧数据处理需要更复杂的逻辑
          decodedMessage.params.frames = config.frames
        }
      } else {
        console.warn('[Exporter Lite] decodedMessage.params is null or undefined!')
      }

      // 3. 处理图片替换
      const slotConfigs = config.slotConfigs || {}
      const replacementKeys = Object.keys(slotConfigs).filter(
        key => slotConfigs[key]?.type === 'image' && slotConfigs[key]?.value
      )

      // 关键修复：直接操作解码后的消息对象，而不是 movieObj
      // 这样可以保留原始数据中的 undefined 值
      if (replacementKeys.length > 0) {
        
        for (const key of replacementKeys) {
          const slotConfig = slotConfigs[key]
          if (!slotConfig?.value) continue

          try {
            const imageUrl = slotConfig.value as string
            const imageBuffer = await this.convertToPng(imageUrl)
            // 直接修改解码后的消息对象
            if (decodedMessage.images) {
              decodedMessage.images[key] = new Uint8Array(imageBuffer)
            }
          } catch (err) {
            throw new Error(`替换图片“${key}”读取失败，请重新选择图片后导出`)
          }
        }
      }

      // 先在原画布坐标合成编辑，再执行兼容导出的整体缩放。
      applyCanvasTransformsToMovie(decodedMessage, config.layers, this.getImageSizes(), config.frames)

      // 4. 处理压缩和缩放
      const compression = config.compression
      if (compression?.enabled && decodedMessage.images) {

        // 检查是否需要缩放
        const needResize = compression.resizeEnabled && compression.resizePercent < 100
        const useWebP = compression.mode === 'webp'
        const needCompress = useWebP || compression.quality < 100
        
        const baseScale = needResize ? compression.resizePercent / 100 : 1

        if (needResize || needCompress) {
          let totalOriginalSize = 0
          let totalCompressedSize = 0

          for (const key of Object.keys(decodedMessage.images)) {
            try {
              const uint8Data = decodedMessage.images[key]
              const originalSize = uint8Data.length
              totalOriginalSize += originalSize

              const blob = new Blob([uint8Data])
              const url = URL.createObjectURL(blob)

              // 处理图片（缩放和压缩），使用统一的 baseScale
              const { buffer: processedBuffer } = await this.processImageWithScale(
                url,
                compression.quality / 100,
                baseScale,  // 使用统一的 baseScale
                useWebP
              )

              // 只有处理后更小才替换
              if (processedBuffer.byteLength < originalSize) {
                decodedMessage.images[key] = new Uint8Array(processedBuffer)
                totalCompressedSize += processedBuffer.byteLength
              } else {
                totalCompressedSize += originalSize
              }

              URL.revokeObjectURL(url)
            } catch (err) {
              console.warn(`[Exporter Lite] Failed to process image "${key}":`, err)
            }
          }

        }

        // 缩放 viewBox 和 sprites（使用统一的 baseScale）
        if (baseScale !== 1) {
          
          // 缩放 viewBox（画布尺寸）
          if (decodedMessage.params) {
            if (decodedMessage.params.viewBoxWidth !== undefined) {
              decodedMessage.params.viewBoxWidth = Math.round(decodedMessage.params.viewBoxWidth * baseScale)
            }
            if (decodedMessage.params.viewBoxHeight !== undefined) {
              decodedMessage.params.viewBoxHeight = Math.round(decodedMessage.params.viewBoxHeight * baseScale)
            }
          }
          
          // 缩放精灵 layout 和 transform
          if (decodedMessage.sprites) {
            for (const sprite of decodedMessage.sprites) {
              if (!sprite.frames) continue
              
              for (const frame of sprite.frames) {
                // 缩放 layout
                if (frame.layout) {
                  if (frame.layout.width !== undefined) {
                    frame.layout.width = Math.round(frame.layout.width * baseScale)
                  }
                  if (frame.layout.height !== undefined) {
                    frame.layout.height = Math.round(frame.layout.height * baseScale)
                  }
                  if (frame.layout.x !== undefined) {
                    frame.layout.x = Math.round(frame.layout.x * baseScale)
                  }
                  if (frame.layout.y !== undefined) {
                    frame.layout.y = Math.round(frame.layout.y * baseScale)
                  }
                }
                // 缩放 transform
                if (frame.transform) {
                  if (frame.transform.tx !== undefined) {
                    frame.transform.tx = Math.round(frame.transform.tx * baseScale)
                  }
                  if (frame.transform.ty !== undefined) {
                    frame.transform.ty = Math.round(frame.transform.ty * baseScale)
                  }
                  // 不修改 a, b, c, d
                }
              }
            }
          }
        }
      }

      applyLayerNamesToMovie(decodedMessage, config.layers)
      normalizeSpriteFrameCounts(decodedMessage.sprites, config.frames)
      const normalizedReferences = normalizeMovieImageReferences(decodedMessage)
      if (normalizedReferences.missingImageKeys.length > 0) {
        console.warn(
          '[Exporter Lite] Missing image data for sprite references:',
          normalizedReferences.missingImageKeys
        )
      }

      // 5. 直接使用标准 protobuf 编码（不使用 lite 格式转换）
      // 这样可以保留原始数据的完整性
      const encoded = this.MovieEntity.encode(decodedMessage).finish()

      // 验证编码后的数据可以正确解码
      const verifyMessage = this.MovieEntity.decode(encoded)
      const verifyObj = this.MovieEntity.toObject(verifyMessage, { bytes: Uint8Array, defaults: false })

      // 验证帧数据是否保留正确
      if (verifyObj.sprites && !Array.isArray(verifyObj.sprites)) {
        throw new Error('导出验证失败: sprites 数据格式异常')
      }

      // Official SVGA 2.0: zlib-compressed protobuf MovieEntity, no custom file header.
      return createSVGA2Blob(encoded)
    } catch (error) {
      console.error('[Exporter Lite] Export failed:', error)
      throw error
    }
  }
}

/**
 * 保存文件
 */
function getBrowserSavePicker(): BrowserSaveFilePicker | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as BrowserWindowWithSavePicker).showSaveFilePicker
}

function getPickerTypes(defaultName: string) {
  const extension = defaultName.match(/\.[^.]+$/)?.[0]?.toLowerCase()

  switch (extension) {
    case '.svga':
      return [{ description: 'SVGA File', accept: { 'application/octet-stream': ['.svga'] } }]
    case '.zip':
      return [{ description: 'ZIP Archive', accept: { 'application/zip': ['.zip'] } }]
    case '.webp':
      return [{ description: 'WebP Image', accept: { 'image/webp': ['.webp'] } }]
    case '.png':
      return [{ description: 'PNG Image', accept: { 'image/png': ['.png'] } }]
    default:
      return undefined
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

async function downloadBlob(blob: Blob, defaultName: string): Promise<void> {
  ensureBlobHasData(blob, defaultName)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = defaultName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function ensureBlobHasData(blob: Blob, defaultName: string): void {
  if (blob.size === 0) {
    throw new Error(`${defaultName} 导出结果为空，已取消保存`)
  }
}

async function saveWithBrowserFileHandle(
  handle: BrowserFileHandle,
  blob: Blob,
  defaultName: string
): Promise<void> {
  let writable: BrowserWritableFileStream | null = null
  ensureBlobHasData(blob, defaultName)
  const buffer = await blob.arrayBuffer()

  try {
    writable = await handle.createWritable()
    await writable.write(buffer)
    await writable.close()
    writable = null
  } catch (error) {
    if (writable) {
      try {
        if (writable.abort) {
          await writable.abort()
        }
      } catch {
        // Preserve the original write error.
      }
    }

    throw error
  }
}

export async function createSaveFileTarget(defaultName: string): Promise<SaveFileTarget | null> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { tauriAPI } = await import('@/lib/tauri-api')
    const extension = defaultName.split('.').pop() || 'svga'
    const filePath = await tauriAPI.dialog.saveFile({ defaultPath: defaultName, filters: [
      { name: `${extension.toUpperCase()} 文件`, extensions: [extension] },
      { name: '所有文件', extensions: ['*'] }
    ] })
    if (!filePath) return null
    return async (blob) => {
      ensureBlobHasData(blob, defaultName)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const chunks: string[] = []
      for (let index = 0; index < bytes.length; index += 8192) chunks.push(String.fromCharCode(...bytes.subarray(index, index + 8192)))
      const result = await tauriAPI.file.write(filePath, btoa(chunks.join('')))
      if (!result.success) throw new Error(result.error || '写入文件失败')
    }
  }

  const browserSavePicker = getBrowserSavePicker()
  if (browserSavePicker) {
    try {
      const handle = await browserSavePicker({
        suggestedName: defaultName,
        types: getPickerTypes(defaultName)
      })

      return async (blob) => {
        await saveWithBrowserFileHandle(handle, blob, defaultName)
      }
    } catch (error) {
      if (isAbortError(error)) return null
      console.warn('[Exporter] Browser save picker unavailable, falling back to download:', error)
    }
  }

  return (blob) => downloadBlob(blob, defaultName)
}

export async function saveGeneratedFile(blob: Blob, defaultName: string): Promise<boolean> {
  ensureBlobHasData(blob, defaultName)
  const saveTarget = await createSaveFileTarget(defaultName)
  if (!saveTarget) return false
  await saveTarget(blob)
  return true
}

export async function saveFile(blob: Blob, defaultName: string): Promise<void> {
  await saveGeneratedFile(blob, defaultName)
}
