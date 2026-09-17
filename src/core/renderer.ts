/**
 * Canvas 输出适配器。
 * 图片序列与编辑预览共用同一逐帧绘制实现，避免独立路径漏掉变换、遮罩或替换图。
 */

import type { VideoItem, SlotConfig, Layer } from '@/types'
import { HighPerformanceRenderer } from './renderer.high-performance'

export interface RenderOptions {
  clearCanvas?: boolean
  applySlots?: boolean
  slotConfigs?: Record<string, SlotConfig>
  layers?: Layer[]
  imageResources?: Map<string, { data: Uint8Array; blobUrl?: string; width: number; height: number }>
  useFrameCache?: boolean
  /** 异步图片解码后由调用者检查请求是否仍是最新状态。 */
  shouldRender?: () => boolean
}

export class CanvasRenderer {
  private renderer: HighPerformanceRenderer
  private ready: Promise<void> = Promise.resolve()
  private videoItem: VideoItem | null = null
  private preparedSource: VideoItem | null | undefined

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new HighPerformanceRenderer(canvas)
  }

  setVideoItem(videoItem: VideoItem | null): void {
    this.videoItem = videoItem
    this.preparedSource = undefined
  }

  private ensureReady(): Promise<void> {
    if (this.preparedSource !== this.videoItem) {
      this.preparedSource = this.videoItem
      this.ready = this.renderer.setVideoItem(this.videoItem, { waitForImages: true })
    }
    return this.ready
  }

  precomputeFrameData(): void {
    void this.ensureReady().then(() => this.renderer.precomputeFrameData())
  }

  async preloadSlotImages(slotConfigs: Record<string, SlotConfig>): Promise<void> {
    await this.ensureReady()
    await this.renderer.prepareImages({ slotConfigs, applySlots: true })
  }

  async renderFrameAsync(frameIndex: number, options: RenderOptions = {}): Promise<void> {
    await this.ensureReady()
    if (options.shouldRender?.() === false) return
    await this.renderer.renderFrameAsync(frameIndex, options)
  }

  renderFrame(frameIndex: number, options: RenderOptions = {}): void {
    void this.renderFrameAsync(frameIndex, options).catch(error => {
      console.error('[Renderer] 帧绘制失败:', error)
    })
  }

  clear(): void { this.renderer.clear() }
  resize(width: number, height: number): void { this.renderer.resize(width, height) }
  getFrameImageData(_frameIndex: number): ImageData | null { return null }
  cacheFrame(_frameIndex: number): void {}

  exportFrame(format = 'image/png', quality = 1): Promise<Blob> {
    return this.renderer.exportFrame(format, quality)
  }

  getDataURL(format = 'image/png', quality = 1): string {
    return this.renderer.getDataURL(format, quality)
  }

  getPerformanceMetrics() { return this.renderer.getPerformanceMetrics() }
  clearAllCaches(): void {
    this.renderer.clearAllCaches()
    this.preparedSource = undefined
  }
  setFrameCache(enabled: boolean): void { this.renderer.setFrameCacheEnabled(enabled) }
  destroy(): void { this.renderer.destroy() }
}
