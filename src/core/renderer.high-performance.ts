/**
 * 高性能渲染器 v2 - 修复卡顿和残缺问题
 * 
 * 核心修复：
 * 1. 移除全量预渲染（FPS杀手）→ 改为按需LRU帧缓存
 * 2. 复用离屏Canvas（matte遮罩）→ Canvas池化
 * 3. 二分查找关键帧 → O(logN) 替代 O(n) 线性扫描
 * 4. 修复图片残缺 → 正确的layout/transform渲染逻辑
 * 5. ImageBitmap加速 → 预转换图片为ImageBitmap
 */

import type { VideoItem, SlotConfig, Layer, FrameData } from '@/types'
import type { RenderOptions } from './renderer'
import { applyLayerFrameEdits, getFrameAlpha, getFrameTransform, getLayerBaseFrame, getOriginalLayerIndex } from './layer-transform'
import { RendererImageCache } from './renderer-images'
import { getLayerSourceFrame, getLayerTimeOffset } from './layer-time'

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

/** 帧缓存条目 */
interface FrameCacheItem {
  canvas: HTMLCanvasElement
  timestamp: number
}

/** 预计算的精灵渲染数据 */
interface PrecomputedSprite {
  spriteIndex: number
  imageKey: string
  matteKey?: string | null
  frame: FrameData
  finalAlpha: number
  blendMode?: string
  compositeOperation?: GlobalCompositeOperation
  fastDrawable: boolean
}

/** 排好序的关键帧索引（用于二分查找） */
interface SortedKeyFrames {
  indices: number[]         // 排好序的关键帧索引
  frames: FrameData[]       // 对应的帧数据
}

interface LayerRenderState {
  visible: boolean
  opacity: number
  layer: Layer
}

