/**
 * SVGA 构建器
 * 从编辑器状态生成新的 SVGA 文件
 */

import pako from 'pako'
import protobuf from 'protobufjs'
import type { 
  Layer, 
  MovieParams, 
  ImageResource,
  Sprite,
  FrameData,
  Transform,
  Layout
} from '@/types'
import { AnimationEngine } from './animation-engine'
import {
  createLayerImageAliases,
  findLayerForSpriteIndex
} from './layer-name-sync'
import SVGA_PROTO_JSON from './svga-proto'

export interface SVGABuildConfig {
  params: MovieParams
  layers: Layer[]
  imageResources: Map<string, ImageResource>
  originalImages?: Record<string, Uint8Array>
  /** 新增图片的尺寸信息 */
  imageSizes?: Map<string, { width: number; height: number }>
}

export class SVGABuilder {
  private MovieEntity: any = null

  async init(): Promise<void> {
    const root = protobuf.Root.fromJSON(SVGA_PROTO_JSON)
    this.MovieEntity = root.lookupType('com.opensource.svga.MovieEntity')
  }

  /**
   * 构建 SVGA 文件
   */
  async build(config: SVGABuildConfig): Promise<Blob> {
    if (!this.MovieEntity) {
      await this.init()
    }

    // 1. 构建 Movie 对象
    const movie = this.buildMovie(config)

    // 2. 编码为 protobuf
    const encoded = this.MovieEntity.encode(movie).finish()

    // 3. 压缩
    const compressed = pako.deflate(encoded, { level: 6 })

    // 4. 构建 SVGA 文件（带文件头）
    const header = new Uint8Array([0x53, 0x56, 0x47, 0x41, 0x02, 0x00, 0x00, 0x00])
    const result = new Uint8Array(header.length + compressed.length)
    result.set(header, 0)
    result.set(compressed, header.length)

    return new Blob([result], { type: 'application/octet-stream' })
  }

  /**
   * 构建 Movie 对象
   */
  private buildMovie(config: SVGABuildConfig): any {
    const { params, layers, imageResources, originalImages, imageSizes } = config

    // 收集所有图片资源
    const images: Record<string, Uint8Array> = {}

    // 添加原始图片
    if (originalImages) {
      Object.assign(images, originalImages)
    }

    // 添加新增图片
    imageResources.forEach((resource, key) => {
      images[key] = resource.data
    })

    const imageAliases = createLayerImageAliases(images, layers)

    // 构建 sprites
    const sprites = this.buildSprites(layers, params, imageSizes, imageAliases)

    // 构建 Movie 对象
    const movie = {
      version: '2.0.0',
      params: {
        viewBoxWidth: params.viewBoxWidth,
        viewBoxHeight: params.viewBoxHeight,
        fps: params.fps,
        frames: params.frames
      },
      images,
      sprites
    }

    return movie
  }

  /**
   * 构建 Sprites 数组
   */
  private buildSprites(
    layers: Layer[], 
    params: MovieParams,
    imageSizes?: Map<string, { width: number; height: number }>,
    imageAliases?: Map<string, string>
  ): Sprite[] {
    const sprites: Sprite[] = []

    for (const layer of layers) {
      // 只处理图片图层
      if (layer.type !== 'image') continue
      if (!layer.imageKey) continue

      // 获取图片尺寸
      const size = imageSizes?.get(layer.imageKey)
      const sprite = this.buildSprite(layer, params, size, imageAliases?.get(layer.id))
      sprites.push(sprite)
    }

    return sprites
  }

  /**
   * 构建单个 Sprite
   */
  private buildSprite(
    layer: Layer, 
    params: MovieParams,
    imageSize?: { width: number; height: number },
    exportImageKey?: string
  ): Sprite {
    const frames: FrameData[] = []

    // 计算每一帧的数据
    for (let frameIndex = 0; frameIndex < params.frames; frameIndex++) {
      // 检查图层是否在此帧可见
      const { startFrame, duration } = layer.clip
      if (frameIndex < startFrame || frameIndex >= startFrame + duration) {
        // 不在此帧范围内，添加空白帧
        frames.push({
          alpha: 0,
          layout: null,
          transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
          clipPath: null
        })
        continue
      }

      // 获取图层在此帧的属性
      const props = AnimationEngine.getLayerPropertiesAtFrame(layer, frameIndex)

      // 构建 FrameData
      const frameData = this.buildFrameData(props, frameIndex, layer, imageSize)
      frames.push(frameData)
    }

    return {
      imageKey: exportImageKey || layer.imageKey || '',
      matteKey: null,
      frames
    }
  }

