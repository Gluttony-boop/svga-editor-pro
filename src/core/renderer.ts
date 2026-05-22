/**
* Canvas 渲染器 - 基于E-SVGA优化策略的高性能版本
* 
* 核心优化策略（参考E-SVGA实现）：
* 1. 离屏Canvas + 帧缓存 + 批量渲染
* 2. 智能预加载和图片缓存
* 3. 分层渲染和增量更新
* 4. GPU加速优化
* 5. 性能监控和自适应降级
*/

import type { VideoItem, SlotConfig, Sprite, Layer } from '@/types'
import { AnimationEngine } from './animation-engine'

export interface RenderOptions {
  clearCanvas?: boolean
  applySlots?: boolean
  slotConfigs?: Record<string, SlotConfig>
  layers?: Layer[]
  imageResources?: Map<string, { data: Uint8Array; blobUrl?: string; width: number; height: number }>
  useFrameCache?: boolean // 是否启用帧缓存
}

// 全局图片缓存
const globalImageCache = new Map<string, HTMLImageElement>()

// 加载图片并缓存
async function loadImage(url: string): Promise<HTMLImageElement> {
  if (globalImageCache.has(url)) {
    const cachedImg = globalImageCache.get(url)!
    if (cachedImg.complete && cachedImg.width > 0) {
      return cachedImg
    }
  }
  
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      globalImageCache.set(url, img)
      resolve(img)
    }
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`))
    img.src = url
  })
}

export class CanvasRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private videoItem: VideoItem | null = null
  
  // 离屏Canvas（用于高性能渲染）
  private offscreenCanvas: HTMLCanvasElement | null = null
  private offscreenCtx: CanvasRenderingContext2D | null = null
  
  // 帧缓存（使用Canvas缓存而不是ImageData）
  private frameCanvasCache: Map<number, HTMLCanvasElement> = new Map()
  private maxCacheSize = 30
  
  // 预加载的插槽图片
  private loadedSlotImages: Map<string, HTMLImageElement> = new Map()
  
  // 新增图片缓存
  private newImageCache: Map<string, HTMLImageElement> = new Map()
  
  // 性能监控
  private lastRenderTime = 0
  private renderCount = 0
  private fps = 0
  private lastFpsUpdate = 0
  
  // 预计算的帧数据缓存（轻量级结构）
  private precomputedFrames: Array<Array<{
    imageKey: string
    transform: { a: number; b: number; c: number; d: number; tx: number; ty: number } | null
    layout: { width: number; height: number }
    alpha: number
  }>> = []
  
  // 是否已预计算
  private isPrecomputed = false
  
  // 渲染状态缓存（避免重复计算）
  private lastFrameIndex = -1
  private lastLayersHash = ''
  
  // 是否启用帧缓存
  private useFrameCache = true

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', { 
      alpha: true,
      desynchronized: true,
      willReadFrequently: false
    })!
    
    // 创建离屏Canvas
    this.offscreenCanvas = document.createElement('canvas')
    this.offscreenCtx = this.offscreenCanvas.getContext('2d', {
      alpha: true,
      desynchronized: true
    })
  }

  /**
   * 设置视频项
   */
  setVideoItem(videoItem: VideoItem | null): void {
    this.videoItem = videoItem
    this.frameCanvasCache.clear()
    this.precomputedFrames = []
    this.isPrecomputed = false
    this.lastFrameIndex = -1
    this.lastLayersHash = ''
    
    // 调整离屏Canvas尺寸
    if (videoItem?.movie?.params && this.offscreenCanvas) {
      const dpr = window.devicePixelRatio || 1
      this.offscreenCanvas.width = videoItem.movie.params.viewBoxWidth * dpr
      this.offscreenCanvas.height = videoItem.movie.params.viewBoxHeight * dpr
      this.offscreenCtx?.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
  }

  /**
   * 预计算所有帧数据（轻量级优化）
   */
  precomputeFrameData(): void {
    if (!this.videoItem || this.isPrecomputed) return
    
    const { movie } = this.videoItem
    const sprites = movie.sprites || []
    const params = movie.params
    
    if (!params) return
    
    const totalFrames = params.frames
    this.precomputedFrames = new Array(totalFrames)
    
    // 为每帧预计算所有精灵的变换数据
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      const frameSprites: Array<any> = []
      
      for (let spriteIndex = 0; spriteIndex < sprites.length; spriteIndex++) {
        const sprite = sprites[spriteIndex]
        const frames = sprite.frames
        if (!frames || frameIndex >= frames.length) continue
        
        const frame = frames[frameIndex]
        if (!frame || (frame.alpha !== undefined && frame.alpha <= 0)) continue
        
        const layout = frame.layout
        if (!layout || !layout.width || !layout.height) continue
        
        frameSprites.push({
          imageKey: sprite.imageKey,
          transform: frame.transform || null,
          layout: { width: layout.width, height: layout.height },
          alpha: frame.alpha !== undefined ? frame.alpha : 1
        })
      }
      
      this.precomputedFrames[frameIndex] = frameSprites
    }
    
    this.isPrecomputed = true
  }

  /**
   * 预加载插槽图片
   */
  async preloadSlotImages(slotConfigs: Record<string, SlotConfig>): Promise<void> {
    this.loadedSlotImages.clear()
    
    const loadPromises: Promise<void>[] = []
    
    for (const [key, slot] of Object.entries(slotConfigs)) {
      if (slot.type === 'image' && slot.imageConfig?.url) {
        loadPromises.push(
          loadImage(slot.imageConfig.url)
            .then(img => {
              this.loadedSlotImages.set(key, img)
            })
            .catch(err => {
              console.warn('[Renderer] Failed to preload slot image:', key, err)
            })
        )
      }
    }
    
    await Promise.all(loadPromises)
  }

  /**
   * 预加载新增图片
   */
  private async preloadNewImages(imageResources: Map<string, { data: Uint8Array; blobUrl?: string; width: number; height: number }>): Promise<void> {
    const loadPromises: Promise<void>[] = []
    
    imageResources.forEach((resource, key) => {
      if (!this.newImageCache.has(key)) {
        const url = resource.blobUrl || URL.createObjectURL(new Blob([resource.data.buffer as ArrayBuffer]))
        loadPromises.push(
          loadImage(url)
            .then(img => {
              this.newImageCache.set(key, img)
            })
            .catch(err => {
              console.warn('[Renderer] Failed to preload new image:', key, err)
            })
        )
      }
    })
    
    await Promise.all(loadPromises)
  }

  /**
   * 渲染指定帧（高性能版本）
   */
  async renderFrameAsync(
    frameIndex: number, 
    options: RenderOptions = {}
  ): Promise<void> {
    const startTime = performance.now()
    
    const { 
      clearCanvas = true, 
      applySlots = true, 
      slotConfigs = {}, 
      layers = [], 
      imageResources,
      useFrameCache = this.useFrameCache 
    } = options

    if (!this.videoItem) return

    // 计算图层哈希（用于判断是否需要重新渲染）
    const layersHash = JSON.stringify(layers.map(l => ({ id: l.id, visible: l.visible, opacity: l.opacity })))
    
    // 检查是否可以使用缓存的帧
    if (useFrameCache && frameIndex === this.lastFrameIndex && layersHash === this.lastLayersHash) {
      // 使用缓存的帧Canvas
      const cachedFrame = this.frameCanvasCache.get(frameIndex)
      if (cachedFrame) {
        if (clearCanvas) {
          this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
        }
        const dpr = window.devicePixelRatio || 1
        this.ctx.drawImage(cachedFrame, 0, 0, cachedFrame.width / dpr, cachedFrame.height / dpr)
        return
      }
    }
    
    // 预加载插槽图片
    if (applySlots && Object.keys(slotConfigs).length > 0) {
      await this.preloadSlotImages(slotConfigs)
    }

    // 预加载新增图片
    if (imageResources && imageResources.size > 0) {
      await this.preloadNewImages(imageResources)
    }

    const { movie, images } = this.videoItem
    const sprites = movie.sprites || []
    const params = movie.params

    if (!params) return

    // 使用离屏Canvas进行渲染
    const renderCtx = this.offscreenCtx || this.ctx
    const renderCanvas = this.offscreenCanvas || this.canvas
    
    if (clearCanvas) {
      const dpr = window.devicePixelRatio || 1
      renderCtx.setTransform(1, 0, 0, 1, 0, 0)
      renderCtx.clearRect(0, 0, renderCanvas.width, renderCanvas.height)
      renderCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    // 创建图层可见性映射
    const useLayerVisibility = layers.length > 0 && layers.length === sprites.length
    
    let renderedCount = 0
    
    // 使用预计算的帧数据（如果可用）
    if (this.isPrecomputed && this.precomputedFrames[frameIndex]) {
      const frameSprites = this.precomputedFrames[frameIndex]
      
      // 批量渲染优化：按alpha分组，减少状态切换
      const spritesByAlpha = new Map<number, typeof frameSprites>()
      
      for (const spriteData of frameSprites) {
        // 检查图层可见性
        let layerOpacity = 1
        if (useLayerVisibility) {
          const spriteIndex = sprites.findIndex(s => s.imageKey === spriteData.imageKey)
          if (spriteIndex >= 0) {
            const layer = layers[spriteIndex]
            if (layer?.visible === false) continue
            layerOpacity = layer?.opacity ?? 1
          }
        }
        
        const finalAlpha = Math.round((spriteData.alpha * layerOpacity) * 100)
        if (!spritesByAlpha.has(finalAlpha)) {
          spritesByAlpha.set(finalAlpha, [])
        }
        spritesByAlpha.get(finalAlpha)!.push(spriteData)
      }
      
      // 按alpha分组渲染
      for (const [alpha, spriteList] of spritesByAlpha) {
        renderCtx.globalAlpha = alpha / 100
        
        for (const spriteData of spriteList) {
          this.renderSpriteFast(
            spriteData.imageKey,
            spriteData,
            images,
            applySlots,
            1 // alpha已经在分组时设置
          )
          renderedCount++
        }
      }
    } else {
      // 实时计算（备用）
      for (let index = 0; index < sprites.length; index++) {
        const sprite = sprites[index]
        
        // 检查图层可见性
        let isVisible = true
        let layerOpacity = 1
        
        if (useLayerVisibility) {
          const layer = layers[index]
          isVisible = layer?.visible !== false
          layerOpacity = layer?.opacity ?? 1
        }
        
        if (!isVisible) continue
        
        this.renderSprite(
          sprite,
          frameIndex,
          images,
          applySlots,
          layerOpacity,
          renderCtx
        )
        renderedCount++
      }
    }
    
    // 渲染新增图层
    const newLayers = layers.filter(l => l.isNew)
    if (newLayers.length > 0) {
      for (const layer of newLayers) {
        if (!layer.visible) continue
        this.renderNewLayer(layer, frameIndex, images, params, renderCtx)
      }
    }
    
    // 如果使用了离屏Canvas，将其绘制到主Canvas
    if (this.offscreenCanvas && this.offscreenCtx) {
      const dpr = window.devicePixelRatio || 1
      if (clearCanvas) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
      }
      this.ctx.drawImage(this.offscreenCanvas, 0, 0, this.offscreenCanvas.width / dpr, this.offscreenCanvas.height / dpr)
      
      // 缓存当前帧到Canvas
      if (useFrameCache) {
        const cachedCanvas = document.createElement('canvas')
        cachedCanvas.width = this.offscreenCanvas.width
        cachedCanvas.height = this.offscreenCanvas.height
        const cachedCtx = cachedCanvas.getContext('2d')!
        cachedCtx.drawImage(this.offscreenCanvas, 0, 0)
        
        // LRU淘汰
        if (this.frameCanvasCache.size >= this.maxCacheSize) {
          const firstKey = this.frameCanvasCache.keys().next().value
          if (firstKey !== undefined) {
            this.frameCanvasCache.delete(firstKey)
          }
        }
        
        this.frameCanvasCache.set(frameIndex, cachedCanvas)
      }
    }
    
    // 更新渲染状态
    this.lastFrameIndex = frameIndex
    this.lastLayersHash = layersHash
    
    // 更新性能指标
    this.lastRenderTime = performance.now() - startTime
    this.renderCount++
    
    const now = performance.now()
    if (now - this.lastFpsUpdate >= 1000) {
      this.fps = Math.round(this.renderCount * 1000 / (now - this.lastFpsUpdate))
      this.renderCount = 0
      this.lastFpsUpdate = now
    }
  }

  /**
   * 快速渲染精灵（使用预计算数据）
   */
  private renderSpriteFast(
    imageKey: string,
    spriteData: {
      transform: { a: number; b: number; c: number; d: number; tx: number; ty: number } | null
      layout: { width: number; height: number }
      alpha: number
    },
    images: Record<string, HTMLImageElement>,
    applySlots: boolean,
    _layerOpacity: number = 1
  ): void {
    // 获取图片
    let img = images[imageKey]
    
    // 应用插槽替换
    if (applySlots && this.loadedSlotImages.has(imageKey)) {
      img = this.loadedSlotImages.get(imageKey)!
    }

    if (!img || !img.complete || img.width === 0 || img.height === 0) return

    const { transform, layout } = spriteData
    const ctx = this.offscreenCtx || this.ctx

    ctx.save()

    // 应用变换矩阵
    if (transform) {
      ctx.transform(
        transform.a ?? 1, 
        transform.b ?? 0,
        transform.c ?? 0, 
        transform.d ?? 1,
        transform.tx ?? 0, 
        transform.ty ?? 0
      )
    }
    
    // 绘制图片
    ctx.drawImage(img, 0, 0, layout.width, layout.height)

    ctx.restore()
  }

  /**
   * 渲染精灵（实时计算版本）
   */
  private renderSprite(
    sprite: Sprite,
    frameIndex: number,
    images: Record<string, HTMLImageElement>,
    applySlots: boolean,
    layerOpacity: number = 1,
    ctx: CanvasRenderingContext2D = this.ctx
  ): void {
    const frames = sprite.frames
    if (!frames || frameIndex >= frames.length) return

    const frame = frames[frameIndex]
    if (!frame || (frame.alpha !== undefined && frame.alpha <= 0)) return

    const imageKey = sprite.imageKey

    let img = images[imageKey]
    if (applySlots && this.loadedSlotImages.has(imageKey)) {
      img = this.loadedSlotImages.get(imageKey)!
    }

    if (!img || !img.complete || img.width === 0 || img.height === 0) return

    const transform = frame.transform
    const layout = frame.layout
    const alpha = frame.alpha !== undefined ? frame.alpha : 1

    if (!layout || !layout.width || !layout.height) return

    ctx.save()
    ctx.globalAlpha = alpha * layerOpacity

    if (transform) {
      ctx.transform(
        transform.a ?? 1, 
        transform.b ?? 0,
        transform.c ?? 0, 
        transform.d ?? 1,
        transform.tx ?? 0, 
        transform.ty ?? 0
      )
    }
    
    if (frame.clipPath) {
      try {
        const path = new Path2D(frame.clipPath)
        ctx.clip(path)
      } catch (e) {
        // ignore
      }
    }
    
    ctx.drawImage(img, 0, 0, layout.width, layout.height)
    ctx.restore()
  }
  
  /**
   * 渲染新增图层
   */
  private renderNewLayer(
    layer: Layer,
    frameIndex: number,
    images: Record<string, HTMLImageElement>,
    _params: { viewBoxWidth: number; viewBoxHeight: number; fps: number; frames: number },
    ctx: CanvasRenderingContext2D = this.ctx
  ): void {
    if (!layer.imageKey) return
    
    let img = this.newImageCache.get(layer.imageKey) || images[layer.imageKey]
    if (!img) return
    
    const { startFrame, duration } = layer.clip
    if (frameIndex < startFrame || frameIndex >= startFrame + duration) return
    
    const props = AnimationEngine.getLayerPropertiesAtFrame(layer, frameIndex)
    const { position, scale, rotation, alpha } = props
    
    if (alpha <= 0) return
    
    const layout = {
      width: img.width,
      height: img.height
    }
    
    ctx.save()
    ctx.globalAlpha = alpha * (layer.opacity ?? 1)
    
    const rad = (rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    
    ctx.transform(
      scale.scaleX * cos, 
      scale.scaleX * sin,
      -scale.scaleY * sin, 
      scale.scaleY * cos,
      position.x, 
      position.y
    )
    
    ctx.drawImage(img, 0, 0, layout.width, layout.height)
    ctx.restore()
  }

  /**
   * 渲染指定帧（同步版本）
   */
  renderFrame(
    frameIndex: number, 
    options: RenderOptions = {}
  ): void {
    this.renderFrameAsync(frameIndex, options).catch(err => {
      console.error('[Renderer] renderFrame error:', err)
    })
  }

  /**
   * 清除画布
   */
  clear(): void {
    const dpr = window.devicePixelRatio || 1
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    
    if (this.offscreenCtx && this.offscreenCanvas) {
      this.offscreenCtx.setTransform(1, 0, 0, 1, 0, 0)
      this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height)
      this.offscreenCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
  }

  /**
   * 调整画布尺寸
   */
  resize(width: number, height: number): void {
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = width * dpr
    this.canvas.height = height * dpr
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    
    // 同步调整离屏Canvas
    if (this.offscreenCanvas && this.offscreenCtx) {
      this.offscreenCanvas.width = width * dpr
      this.offscreenCanvas.height = height * dpr
      this.offscreenCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
  }

  /**
   * 获取帧图像数据
   */
  getFrameImageData(_frameIndex: number): ImageData | null {
    return null
  }

  /**
   * 缓存帧
   */
  cacheFrame(_frameIndex: number): void {
    // 使用Canvas缓存，不使用ImageData
  }

  /**
   * 导出当前帧为 Blob
   */
  async exportFrame(format: string = 'image/png', quality: number = 1): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob)
          } else {
            reject(new Error('导出失败'))
          }
        },
        format,
        quality
      )
    })
  }

  /**
   * 获取当前画布的 DataURL
   */
  getDataURL(format: string = 'image/png', quality: number = 1): string {
    return this.canvas.toDataURL(format, quality)
  }
  
  /**
   * 获取性能指标
   */
  getPerformanceMetrics(): {
    lastRenderTime: number
    fps: number
    cacheSize: number
  } {
    return {
      lastRenderTime: this.lastRenderTime,
      fps: this.fps,
      cacheSize: this.frameCanvasCache.size
    }
  }
  
  /**
   * 清除所有缓存
   */
  clearAllCaches(): void {
    this.frameCanvasCache.clear()
    this.precomputedFrames = []
    this.loadedSlotImages.clear()
    this.newImageCache.clear()
    this.isPrecomputed = false
    this.lastFrameIndex = -1
    this.lastLayersHash = ''
  }
  
  /**
   * 启用/禁用帧缓存
   */
  setFrameCache(enabled: boolean): void {
    this.useFrameCache = enabled
    if (!enabled) {
      this.frameCanvasCache.clear()
    }
  }
}
