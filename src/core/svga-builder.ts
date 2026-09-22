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
  SlotConfig,
  Sprite,
  FrameData,
  Transform,
  Layout
} from '@/types'
import { AnimationEngine } from './animation-engine'
import { applyLayerFrameEdits, bakeLayerFrames, findOriginalLayer } from './layer-transform'
import { getLayerSourceFrame } from './layer-time'
import { getSlotImageUrl } from '@/utils/slot-config'
import {
  assertDecodedImageReferences,
  createLayerImageAliases,
  normalizeMovieImageReferences
} from './layer-name-sync'
import SVGA_PROTO_JSON from './svga-proto'
import { mapSlotsToExportImages, mapSlotsToSourceImages, prepareTextSlotsForExport, resolveTextExportImageSizes } from './text-export'
import type { ExportSpriteBinding } from '@/types/export-artifact'
import { createExportSpriteBinding, emitExportBindings, throwIfExportAborted, type ExportProvenanceOptions } from './export-provenance'

export interface SVGABuildConfig extends ExportProvenanceOptions {
  params: MovieParams
  layers: Layer[]
  imageResources: Map<string, ImageResource>
  originalImages?: Record<string, Uint8Array>
  slotConfigs?: Record<string, SlotConfig>
  /** 新增图片的尺寸信息 */
  imageSizes?: Map<string, { width: number; height: number }>
}

function createEmptyFrame(): FrameData {
  return {
    alpha: 0,
    layout: null,
    transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
    clipPath: null
  }
}

function fitSpriteFrameCount(sprite: Sprite, frameCount: number): Sprite {
  if (!Number.isFinite(frameCount) || frameCount < 1) return sprite

  const frames = sprite.frames ?? []
  if (frames.length === frameCount) return sprite

  if (frames.length > frameCount) {
    return { ...sprite, frames: frames.slice(0, frameCount) }
  }

  return {
    ...sprite,
    frames: [
      ...frames,
      ...Array.from({ length: frameCount - frames.length }, () => createEmptyFrame())
    ]
  }
}

