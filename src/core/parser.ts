/**
 * SVGA 解析器
 * 支持 SVGA 1.0 和 2.0 格式
 */

import pako from 'pako'
import type { MovieEntity, VideoItem, MovieParams, Sprite, AudioResource } from '@/types'
import SVGA_PROTO_JSON from './svga-proto'

export class SVGAParser {
  private MovieEntity: any = null

  async init(): Promise<void> {
    const protobuf = await import('protobufjs')
    const root = protobuf.Root.fromJSON(SVGA_PROTO_JSON)
    this.MovieEntity = root.lookupType('com.opensource.svga.MovieEntity')
  }

  /**
   * 解析 SVGA 文件
   */
  async parse(buffer: ArrayBuffer, options?: { onImageUrlCreated?: (url: string) => void }): Promise<VideoItem> {
    if (!this.MovieEntity) {
      await this.init()
    }

    try {
      // 解压缩
      const decompressed = this.decompress(buffer)
      
      // 解码 protobuf
      const movie = this.decodeProto(decompressed)
      
      // 解析图片
      const images = await this.parseImages(movie.images || {}, options?.onImageUrlCreated)
      
      const buffers: Record<string, ArrayBuffer> = {}
      
      // 转换图片数据
      if (movie.images) {
        for (const [key, data] of Object.entries(movie.images)) {
          const uint8Data = Array.isArray(data) ? new Uint8Array(data) : data as Uint8Array
          // 创建新的 ArrayBuffer 副本以避免 SharedArrayBuffer 问题
          const bufferCopy = new ArrayBuffer(uint8Data.length)
          new Uint8Array(bufferCopy).set(uint8Data)
          buffers[key] = bufferCopy
        }
      }
      
      return {
        movie,
        images,
        buffers
      }
    } catch (error) {
      console.error('[Parser] Error:', error)
      throw new Error(`SVGA 解析失败: ${(error as Error).message}`)
    }
  }

  /**
   * 解析 SVGA 音频轨道
   * 返回 AudioResource 数组，包含解码后的音频数据
   */
  async parseAudios(movie: MovieEntity): Promise<AudioResource[]> {
    if (!movie.audios || movie.audios.length === 0) return []

    const { audioManager } = await import('./audio-manager')
    return audioManager.parseAudioTracks(movie.audios)
  }

  /**
   * 解压缩数据
   */
  private decompress(buffer: ArrayBuffer): Uint8Array {
    const data = new Uint8Array(buffer)
    
    // 检查是否为 SVGA 格式 (magic: SVGA)
    const magic = String.fromCharCode(...data.slice(0, 4))
    
    if (magic === 'SVGA') {
      // SVGA 格式，跳过头部
      const version = data[4]
      const compressedData = data.slice(8)
      
      if (version === 0x01) {
        // 未压缩
        return compressedData
      } else if (version === 0x02) {
        // zlib 压缩
        return pako.inflate(compressedData)
      }
    }
    
    // 尝试直接解压（无文件头格式）
    try {
      const decompressed = pako.inflate(data)
      return decompressed
    } catch {
      // 如果解压失败，返回原始数据
      return data
    }
  }

  /**
   * 解码 Protobuf
   */
  private decodeProto(data: Uint8Array): MovieEntity {
    const message = this.MovieEntity.decode(data)
    // 注意：不使用 defaults: true，保留 undefined 值
    // 这样 layout.x, transform.tx 等字段如果原文件中不存在就保持 undefined
    // 否则会被填充为 0，导致动画轨迹错误
    return this.MovieEntity.toObject(message, {
      bytes: Array,
      defaults: false,
      arrays: true,
      objects: true
    })
  }

