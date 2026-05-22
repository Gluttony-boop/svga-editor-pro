/**
 * SVGA 文件验证工具
 * 用于验证导出的 SVGA 文件是否正确
 */

import pako from 'pako'
import protobuf from 'protobufjs'
import SVGA_PROTO_JSON from '@/core/svga-proto'

export interface ValidationResult {
  isValid: boolean
  errors: string[]
  warnings: string[]
  info: {
    version?: string
    params?: {
      viewBoxWidth: number
      viewBoxHeight: number
      fps: number
      frames: number
    }
    imagesCount: number
    spritesCount: number
  }
}

export class SVGAValidator {
  private MovieEntity: any = null

  async init(): Promise<void> {
    const root = protobuf.Root.fromJSON(SVGA_PROTO_JSON)
    this.MovieEntity = root.lookupType('com.opensource.svga.MovieEntity')
  }

  /**
   * 验证 SVGA 文件
   */
  async validate(buffer: ArrayBuffer): Promise<ValidationResult> {
    const result: ValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
      info: {
        imagesCount: 0,
        spritesCount: 0
      }
    }

    try {
      if (!this.MovieEntity) {
        await this.init()
      }

      const data = new Uint8Array(buffer)

      // 1. 验证文件头
      if (data.length < 8) {
        result.errors.push('文件太小，不是有效的 SVGA 文件')
        result.isValid = false
        return result
      }

      const magic = String.fromCharCode(...data.slice(0, 4))
      if (magic !== 'SVGA') {
        result.errors.push(`无效的文件头: ${magic}，应该是 'SVGA'`)
        result.isValid = false
        return result
      }

      const version = data[4]
      result.info.version = `2.0`

      // 2. 解压数据
      let decompressed: Uint8Array
      try {
        if (version === 0x02) {
          decompressed = pako.inflate(data.slice(8))
        } else if (version === 0x01) {
          decompressed = data.slice(8)
        } else {
          result.warnings.push(`未知的版本号: ${version}，尝试作为 2.0 解压`)
          decompressed = pako.inflate(data.slice(8))
        }
      } catch (e) {
        result.errors.push(`解压失败: ${(e as Error).message}`)
        result.isValid = false
        return result
      }


      // 3. 解码 protobuf
      let message: any
      try {
        message = this.MovieEntity.decode(decompressed)
      } catch (e) {
        result.errors.push(`Protobuf 解码失败: ${(e as Error).message}`)
        result.isValid = false
        return result
      }

      // 4. 验证字段
      const movieObj = this.MovieEntity.toObject(message, {
        bytes: Uint8Array,
        arrays: true,
        objects: true
      })

      // 版本
      if (!movieObj.version) {
        result.warnings.push('缺少 version 字段')
      }

      // 参数
      if (movieObj.params) {
        result.info.params = {
          viewBoxWidth: movieObj.params.viewBoxWidth || 0,
          viewBoxHeight: movieObj.params.viewBoxHeight || 0,
          fps: movieObj.params.fps || 0,
          frames: movieObj.params.frames || 0
        }

        if (movieObj.params.frames <= 0) {
          result.warnings.push('帧数为 0')
        }
        if (movieObj.params.fps <= 0) {
          result.warnings.push('帧率为 0')
        }
      } else {
        result.warnings.push('缺少 params 字段')
      }

      // 图片
      if (movieObj.images) {
        const imageKeys = Object.keys(movieObj.images)
        result.info.imagesCount = imageKeys.length

        for (const key of imageKeys) {
          const imageData = movieObj.images[key]
          if (!imageData || imageData.length === 0) {
            result.warnings.push(`图片 "${key}" 数据为空`)
            continue
          }

          // 验证图片格式
          const mime = this.getImageMimeType(imageData)
          if (mime === 'image/png') {
            // 验证 PNG 头
            if (!(imageData[0] === 0x89 && imageData[1] === 0x50)) {
              result.warnings.push(`图片 "${key}" PNG 头无效`)
            }
          } else if (mime === 'image/jpeg') {
            // 验证 JPEG 头
            if (!(imageData[0] === 0xFF && imageData[1] === 0xD8)) {
              result.warnings.push(`图片 "${key}" JPEG 头无效`)
            }
          } else if (mime === 'image/webp') {
            result.warnings.push(`图片 "${key}" 是 WebP 格式，可能不被所有播放器支持`)
          }
        }
      } else {
        result.warnings.push('没有图片资源')
      }

      // 精灵
      if (movieObj.sprites && Array.isArray(movieObj.sprites)) {
        result.info.spritesCount = movieObj.sprites.length

        for (let i = 0; i < movieObj.sprites.length; i++) {
          const sprite = movieObj.sprites[i]
          if (!sprite.frames || sprite.frames.length === 0) {
            result.warnings.push(`精灵 ${i} 没有帧数据`)
          }
          if (sprite.imageKey && !movieObj.images?.[sprite.imageKey]) {
            result.warnings.push(`精灵 ${i} 引用了不存在的图片: ${sprite.imageKey}`)
          }
        }
      } else {
        result.warnings.push('没有精灵数据')
      }

      // 5. 尝试重新编码和解码
      try {
        const reEncoded = this.MovieEntity.encode(message).finish()
        const reDecoded = this.MovieEntity.decode(reEncoded)
        const reObj = this.MovieEntity.toObject(reDecoded, { bytes: Uint8Array })
        
        if (Object.keys(reObj.images || {}).length !== result.info.imagesCount) {
          result.errors.push('重新编码后图片数量不一致')
          result.isValid = false
        }
        
      } catch (e) {
        result.errors.push(`重新编码验证失败: ${(e as Error).message}`)
        result.isValid = false
      }

    } catch (e) {
      result.errors.push(`验证过程出错: ${(e as Error).message}`)
      result.isValid = false
    }

    return result
  }

  /**
   * 根据文件头判断图片 MIME 类型
   */
  private getImageMimeType(data: Uint8Array): string {
    if (!data || data.length < 12) return 'unknown'
    
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
    return 'unknown'
  }
}

export const svgaValidator = new SVGAValidator()
