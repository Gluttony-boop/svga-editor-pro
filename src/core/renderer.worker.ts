/**
 * Web Worker 渲染器
 * 在 Worker 线程中进行离屏渲染，避免阻塞主线程
 */

// Worker 消息类型
export enum WorkerMessageType {
  INIT = 'INIT',
  SET_VIDEO_ITEM = 'SET_VIDEO_ITEM',
  RENDER_FRAME = 'RENDER_FRAME',
  CLEAR_CACHE = 'CLEAR_CACHE',
  PRELOAD_IMAGES = 'PRELOAD_IMAGES',
  DESTROY = 'DESTROY'
}

// Worker 消息接口
export interface WorkerMessage {
  type: WorkerMessageType
  payload: any
  transferables?: Transferable[]
}

// 渲染结果消息
export interface RenderResult {
  type: 'RENDER_COMPLETE'
  frameIndex: number
  imageData: ImageData
  renderTime: number
  metrics: {
    spriteCount: number
    cacheHits: number
    cacheMisses: number
  }
}

// 精灵数据（轻量级，可序列化）
interface SpriteData {
  imageKey: string
  imageBitmap?: ImageBitmap
  frames: Array<{
    transform?: { a: number; b: number; c: number; d: number; tx: number; ty: number }
    layout?: { width: number; height: number }
    alpha?: number
    clipPath?: string
  }>
}

// 预计算的帧数据
interface PrecomputedFrame {
  sprites: Array<{
    imageKey: string
    transform: { a: number; b: number; c: number; d: number; tx: number; ty: number } | null
    layout: { width: number; height: number }
    alpha: number
  }>
}

/**
 * Worker 渲染器类
 */
class WorkerRenderer {
  private canvas: OffscreenCanvas | null = null
  private ctx: OffscreenCanvasRenderingContext2D | null = null
  
  // 视频数据
  private sprites: SpriteData[] = []
  private params: { viewBoxWidth: number; viewBoxHeight: number; fps: number; frames: number } | null = null
  
  // 图片缓存
  private imageCache = new Map<string, ImageBitmap>()
  
  // 帧缓存（使用 ImageData）
  private frameCache = new Map<number, ImageData>()
  private maxCacheSize = 50 // 增加缓存大小
  
  // 预计算的帧数据
  private precomputedFrames: PrecomputedFrame[] = []
  private isPrecomputed = false
  
  // 性能指标
  private metrics = {
    spriteCount: 0,
    cacheHits: 0,
    cacheMisses: 0,
    lastRenderTime: 0
  }
  
  // 图层状态（用于增量更新）
  private layerStates = new Map<string, { visible: boolean; opacity: number }>()
  private lastLayerHash = ''

  /**
   * 初始化渲染器
   */
  init(width: number, height: number) {
    try {
      this.canvas = new OffscreenCanvas(width, height)
      const ctx = this.canvas.getContext('2d', {
        alpha: true,
        desynchronized: true // 启用异步渲染优化
      })
      
      if (!ctx) {
        throw new Error('Failed to get 2D context')
      }
      
      this.ctx = ctx
    } catch (error) {
      console.error('[WorkerRenderer] Init failed:', error)
    }
  }

