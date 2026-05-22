/**
 * 图片资源管理器
 * 负责图片的上传、处理和缓存
 */

import type { ImageResource, ResourceOperationResult } from '@/types'
import { v4 as uuid } from 'uuid'

export class ResourceManager {
  private imageCache = new Map<string, HTMLImageElement>()
  private blobUrls = new Map<string, string>()

  /**
   * 从文件创建图片资源
   */
  async loadFromFile(file: File): Promise<ResourceOperationResult> {
    try {
      // 验证文件类型
      if (!file.type.startsWith('image/')) {
        return { success: false, error: '不支持的文件类型，请选择图片文件' }
      }

      // 验证文件大小（最大 10MB）
      const maxSize = 10 * 1024 * 1024
      if (file.size > maxSize) {
        return { success: false, error: '文件大小超过 10MB 限制' }
      }

      // 读取文件数据
      const arrayBuffer = await file.arrayBuffer()
      const uint8Data = new Uint8Array(arrayBuffer)

      // 获取图片尺寸
      const dimensions = await this.getImageDimensions(uint8Data)

      // 生成唯一 key
      const key = `img_${uuid().substring(0, 8)}`

      // 创建 Blob URL
      const blob = new Blob([uint8Data], { type: file.type })
      const blobUrl = URL.createObjectURL(blob)
      this.blobUrls.set(key, blobUrl)

      const resource: ImageResource = {
        key,
        data: uint8Data,
        width: dimensions.width,
        height: dimensions.height,
        mimeType: file.type as any,
        blobUrl,
        source: {
          type: 'file',
          value: file.name,
          file
        },
        isNew: true
      }

      return { success: true, resource }
    } catch (error) {
      console.error('[ResourceManager] loadFromFile error:', error)
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * 从 URL 创建图片资源
   */
  async loadFromUrl(url: string): Promise<ResourceOperationResult> {
    try {
      const response = await fetch(url)
      if (!response.ok) {
        return { success: false, error: `加载图片失败: ${response.status}` }
      }

      const blob = await response.blob()
      const arrayBuffer = await blob.arrayBuffer()
      const uint8Data = new Uint8Array(arrayBuffer)

      // 获取图片尺寸
      const dimensions = await this.getImageDimensions(uint8Data)

      // 生成唯一 key
      const key = `img_${uuid().substring(0, 8)}`

      // 创建 Blob URL
      const blobUrl = URL.createObjectURL(blob)
      this.blobUrls.set(key, blobUrl)

      const resource: ImageResource = {
        key,
        data: uint8Data,
        width: dimensions.width,
        height: dimensions.height,
        mimeType: blob.type as any || 'image/png',
        blobUrl,
        source: {
          type: 'url',
          value: url
        },
        isNew: true
      }

      return { success: true, resource }
    } catch (error) {
      console.error('[ResourceManager] loadFromUrl error:', error)
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * 从 Data URL 创建图片资源
   */
  async loadFromDataUrl(dataUrl: string, key?: string): Promise<ResourceOperationResult> {
    try {
      // 解析 Data URL
      const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/)
      if (!match) {
        return { success: false, error: '无效的 Data URL 格式' }
      }

      const mimeType = match[1]
      const base64Data = match[2]

      // 转换为 Uint8Array
      const binaryString = atob(base64Data)
      const uint8Data = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        uint8Data[i] = binaryString.charCodeAt(i)
      }

      // 获取图片尺寸
      const dimensions = await this.getImageDimensions(uint8Data)

      // 使用提供的 key 或生成新的
      const resourceKey = key || `img_${uuid().substring(0, 8)}`

      // 创建 Blob URL
      const blob = new Blob([uint8Data], { type: mimeType })
      const blobUrl = URL.createObjectURL(blob)
      this.blobUrls.set(resourceKey, blobUrl)

      const resource: ImageResource = {
        key: resourceKey,
        data: uint8Data,
        width: dimensions.width,
        height: dimensions.height,
        mimeType: mimeType as any,
        blobUrl,
        source: {
          type: 'dataUrl',
          value: dataUrl.substring(0, 100) + '...' // 截断存储
        },
        isNew: true
      }

      return { success: true, resource }
    } catch (error) {
      console.error('[ResourceManager] loadFromDataUrl error:', error)
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * 获取图片尺寸
   */
  private async getImageDimensions(data: Uint8Array): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      const blob = new Blob([data.buffer as ArrayBuffer])
      const url = URL.createObjectURL(blob)
      const img = new Image()

      img.onload = () => {
        URL.revokeObjectURL(url)
        resolve({ width: img.width, height: img.height })
      }

      img.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('无法加载图片'))
      }

      img.src = url
    })
  }

  /**
   * 获取缓存的 HTMLImageElement
   */
  async getCachedImage(key: string, resource: ImageResource): Promise<HTMLImageElement> {
    // 检查缓存
    const cached = this.imageCache.get(key)
    if (cached) return cached

    // 创建新图片
    const img = new Image()
    
    return new Promise((resolve, reject) => {
      img.onload = () => {
        this.imageCache.set(key, img)
        resolve(img)
      }
      img.onerror = () => reject(new Error(`加载图片失败: ${key}`))

      // 使用 Blob URL 或创建新的
      if (resource.blobUrl) {
        img.src = resource.blobUrl
      } else {
        const blob = new Blob([resource.data.buffer as ArrayBuffer], { type: resource.mimeType })
        const url = URL.createObjectURL(blob)
        this.blobUrls.set(key, url)
        img.src = url
      }
    })
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    // 清理 Blob URLs
    for (const url of this.blobUrls.values()) {
      URL.revokeObjectURL(url)
    }
    this.blobUrls.clear()

    // 清理图片缓存
    this.imageCache.clear()
  }

  /**
   * 移除单个资源
   */
  removeResource(key: string): void {
    const blobUrl = this.blobUrls.get(key)
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl)
      this.blobUrls.delete(key)
    }
    this.imageCache.delete(key)
  }

  /**
   * 缩放图片
   */
  async resizeImage(
    resource: ImageResource,
    scale: number
  ): Promise<ResourceOperationResult> {
    try {
      const img = await this.getCachedImage(resource.key, resource)
      
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        return { success: false, error: '无法创建 Canvas 上下文' }
      }

      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

      // 转换为 Blob
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => {
          if (b) resolve(b)
          else reject(new Error('Canvas toBlob 失败'))
        }, 'image/png')
      })

      const arrayBuffer = await blob.arrayBuffer()
      const uint8Data = new Uint8Array(arrayBuffer)

      const newResource: ImageResource = {
        ...resource,
        data: uint8Data,
        width: canvas.width,
        height: canvas.height,
        isNew: true
      }

      return { success: true, resource: newResource }
    } catch (error) {
      console.error('[ResourceManager] resizeImage error:', error)
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * 转换图片格式
   */
  async convertFormat(
    resource: ImageResource,
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp',
    quality: number = 0.9
  ): Promise<ResourceOperationResult> {
    try {
      const img = await this.getCachedImage(resource.key, resource)
      
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        return { success: false, error: '无法创建 Canvas 上下文' }
      }

      ctx.drawImage(img, 0, 0)

      // 转换为指定格式
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => {
            if (b) resolve(b)
            else reject(new Error('Canvas toBlob 失败'))
          },
          mimeType,
          quality
        )
      })

      const arrayBuffer = await blob.arrayBuffer()
      const uint8Data = new Uint8Array(arrayBuffer)

      // 更新 Blob URL
      this.removeResource(resource.key)
      const newBlobUrl = URL.createObjectURL(blob)
      this.blobUrls.set(resource.key, newBlobUrl)

      const newResource: ImageResource = {
        ...resource,
        data: uint8Data,
        mimeType,
        blobUrl: newBlobUrl,
        isNew: true
      }

      return { success: true, resource: newResource }
    } catch (error) {
      console.error('[ResourceManager] convertFormat error:', error)
      return { success: false, error: (error as Error).message }
    }
  }
}

// 单例导出
export const resourceManager = new ResourceManager()
