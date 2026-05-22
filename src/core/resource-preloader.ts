/**
 * 资源预加载器
 * 智能预加载SVGA动画资源，提升渲染性能
 * 
 * 改进点（参考在线编辑器）：
 * - 位图缓存管理（_bitmapCache）
 * - LRU缓存淘汰策略
 * - 内存使用监控
 * - 自动清理机制
 */

export interface PreloadProgress {
  total: number
  loaded: number
  failed: number
  percent: number
}

export interface PreloadResult {
  images: Map<string, HTMLImageElement>
  bitmaps: Map<string, ImageBitmap>
  errors: Array<{ key: string; error: Error }>
  duration: number
}

/**
 * 缓存条目（带LRU信息）
 */
interface CacheEntry {
  image: HTMLImageElement
  bitmap?: ImageBitmap
  lastAccess: number
  size: number  // 估算的内存占用（字节）
}

/**
 * 图片预加载器
 */
export class ImagePreloader {
  private cache = new Map<string, CacheEntry>()
  private loading = new Map<string, Promise<HTMLImageElement>>()
  
  // 缓存配置
  private maxCacheSize = 100        // 最大缓存条目数
  private maxMemoryMB = 128         // 最大内存占用（MB）
  private accessOrder = 0           // LRU访问计数器
  
  /**
   * 预加载单个图片
   */
  async preloadImage(key: string, url: string): Promise<HTMLImageElement> {
    // 检查缓存
    const cached = this.cache.get(key)
    if (cached && cached.image.complete && cached.image.width > 0) {
      cached.lastAccess = this.accessOrder++
      return cached.image
    }
    
    // 检查是否正在加载
    if (this.loading.has(key)) {
      return this.loading.get(key)!
    }
    
    // 开始加载
    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      
      img.onload = () => {
        // 估算图片内存占用: width * height * 4 (RGBA)
        const size = img.width * img.height * 4
        this.cache.set(key, { 
          image: img, 
          lastAccess: this.accessOrder++,
          size 
        })
        this.loading.delete(key)
        
        // 检查缓存容量，必要时淘汰
        this.evictIfNeeded()
        
        resolve(img)
      }
      
      img.onerror = () => {
        this.loading.delete(key)
        reject(new Error(`Failed to load image: ${key}`))
      }
      
      img.src = url
    })
    
    this.loading.set(key, promise)
    return promise
  }

  /**
   * 批量预加载图片
   */
  async preloadImages(
    sources: Map<string, string>,
    onProgress?: (progress: PreloadProgress) => void
  ): Promise<PreloadResult> {
    const startTime = performance.now()
    const result: PreloadResult = {
      images: new Map(),
      bitmaps: new Map(),
      errors: [],
      duration: 0
    }
    
    let loaded = 0
    const total = sources.size
    
    const promises = Array.from(sources.entries()).map(async ([key, url]) => {
      try {
        const img = await this.preloadImage(key, url)
        result.images.set(key, img)
        
        // 创建ImageBitmap（用于Worker传输）
        try {
          const bitmap = await createImageBitmap(img)
          result.bitmaps.set(key, bitmap)
          
          // 更新缓存中的bitmap
          const cached = this.cache.get(key)
          if (cached) {
            if (cached.bitmap) cached.bitmap.close()
            cached.bitmap = bitmap
          }
        } catch (err) {
          // Bitmap创建失败不影响图片加载
          console.warn('[ImagePreloader] Failed to create bitmap for:', key, err)
        }
        
        loaded++
        if (onProgress) {
          onProgress({
            total,
            loaded,
            failed: result.errors.length,
            percent: Math.round((loaded / total) * 100)
          })
        }
      } catch (error) {
        result.errors.push({ key, error: error as Error })
      }
    })
    
    await Promise.all(promises)
    
    result.duration = performance.now() - startTime
    return result
  }

  /**
   * 从HTMLImageElement预加载
   */
  async preloadFromElements(
    images: Record<string, HTMLImageElement>,
    onProgress?: (progress: PreloadProgress) => void
  ): Promise<PreloadResult> {
    const startTime = performance.now()
    const result: PreloadResult = {
      images: new Map(),
      bitmaps: new Map(),
      errors: [],
      duration: 0
    }
    
    const entries = Object.entries(images)
    let loaded = 0
    const total = entries.length
    
    const promises = entries.map(async ([key, img]) => {
      try {
        // 等待图片加载完成
        await this.waitForImage(img)
        result.images.set(key, img)
        
        // 添加到缓存
        const size = img.width * img.height * 4
        this.cache.set(key, { 
          image: img, 
          lastAccess: this.accessOrder++,
          size 
        })
        
        // 创建ImageBitmap
        try {
          const bitmap = await createImageBitmap(img)
          result.bitmaps.set(key, bitmap)
          
          const cached = this.cache.get(key)
          if (cached) {
            if (cached.bitmap) cached.bitmap.close()
            cached.bitmap = bitmap
          }
        } catch (err) {
          console.warn('[ImagePreloader] Failed to create bitmap for:', key, err)
        }
        
        loaded++
        if (onProgress) {
          onProgress({
            total,
            loaded,
            failed: result.errors.length,
            percent: Math.round((loaded / total) * 100)
          })
        }
      } catch (error) {
        result.errors.push({ key, error: error as Error })
      }
    })
    
    await Promise.all(promises)
    
    this.evictIfNeeded()
    
    result.duration = performance.now() - startTime
    return result
  }

  /**
   * 等待图片加载完成
   */
  private waitForImage(img: HTMLImageElement): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      if (img.complete && img.width > 0) {
        resolve(img)
      } else {
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('Image load failed'))
      }
    })
  }

  /**
   * LRU淘汰：当缓存超过限制时，移除最久未访问的条目
   */
  private evictIfNeeded(): void {
    // 检查条目数量限制
    while (this.cache.size > this.maxCacheSize) {
      this.evictOldest()
    }
    
    // 检查内存限制
    const totalMB = this.getMemoryUsageMB()
    if (totalMB > this.maxMemoryMB) {
      // 淘汰到内存限制的80%
      const targetMB = this.maxMemoryMB * 0.8
      while (this.getMemoryUsageMB() > targetMB && this.cache.size > 0) {
        this.evictOldest()
      }
    }
  }

  /**
   * 淘汰最久未访问的缓存条目
   */
  private evictOldest(): void {
    let oldestKey: string | null = null
    let oldestAccess = Infinity
    
    for (const [key, entry] of this.cache) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess
        oldestKey = key
      }
    }
    
    if (oldestKey) {
      this.removeCacheEntry(oldestKey)
    }
  }

  /**
   * 移除单个缓存条目并释放资源
   */
  private removeCacheEntry(key: string): void {
    const entry = this.cache.get(key)
    if (entry) {
      if (entry.bitmap) {
        entry.bitmap.close()
      }
      // 注意：不revoke blob URL，因为可能还在使用
      this.cache.delete(key)
    }
  }

  /**
   * 获取当前缓存内存占用（MB）
   */
  getMemoryUsageMB(): number {
    let totalBytes = 0
    for (const entry of this.cache.values()) {
      totalBytes += entry.size
    }
    return totalBytes / (1024 * 1024)
  }

  /**
   * 获取缓存统计信息
   */
  getCacheStats(): { entries: number; memoryMB: number; hitRate: number } {
    return {
      entries: this.cache.size,
      memoryMB: Math.round(this.getMemoryUsageMB() * 100) / 100,
      hitRate: 0  // 需要额外计数器来计算命中率
    }
  }

  /**
   * 获取缓存的图片
   */
  getCachedImage(key: string): HTMLImageElement | undefined {
    const entry = this.cache.get(key)
    if (entry) {
      entry.lastAccess = this.accessOrder++
    }
    return entry?.image
  }

  /**
   * 获取缓存的Bitmap
   */
  getCachedBitmap(key: string): ImageBitmap | undefined {
    const entry = this.cache.get(key)
    if (entry) {
      entry.lastAccess = this.accessOrder++
    }
    return entry?.bitmap
  }

  /**
   * 清除指定缓存
   */
  removeCache(key: string): void {
    this.removeCacheEntry(key)
  }

  /**
   * 清除所有缓存
   */
  clearCache() {
    this.cache.forEach(({ bitmap }) => {
      if (bitmap) {
        bitmap.close()
      }
    })
    this.cache.clear()
    this.accessOrder = 0
  }

  /**
   * 获取缓存大小
   */
  getCacheSize(): number {
    return this.cache.size
  }

  /**
   * 设置最大缓存大小
   */
  setMaxCacheSize(maxSize: number): void {
    this.maxCacheSize = maxSize
    this.evictIfNeeded()
  }

  /**
   * 设置最大内存占用
   */
  setMaxMemoryMB(maxMB: number): void {
    this.maxMemoryMB = maxMB
    this.evictIfNeeded()
  }
}

