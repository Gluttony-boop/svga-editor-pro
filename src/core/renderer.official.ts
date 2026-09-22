/**
 * 官方 SVGA 播放器渲染器
 * 基于 SVGAPlayer-Web-Lite 的正确实现
 * 关键特性：时间轴插值、正确的渲染顺序、完整的遮罩支持
 */

import type { VideoItem, SlotConfig, Layer, Sprite, FrameData } from '@/types'
import type { RenderOptions } from './renderer'
import { applyLayerFrameEdits, getFrameAlpha, getFrameTransform, getLayerBaseFrame, getOriginalLayerIndex } from './layer-transform'
import { getLayerSourceFrame, getLayerTimeOffset } from './layer-time'
import { RendererImageCache } from './renderer-images'
import { TextPreviewCache, applyTextFrameLayout, getTextPreviewSize, hasTextBox, hasTextPreview } from './text-preview'
import { getActiveMatteKeys } from './renderer-matte'

export type { RenderOptions } from './renderer'

export interface PerformanceMetrics {
  fps: number
  lastRenderTime: number
  cacheSize: number
  workerEnabled: boolean
  spriteCount: number
  cacheHits: number
  cacheMisses: number
}

/**
 * 帧数据插值计算结果
 */
interface InterpolatedFrameData {
  layout: {
    x: number
    y: number
    width: number
    height: number
  }
  transform: {
    a: number
    b: number
    c: number
    d: number
    tx: number
    ty: number
  }
  alpha: number
  clipPath?: string
  shapes?: any[]
  blendMode?: string
}

/**
 * 插值关键帧
 */
interface KeyFrame {
  frame: number
  data: FrameData
}

/**
 * 官方 SVGA 渲染器
 * 
 * 核心特性：
 * 1. 时间轴插值 - 根据当前帧在关键帧之间插值计算
 * 2. 正确的渲染顺序 - 遵循 SVGA 规范
 * 3. 完整的遮罩支持 - 正确的 Alpha 通道处理
 * 4. 矢量图形支持 - 完整的 Shape 渲染
 */