function exportImageSizes(
  sizes: Map<string, { width: number; height: number }>,
  layers: Layer[],
  aliases: ReadonlyMap<string, string>,
  sourceKeys: ReadonlyMap<string, string> = new Map()
) {
  const result = new Map(sizes)
  for (const layer of layers) {
    const alias = aliases.get(layer.id)
    const size = sizes.get(layer.imageKey || '') || sizes.get(sourceKeys.get(layer.id) || '')
    if (alias && size) result.set(alias, size)
  }
  return result
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
    throwIfExportAborted(config.signal)
    if (!this.MovieEntity) {
      await this.init()
    }

    // 1. 构建 Movie 对象
    const bindings: ExportSpriteBinding[] = []
    const movie = await this.buildMovie(config, bindings)
    throwIfExportAborted(config.signal)
    normalizeMovieImageReferences(movie)

    // 2. 编码为 protobuf
    const encoded = this.MovieEntity.encode(this.MovieEntity.fromObject(movie)).finish()

    // 3. 官方 SVGA 2.0 是 zlib 压缩后的 protobuf MovieEntity。
    const compressed = pako.deflate(encoded, { level: 6 })
    emitExportBindings(config, bindings, movie.sprites)

    return new Blob([compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer], {
      type: 'application/octet-stream'
    })
  }

  /**
   * 构建 Movie 对象
   */
  private async buildMovie(config: SVGABuildConfig, bindings: ExportSpriteBinding[]): Promise<any> {
    const { params, layers, imageResources, originalImages } = config

    // 收集所有图片资源
    const images: Record<string, Uint8Array> = Object.create(null)

    // 添加原始图片
    if (originalImages) {
      Object.assign(images, originalImages)
    }

    // 添加新增图片
    imageResources.forEach((resource, key) => {
      if (resource.data.byteLength > 0) {
        images[key] = resource.data
      }
    })

    const knownSizes = new Map(config.imageSizes)
    imageResources.forEach((resource, key) => {
      if (resource.width > 0 && resource.height > 0) knownSizes.set(key, { width: resource.width, height: resource.height })
    })
    const sourceSprites = layers.map(layer => ({ ...layer.sprites, imageKey: layer.imageKey }))
    const sourceSlots = mapSlotsToSourceImages(config.slotConfigs, sourceSprites, undefined)
    const imageSizes = await resolveTextExportImageSizes({ images, sprites: sourceSprites }, sourceSlots, knownSizes)
    throwIfExportAborted(config.signal)

    for (const [key, slot] of Object.entries(config.slotConfigs || {})) {
      throwIfExportAborted(config.signal)
      const url = getSlotImageUrl(slot)
      if (url) images[key] = new Uint8Array(await this.convertToPng(url))
    }

    const imageAliases = createLayerImageAliases(images, layers)

    // 构建 sprites
    const sprites = this.buildSprites(layers, params, imageSizes, imageAliases, (layer, sprite) => {
      bindings.push(createExportSpriteBinding(bindings.length, layer, null, layer.imageKey, sprite.imageKey, config.slotConfigs))
    })

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

    return prepareTextSlotsForExport(movie, mapSlotsToExportImages(config.slotConfigs, layers, imageAliases),
      exportImageSizes(imageSizes, layers, imageAliases))
  }

  /**
   * 构建 Sprites 数组
   */
  private buildSprites(
    layers: Layer[], 
    params: MovieParams,
    imageSizes?: Map<string, { width: number; height: number }>,
    imageAliases?: Map<string, string>,
    onSprite?: (layer: Layer, sprite: Sprite) => void
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
      onSprite?.(layer, sprite)
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
    // 导入层的副本有独立身份，但仍沿用原逐帧运动，不应当作静态新图片重建。
    if (layer.sprites) {
      return {
        ...layer.sprites,
        imageKey: exportImageKey || layer.imageKey || layer.sprites.imageKey,
        frames: bakeLayerFrames(layer.sprites.frames, { ...layer, isNew: false }, params.frames, imageSize)
      }
    }
    const frames: FrameData[] = []

    // 计算每一帧的数据
    for (let frameIndex = 0; frameIndex < params.frames; frameIndex++) {
      const sourceFrame = getLayerSourceFrame(layer, frameIndex)
      // 检查图层是否在此帧可见
      const { startFrame, duration } = layer.clip
      if (sourceFrame < 0 || sourceFrame < startFrame || sourceFrame >= startFrame + duration) {
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
      const props = AnimationEngine.getLayerPropertiesAtFrame(layer, sourceFrame)

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
    const sourceFrame = getLayerSourceFrame(layer, frameIndex)
    if (layer.sprites?.frames?.[sourceFrame]?.layout) {
      layout = { ...layer.sprites.frames[sourceFrame].layout }
    } else if (imageSize) {
      // 新增图层：使用图片实际尺寸
      layout = {
        x: 0,
        y: 0,
        width: imageSize.width,
        height: imageSize.height
      }
    }

    return applyLayerFrameEdits({
      alpha,
      layout,
      transform,
      clipPath: null
    }, layer, frameIndex, imageSize)
  }

  private async convertToPng(url: string): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      let canvas: HTMLCanvasElement | undefined
      const cleanup = () => {
        img.onload = null
        img.onerror = null
        if (canvas) { canvas.width = 0; canvas.height = 0 }
      }

      img.onload = () => {
        try {
          canvas = document.createElement('canvas')
          canvas.width = img.width
          canvas.height = img.height
          const ctx = canvas.getContext('2d')
          if (!ctx) throw new Error('Failed to get canvas context')
          ctx.drawImage(img, 0, 0)
          canvas.toBlob(async (blob) => {
            try {
              if (!blob) throw new Error('Failed to convert image to PNG')
              resolve(await blob.arrayBuffer())
            } catch (error) { reject(error) }
            finally { cleanup() }
          }, 'image/png')
        } catch (error) {
          cleanup()
          reject(error)
        }
      }

      img.onerror = () => { cleanup(); reject(new Error(`Failed to load image: ${url}`)) }
      try { img.src = url } catch (error) { cleanup(); reject(error) }
    })
  }

  /**
   * 合并原始 SVGA 和新增内容
   */
  async mergeWithOriginal(
    originalBuffer: ArrayBuffer,
    config: SVGABuildConfig
  ): Promise<Blob> {
    throwIfExportAborted(config.signal)
    if (!this.MovieEntity) {
      await this.init()
    }
    throwIfExportAborted(config.signal)

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
    assertDecodedImageReferences(originalMovie)
    const originalObj = this.MovieEntity.toObject(originalMovie, {
      bytes: Uint8Array,
      arrays: true,
      objects: true,
      defaults: false
    })

    // 合并图片
    const mergedImages = Object.assign(Object.create(null), originalObj.images)
    config.imageResources.forEach((resource, key) => {
      if (resource.data.byteLength > 0) {
        mergedImages[key] = resource.data
      }
    })

    const slotConfigs = mapSlotsToSourceImages(config.slotConfigs, originalObj.sprites, config.layers)
    const knownSizes = new Map<string, { width: number; height: number }>(config.imageSizes)
    config.imageResources.forEach((resource, key) => {
      if (resource.width > 0 && resource.height > 0) knownSizes.set(key, { width: resource.width, height: resource.height })
    })
    const imageSizes = await resolveTextExportImageSizes({ images: mergedImages, sprites: originalObj.sprites }, slotConfigs, knownSizes, config.layers)
    throwIfExportAborted(config.signal)
    const replacementKeys = Object.keys(slotConfigs).filter(
      key => !!getSlotImageUrl(slotConfigs[key])
    )

    for (const key of replacementKeys) {
      throwIfExportAborted(config.signal)
      const slotConfig = slotConfigs[key]
      if (!getSlotImageUrl(slotConfig)) continue
      mergedImages[key] = new Uint8Array(await this.convertToPng(getSlotImageUrl(slotConfig)))
    }

    // 构建原始 key → 图层映射，优先使用解码后的原始 sprite imageKey
    // 这样 renameImageKey 后 layer.imageKey 已变，但 images map 里还是旧 key
    const sourceKeyByLayerId = new Map<string, string>()
    if (originalObj.sprites) {
      originalObj.sprites.forEach((sprite: Sprite, index: number) => {
        const layer = findOriginalLayer(config.layers, index)
        const sourceKey = sprite.imageKey || layer?.imageKey || ''
        if (layer && sourceKey) {
          sourceKeyByLayerId.set(layer.id, sourceKey)
        }
      })
    }

    // 导入层的副本仍引用同一资源；重命名后的当前Key不能成为丢失源图片的新占位图。
    const sourceByCurrentKey = new Map<string, string>()
    for (const layer of config.layers) {
      const sourceKey = sourceKeyByLayerId.get(layer.id)
      if (sourceKey && layer.imageKey) sourceByCurrentKey.set(layer.imageKey, sourceKey)
    }
    for (const layer of config.layers) {
      const sourceKey = layer.imageKey ? sourceByCurrentKey.get(layer.imageKey) : undefined
      if (sourceKey && !sourceKeyByLayerId.has(layer.id)) sourceKeyByLayerId.set(layer.id, sourceKey)
    }

    const imageAliases = createLayerImageAliases(mergedImages, config.layers, sourceKeyByLayerId)
    throwIfExportAborted(config.signal)

    // 合并 sprites
    const originalSprites = originalObj.sprites || []
    const bindings: ExportSpriteBinding[] = []

    // 更新现有图层的动画；缺失的原始图层视为已删除
    const updatedOriginalSprites = originalSprites.flatMap((sprite: Sprite, index: number) => {
      const layer = findOriginalLayer(config.layers, index)
      if (!layer) return []

      const exportImageKey = imageAliases.get(layer.id) || sprite.imageKey
      const hasRenamed = Boolean(exportImageKey && exportImageKey !== sprite.imageKey)
      let nextSprite = hasRenamed ? { ...sprite, imageKey: exportImageKey } : sprite
      // 导入图层的逐帧矩阵、路径和遮罩是原始动画；整段调整不得改成新增图层重建。
      nextSprite = {
        ...nextSprite,
        frames: bakeLayerFrames(sprite.frames, layer, config.params.frames, imageSizes.get(layer.imageKey || ''))
      }
      bindings.push(createExportSpriteBinding(bindings.length, layer, index,
        sourceKeyByLayerId.get(layer.id) || sprite.imageKey, nextSprite.imageKey, config.slotConfigs))
      return [fitSpriteFrameCount(nextSprite, config.params.frames)]
    })

    const newSprites = this.buildSprites(
      config.layers.filter(l => l.isNew), config.params, imageSizes, imageAliases,
      (layer, sprite) => {
        // 副本有独立图层身份，不能仅因共享图片 Key 就推测它来自某一个原 sprite。
        bindings.push(createExportSpriteBinding(bindings.length, layer, null,
          sourceKeyByLayerId.get(layer.id) || layer.imageKey, sprite.imageKey, config.slotConfigs))
      }
    )

    const sourceToExportKey = new Map<string, string>()
    config.layers.forEach((layer) => {
      const exportKey = imageAliases.get(layer.id)
      if (layer.imageKey && exportKey && exportKey !== layer.imageKey) {
        sourceToExportKey.set(layer.imageKey, exportKey)
      }
      const originalKey = sourceKeyByLayerId.get(layer.id)
      if (originalKey && exportKey && exportKey !== originalKey) sourceToExportKey.set(originalKey, exportKey)
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
      sprites: mergedSprites,
      audios: originalObj.audios || []
    }

    const preparedMovie = await prepareTextSlotsForExport(mergedMovie,
      mapSlotsToExportImages(config.slotConfigs, config.layers, imageAliases, sourceKeyByLayerId),
      exportImageSizes(imageSizes, config.layers, imageAliases, sourceKeyByLayerId))
    throwIfExportAborted(config.signal)

    const normalizedReferences = normalizeMovieImageReferences(preparedMovie)
    if (normalizedReferences.missingImageKeys.length > 0) {
      console.warn(
        '[SVGABuilder] Missing image data for sprite references:',
        normalizedReferences.missingImageKeys
      )
    }

    // 编码并压缩
    // 编辑态形状可能使用 RECT / SHAPE 等字符串枚举，编码前统一转换为协议数值。
    const encoded = this.MovieEntity.encode(this.MovieEntity.fromObject(preparedMovie)).finish()
    const compressed = pako.deflate(encoded, { level: 6 })
    emitExportBindings(config, bindings, preparedMovie.sprites)

    return new Blob([compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer], {
      type: 'application/octet-stream'
    })
  }
}

// 单例导出
export const svgaBuilder = new SVGABuilder()