  /**
   * 构建帧数据
   */
  private buildFrameData(
    props: {
      position: { x: number; y: number }
      scale: { scaleX: number; scaleY: number }
      rotation: number
      alpha: number
    },
    frameIndex: number,
    layer: Layer,
    imageSize?: { width: number; height: number }
  ): FrameData {
    const { position, scale, rotation, alpha } = props

    // 将旋转角度转换为弧度
    const rad = (rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)

    // 构建变换矩阵
    // [ a  c  tx ]   [ scaleX*cos    -scaleY*sin   tx ]
    // [ b  d  ty ] = [ scaleX*sin     scaleY*cos   ty ]
    const transform: Transform = {
      a: scale.scaleX * cos,
      b: scale.scaleX * sin,
      c: -scale.scaleY * sin,
      d: scale.scaleY * cos,
      tx: position.x,
      ty: position.y
    }

    // 构建 Layout
    let layout: Layout | null = null

    // 如果图层有原始 sprites 数据，使用其 layout
    if (layer.sprites?.frames?.[frameIndex]?.layout) {
      layout = { ...layer.sprites.frames[frameIndex].layout }
    } else if (imageSize) {
      // 新增图层：使用图片实际尺寸
      layout = {
        x: 0,
        y: 0,
        width: imageSize.width,
        height: imageSize.height
      }
    }

    return {
      alpha,
      layout,
      transform,
      clipPath: null
    }
  }

  /**
   * 合并原始 SVGA 和新增内容
   */
  async mergeWithOriginal(
    originalBuffer: ArrayBuffer,
    config: SVGABuildConfig
  ): Promise<Blob> {
    if (!this.MovieEntity) {
      await this.init()
    }

    // 解压原始 SVGA
    const data = new Uint8Array(originalBuffer)
    let decompressed: Uint8Array

    const magic = String.fromCharCode(...data.slice(0, 4))
    if (magic === 'SVGA') {
      const version = data[4]
      if (version === 0x02) {
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

    // 解码原始 Movie
    const originalMovie = this.MovieEntity.decode(decompressed)
    const originalObj = this.MovieEntity.toObject(originalMovie, {
      bytes: Uint8Array,
      arrays: true,
      objects: true,
      defaults: false
    })

    // 合并图片
    const mergedImages = { ...(originalObj.images || {}) }
    config.imageResources.forEach((resource, key) => {
      mergedImages[key] = resource.data
    })

    // 构建图片尺寸映射
    const imageSizes = new Map<string, { width: number; height: number }>()
    config.imageResources.forEach((resource, key) => {
      if (resource.width > 0 && resource.height > 0) {
        imageSizes.set(key, { width: resource.width, height: resource.height })
      }
    })

    // 构建原始 key → 图层映射，优先使用解码后的原始 sprite imageKey
    // 这样 renameImageKey 后 layer.imageKey 已变，但 images map 里还是旧 key
    const sourceKeyByLayerId = new Map<string, string>()
    if (originalObj.sprites) {
      originalObj.sprites.forEach((sprite: Sprite, index: number) => {
        const layer = findLayerForSpriteIndex(config.layers, index)
        const sourceKey = sprite.imageKey || layer?.imageKey || ''
        if (layer && sourceKey) {
          sourceKeyByLayerId.set(layer.id, sourceKey)
        }
      })
    }

    const imageAliases = createLayerImageAliases(mergedImages, config.layers, sourceKeyByLayerId)

    // 合并 sprites
    const originalSprites = originalObj.sprites || []
    const newSprites = this.buildSprites(
      config.layers.filter(l => l.isNew),
      config.params,
      imageSizes,
      imageAliases
    )

    // 更新现有图层的动画
    const updatedOriginalSprites = originalSprites.map((sprite: Sprite, index: number) => {
      const layer = findLayerForSpriteIndex(config.layers, index)
      if (!layer) return sprite

      // 检查图层是否有新的动画关键帧
      const hasNewAnimation = Object.values(layer.tracks).some(
        track => track.keyframes.length > 0
      )
      const exportImageKey = imageAliases.get(layer.id) || sprite.imageKey
      const hasRenamed = Boolean(exportImageKey && exportImageKey !== sprite.imageKey)

      if (!hasNewAnimation) {
        return hasRenamed ? { ...sprite, imageKey: exportImageKey } : sprite
      }

      // 重新计算帧数据
      return this.buildSprite(layer, config.params, undefined, exportImageKey)
    })

    const sourceToExportKey = new Map<string, string>()
    config.layers.forEach((layer) => {
      const exportKey = imageAliases.get(layer.id)
      if (layer.imageKey && exportKey && exportKey !== layer.imageKey) {
        sourceToExportKey.set(layer.imageKey, exportKey)
      }
    })

    const mergedSprites = [...updatedOriginalSprites, ...newSprites].map((sprite) => {
      if (!sprite.matteKey) return sprite

      const exportMatteKey = sourceToExportKey.get(sprite.matteKey)
      return exportMatteKey ? { ...sprite, matteKey: exportMatteKey } : sprite
    })

    // 构建合并后的 Movie
    const mergedMovie = {
      version: '2.0.0',
      params: {
        viewBoxWidth: config.params.viewBoxWidth,
        viewBoxHeight: config.params.viewBoxHeight,
        fps: config.params.fps,
        frames: config.params.frames
      },
      images: mergedImages,
      sprites: mergedSprites
    }

    // 编码并压缩
    const encoded = this.MovieEntity.encode(mergedMovie).finish()
    const compressed = pako.deflate(encoded, { level: 6 })

    // 添加文件头
    const header = new Uint8Array([0x53, 0x56, 0x47, 0x41, 0x02, 0x00, 0x00, 0x00])
    const result = new Uint8Array(header.length + compressed.length)
    result.set(header, 0)
    result.set(compressed, header.length)


    return new Blob([result], { type: 'application/octet-stream' })
  }
}

// 单例导出
export const svgaBuilder = new SVGABuilder()