export class OfficialSvgRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  
  // 视频数据
  private videoItem: VideoItem | null = null
  private params: { viewBoxWidth: number; viewBoxHeight: number; fps: number; frames: number } | null = null
  
  // 图片缓存
  private imageCache: Map<string, HTMLImageElement> = new Map()
  private liveImages = new RendererImageCache(() => this.clearFrameCache())
  private textPreview = new TextPreviewCache()
  private activeSlotConfigs: Record<string, SlotConfig> = {}
  private applySlotPreviews = true
  private previewImageSizes: RenderOptions['imageResources']
  private matteKeys = new Set<string>()
  private videoGeneration = 0
  private renderSignature = ''

  // 帧缓存（按需LRU）
  private frameCache: Map<number, { canvas: HTMLCanvasElement; timestamp: number }> = new Map()
  private maxCacheSize = 50

  // 离屏Canvas池
  private offscreenCanvasPool: HTMLCanvasElement[] = []
  // 性能指标
  private metrics: PerformanceMetrics = {
    fps: 0,
    lastRenderTime: 0,
    cacheSize: 0,
    workerEnabled: false,
    spriteCount: 0,
    cacheHits: 0,
    cacheMisses: 0
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', {
      alpha: true,
      desynchronized: true
    })!
  }

  /**
   * 设置视频项
   */
  async setVideoItem(videoItem: VideoItem | null, options?: { waitForImages?: boolean }): Promise<void> {
    const generation = ++this.videoGeneration
    this.videoItem = videoItem
    this.params = null
    this.liveImages.clear()
    this.textPreview.clear()
    this.activeSlotConfigs = {}
    this.matteKeys = new Set((videoItem?.movie.sprites || []).flatMap(sprite => sprite.matteKey ? [sprite.matteKey] : []))
    this.renderSignature = ''
    this.imageCache.clear()
    this.frameCache.clear()
    this.metrics.cacheSize = 0
    this.metrics.cacheHits = 0
    this.metrics.cacheMisses = 0
    
    if (!videoItem || !videoItem.movie.params) {
      return
    }
    
    this.params = videoItem.movie.params
    
    // 设置 Canvas 尺寸
    this.canvas.width = this.params.viewBoxWidth
    this.canvas.height = this.params.viewBoxHeight
    
    // 等待图片加载完成
    if (options?.waitForImages && videoItem.images) {
      const images = videoItem.images
      const imageEntries = Object.entries(images)
      
      await Promise.all(
        imageEntries.map(([key, img]) => 
          new Promise<void>((resolve) => {
            if (img && img.complete && img.width > 0) {
              if (generation === this.videoGeneration) this.imageCache.set(key, img)
              resolve()
            } else if (img) {
              img.onload = () => {
                if (generation === this.videoGeneration) this.imageCache.set(key, img)
                resolve()
              }
              img.onerror = () => {
                console.warn('[OfficialSvgRenderer] Image failed to load:', key)
                resolve()
              }
              if (img.complete) {
                if (img.width > 0) {
                  if (generation === this.videoGeneration) this.imageCache.set(key, img)
                }
                resolve()
              }
            } else {
              resolve()
            }
          })
        )
      )
      
    } else if (videoItem.images) {
      // 不等待，直接缓存已加载的图片
      for (const [key, img] of Object.entries(videoItem.images)) {
        if (img && img.complete && img.width > 0) {
          this.imageCache.set(key, img)
        }
      }
    }
  }

  /**
   * 渲染指定帧 - 基于官方实现的时间轴插值
   */
  renderFrame(frameIndex: number, options: RenderOptions = {}): void {
    const startTime = performance.now()
    
    const { 
      slotConfigs = {},
      layers = [],
      useFrameCache = true
    } = options

    this.activeSlotConfigs = slotConfigs
    this.applySlotPreviews = options.applySlots !== false
    this.matteKeys = getActiveMatteKeys(this.videoItem, options.layers)
    this.previewImageSizes = options.imageResources

    if (!this.videoItem || !this.params || options.shouldRender?.() === false) {
      return
    }

    const signature = this.createRenderSignature(slotConfigs, layers, options.applySlots !== false)
    if (signature !== this.renderSignature) {
      this.clearFrameCache()
      this.renderSignature = signature
    }
    void this.liveImages.prepare(slotConfigs, options.applySlots !== false, options.imageResources).catch(() => undefined)

    // 检查帧缓存
    if (useFrameCache) {
      const cached = this.frameCache.get(frameIndex)
      if (cached) {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0)
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
        this.ctx.drawImage(cached.canvas, 0, 0)
        cached.timestamp = Date.now()
        this.metrics.cacheHits++
        this.metrics.lastRenderTime = performance.now() - startTime
        return
      }
      this.metrics.cacheMisses++
    }

    // 重置变换矩阵并清空画布
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)

    // 同一图片可被多层复用，图层变换和可见性必须按稳定索引分别处理。
    const layerMap = new Map<number, Layer>()
    for (const layer of layers) {
      const index = getOriginalLayerIndex(layer)
      if (index !== null) layerMap.set(index, layer)
    }

    // 按正确的渲染顺序渲染所有精灵
    const sprites = this.videoItem.movie.sprites || []
    let spriteCount = 0
    
    const matteKeys = this.matteKeys
    for (let index = 0; index < sprites.length; index++) {
      const sprite = sprites[index]
      const { imageKey, frames, matteKey } = sprite
      
      const layerState = layerMap.get(index)
      const sourceFrame = layerState ? getLayerSourceFrame(layerState, frameIndex) : frameIndex
      if (!frames || sourceFrame < 0 || sourceFrame >= frames.length) {
        continue
      }

      // 检查图层可见性
      if ((options.layers !== undefined && !layerState) || (layerState && (!layerState.visible || sourceFrame < layerState.clip.startFrame || sourceFrame >= layerState.clip.startFrame + layerState.clip.duration))) {
        continue
      }
      if (matteKeys.has(imageKey) && !matteKey) continue

      // 获取当前帧的插值数据
      let frameData = this.getInterpolatedFrameData(sprite, sourceFrame)
      if (!frameData) {
        continue
      }

      // 获取图片
      const resolvedKey = layerState?.imageKey || imageKey
      const rawImg = this.getImage(resolvedKey, imageKey)
      const img = this.withTextPreview(resolvedKey, rawImg, frameData.layout || undefined) || rawImg || (frameData.shapes?.length ? this.canvas : undefined)
      
      if (!img || img.width === 0) {
        continue
      }
      frameData = this.withTextFrame(resolvedKey, this.editFrame(frameData, layerState, img, frameIndex, resolvedKey))
      const finalAlpha = frameData.alpha
      if (finalAlpha <= 0) continue

      // 渲染精灵（支持遮罩）
      if (matteKey) {
        const matteIndex = sprites.findIndex(candidate => candidate.imageKey === matteKey)
        const matteLayer = layerMap.get(matteIndex)
        const matteSourceFrame = matteLayer ? getLayerSourceFrame(matteLayer, frameIndex) : frameIndex
        const matteInClip = !matteLayer || (matteSourceFrame >= matteLayer.clip.startFrame && matteSourceFrame < matteLayer.clip.startFrame + matteLayer.clip.duration)
        const matteExists = matteIndex >= 0 && (options.layers === undefined || !!matteLayer)
        const matteFrame = matteExists && matteInClip && matteSourceFrame >= 0 && matteSourceFrame < sprites[matteIndex].frames.length
          ? this.getInterpolatedFrameData(sprites[matteIndex], matteSourceFrame) : null
        const resolvedMatteKey = matteLayer?.imageKey || matteKey
        const rawMatteImg = this.getImage(resolvedMatteKey, matteKey)
        const matteImg = this.withTextPreview(resolvedMatteKey, rawMatteImg, matteFrame?.layout || undefined) || rawMatteImg || (matteFrame?.shapes?.length ? this.canvas : undefined)
        const editedMatte = matteFrame && matteImg ? this.editFrame(matteFrame, matteLayer, matteImg, frameIndex, resolvedMatteKey) : null
        const matteAlpha = editedMatte?.alpha ?? 1
        this.renderSpriteWithMatte(img, frameData, matteImg, editedMatte, finalAlpha, matteAlpha)
      } else {
        this.renderSprite(img, frameData, finalAlpha)
      }
      
      spriteCount++
    }

    for (const layer of layers) {
      if (!layer.isNew || !layer.visible || !layer.imageKey) continue
      const base = getLayerBaseFrame(layer, frameIndex, this.videoItem, options.imageResources)
      if (!base || (base.alpha ?? 1) <= 0) continue
      const rawImage = this.getImage(layer.imageKey)
      const image = this.withTextPreview(layer.imageKey, rawImage, base.layout) || rawImage
      if (!image) continue
      const edited = applyLayerFrameEdits(base, layer, frameIndex, this.textSourceSize(layer.imageKey, base.layout, image))
      this.renderSprite(image, this.withTextFrame(layer.imageKey, this.convertFrameData(edited)), getFrameAlpha(edited))
      spriteCount++
    }

    // 更新性能指标
    this.metrics.lastRenderTime = performance.now() - startTime
    this.metrics.spriteCount = spriteCount

    // 缓存当前帧（按需LRU）
    if (useFrameCache) {
      this.cacheFrame(frameIndex)
    }
  }

  /**
   * 获取插值后的帧数据
   * 官方 SVGA 播放器的核心：时间轴插值计算
   */
  private getInterpolatedFrameData(sprite: Sprite, frameIndex: number): InterpolatedFrameData | null {
    const { frames } = sprite
    
    if (!frames || frames.length === 0) {
      return null
    }

    if (frames[frameIndex]) return this.convertFrameData(frames[frameIndex])

    // 查找当前帧的前后关键帧
    const keyFrames: KeyFrame[] = []
    
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]
      if (this.isValidFrameData(frame)) {
        keyFrames.push({ frame: i, data: frame })
      }
    }

    if (keyFrames.length === 0) {
      return null
    }

    // 如果当前帧正好是关键帧，直接返回
    const exactFrame = keyFrames.find(kf => kf.frame === frameIndex)
    if (exactFrame) {
      return this.convertFrameData(exactFrame.data)
    }

    // 查找前后关键帧进行插值
    const prevKeyFrame = this.findPrevKeyFrame(keyFrames, frameIndex)
    const nextKeyFrame = this.findNextKeyFrame(keyFrames, frameIndex)

    if (!prevKeyFrame || !nextKeyFrame) {
      return null
    }

    // 计算插值比例 (0-1)
    const totalFrames = nextKeyFrame.frame - prevKeyFrame.frame
    const currentFrameOffset = frameIndex - prevKeyFrame.frame
    const ratio = totalFrames > 0 ? currentFrameOffset / totalFrames : 0

    // 插值计算
    return this.interpolateFrameData(prevKeyFrame.data, nextKeyFrame.data, ratio)
  }

  /**
   * 查找前一个关键帧
   */
  private findPrevKeyFrame(keyFrames: KeyFrame[], frameIndex: number): KeyFrame | null {
    let prevFrame: KeyFrame | null = null
    
    for (const kf of keyFrames) {
      if (kf.frame <= frameIndex) {
        if (!prevFrame || kf.frame > prevFrame.frame) {
          prevFrame = kf
        }
      }
    }
    
    return prevFrame
  }

  /**
   * 查找后一个关键帧
   */
  private findNextKeyFrame(keyFrames: KeyFrame[], frameIndex: number): KeyFrame | null {
    let nextFrame: KeyFrame | null = null
    
    for (const kf of keyFrames) {
      if (kf.frame >= frameIndex) {
        if (!nextFrame || kf.frame < nextFrame.frame) {
          nextFrame = kf
        }
      }
    }
    
    return nextFrame
  }

  /**
   * 插值计算帧数据
   */
  private interpolateFrameData(
    prev: FrameData, 
    next: FrameData, 
    ratio: number
  ): InterpolatedFrameData {
    // 插值布局
    const layout = {
      x: this.interpolateValue(prev.layout?.x, next.layout?.x, ratio, 0),
      y: this.interpolateValue(prev.layout?.y, next.layout?.y, ratio, 0),
      width: this.interpolateValue(prev.layout?.width, next.layout?.width, ratio, 0),
      height: this.interpolateValue(prev.layout?.height, next.layout?.height, ratio, 0)
    }

    // 插值变换矩阵
    const transform = {
      a: this.interpolateValue(prev.transform?.a, next.transform?.a, ratio, 1),
      b: this.interpolateValue(prev.transform?.b, next.transform?.b, ratio, 0),
      c: this.interpolateValue(prev.transform?.c, next.transform?.c, ratio, 0),
      d: this.interpolateValue(prev.transform?.d, next.transform?.d, ratio, 1),
      tx: this.interpolateValue(prev.transform?.tx, next.transform?.tx, ratio, 0),
      ty: this.interpolateValue(prev.transform?.ty, next.transform?.ty, ratio, 0)
    }

    // 插值透明度
    const alpha = this.interpolateValue(prev.alpha, next.alpha, ratio, 1)

    // 使用前一个关键帧的其他属性（clipPath, shapes, blendMode）
    return {
      layout,
      transform,
      alpha,
      clipPath: prev.clipPath ?? undefined,
      shapes: prev.shapes,
      blendMode: prev.blendMode
    }
  }

  /**
   * 数值插值
   */
  private interpolateValue(prevVal: number | undefined, nextVal: number | undefined, ratio: number, defaultValue: number): number {
    const prev = prevVal ?? defaultValue
    const next = nextVal ?? defaultValue
    return prev + (next - prev) * ratio
  }

  /**
   * 验证帧数据是否有效
   */
  private isValidFrameData(frame: any): frame is FrameData {
    if (!frame) return false
    
    // 检查是否有布局信息
    if (frame.layout) {
      if (typeof frame.layout.width !== 'number' || frame.layout.width <= 0) return false
      if (typeof frame.layout.height !== 'number' || frame.layout.height <= 0) return false
    }
    
    // 检查是否有变换信息
    if (frame.transform) {
      if (typeof frame.transform.tx !== 'number') return false
      if (typeof frame.transform.ty !== 'number') return false
    }
    
    return true
  }

  /**
   * 转换帧数据格式
   */
  private convertFrameData(frame: FrameData): InterpolatedFrameData {
    return {
      layout: {
        x: frame.layout?.x ?? 0,
        y: frame.layout?.y ?? 0,
        width: frame.layout?.width ?? 0,
        height: frame.layout?.height ?? 0
      },
      transform: getFrameTransform(frame),
      alpha: frame.alpha ?? 1,
      clipPath: frame.clipPath ?? undefined,
      shapes: frame.shapes,
      blendMode: frame.blendMode
    }
  }

  /**
   * 使用遮罩渲染精灵
   * 复用离屏Canvas池，避免每帧createElement
   */
  private renderSpriteWithMatte(
    img: HTMLImageElement | HTMLCanvasElement,
    frameData: InterpolatedFrameData,
    matteImg: HTMLImageElement | HTMLCanvasElement | undefined,
    matteFrame: InterpolatedFrameData | null,
    alpha: number,
    matteAlpha: number
  ): void {
    if (!matteImg || !matteFrame || matteImg.width === 0) {
      // 缺失或时间范围外的遮罩必须保持透明，避免露出原本被遮挡的内容。
      return
    }

    // 从池中获取离屏Canvas
    const offscreenCanvas = this.getOffscreenCanvas()
    const offscreenCtx = offscreenCanvas.getContext('2d')!
    offscreenCtx.setTransform(1, 0, 0, 1, 0, 0)
    offscreenCtx.clearRect(0, 0, offscreenCanvas.width, offscreenCanvas.height)

    // 第一步：在离屏 Canvas 上渲染被遮罩图层
    offscreenCtx.save()
    this.renderSpriteInternal(offscreenCtx, img, frameData, alpha)
    offscreenCtx.restore()

    // 第二步：应用遮罩（destination-in 模式）
    offscreenCtx.save()
    offscreenCtx.globalCompositeOperation = 'destination-in'
    this.renderSpriteInternal(offscreenCtx, matteImg, { ...matteFrame, blendMode: undefined }, matteAlpha)
    offscreenCtx.restore()

    // 第三步：将结果绘制到主画布
    this.ctx.save()
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.ctx.globalAlpha = 1
    this.ctx.globalCompositeOperation = 'source-over'
    this.ctx.drawImage(offscreenCanvas, 0, 0)
    this.ctx.restore()

    // 归还离屏Canvas
    this.returnOffscreenCanvas(offscreenCanvas)
  }

  /**
   * 获取池化的离屏Canvas
   */
  private getOffscreenCanvas(): HTMLCanvasElement {
    const pooled = this.offscreenCanvasPool.pop()
    if (pooled) {
      if (pooled.width !== this.canvas.width || pooled.height !== this.canvas.height) {
        pooled.width = this.canvas.width
        pooled.height = this.canvas.height
      }
      return pooled
    }
    const c = document.createElement('canvas')
    c.width = this.canvas.width
    c.height = this.canvas.height
    return c
  }

  /**
   * 归还离屏Canvas
   */
  private returnOffscreenCanvas(c: HTMLCanvasElement): void {
    if (this.offscreenCanvasPool.length < 4) {
      const ctx = c.getContext('2d')
      if (ctx) ctx.clearRect(0, 0, c.width, c.height)
      this.offscreenCanvasPool.push(c)
    }
  }

  /**
   * 帧缓存
   */
  private cacheFrame(frameIndex: number): void {
    if (this.frameCache.has(frameIndex)) return

    // LRU淘汰
    if (this.frameCache.size >= this.maxCacheSize) {
      let oldestKey = -1, oldestTime = Infinity
      for (const [key, item] of this.frameCache) {
        if (item.timestamp < oldestTime) { oldestTime = item.timestamp; oldestKey = key }
      }
      if (oldestKey >= 0) this.frameCache.delete(oldestKey)
    }

    const snapshot = document.createElement('canvas')
    snapshot.width = this.canvas.width
    snapshot.height = this.canvas.height
    const snapshotCtx = snapshot.getContext('2d')
    if (!snapshotCtx) return

    snapshotCtx.drawImage(this.canvas, 0, 0)
    this.frameCache.set(frameIndex, {
      canvas: snapshot,
      timestamp: Date.now()
    })
  }

  /**
   * 渲染精灵（无遮罩）
   */
  private renderSprite(img: HTMLImageElement | HTMLCanvasElement, frameData: InterpolatedFrameData, alpha: number): void {
    this.renderSpriteInternal(this.ctx, img, frameData, alpha)
  }

  /**
   * 内部渲染实现
   */
  private renderSpriteInternal(
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement | HTMLCanvasElement,
    frameData: InterpolatedFrameData,
    alpha: number
  ): void {
    const { layout, transform, clipPath, shapes, blendMode } = frameData

    ctx.save()

    // 设置透明度
    ctx.globalAlpha = alpha

    // 应用混合模式
    if (blendMode) {
      ctx.globalCompositeOperation = this.normalizeBlendMode(blendMode)
    }

    // 应用变换矩阵
    ctx.setTransform(
      transform.a,
      transform.b,
      transform.c,
      transform.d,
      transform.tx,
      transform.ty
    )

    // 应用裁剪路径
    if (clipPath) {
      try {
        const path = new Path2D(clipPath)
        ctx.clip(path)
      } catch {
        // 忽略无效的裁剪路径
      }
    }

    // 绘制矢量图形（如果有）
    if (shapes && shapes.length > 0) {
      this.renderShapes(ctx, shapes)
    } else {
      // 绘制图片
      ctx.drawImage(img, 0, 0, layout.width || img.width, layout.height || img.height)
    }

    ctx.restore()
  }

  /**
   * 渲染矢量图形
   */
  private renderShapes(ctx: CanvasRenderingContext2D, shapes: any[]): void {
    for (const shape of shapes) {
      ctx.save()

      // 应用形状变换
      if (shape.transform) {
        const t = shape.transform
        ctx.transform(
          t.a ?? 1,
          t.b ?? 0,
          t.c ?? 0,
          t.d ?? 1,
          t.tx ?? 0,
          t.ty ?? 0
        )
      }

      // 应用样式
      if (shape.styles) {
        const styles = shape.styles
        
        // 填充样式
        if (styles.fill) {
          const fill = styles.fill
          ctx.fillStyle = `rgba(${fill.r}, ${fill.g}, ${fill.b}, ${fill.a})`
        }
        
        // 描边样式
        if (styles.stroke) {
          const stroke = styles.stroke
          ctx.strokeStyle = `rgba(${stroke.r}, ${stroke.g}, ${stroke.b}, ${stroke.a})`
          ctx.lineWidth = styles.strokeWidth ?? 1
        }
      }

      // 根据形状类型绘制
      switch (shape.type) {
        case 'RECT':
          this.renderRect(ctx, shape.rect, shape.styles)
          break
        case 'ELLIPSE':
          this.renderEllipse(ctx, shape.ellipse, shape.styles)
          break
        case 'SHAPE':
          this.renderPath(ctx, shape.shape, shape.styles)
          break
        case 'KEEP':
          // KEEP 类型保留之前的路径
          break
      }

      ctx.restore()
    }
  }

  /**
   * 渲染矩形
   */
  private renderRect(ctx: CanvasRenderingContext2D, rect: any, styles?: any): void {
    if (!rect) return

    const { x, y, width, height, cornerRadius } = rect

    if (cornerRadius && cornerRadius > 0) {
      ctx.beginPath()
      ctx.roundRect(x, y, width, height, cornerRadius)
    } else {
      ctx.beginPath()
      ctx.rect(x, y, width, height)
    }

    if (styles?.fill) {
      ctx.fill()
    }
    if (styles?.stroke) {
      ctx.stroke()
    }
  }

  /**
   * 渲染椭圆
   */
  private renderEllipse(ctx: CanvasRenderingContext2D, ellipse: any, styles?: any): void {
    if (!ellipse) return

    const { x, y, radiusX, radiusY } = ellipse

    ctx.beginPath()
    ctx.ellipse(x, y, radiusX, radiusY, 0, 0, 2 * Math.PI)

    if (styles?.fill) {
      ctx.fill()
    }
    if (styles?.stroke) {
      ctx.stroke()
    }
  }

  /**
   * 渲染路径
   */
  private renderPath(ctx: CanvasRenderingContext2D, shape: any, styles?: any): void {
    if (!shape || !shape.d) return

    try {
      const path = new Path2D(shape.d)
      
      if (styles?.fill) {
        ctx.fill(path)
      }
      if (styles?.stroke) {
        ctx.stroke(path)
      }
    } catch (error) {
      console.warn('[OfficialSvgRenderer] Failed to render path:', error)
    }
  }

  /**
   * 标准化混合模式名称
   */
  private normalizeBlendMode(blendMode: string): GlobalCompositeOperation {
    const modeMap: Record<string, GlobalCompositeOperation> = {
      'normal': 'source-over',
      'multiply': 'multiply',
      'screen': 'screen',
      'overlay': 'overlay',
      'darken': 'darken',
      'lighten': 'lighten',
      'color-dodge': 'color-dodge',
      'color-burn': 'color-burn',
      'hard-light': 'hard-light',
      'soft-light': 'soft-light',
      'difference': 'difference',
      'exclusion': 'exclusion',
      'hue': 'hue',
      'saturation': 'saturation',
      'color': 'color',
      'luminosity': 'luminosity'
    }
    
    return modeMap[blendMode.toLowerCase()] || 'source-over'
  }

  private getImage(key: string, fallbackKey?: string): HTMLImageElement | undefined {
    const image = this.liveImages.getSlot(key) || this.liveImages.getResource(key) || this.videoItem?.images?.[key] || this.imageCache.get(key)
    if (image?.complete && image.width > 0) return image
    return fallbackKey && fallbackKey !== key ? this.getImage(fallbackKey) : undefined
  }

  private editFrame(frame: InterpolatedFrameData, layer: Layer | undefined, image: HTMLImageElement | HTMLCanvasElement, frameIndex: number, key: string): InterpolatedFrameData {
    if (!layer) return frame
    return this.convertFrameData(applyLayerFrameEdits(
      { ...frame, clipPath: frame.clipPath ?? null },
      layer,
      frameIndex,
      this.textSourceSize(key, frame.layout, image)
    ))
  }

  private withTextPreview(key: string, image: HTMLImageElement | undefined, layout: { width?: number; height?: number } | null | undefined): HTMLImageElement | HTMLCanvasElement | undefined {
    const slot = Object.prototype.hasOwnProperty.call(this.activeSlotConfigs, key) ? this.activeSlotConfigs[key] : undefined
    if (!this.applySlotPreviews || (!hasTextPreview(slot) && !hasTextBox(slot)) || this.matteKeys.has(key) || /\.(matte|vector)$/i.test(key)) return image
    return this.textPreview.compose(key, slot, image || null, this.textSourceSize(key, layout)) || undefined
  }

  private textSourceSize(key: string, layout: { width?: number; height?: number } | null | undefined, fallback?: HTMLImageElement | HTMLCanvasElement) {
    const source = this.previewImageSizes?.get(key) || this.imageCache.get(key)
      || (Object.prototype.hasOwnProperty.call(this.videoItem?.images || {}, key) ? this.videoItem?.images[key] : undefined)
    const original = getTextPreviewSize(null, source)
    const config = Object.prototype.hasOwnProperty.call(this.activeSlotConfigs, key) ? this.activeSlotConfigs[key].textConfig : undefined
    const backup = getTextPreviewSize(null, fallback)
    return getTextPreviewSize(layout, {
      width: original.width > 0 ? original.width : config?.referenceWidth ?? backup.width,
      height: original.height > 0 ? original.height : config?.referenceHeight ?? backup.height
    })
  }

  private withTextFrame(key: string, frame: InterpolatedFrameData): InterpolatedFrameData {
    if (!this.applySlotPreviews || this.matteKeys.has(key) || /\.(matte|vector)$/i.test(key) || frame.shapes?.length) return frame
    const slot = Object.prototype.hasOwnProperty.call(this.activeSlotConfigs, key) ? this.activeSlotConfigs[key] : undefined
    return applyTextFrameLayout(frame, slot, this.textSourceSize(key, frame.layout))
  }

  private createRenderSignature(slots: Record<string, SlotConfig>, layers: Layer[], applySlots: boolean): string {
    return JSON.stringify({
      layers: layers.map(layer => [layer.id, layer.editableIndex, layer.imageKey, layer.visible, layer.opacity, layer.clip, getLayerTimeOffset(layer), layer.canvasTransform, layer.animationTracks, layer.tracks]),
      slots: applySlots ? Object.entries(slots).map(([key, slot]) => [key, slot.type, slot.imageConfig?.url, slot.value, slot.textConfig]) : []
    })
  }

  clearFrameCache(): void {
    this.frameCache.clear()
    this.metrics.cacheSize = 0
  }

  /** 图片解码结束后重新检查请求时效，过期编辑不能覆盖较新的画面。 */
  async renderFrameAsync(frameIndex: number, options: RenderOptions = {}): Promise<void> {
    const generation = this.videoGeneration
    await this.liveImages.prepare(options.slotConfigs || {}, options.applySlots !== false, options.imageResources)
    if (generation !== this.videoGeneration || options.shouldRender?.() === false) return
    this.renderFrame(frameIndex, options)
  }

  /**
   * 获取性能指标
   */
  getPerformanceMetrics(): PerformanceMetrics {
    return { ...this.metrics }
  }

  /**
   * 销毁渲染器
   */
  destroy(): void {
    this.videoGeneration++
    this.videoItem = null
    this.params = null
    this.imageCache.clear()
    this.textPreview.clear()
    this.activeSlotConfigs = {}
    this.liveImages.clear()
    this.frameCache.clear()
    for (const c of this.offscreenCanvasPool) {
      c.getContext('2d')?.clearRect(0, 0, c.width, c.height)
    }
    this.offscreenCanvasPool = []
  }

  /**
   * 检查是否已加载视频数据
   */
  hasVideoData(): boolean {
    return this.videoItem !== null && this.params !== null
  }
}
