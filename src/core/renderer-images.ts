import type { SlotConfig } from '@/types'

export interface RendererImageResource {
  data: Uint8Array
  blobUrl?: string
  width: number
  height: number
}

interface ImageRequest {
  url: string
  promise: Promise<void>
  image?: HTMLImageElement
}

/** 同一地址共享解码任务，旧请求完成后不能覆盖新替换或新文件的缓存。 */
export class RendererImageCache {
  private requests = new Map<string, ImageRequest>()
  private activeSlots = new Set<string>()
  private resourceSources = new Map<string, RendererImageResource>()
  private resourceUrls = new Map<string, { url: string; owned: boolean }>()

  constructor(private onChange: () => void) {}

  prepare(
    slots: Record<string, SlotConfig>,
    applySlots: boolean,
    resources?: ReadonlyMap<string, RendererImageResource>
  ): Promise<void> {
    this.activeSlots = new Set()
    const pending: Promise<void>[] = []
    if (applySlots) {
      for (const [key, slot] of Object.entries(slots)) {
        const url = slot.type === 'image' ? slot.imageConfig?.url || (typeof slot.value === 'string' ? slot.value : '') : ''
        if (!url) continue
        this.activeSlots.add(key)
        pending.push(this.load(`slot:${key}`, url))
      }
    }
    resources?.forEach((resource, key) => {
      if (!resource.blobUrl && !resource.data.byteLength) return
      if (this.resourceSources.get(key) !== resource) {
        const previous = this.resourceUrls.get(key)
        if (previous?.owned) URL.revokeObjectURL(previous.url)
        const owned = !resource.blobUrl
        const url = resource.blobUrl || URL.createObjectURL(new Blob([new Uint8Array(resource.data).buffer]))
        this.resourceSources.set(key, resource)
        this.resourceUrls.set(key, { url, owned })
      }
      pending.push(this.load(`resource:${key}`, this.resourceUrls.get(key)!.url))
    })
    return Promise.all(pending).then(() => undefined)
  }

  private load(key: string, url: string): Promise<void> {
    const existing = this.requests.get(key)
    if (existing?.url === url) return existing.promise
    const image = new Image()
    image.crossOrigin = 'anonymous'
    const request: ImageRequest = { url, promise: Promise.resolve() }
    this.requests.set(key, request)
    request.promise = new Promise<void>((resolve, reject) => {
      image.onload = () => {
        if (this.requests.get(key) === request) {
          request.image = image
          this.onChange()
        }
        resolve()
      }
      image.onerror = () => {
        if (this.requests.get(key) !== request) { resolve(); return }
        reject(new Error(`图片解码失败：${key.replace(/^(slot|resource):/, '')}`))
      }
      image.src = url
    })
    return request.promise
  }

  getSlot(key: string): HTMLImageElement | undefined {
    return this.activeSlots.has(key) ? this.requests.get(`slot:${key}`)?.image : undefined
  }

  getResource(key: string): HTMLImageElement | undefined {
    return this.requests.get(`resource:${key}`)?.image
  }

  clear(): void {
    this.requests.clear()
    this.activeSlots.clear()
    this.resourceSources.clear()
    this.resourceUrls.forEach(item => { if (item.owned) URL.revokeObjectURL(item.url) })
    this.resourceUrls.clear()
  }
}