/**
 * 资源池 - 管理所有预加载的资源
 */
export class ResourcePool {
  private preloader: ImagePreloader
  private blobUrls = new Map<string, string>()
  
  constructor() {
    this.preloader = new ImagePreloader()
  }
  
  /**
   * 预加载SVGA资源
   */
  async preloadSVGA(videoItem: {
    images: Record<string, HTMLImageElement>
    buffers?: Map<string, Uint8Array>
  }, onProgress?: (progress: PreloadProgress) => void): Promise<PreloadResult> {
    // 从现有图片预加载
    const result = await this.preloader.preloadFromElements(videoItem.images, onProgress)
    
    // 如果有buffer数据，创建blob URL
    if (videoItem.buffers) {
      videoItem.buffers.forEach((buffer, key) => {
        const blob = new Blob([buffer.buffer as ArrayBuffer])
        const url = URL.createObjectURL(blob)
        this.blobUrls.set(key, url)
      })
    }
    
    return result
  }
  
  /**
   * 获取Blob URL
   */
  getBlobUrl(key: string): string | undefined {
    return this.blobUrls.get(key)
  }

  /**
   * 获取缓存统计
   */
  getCacheStats() {
    return this.preloader.getCacheStats()
  }
  
  /**
   * 清理资源
   */
  dispose() {
    // 清理Blob URLs
    this.blobUrls.forEach(url => URL.revokeObjectURL(url))
    this.blobUrls.clear()
    
    // 清理图片缓存
    this.preloader.clearCache()
  }
}
