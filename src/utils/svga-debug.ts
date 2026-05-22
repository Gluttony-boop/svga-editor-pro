/**
 * SVGA 调试工具
 * 用于对比原始文件和导出文件的差异
 */

import pako from 'pako'
import protobuf from 'protobufjs'
import SVGA_PROTO_JSON from '@/core/svga-proto'

export interface DebugInfo {
  header: {
    magic: string
    version: number
  }
  protobuf: {
    version: string
    params: any
    imagesKeys: string[]
    spritesCount: number
    rawSize: number
    compressedSize: number
  }
  images: {
    key: string
    size: number
    mime: string
    validHeader: boolean
  }[]
}

export class SVGADebugger {
  private MovieEntity: any = null

  async init(): Promise<void> {
    const root = protobuf.Root.fromJSON(SVGA_PROTO_JSON)
    this.MovieEntity = root.lookupType('com.opensource.svga.MovieEntity')
  }

  /**
   * 分析 SVGA 文件
   */
  async analyze(buffer: ArrayBuffer): Promise<DebugInfo> {
    if (!this.MovieEntity) {
      await this.init()
    }

    const data = new Uint8Array(buffer)
    
    // 分析头部
    const magic = String.fromCharCode(...data.slice(0, 4))
    let version = 0x02
    
    // 解压
    let decompressed: Uint8Array
    let compressedSize = data.length
    
    if (magic === 'SVGA') {
      // 标准SVGA格式
      version = data[4]
      compressedSize = data.length - 8
      if (version === 0x02) {
        decompressed = pako.inflate(data.slice(8))
      } else {
        decompressed = data.slice(8)
      }
    } else {
      // 无文件头格式
      try {
        decompressed = pako.inflate(data)
      } catch {
        decompressed = data
        version = 0x01
      }
    }

    // 解码
    const message = this.MovieEntity.decode(decompressed)
    const movieObj = this.MovieEntity.toObject(message, {
      bytes: Uint8Array,
      arrays: true,
      objects: true
    })

    // 分析图片
    const images: DebugInfo['images'] = []
    if (movieObj.images) {
      for (const key of Object.keys(movieObj.images)) {
        const imgData = movieObj.images[key]
        const mime = this.getImageMimeType(imgData)
        images.push({
          key,
          size: imgData.length,
          mime,
          validHeader: this.validateImageHeader(imgData, mime)
        })
      }
    }

    return {
      header: {
        magic,
        version
      },
      protobuf: {
        version: movieObj.version,
        params: movieObj.params,
        imagesKeys: Object.keys(movieObj.images || {}),
        spritesCount: movieObj.sprites?.length || 0,
        rawSize: decompressed.length,
        compressedSize
      },
      images
    }
  }

  /**
   * 对比两个 SVGA 文件
   */
  async compare(original: ArrayBuffer, exported: ArrayBuffer): Promise<{
    original: DebugInfo
    exported: DebugInfo
    differences: string[]
  }> {
    const originalInfo = await this.analyze(original)
    const exportedInfo = await this.analyze(exported)
    const differences: string[] = []

    // 对比头部
    if (originalInfo.header.version !== exportedInfo.header.version) {
      differences.push(`版本不同: ${originalInfo.header.version} vs ${exportedInfo.header.version}`)
    }

    // 对比参数
    const origParams = originalInfo.protobuf.params
    const exportParams = exportedInfo.protobuf.params
    if (origParams && exportParams) {
      if (origParams.viewBoxWidth !== exportParams.viewBoxWidth) {
        differences.push(`宽度不同: ${origParams.viewBoxWidth} vs ${exportParams.viewBoxWidth}`)
      }
      if (origParams.viewBoxHeight !== exportParams.viewBoxHeight) {
        differences.push(`高度不同: ${origParams.viewBoxHeight} vs ${exportParams.viewBoxHeight}`)
      }
      if (origParams.frames !== exportParams.frames) {
        differences.push(`帧数不同: ${origParams.frames} vs ${exportParams.frames}`)
      }
    }

    // 对比图片数量
    if (originalInfo.protobuf.imagesKeys.length !== exportedInfo.protobuf.imagesKeys.length) {
      differences.push(`图片数量不同: ${originalInfo.protobuf.imagesKeys.length} vs ${exportedInfo.protobuf.imagesKeys.length}`)
    }

    // 对比图片内容
    const origImages = new Map(originalInfo.images.map(i => [i.key, i]))
    const exportImages = new Map(exportedInfo.images.map(i => [i.key, i]))

    for (const [key, origImg] of origImages) {
      const exportImg = exportImages.get(key)
      if (!exportImg) {
        differences.push(`图片缺失: ${key}`)
      } else if (origImg.size !== exportImg.size) {
        differences.push(`图片大小不同 ${key}: ${origImg.size} vs ${exportImg.size}`)
      }
    }

    // 对比精灵数量
    if (originalInfo.protobuf.spritesCount !== exportedInfo.protobuf.spritesCount) {
      differences.push(`精灵数量不同: ${originalInfo.protobuf.spritesCount} vs ${exportedInfo.protobuf.spritesCount}`)
    }

    return {
      original: originalInfo,
      exported: exportedInfo,
      differences
    }
  }

  /**
   * 根据文件头判断图片 MIME 类型
   */
  private getImageMimeType(data: Uint8Array): string {
    if (!data || data.length < 12) return 'unknown'
    
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
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
      return 'image/gif'
    }
    return 'unknown'
  }

  /**
   * 验证图片头
   */
  private validateImageHeader(data: Uint8Array, mime: string): boolean {
    if (!data || data.length < 4) return false
    
    switch (mime) {
      case 'image/png':
        return data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47
      case 'image/jpeg':
        return data[0] === 0xFF && data[1] === 0xD8
      case 'image/webp':
        return data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
      case 'image/gif':
        return data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46
      default:
        return false
    }
  }
}

export const svgaDebugger = new SVGADebugger()