export class HighPerformanceRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D

  // 视频数据
  private videoItem: VideoItem | null = null
  private params: { viewBoxWidth: number; viewBoxHeight: number; fps: number; frames: number } | null = null

  // 帧缓存（按需，LRU淘汰）
  private frameCache: Map<number, FrameCacheItem> = new Map()
  private maxCacheSize = 50
  private cacheEnabled = true
  private lastRenderSignature = ''

  // 插槽图片缓存
  private liveImages = new RendererImageCache(() => this.clearFrameCache())
  private videoGeneration = 0

  // 预计算的关键帧索引（二分查找加速）
  private spriteKeyFrameMap: Map<number, SortedKeyFrames> = new Map()

  // 预计算的帧精灵数据
  private precomputedFrames: Map<number, PrecomputedSprite[]> = new Map()
  private precomputedLayerFrames: Map<number, Map<number, PrecomputedSprite>> = new Map()
  private referencedMatteKeys: Set<string> = new Set()

  // 图层状态缓存，播放时避免每帧重建 Map
  private layerStates: Array<LayerRenderState | undefined> = []
  private layerStatesSource: Layer[] | null = null

  // 图片缓存
  private imageCache: Map<string, HTMLImageElement> = new Map()
  private imageBitmapCache: Map<string, ImageBitmap> = new Map()

  // 离屏Canvas池（复用，避免每帧createElement）
  private offscreenCanvasPool: HTMLCanvasElement[] = []

  // 性能指标
  private metrics: PerformanceMetrics = {
    fps: 0, lastRenderTime: 0, cacheSize: 0,
    workerEnabled: false, spriteCount: 0,
    cacheHits: 0, cacheMisses: 0
  }
  private renderCount = 0
  private lastFpsUpdate = 0

  constructor(canvas: HTMLCanvasElement, _enableWorker: boolean = false) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', { alpha: true, desynchronized: true })!
  }

  /**
   * 获取或创建池化的离屏Canvas
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
   * 归还离屏Canvas到池
   */
  private returnOffscreenCanvas(c: HTMLCanvasElement): void {
    if (this.offscreenCanvasPool.length < 4) {
      const ctx = c.getContext('2d')
      if (ctx) {
        this.resetContextState(ctx)
        ctx.clearRect(0, 0, c.width, c.height)
      }
      this.offscreenCanvasPool.push(c)
    }
  }

  /**
   * 设置视频项
   */
  async setVideoItem(videoItem: VideoItem | null, _options?: { waitForImages?: boolean }): Promise<void> {
    const generation = ++this.videoGeneration
    this.videoItem = videoItem
    this.params = null
    this.liveImages.clear()
    this.frameCache.clear()
    this.lastRenderSignature = ''
    this.layerStates = []
    this.layerStatesSource = null
    this.precomputedLayerFrames.clear()
    this.referencedMatteKeys.clear()
    this.renderCount = 0
    this.lastFpsUpdate = 0
    this.metrics = {
      fps: 0, lastRenderTime: 0, cacheSize: 0,
      workerEnabled: false, spriteCount: 0,
      cacheHits: 0, cacheMisses: 0
    }
    this.precomputedFrames.clear()
    this.imageCache.clear()
    this.spriteKeyFrameMap.clear()

    // 清理 ImageBitmap 缓存
    for (const bmp of this.imageBitmapCache.values()) bmp.close()
    this.imageBitmapCache.clear()

    if (!videoItem || !videoItem.movie.params) return

    this.params = videoItem.movie.params
    this.canvas.width = this.params.viewBoxWidth
    this.canvas.height = this.params.viewBoxHeight

    // 加载图片
    if (videoItem.images) {
      const entries = Object.entries(videoItem.images)
      await Promise.all(entries.map(([key, img]) =>
        new Promise<void>((resolve) => {
          if (!img) { resolve(); return }
          const done = () => {
            if (generation === this.videoGeneration) this.imageCache.set(key, img)
            resolve()
          }
          if (img.complete && img.width > 0) { done(); return }
          img.onload = done
          img.onerror = () => { console.warn('[Renderer] Image failed:', key); resolve() }
          if (img.complete) done()
        })
      ))
      if (generation !== this.videoGeneration) return

      // 预转换 ImageBitmap（GPU加速drawImage）
      if (typeof createImageBitmap === 'function') {
        const bitmapPromises = entries.map(async ([key, img]) => {
          if (img && img.complete && img.width > 0) {
            try {
              const bmp = await createImageBitmap(img)
              if (generation === this.videoGeneration) this.imageBitmapCache.set(key, bmp)
              else bmp.close()
            } catch { /* ignore */ }
          }
        })
        // 不阻塞，后台转换
        Promise.all(bitmapPromises)
      }
    }

    if (generation !== this.videoGeneration) return

    // 预构建关键帧索引（二分查找加速）
    this.buildKeyFrameIndex()

    // 预计算帧精灵数据
    this.precomputeAllFrames()

    // 初始化仅准备资源，调用者用最新帧和编辑快照发起绘制。
  }

  /**
   * 构建关键帧二分查找索引
   */
  private buildKeyFrameIndex(): void {
    if (!this.videoItem) return
    const sprites = this.videoItem.movie.sprites || []
    this.spriteKeyFrameMap.clear()

    for (let spriteIndex = 0; spriteIndex < sprites.length; spriteIndex++) {
      const { frames } = sprites[spriteIndex]
      if (!frames || frames.length === 0) continue

      const indices: number[] = []
      const frameDataList: FrameData[] = []

      for (let i = 0; i < frames.length; i++) {
        if (this.isValidFrameData(frames[i])) {
          indices.push(i)
          frameDataList.push(frames[i])
        }
      }

      if (indices.length > 0) {
        this.spriteKeyFrameMap.set(spriteIndex, { indices, frames: frameDataList })
      }
    }
  }

  /**
   * 二分查找前一个关键帧索引
   */
  private binarySearchPrev(sorted: number[], frameIndex: number): number {
    let lo = 0, hi = sorted.length - 1, result = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid] <= frameIndex) { result = mid; lo = mid + 1 }
      else { hi = mid - 1 }
    }
    return result
  }

  /**
   * 二分查找后一个关键帧索引
   */
  private binarySearchNext(sorted: number[], frameIndex: number): number {
    let lo = 0, hi = sorted.length - 1, result = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid] > frameIndex) { result = mid; hi = mid - 1 }
      else { lo = mid + 1 }
    }
    return result
  }

  /**
   * 使用二分查找获取插值帧数据
   */
  getInterpolatedFrameDataFast(spriteIndex: number, frameIndex: number): FrameData | null {
    const skf = this.spriteKeyFrameMap.get(spriteIndex)
    if (!skf) return null

    const { indices, frames } = skf

    // 精确匹配
    const exactIdx = this.binarySearchPrev(indices, frameIndex)
    if (exactIdx >= 0 && indices[exactIdx] === frameIndex) {
      return frames[exactIdx]
    }

    // 插值
    const prevIdx = exactIdx
    const nextIdx = this.binarySearchNext(indices, frameIndex)

    if (prevIdx < 0) {
      return nextIdx >= 0 ? frames[nextIdx] : null
    }
    if (nextIdx < 0) {
      // 最后一帧之后，保持
      return frames[prevIdx]
    }

    const prevFrame = indices[prevIdx]
    const nextFrame = indices[nextIdx]
    const totalDist = nextFrame - prevFrame
    const ratio = totalDist > 0 ? (frameIndex - prevFrame) / totalDist : 0

    return this.interpolateFrameData(frames[prevIdx], frames[nextIdx], ratio)
  }

  /**
   * 预计算所有帧的精灵列表
   */
  private precomputeAllFrames(): void {
    if (!this.videoItem) return
    const sprites = this.videoItem.movie.sprites || []
    const referencedMatteKeys = new Set(sprites.map(sprite => sprite.matteKey).filter((key): key is string => !!key))
    this.precomputedFrames.clear()
    this.precomputedLayerFrames.clear()
    this.referencedMatteKeys = referencedMatteKeys

    for (let spriteIndex = 0; spriteIndex < sprites.length; spriteIndex++) {
      const sprite = sprites[spriteIndex]
      const { imageKey, frames } = sprite
      if (!frames || frames.length === 0) continue
      if (!this.imageCache.has(imageKey) && !this.imageBitmapCache.has(imageKey) && !frames.some(frame => frame.shapes?.length)) continue
      const layerFrames = new Map<number, PrecomputedSprite>()
      this.precomputedLayerFrames.set(spriteIndex, layerFrames)

      for (let fi = 0; fi < frames.length; fi++) {
        const frameData = frames[fi]
        if (!frameData) continue

        const alpha = frameData.alpha ?? 1
        // 全透明遮罩仍参与合成；把它省略会让被遮罩内容意外全部出现。
        if (alpha <= 0 && !referencedMatteKeys.has(imageKey)) continue

        const layout = frameData.layout
        const transform = frameData.transform
        const hasValidLayout = layout && (layout.width ?? 0) > 0 && (layout.height ?? 0) > 0
        const hasValidTransform = transform && typeof transform.tx === 'number'
        if (!hasValidLayout && !hasValidTransform) continue

        if (!this.precomputedFrames.has(fi)) {
          this.precomputedFrames.set(fi, [])
        }
        const compositeOperation = frameData.blendMode
          ? this.normalizeBlendMode(frameData.blendMode) ?? undefined
          : undefined
        const precomputedSprite: PrecomputedSprite = {
          spriteIndex,
          imageKey,
          matteKey: sprite.matteKey,
          frame: frameData,
          finalAlpha: alpha,
          blendMode: frameData.blendMode,
          compositeOperation,
          fastDrawable: !frameData.clipPath &&
            !(frameData.shapes && frameData.shapes.length > 0) &&
            (!compositeOperation || compositeOperation === 'source-over')
        }

        this.precomputedFrames.get(fi)!.push(precomputedSprite)
        layerFrames.set(fi, precomputedSprite)
      }
    }
  }

  /**
   * 验证帧数据有效性
   */
  private isValidFrameData(frame: any): frame is FrameData {
    return !!(frame && (
      (frame.layout && typeof frame.layout.width === 'number' && frame.layout.width > 0 &&
       typeof frame.layout.height === 'number' && frame.layout.height > 0) ||
      (frame.transform && typeof frame.transform.tx === 'number')
    ))
  }

  /**
   * 插值计算帧数据
   */
  private interpolateFrameData(prev: FrameData, next: FrameData, ratio: number): FrameData {
    const lerp = (a: number | undefined, b: number | undefined, d: number): number =>
      (a ?? d) + ((b ?? d) - (a ?? d)) * ratio

    const layout = prev.layout && next.layout ? {
      x: lerp(prev.layout.x, next.layout.x, 0),
      y: lerp(prev.layout.y, next.layout.y, 0),
      width: lerp(prev.layout.width, next.layout.width, 0),
      height: lerp(prev.layout.height, next.layout.height, 0)
    } : (prev.layout || next.layout || null)

    const transform = prev.transform && next.transform ? {
      a: lerp(prev.transform.a, next.transform.a, 1),
      b: lerp(prev.transform.b, next.transform.b, 0),
      c: lerp(prev.transform.c, next.transform.c, 0),
      d: lerp(prev.transform.d, next.transform.d, 1),
      tx: lerp(prev.transform.tx, next.transform.tx, 0),
      ty: lerp(prev.transform.ty, next.transform.ty, 0)
    } : (prev.transform || next.transform)

    return {
      ...prev,
      alpha: lerp(prev.alpha, next.alpha, 1),
      layout,
      transform,
      clipPath: prev.clipPath ?? next.clipPath ?? null,
      shapes: prev.shapes ?? next.shapes,
      blendMode: prev.blendMode ?? next.blendMode
    }
  }

  /**
   * 渲染指定帧 - 高性能版本
   */
  renderFrame(frameIndex: number, options: RenderOptions = {}): void {
    const startTime = performance.now()
    const {
      applySlots = true,
      slotConfigs = {},
      layers = [],
      useFrameCache = true
    } = options

    if (!this.videoItem || !this.params || options.shouldRender?.() === false) return
    const shouldUseCache = this.cacheEnabled && useFrameCache
    if (shouldUseCache) {
      const renderSignature = this.createRenderSignature(slotConfigs, layers, applySlots)
      if (renderSignature !== this.lastRenderSignature) {
        this.frameCache.clear()
        this.metrics.cacheSize = 0
        this.lastRenderSignature = renderSignature
      }
    }

    // 检查帧缓存
    if (shouldUseCache) {
      const cached = this.frameCache.get(frameIndex)
      if (cached) {
        this.resetContextState(this.ctx)
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
        this.ctx.drawImage(cached.canvas, 0, 0)
        cached.timestamp = Date.now()
        this.metrics.cacheHits++
        this.recordRender(startTime)
        this.metrics.cacheSize = this.frameCache.size
        return
      }
      this.metrics.cacheMisses++
    }

    // 同步调用沿用已解码图片；编辑预览通过异步入口等待最新替换。
    void this.liveImages.prepare(slotConfigs, applySlots, options.imageResources).catch(() => undefined)

    const layerStates = this.getLayerStates(layers)

    // 清空画布
    this.resetContextState(this.ctx)
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)

    // 获取预计算的帧精灵数据
    const shifted = layers.some(layer => getLayerTimeOffset(layer) !== 0)
    const sourceSprites = shifted
      ? (this.videoItem.movie.sprites || []).flatMap((_, index) => {
        const layer = layerStates[index]?.layer
        if (!layer) return []
        const sprite = this.precomputedLayerFrames.get(index)?.get(getLayerSourceFrame(layer, frameIndex))
        return sprite ? [sprite] : []
      })
      : this.precomputedFrames.get(frameIndex) || []
    const frameSprites = options.layers === undefined ? sourceSprites : sourceSprites.filter(sprite => {
      const layer = layerStates[sprite.spriteIndex]?.layer
      if (!layer) return false
      const sourceFrame = getLayerSourceFrame(layer, frameIndex)
      return sourceFrame >= 0 && sourceFrame >= layer.clip.startFrame && sourceFrame < layer.clip.startFrame + layer.clip.duration
    })

    // 渲染所有精灵
    this.renderSprites(frameIndex, frameSprites, layerStates)

    for (const layer of layers) {
      if (!layer.isNew || !layer.visible || !layer.imageKey) continue
      const frame = getLayerBaseFrame(layer, frameIndex, this.videoItem, options.imageResources)
      if (!frame || (frame.alpha ?? 1) <= 0) continue
      const img = this.getImage(layer.imageKey)
      if (!img) continue
      const edited = applyLayerFrameEdits(frame, layer, frameIndex, this.getDrawSize(img, frame.layout))
      this.renderSpriteToCtx(this.ctx, img, edited, getFrameAlpha(edited))
      this.metrics.spriteCount++
    }

    // 按需缓存帧
    if (shouldUseCache) {
      this.cacheFrame(frameIndex)
    }

    this.recordRender(startTime)
    this.metrics.cacheSize = this.frameCache.size
  }

  private getLayerStates(layers: Layer[]): Array<LayerRenderState | undefined> {
    if (this.layerStatesSource === layers) {
      return this.layerStates
    }

    const nextStates: Array<LayerRenderState | undefined> = []
    for (const layer of layers) {
      const index = getOriginalLayerIndex(layer)
      if (index === null) continue
      nextStates[index] = { visible: layer.visible !== false, opacity: layer.opacity ?? 1, layer }
    }
    this.layerStates = nextStates
    this.layerStatesSource = layers
    return this.layerStates
  }

  /**
   * 渲染精灵列表（处理matte遮罩）
   */
  private renderSprites(
    frameIndex: number,
    frameSprites: PrecomputedSprite[],
    layerStates: Array<LayerRenderState | undefined>
  ): void {
    let spriteCount = 0
    // 纯遮罩身份来自全局引用，不能因为关联内容本帧未出现就把遮罩画到画布。
    const matteLayerKeys = this.referencedMatteKeys

    if (matteLayerKeys.size === 0) {
      for (const sprite of frameSprites) {
        if (this.renderSingleSprite(sprite, layerStates, frameIndex)) spriteCount++
      }

      this.metrics.spriteCount = spriteCount
      this.resetContextState(this.ctx)
      return
    }

    const spritesByImageKey = new Map<string, PrecomputedSprite>()
    for (const sprite of frameSprites) {
      if (!spritesByImageKey.has(sprite.imageKey)) spritesByImageKey.set(sprite.imageKey, sprite)
    }

    for (const sprite of frameSprites) {
      // 跳过纯遮罩图层
      if (matteLayerKeys.has(sprite.imageKey) && !sprite.matteKey) continue

      // 被遮罩图层
      if (sprite.matteKey) {
        const matteSprite = spritesByImageKey.get(sprite.matteKey)
        if (matteSprite) {
          if (this.renderWithMatte(sprite, matteSprite, layerStates, frameIndex)) spriteCount++
        }
      } else {
        if (this.renderSingleSprite(sprite, layerStates, frameIndex)) spriteCount++
      }
    }

    this.metrics.spriteCount = spriteCount
    this.resetContextState(this.ctx)
  }

  /**
   * 渲染带matte遮罩的精灵（复用离屏Canvas）
   */
  private renderWithMatte(
    sprite: PrecomputedSprite,
    matteSprite: PrecomputedSprite,
    layerStates: Array<LayerRenderState | undefined>,
    frameIndex: number
  ): boolean {
    const layerState = layerStates[sprite.spriteIndex]
    if (layerState?.visible === false) return false

    // 获取图片
    const img = this.getImage(layerState?.layer.imageKey || sprite.imageKey, sprite.imageKey) || (sprite.frame.shapes?.length ? this.canvas : null)
    if (!img) return false

    const editedSprite = {
      ...sprite,
      frame: layerState ? applyLayerFrameEdits(sprite.frame, layerState.layer, frameIndex, this.getDrawSize(img, sprite.frame.layout)) : sprite.frame
    }
    const finalAlpha = getFrameAlpha(editedSprite.frame)
    if (finalAlpha <= 0) return false

    const matteState = layerStates[matteSprite.spriteIndex]
    const matteImg = this.getImage(matteState?.layer.imageKey || matteSprite.imageKey, matteSprite.imageKey) || (matteSprite.frame.shapes?.length ? this.canvas : null)
    // 缺失或时间范围外的遮罩是透明结果，不能退回未遮罩的内容。
    if (!matteImg) return false

    // 使用池化的离屏Canvas
    const offscreen = this.getOffscreenCanvas()
    const offCtx = offscreen.getContext('2d')!
    this.resetContextState(offCtx)
    offCtx.clearRect(0, 0, offscreen.width, offscreen.height)

    // 渲染被遮罩层
    offCtx.save()
    this.renderSpriteToCtx(offCtx, img, editedSprite.frame, finalAlpha)
    offCtx.restore()

    // 应用遮罩
    offCtx.save()
    offCtx.globalCompositeOperation = 'destination-in'
    const matteFrame = matteState ? applyLayerFrameEdits(matteSprite.frame, matteState.layer, frameIndex, this.getDrawSize(matteImg, matteSprite.frame.layout)) : matteSprite.frame
    const matteAlpha = getFrameAlpha(matteFrame)
    this.renderSpriteToCtx(offCtx, matteImg, matteFrame, matteAlpha)
    offCtx.restore()

    // 绘制到主画布
    this.resetContextState(this.ctx)
    this.ctx.drawImage(offscreen, 0, 0)
    this.returnOffscreenCanvas(offscreen)
    return true
  }

  /**
   * 渲染单个精灵（无遮罩）
   */
  private renderSingleSprite(
    sprite: PrecomputedSprite,
    layerStates: Array<LayerRenderState | undefined>,
    frameIndex: number
  ): boolean {
    const layerState = layerStates[sprite.spriteIndex]
    if (layerState?.visible === false) return false

    const img = this.getImage(layerState?.layer.imageKey || sprite.imageKey, sprite.imageKey) || (sprite.frame.shapes?.length ? this.canvas : null)
    if (!img) return false

    const editedFrame = layerState ? applyLayerFrameEdits(sprite.frame, layerState.layer, frameIndex, this.getDrawSize(img, sprite.frame.layout)) : sprite.frame
    const finalAlpha = getFrameAlpha(editedFrame)
    if (finalAlpha <= 0) return false
    this.renderSprite(editedFrame === sprite.frame ? sprite : { ...sprite, frame: editedFrame }, this.ctx, img, finalAlpha)
    return true
  }

  private renderSprite(
    sprite: PrecomputedSprite,
    ctx: CanvasRenderingContext2D,
    img: CanvasImageSource,
    alpha: number
  ): void {
    if (sprite.fastDrawable) {
      this.renderSpriteFast(ctx, img, sprite.frame, alpha)
      return
    }

    if (sprite.compositeOperation) {
      ctx.globalCompositeOperation = sprite.compositeOperation
    }

    this.renderSpriteToCtx(ctx, img, sprite.frame, alpha)
    if (sprite.compositeOperation && sprite.compositeOperation !== 'source-over') {
      ctx.globalCompositeOperation = 'source-over'
    }
  }

  private renderSpriteFast(
    ctx: CanvasRenderingContext2D,
    img: CanvasImageSource,
    frame: FrameData,
    alpha: number
  ): void {
    const { layout } = frame
    const transform = getFrameTransform(frame)

    ctx.globalAlpha = alpha
    ctx.globalCompositeOperation = 'source-over'

    if (transform) {
      ctx.setTransform(
        transform.a ?? 1,
        transform.b ?? 0,
        transform.c ?? 0,
        transform.d ?? 1,
        transform.tx ?? layout?.x ?? 0,
        transform.ty ?? layout?.y ?? 0
      )
    } else {
      ctx.setTransform(1, 0, 0, 1, layout?.x ?? 0, layout?.y ?? 0)
    }

    const { width, height } = this.getDrawSize(img, layout)
    if (width > 0 && height > 0) {
      ctx.drawImage(img, 0, 0, width, height)
    }
  }

  private getDrawSize(
    img: CanvasImageSource,
    layout: FrameData['layout']
  ): { width: number; height: number } {
    const source = img as HTMLImageElement & { width?: number; height?: number }
    return {
      width: layout?.width || source.naturalWidth || source.width || 0,
      height: layout?.height || source.naturalHeight || source.height || 0
    }
  }

  private resetContextState(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  /**
   * 获取图片（优先ImageBitmap，其次HTMLImageElement，最后插槽缓存）
   */
  private getImage(imageKey: string, fallbackKey?: string): CanvasImageSource | null {
    const slotImg = this.liveImages.getSlot(imageKey)
    if (slotImg && slotImg.complete && slotImg.width > 0) return slotImg

    const resource = this.liveImages.getResource(imageKey)
    if (resource?.complete && resource.width > 0) return resource

    const bmp = this.imageBitmapCache.get(imageKey)
    if (bmp) return bmp

    const img = this.videoItem?.images?.[imageKey] || this.imageCache.get(imageKey)
    if (img && img.complete && img.width > 0) return img

    if (fallbackKey && fallbackKey !== imageKey) return this.getImage(fallbackKey)
    return null
  }

  /**
   * 渲染精灵到指定Context
   * 
   * 关键修复：正确处理layout与transform的关系
   * SVGA规范：layout定义位置和尺寸，transform是在layout基础上的额外变换
   * 渲染顺序：先设置transform（包含layout的位置tx/ty），再drawImage
   */
  private renderSpriteToCtx(
    ctx: CanvasRenderingContext2D,
    img: CanvasImageSource,
    frame: FrameData,
    alpha: number
  ): void {
    const { layout, clipPath, shapes } = frame
    const transform = getFrameTransform(frame)

    ctx.save()
    ctx.globalAlpha = alpha

    // 设置变换矩阵
    if (transform) {
      ctx.setTransform(
        transform.a ?? 1,
        transform.b ?? 0,
        transform.c ?? 0,
        transform.d ?? 1,
        transform.tx ?? layout?.x ?? 0,
        transform.ty ?? layout?.y ?? 0
      )
    } else {
      ctx.setTransform(1, 0, 0, 1, layout?.x ?? 0, layout?.y ?? 0)
    }

    // 应用裁剪路径
    if (clipPath) {
      try {
        const path = new Path2D(clipPath)
        ctx.clip(path)
      } catch { /* ignore */ }
    }

    // 绘制
    if (shapes && shapes.length > 0) {
      this.renderShapes(ctx, shapes)
    } else {
      // 关键修复：正确计算drawImage的绘制尺寸
      // 当有layout时，使用layout的width/height作为绘制尺寸
      // 当没有layout时，使用图片原始尺寸
      const { width, height } = this.getDrawSize(img, layout)
      if (width > 0 && height > 0) {
        ctx.drawImage(img, 0, 0, width, height)
      }
    }

    ctx.restore()
  }

  /**
   * 渲染矢量图形
   */
  private renderShapes(ctx: CanvasRenderingContext2D, shapes: any[]): void {
    for (const shape of shapes) {
      ctx.save()

      if (shape.transform) {
        const t = shape.transform
        ctx.transform(t.a ?? 1, t.b ?? 0, t.c ?? 0, t.d ?? 1, t.tx ?? 0, t.ty ?? 0)
      }

      if (shape.styles) {
        const s = shape.styles
        if (s.fill) ctx.fillStyle = `rgba(${s.fill.r},${s.fill.g},${s.fill.b},${s.fill.a})`
        if (s.stroke) {
          ctx.strokeStyle = `rgba(${s.stroke.r},${s.stroke.g},${s.stroke.b},${s.stroke.a})`
          ctx.lineWidth = s.strokeWidth ?? 1
          if (s.lineCap) {
            const m: Record<string, CanvasLineCap> = { 'LineCap_BUTT': 'butt', 'LineCap_ROUND': 'round', 'LineCap_SQUARE': 'square' }
            ctx.lineCap = m[s.lineCap] || 'butt'
          }
          if (s.lineJoin) {
            const m: Record<string, CanvasLineJoin> = { 'LineJoin_MITER': 'miter', 'LineJoin_ROUND': 'round', 'LineJoin_BEVEL': 'bevel' }
            ctx.lineJoin = m[s.lineJoin] || 'miter'
            if (s.miterLimit !== undefined) ctx.miterLimit = s.miterLimit
          }
          if (s.lineDashI !== undefined || s.lineDashII !== undefined) {
            const d: number[] = []
            if (s.lineDashI !== undefined) d.push(s.lineDashI)
            if (s.lineDashII !== undefined) d.push(s.lineDashII)
            if (s.lineDashIII !== undefined) d.push(s.lineDashIII)
            if (d.length > 0) ctx.setLineDash(d)
          }
        }
      }

      switch (shape.type) {
        case 'RECT':
          if (shape.rect) {
            const { x, y, width, height, cornerRadius } = shape.rect
            ctx.beginPath()
            if (cornerRadius && cornerRadius > 0) {
              ctx.roundRect(x, y, width, height, Math.min(cornerRadius, Math.min(Math.abs(width), Math.abs(height)) / 2))
            } else {
              ctx.rect(x, y, width, height)
            }
            if (shape.styles?.fill) ctx.fill()
            if (shape.styles?.stroke) ctx.stroke()
          }
          break
        case 'ELLIPSE':
          if (shape.ellipse) {
            ctx.beginPath()
            ctx.ellipse(shape.ellipse.x, shape.ellipse.y, shape.ellipse.radiusX, shape.ellipse.radiusY, 0, 0, 2 * Math.PI)
            if (shape.styles?.fill) ctx.fill()
            if (shape.styles?.stroke) ctx.stroke()
          }
          break
        case 'SHAPE':
          if (shape.shape?.d) {
            try {
              const path = new Path2D(shape.shape.d)
              if (shape.styles?.fill) ctx.fill(path)
              if (shape.styles?.stroke) ctx.stroke(path)
            } catch { /* ignore */ }
          }
          break
      }

      ctx.restore()
    }
  }

  /**
   * 标准化混合模式
   */
  private normalizeBlendMode(blendMode: string): GlobalCompositeOperation | null {
    const map: Record<string, GlobalCompositeOperation> = {
      'normal': 'source-over', 'multiply': 'multiply', 'screen': 'screen',
      'overlay': 'overlay', 'darken': 'darken', 'lighten': 'lighten',
      'color-dodge': 'color-dodge', 'color-burn': 'color-burn',
      'hard-light': 'hard-light', 'soft-light': 'soft-light',
      'difference': 'difference', 'exclusion': 'exclusion'
    }
    return map[blendMode.toLowerCase()] || null
  }

  private recordRender(startTime: number): void {
    const now = performance.now()
    this.metrics.lastRenderTime = now - startTime
    this.renderCount++

    if (this.lastFpsUpdate === 0) {
      this.lastFpsUpdate = now
      return
    }

    const elapsed = now - this.lastFpsUpdate
    if (elapsed >= 1000) {
      this.metrics.fps = Math.round(this.renderCount * 1000 / elapsed)
      this.renderCount = 0
      this.lastFpsUpdate = now
    }
  }

  /**
   * 帧缓存（使用ImageData，比Canvas缓存更轻量）
   */
  private cacheFrame(frameIndex: number): void {
    if (this.frameCache.has(frameIndex)) return

    // LRU淘汰
    if (this.frameCache.size >= this.maxCacheSize) {
      let oldestKey = -1
      let oldestTime = Infinity
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

  // ============ 接口兼容方法 ============

  private createRenderSignature(
    slotConfigs: Record<string, SlotConfig>,
    layers: Layer[],
    applySlots: boolean
  ): string {
    const layerState = layers
      .map(layer => [
        layer.id,
        layer.imageKey ?? '',
        layer.visible === false ? 0 : 1,
        layer.opacity ?? 1,
        layer.blendMode ?? '',
        layer.editableIndex ?? '',
        layer.clip.startFrame,
        layer.clip.duration,
        getLayerTimeOffset(layer),
        JSON.stringify(layer.canvasTransform || null),
        JSON.stringify(layer.animationTracks || null),
        JSON.stringify(layer.tracks)
      ].join(':'))
      .join('|')

    if (!applySlots) return layerState

    const slotState = Object.entries(slotConfigs)
      .map(([key, slot]) => [
        key,
        slot.type,
        slot.value ?? '',
        slot.imageConfig?.url ?? '',
        slot.imageConfig?.scaleMode ?? '',
        slot.textConfig?.text ?? ''
      ].join(':'))
      .sort()
      .join('|')

    return `${layerState}||${slotState}`
  }

  precomputeFrameData(): void { this.precomputeAllFrames() }

  prepareImages(options: RenderOptions): Promise<void> {
    return this.liveImages.prepare(options.slotConfigs || {}, options.applySlots !== false, options.imageResources)
  }

  async renderFrameAsync(frameIndex: number, options: RenderOptions = {}): Promise<void> {
    const generation = this.videoGeneration
    await this.liveImages.prepare(options.slotConfigs || {}, options.applySlots !== false, options.imageResources)
    if (generation !== this.videoGeneration || options.shouldRender?.() === false) return
    this.renderFrame(frameIndex, options)
  }

  clearFrameCache(): void {
    this.frameCache.clear()
    this.metrics.cacheSize = 0
    this.metrics.cacheHits = 0
    this.metrics.cacheMisses = 0
  }

  setFrameCacheEnabled(enabled: boolean): void {
    this.cacheEnabled = enabled
    if (!enabled) this.clearFrameCache()
  }

  setMaxCacheSize(size: number): void {
    this.maxCacheSize = size
    while (this.frameCache.size > this.maxCacheSize) {
      let oldestKey = -1, oldestTime = Infinity
      for (const [key, item] of this.frameCache) {
        if (item.timestamp < oldestTime) { oldestTime = item.timestamp; oldestKey = key }
      }
      if (oldestKey >= 0) this.frameCache.delete(oldestKey)
    }
  }

  resize(width: number, height: number): void {
    this.canvas.width = width
    this.canvas.height = height
    this.clearFrameCache()
  }

  clear(): void { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height) }

  clearAllCaches(): void {
    this.clearFrameCache()
    this.liveImages.clear()
    this.precomputedFrames.clear()
    this.precomputedLayerFrames.clear()
    this.referencedMatteKeys.clear()
    this.imageCache.clear()
    this.spriteKeyFrameMap.clear()
    this.layerStates = []
    this.layerStatesSource = null
    for (const bmp of this.imageBitmapCache.values()) bmp.close()
    this.imageBitmapCache.clear()
  }

  hasVideoData(): boolean { return this.videoItem !== null && this.params !== null }

  getPerformanceMetrics(): PerformanceMetrics { return { ...this.metrics } }

  destroy(): void {
    this.videoGeneration++
    this.videoItem = null
    this.params = null
    this.clearAllCaches()
    for (const c of this.offscreenCanvasPool) {
      c.getContext('2d')?.clearRect(0, 0, c.width, c.height)
    }
    this.offscreenCanvasPool = []
  }

  debugCanvasContent(): { nonZeroPixels: number; totalPixels: number } {
    const d = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height)
    let n = 0
    for (let i = 3; i < d.data.length; i += 4) { if (d.data[i] > 0) n++ }
    return { nonZeroPixels: n, totalPixels: this.canvas.width * this.canvas.height }
  }

  async exportFrame(format: string = 'image/png', quality: number = 1): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((b) => b ? resolve(b) : reject(new Error('导出失败')), format, quality)
    })
  }

  getDataURL(format: string = 'image/png', quality: number = 1): string {
    return this.canvas.toDataURL(format, quality)
  }
}