  /**
   * 设置视频数据
   */
  setVideoItem(
    sprites: SpriteData[],
    params: { viewBoxWidth: number; viewBoxHeight: number; fps: number; frames: number }
  ) {
    this.sprites = sprites
    this.params = params
    
    // 清除旧缓存
    this.frameCache.clear()
    this.precomputedFrames = []
    this.isPrecomputed = false
    this.lastLayerHash = ''
    
    // 调整 Canvas 尺寸
    if (this.canvas && params) {
      const dpr = 1 // Worker 中使用标准分辨率
      this.canvas.width = params.viewBoxWidth * dpr
      this.canvas.height = params.viewBoxHeight * dpr
      this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    
    // 预计算帧数据
    this.precomputeFrames()
  }

  /**
   * 预加载图片资源
   */
  async preloadImages(imageBitmaps: Map<string, ImageBitmap>) {
    this.imageCache = new Map(imageBitmaps)
  }

  /**
   * 预计算所有帧数据（关键优化）
   */
  private precomputeFrames() {
    if (!this.params || this.isPrecomputed) return
    
    const totalFrames = this.params.frames
    
    this.precomputedFrames = new Array(totalFrames)
    
    // 遍历所有帧，预计算精灵数据
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      const frameSprites: PrecomputedFrame['sprites'] = []
      
      // 遍历所有精灵
      for (const sprite of this.sprites) {
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
      
      // 按透明度分组（优化渲染性能）
      frameSprites.sort((a, b) => a.alpha - b.alpha)
      
      this.precomputedFrames[frameIndex] = { sprites: frameSprites }
    }
    
    this.isPrecomputed = true
  }

  /**
   * 设置图层状态（用于增量更新）
   */
  setLayerStates(states: Map<string, { visible: boolean; opacity: number }>) {
    this.layerStates = new Map(states)
    
    // 计算图层状态哈希
    const hash = Array.from(states.entries())
      .map(([key, state]) => `${key}:${state.visible}:${state.opacity}`)
      .join(',')
    
    // 如果图层状态改变，清除帧缓存
    if (hash !== this.lastLayerHash) {
      this.frameCache.clear()
      this.lastLayerHash = hash
    }
  }

  /**
   * 渲染指定帧
   */
  renderFrame(
    frameIndex: number,
    layerStates?: Map<string, { visible: boolean; opacity: number }>
  ): RenderResult | null {
    const startTime = performance.now()
    
    if (!this.canvas || !this.ctx || !this.params) {
      return null
    }
    
    // 更新图层状态
    if (layerStates) {
      this.setLayerStates(layerStates)
    }
    
    // 计算图层哈希
    const layerHash = layerStates ? 
      Array.from(layerStates.entries())
        .map(([key, state]) => `${key}:${state.visible}:${state.opacity}`)
        .join(',') : ''
    
    // 检查帧缓存（关键优化）
    // cacheKey: `${frameIndex}:${layerHash}`（保留用于缓存策略扩展）
    const cachedFrame = this.frameCache.get(frameIndex)
    
    if (cachedFrame && layerHash === this.lastLayerHash) {
      this.metrics.cacheHits++
      
      // 直接返回缓存的帧数据
      return {
        type: 'RENDER_COMPLETE',
        frameIndex,
        imageData: cachedFrame,
        renderTime: performance.now() - startTime,
        metrics: {
          spriteCount: 0,
          cacheHits: this.metrics.cacheHits,
          cacheMisses: this.metrics.cacheMisses
        }
      }
    }
    
    this.metrics.cacheMisses++
    
    // 清空画布
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    
    let spriteCount = 0
    
    // 使用预计算的帧数据
    if (this.isPrecomputed && this.precomputedFrames[frameIndex]) {
      const frameData = this.precomputedFrames[frameIndex]
      
      for (const spriteData of frameData.sprites) {
        // 检查图层可见性
        const layerState = this.layerStates.get(spriteData.imageKey)
        if (layerState && !layerState.visible) continue
        
        const layerOpacity = layerState?.opacity ?? 1
        const finalAlpha = spriteData.alpha * layerOpacity
        
        if (finalAlpha <= 0) continue
        
        // 获取图片
        const img = this.imageCache.get(spriteData.imageKey)
        if (!img) continue
        
        // 渲染精灵
        this.ctx.save()
        this.ctx.globalAlpha = finalAlpha
        
        // 应用变换矩阵
        if (spriteData.transform) {
          this.ctx.setTransform(
            spriteData.transform.a ?? 1,
            spriteData.transform.b ?? 0,
            spriteData.transform.c ?? 0,
            spriteData.transform.d ?? 1,
            spriteData.transform.tx ?? 0,
            spriteData.transform.ty ?? 0
          )
        }
        
        // 绘制图片
        this.ctx.drawImage(
          img,
          0,
          0,
          spriteData.layout.width,
          spriteData.layout.height
        )
        
        this.ctx.restore()
        spriteCount++
      }
    }
    
    // 获取渲染结果
    const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height)
    
    // 缓存当前帧（LRU策略）
    if (this.frameCache.size >= this.maxCacheSize) {
      // 删除最旧的缓存
      const firstKey = this.frameCache.keys().next().value
      if (firstKey !== undefined) {
        this.frameCache.delete(firstKey)
      }
    }
    this.frameCache.set(frameIndex, imageData)
    
    this.metrics.spriteCount = spriteCount
    this.metrics.lastRenderTime = performance.now() - startTime
    
    return {
      type: 'RENDER_COMPLETE',
      frameIndex,
      imageData,
      renderTime: this.metrics.lastRenderTime,
      metrics: {
        spriteCount,
        cacheHits: this.metrics.cacheHits,
        cacheMisses: this.metrics.cacheMisses
      }
    }
  }

  /**
   * 清除缓存
   */
  clearCache() {
    this.frameCache.clear()
    this.imageCache.clear()
    this.metrics = {
      spriteCount: 0,
      cacheHits: 0,
      cacheMisses: 0,
      lastRenderTime: 0
    }
  }

  /**
   * 销毁渲染器
   */
  destroy() {
    this.clearCache()
    this.canvas = null
    this.ctx = null
    this.sprites = []
    this.precomputedFrames = []
  }
}

// 创建渲染器实例
const renderer = new WorkerRenderer()

// 监听主线程消息
self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { type, payload, transferables: _transferables } = e.data
  
  switch (type) {
    case WorkerMessageType.INIT:
      renderer.init(payload.width, payload.height)
      self.postMessage({ type: 'INIT_COMPLETE' })
      break
      
    case WorkerMessageType.SET_VIDEO_ITEM:
      renderer.setVideoItem(payload.sprites, payload.params)
      self.postMessage({ type: 'SET_VIDEO_ITEM_COMPLETE' })
      break
      
    case WorkerMessageType.PRELOAD_IMAGES:
      await renderer.preloadImages(new Map(payload.images))
      self.postMessage({ type: 'PRELOAD_IMAGES_COMPLETE' })
      break
      
    case WorkerMessageType.RENDER_FRAME:
      const result = renderer.renderFrame(
        payload.frameIndex,
        payload.layerStates ? new Map(payload.layerStates) : undefined
      )
      
      if (result) {
        // 使用 Transferable 传输 ImageData，避免复制
        ;(self as any).postMessage(result, [result.imageData.data.buffer])
      }
      break
      
    case WorkerMessageType.CLEAR_CACHE:
      renderer.clearCache()
      self.postMessage({ type: 'CLEAR_CACHE_COMPLETE' })
      break
      
    case WorkerMessageType.DESTROY:
      renderer.destroy()
      self.postMessage({ type: 'DESTROY_COMPLETE' })
      break
  }
}

// 导出类型供主线程使用
export type { SpriteData, PrecomputedFrame }