  /**
   * 根据文件头判断图片 MIME 类型
   */
  private getImageMimeType(data: Uint8Array): string {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
      return 'image/png'
    }
    // JPEG: FF D8
    if (data[0] === 0xFF && data[1] === 0xD8) {
      return 'image/jpeg'
    }
    // WebP: RIFF....WEBP
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
        data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
      return 'image/webp'
    }
    // GIF: GIF
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
      return 'image/gif'
    }
    // 默认返回 PNG
    return 'image/png'
  }

  /**
   * 解析图片资源
   */
  private async parseImages(
    imageDataMap: Record<string, Uint8Array | number[]>,
    onImageUrlCreated?: (url: string) => void
  ): Promise<Record<string, HTMLImageElement>> {
    const images: Record<string, HTMLImageElement> = {}
    
    await Promise.all(
      Object.entries(imageDataMap).map(async ([key, data]) => {
        try {
          const uint8Data = Array.isArray(data) 
            ? new Uint8Array(data) 
            : data
          
          // 创建新的 ArrayBuffer 副本
          const bufferCopy = new ArrayBuffer(uint8Data.length)
          new Uint8Array(bufferCopy).set(uint8Data)
          
          // 根据文件头判断 MIME 类型
          const mimeType = this.getImageMimeType(uint8Data)
          const blob = new Blob([bufferCopy], { type: mimeType })
          const url = URL.createObjectURL(blob)
          onImageUrlCreated?.(url)
          
          const img = new Image()
          // 设置 decode 选项，确保图片解码完成
          img.decoding = 'async'
          
          await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => {
              console.warn(`[Parser] Image load timeout: ${key}`)
              resolve()
            }, 3000)

            img.onload = () => {
              window.clearTimeout(timer)
              // 不要立即 revoke URL，图片可能还没完全解码
              // URL.revokeObjectURL(url) 应该在组件卸载时调用
              resolve()
            }
            img.onerror = (e) => {
              window.clearTimeout(timer)
              console.error(`[Parser] Image load error: ${key}`, e)
              reject(e)
            }
            img.src = url
          })
          
          // 额外确保图片已解码
          if (img.decode && img.complete && img.width > 0) {
            await new Promise<void>((resolve) => {
              const timer = window.setTimeout(() => {
                console.warn(`[Parser] Image decode timeout: ${key}`)
                resolve()
              }, 1000)

              img.decode()
                .then(() => {
                  window.clearTimeout(timer)
                  resolve()
                })
                .catch((err) => {
                  window.clearTimeout(timer)
                  console.warn(`[Parser] Image decode failed: ${key}`, err)
                  resolve()
                })
            })
          }
          
          if (img.width > 0 && img.height > 0) {
            images[key] = img
          }
        } catch (error) {
          console.warn(`图片解析失败: ${key}`, error)
        }
      })
    )
    
    return images
  }

  /**
   * 检测插槽名称
   */
  detectSlots(movie: MovieEntity): string[] {
    const slots = new Set<string>()
    
    // 从精灵图中检测插槽
    movie.sprites?.forEach((sprite: Sprite) => {
      const imageKey = sprite.imageKey || ''
      
      // 检测文本插槽
      if (imageKey.includes('_text') || imageKey.includes('text_')) {
        slots.add(imageKey)
      }
      
      // 检测图片插槽
      if (imageKey.includes('_img') || imageKey.includes('img_') || 
          imageKey.includes('slot') || imageKey.includes('Slot')) {
        slots.add(imageKey)
      }
      
      // 通用插槽检测
      const slotMatch = imageKey.match(/\$(.+?)(?:@|$)/)
      if (slotMatch) {
        slots.add(slotMatch[1])
      }
    })
    
    return Array.from(slots)
  }

  /**
   * 获取图层的可编辑索引
   * 返回 sprite -> editableIndex 映射，用于插槽系统
   */
  getLayersByEditableIndex(movie: MovieEntity): Map<number, { sprite: Sprite; imageKey: string; layerType: string }> {
    const result = new Map<number, { sprite: Sprite; imageKey: string; layerType: string }>()
    
    if (!movie.sprites) return result
    
    movie.sprites.forEach((sprite: Sprite, index: number) => {
      const imageKey = sprite.imageKey || ''
      
      // 判断图层类型
      let layerType = 'image'
      if (imageKey.includes('_text') || imageKey.includes('text_')) {
        layerType = 'text'
      } else if (imageKey.includes('slot') || imageKey.includes('Slot') || imageKey.includes('$')) {
        layerType = 'slot'
      }
      
      result.set(index, {
        sprite,
        imageKey,
        layerType
      })
    })
    
    return result
  }

  /**
   * 批量提取图片URL映射
   * 将 SVGA 中的图片数据转换为 Blob URL 映射，用于预览和替换
   */
  getImagesUrl(movie: MovieEntity): Record<string, string> {
    const urlMap: Record<string, string> = {}
    
    if (!movie.images) return urlMap
    
    for (const [key, data] of Object.entries(movie.images)) {
      try {
        const uint8Data = Array.isArray(data) ? new Uint8Array(data) : data as Uint8Array
        const mimeType = this.getImageMimeType(uint8Data)
        const blob = new Blob([uint8Data.buffer as ArrayBuffer], { type: mimeType })
        urlMap[key] = URL.createObjectURL(blob)
      } catch (err) {
        console.warn(`[Parser] 生成图片URL失败: ${key}`, err)
      }
    }
    
    return urlMap
  }

  /**
   * 提取单帧渲染数据
   * 返回指定帧的所有图层的变换信息，用于帧导出和编辑
   */
  extractFrameData(
    movie: MovieEntity,
    frameIndex: number
  ): Array<{
    imageKey: string
    alpha: number
    layout: { x: number; y: number; width: number; height: number } | null
    transform: { a: number; b: number; c: number; d: number; tx: number; ty: number }
    matteKey: string | null
    clipPath: string | null
    blendMode?: string
  }> {
    const result: Array<{
      imageKey: string
      alpha: number
      layout: { x: number; y: number; width: number; height: number } | null
      transform: { a: number; b: number; c: number; d: number; tx: number; ty: number }
      matteKey: string | null
      clipPath: string | null
      blendMode?: string
    }> = []

    if (!movie.sprites) return result

    for (const sprite of movie.sprites) {
      if (frameIndex < 0 || frameIndex >= sprite.frames.length) continue

      const frame = sprite.frames[frameIndex]
      if (!frame) continue

      result.push({
        imageKey: sprite.imageKey,
        alpha: frame.alpha ?? 0,
        layout: frame.layout ? { ...frame.layout } : null,
        transform: frame.transform ? { ...frame.transform } : { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
        matteKey: sprite.matteKey ?? null,
        clipPath: frame.clipPath ?? null,
        blendMode: frame.blendMode
      })
    }

    return result
  }

  /**
   * 获取动画参数
   */
  getParams(movie: MovieEntity): MovieParams {
    return movie.params || {
      viewBoxWidth: 750,
      viewBoxHeight: 1334,
      fps: 24,
      frames: 0
    }
  }
}

// 单例导出
export const svgaParser = new SVGAParser()
