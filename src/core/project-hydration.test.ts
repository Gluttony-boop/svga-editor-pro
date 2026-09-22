import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageResource } from '@/types'
import type { ProjectDocument } from '@/types/project'
import { useEditorStore } from '@/stores/editorStore'
import { hydrateProjectDocument, MAX_PROJECT_DECODED_PIXELS } from './project-hydration'

const PNG_BYTES = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=', 'base64'))
const AUDIO_BYTES = new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0])
const imageDataUrl = (bytes = PNG_BYTES, mime = 'image/png') => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
const pngWithDimensions = (width: number, height: number) => {
  const bytes = new Uint8Array(PNG_BYTES)
  const view = new DataView(bytes.buffer)
  // 只测试水化前的头部尺寸门禁，不让浏览器解码这个故意未重算 CRC 的构造样本。
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}
const imageResource = (key = 'avatar', data = new Uint8Array(PNG_BYTES)): ImageResource => ({
  key, data, width: 99, height: 88, mimeType: 'image/png',
  blobUrl: 'blob:previous-session', source: { type: 'url', value: 'https://example.test/private.png' }
})

function makeDocument(): ProjectDocument {
  const params = { viewBoxWidth: 400, viewBoxHeight: 300, fps: 24, frames: 24 }
  return {
    formatVersion: 1, name: '工程.svga', originalBuffer: new Uint8Array([83, 86, 71, 65]).buffer,
    videoItem: {
      movie: { version: '2.0', params, images: { avatar: new Uint8Array(PNG_BYTES) }, sprites: [] },
      images: {}, buffers: { avatar: new Uint8Array(PNG_BYTES).buffer }
    },
    params, customFps: null, customFrames: null, layers: [],
    imageResources: new Map([['avatar', imageResource()]]), audioResources: new Map(),
    slotConfigs: {}, detectedSlots: [],
    compressionConfig: { enabled: false, mode: 'smart', quality: 80, resizeEnabled: false, resizePercent: 100 },
    optimizationConfig: {
      enabled: false,
      image: { format: 'png', quality: 85, resizeEnabled: false, resizePercent: 100, maxWidth: 0, maxHeight: 0, deduplicate: false },
      frames: { simplify: false, keyframeThreshold: 0.01, removeInvisible: false, precision: 6 },
      compression: { level: 9, useBestCompression: true }
    },
    selectedPresetId: 'none', currentFrame: 0, selectedLayerId: null, selectedLayerIds: []
  }
}

type DecodeResult = { kind: 'load'; width?: number; height?: number } | { kind: 'error' | 'pending' }

function imageHarness(results: DecodeResult[] = []) {
  vi.useFakeTimers()
  const created: Array<{ url: string; blob: Blob }> = []
  const requests: string[] = []
  const instances: MockImage[] = []
  const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
    const url = `blob:project-test-${created.length + 1}`
    created.push({ url, blob: blob as Blob })
    return url
  })
  const fetchMock = vi.fn(() => { throw new Error('工程水化不得下载网络资源') })
  vi.stubGlobal('fetch', fetchMock)
  class MockImage {
    naturalWidth = 0
    naturalHeight = 0
    decoding = ''
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    private srcValue = ''
    private readonly result: DecodeResult

    constructor() {
      this.result = results[instances.length] ?? { kind: 'load', width: 1, height: 1 }
      instances.push(this)
    }

    get src() { return this.srcValue }
    set src(value: string) {
      this.srcValue = value
      requests.push(value)
      if (!value || this.result.kind === 'pending') return
      // 使用真实微任务，假时钟只控制生产实现的十秒超时，不必在测试中实际等待。
      void Promise.resolve().then(() => {
        if (this.result.kind === 'error') this.onerror?.()
        else if (this.result.kind === 'load') {
          this.naturalWidth = this.result.width ?? 1
          this.naturalHeight = this.result.height ?? 1
          this.onload?.()
        }
      })
    }
  }
  vi.stubGlobal('Image', MockImage)
  return { created, requests, instances, revoked, createUrl, fetchMock }
}

function observeStore() {
  const before = useEditorStore.getState()
  const changed = vi.fn()
  const unsubscribe = useEditorStore.subscribe(changed)
  return {
    assertUntouched: () => {
      expect(useEditorStore.getState()).toBe(before)
      expect(changed).not.toHaveBeenCalled()
    },
    unsubscribe
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('工程素材水化：只使用归档字节', () => {
  it('已取消时不创建图片或本机URL', async () => {
    const h = imageHarness()
    const controller = new AbortController(); controller.abort()
    await expect(hydrateProjectDocument(makeDocument(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.created).toHaveLength(0)
    expect(h.instances).toHaveLength(0)
  })

  it('当前解码等待中取消会立即清理，不再解码后续图片', async () => {
    const h = imageHarness([{ kind: 'pending' }, { kind: 'load' }])
    const source = makeDocument()
    source.videoItem.buffers.second = new Uint8Array(PNG_BYTES).buffer
    const controller = new AbortController()
    const task = hydrateProjectDocument(source, controller.signal)
    const rejection = expect(task).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.created).toHaveLength(1)
    controller.abort()
    await rejection
    expect(h.instances).toHaveLength(1)
    expect(h.instances[0].src).toBe('')
    expect(h.instances[0].onload).toBeNull()
    expect(h.revoked).toHaveBeenCalledWith(h.created[0].url)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('取消替换插槽图片的解码也释放已准备的源图，不继续后续插槽', async () => {
    const h = imageHarness([{ kind: 'load' }, { kind: 'pending' }, { kind: 'load' }])
    const source = makeDocument()
    source.slotConfigs = { first: { name: 'first', type: 'image', value: imageDataUrl() }, second: { name: 'second', type: 'image', value: imageDataUrl() } }
    const controller = new AbortController()
    const task = hydrateProjectDocument(source, controller.signal)
    const rejection = expect(task).rejects.toMatchObject({ name: 'AbortError' })
    // 等到真实微任务进入第二次解码，再验证取消确实阻断第三次。
    for (let index = 0; index < 20 && h.instances.length < 2; index++) await Promise.resolve()
    expect(h.instances).toHaveLength(2)
    controller.abort()
    await rejection
    expect(h.instances).toHaveLength(2)
    expect(h.revoked.mock.calls.map(([url]) => url)).toEqual(h.created.map(item => item.url))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('同 Key 同字节的 source 和 imageResource 只解码一次，不访问网络或修改编辑器', async () => {
    const h = imageHarness([{ kind: 'load', width: 120, height: 80 }])
    const source = makeDocument()
    source.slotConfigs.title = { name: 'title', type: 'text', value: 'https://example.test/这只是文字' }
    const inputCopy = structuredClone(source)
    const observer = observeStore()
    try {
      const hydrated = await hydrateProjectDocument(source)
      expect(h.fetchMock).not.toHaveBeenCalled()
      expect(h.created).toHaveLength(1)
      expect(h.instances).toHaveLength(1)
      expect(h.requests).toEqual([h.created[0].url])
      expect(h.created[0].blob.type).toBe('image/png')
      expect(new Uint8Array(await h.created[0].blob.arrayBuffer())).toEqual(PNG_BYTES)
      expect(hydrated.document.videoItem.images.avatar).toBe(h.instances[0])
      expect(hydrated.document.imageResources.get('avatar')).toMatchObject({
        data: PNG_BYTES, width: 120, height: 80, blobUrl: h.created[0].url, source: undefined, bitmap: undefined
      })
      expect(h.instances[0].decoding).toBe('async')
      expect(h.instances[0].onload).toBeNull()
      expect(h.instances[0].onerror).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
      expect(source).toEqual(inputCopy)
      expect(hydrated.document).not.toBe(source)
      expect(hydrated.document.videoItem).not.toBe(source.videoItem)
      expect(hydrated.document.imageResources).not.toBe(source.imageResources)
      observer.assertUntouched()
      hydrated.dispose()
    } finally {
      observer.unsubscribe()
    }
  })

  it('优先使用 video.buffers 中当前 Key 的数据，不被旧 movie.images 覆盖', async () => {
    const h = imageHarness()
    const source = makeDocument()
    source.videoItem.movie.images.avatar = new Uint8Array([...PNG_BYTES, 55])
    const result = await hydrateProjectDocument(source)
    expect(h.created).toHaveLength(1)
    expect(new Uint8Array(await h.created[0].blob.arrayBuffer())).toEqual(PNG_BYTES)
    expect(result.document.imageResources.get('avatar')!.blobUrl).toBe(result.document.videoItem.images.avatar.src)
    result.dispose()
  })

  it('缺少 buffers 时可从 movie.images 数组恢复图片字节', async () => {
    const h = imageHarness()
    const source = makeDocument()
    source.videoItem.buffers = {}
    source.videoItem.movie.images.avatar = Array.from(PNG_BYTES)
    source.imageResources.get('avatar')!.data = new Uint8Array()
    const result = await hydrateProjectDocument(source)
    expect(h.created).toHaveLength(1)
    expect(result.document.imageResources.get('avatar')!.data).toEqual(PNG_BYTES)
    expect(result.document.videoItem.images.avatar).toBe(h.instances[0])
    result.dispose()
  })

  it('资源 data 为空时由 sourceBytes 回填，并保留独立字节副本', async () => {
    const h = imageHarness([{ kind: 'load', width: 32, height: 24 }])
    const source = makeDocument()
    source.imageResources.get('avatar')!.data = new Uint8Array()
    const result = await hydrateProjectDocument(source)
    const resource = result.document.imageResources.get('avatar')!
    expect(resource.data).toEqual(PNG_BYTES)
    expect(resource.width).toBe(32)
    expect(resource.height).toBe(24)
    expect(h.instances).toHaveLength(1)
    resource.data[0] = 0
    expect(new Uint8Array(source.videoItem.buffers.avatar)).toEqual(PNG_BYTES)
    expect(source.imageResources.get('avatar')!.data).toHaveLength(0)
    result.dispose()
  })

  it('同 Key 的替换图片与原图数据不同，各自解码并校正资源尺寸', async () => {
    const h = imageHarness([{ kind: 'load', width: 1, height: 1 }, { kind: 'load', width: 240, height: 160 }])
    const source = makeDocument()
    const replacement = new Uint8Array([...PNG_BYTES, 1])
    source.imageResources.set('avatar', { ...imageResource(), data: replacement })
    const result = await hydrateProjectDocument(source)
    expect(h.created).toHaveLength(2)
    expect(new Uint8Array(await h.created[0].blob.arrayBuffer())).toEqual(PNG_BYTES)
    expect(new Uint8Array(await h.created[1].blob.arrayBuffer())).toEqual(replacement)
    expect(result.document.videoItem.images.avatar).toBe(h.instances[0])
    expect(result.document.imageResources.get('avatar')).toMatchObject({
      width: 240, height: 160, blobUrl: h.created[1].url, data: replacement
    })
    result.dispose()
  })

  it('仅资源库中的新增图片也从 data 解码，移除过期 URL 来源和位图缓存', async () => {
    const h = imageHarness([{ kind: 'load' }, { kind: 'load', width: 64, height: 32 }])
    const source = makeDocument()
    source.imageResources.set('new', { ...imageResource('new'), isNew: true, bitmap: {} as ImageBitmap })
    const result = await hydrateProjectDocument(source)
    expect(result.document.imageResources.get('new')).toMatchObject({
      key: 'new', isNew: true, data: PNG_BYTES, width: 64, height: 32,
      blobUrl: h.created[1].url, bitmap: undefined, source: undefined
    })
    expect(h.fetchMock).not.toHaveBeenCalled()
    expect(h.requests.every(url => url.startsWith('blob:project-test-'))).toBe(true)
    result.dispose()
  })

  it('audio-only buffers 不创建 Image，也不把音频伪装成 PNG', async () => {
    const h = imageHarness()
    const source = makeDocument()
    source.videoItem.buffers = { soundtrack: new Uint8Array(AUDIO_BYTES).buffer }
    source.videoItem.movie.images = { soundtrack: AUDIO_BYTES }
    source.imageResources = new Map()
    source.audioResources = new Map([['soundtrack', { key: 'soundtrack', data: AUDIO_BYTES, startTime: 0, duration: 300 }]])
    const result = await hydrateProjectDocument(source)
    expect(h.instances).toHaveLength(0)
    expect(h.created).toHaveLength(0)
    expect(Object.keys(result.document.videoItem.images)).toEqual([])
    expect(result.document.audioResources).toBe(source.audioResources)
    expect(h.fetchMock).not.toHaveBeenCalled()
    result.dispose()
    expect(h.revoked).not.toHaveBeenCalled()
  })

  it('混合音频和图片 buffers 时仅为有效图片字节分配 URL', async () => {
    const h = imageHarness()
    const source = makeDocument()
    source.videoItem.buffers.soundtrack = new Uint8Array(AUDIO_BYTES).buffer
    source.videoItem.movie.images.soundtrack = AUDIO_BYTES
    const result = await hydrateProjectDocument(source)
    expect(h.instances).toHaveLength(1)
    expect(h.created).toHaveLength(1)
    expect(Object.keys(result.document.videoItem.images)).toEqual(['avatar'])
    result.dispose()
  })

  it('成功结果的 dispose 幂等，每个本次创建的 URL 恰好释放一次', async () => {
    const h = imageHarness()
    const source = makeDocument()
    source.imageResources.set('extra', imageResource('extra', new Uint8Array([...PNG_BYTES, 1])))
    const result = await hydrateProjectDocument(source)
    expect(h.created).toHaveLength(2)
    expect(h.revoked).not.toHaveBeenCalled()
    result.dispose()
    result.dispose()
    expect(h.revoked.mock.calls.map(([url]) => url)).toEqual(h.created.map(item => item.url))
    expect(h.revoked).not.toHaveBeenCalledWith('blob:previous-session')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('合法边界尺寸仍可水化', async () => {
    const h = imageHarness([{ kind: 'load', width: 8192, height: 4096 }])
    const result = await hydrateProjectDocument(makeDocument())
    expect(result.document.imageResources.get('avatar')).toMatchObject({ width: 8192, height: 4096 })
    expect(h.created).toHaveLength(1)
    result.dispose()
  })

  it('特殊图片 Key 按自身属性恢复，不写入 Object.prototype', async () => {
    const h = imageHarness()
    const source = makeDocument()
    source.videoItem.buffers = Object.fromEntries([['__proto__', new Uint8Array(PNG_BYTES).buffer]])
    source.videoItem.movie.images = {}
    source.imageResources = new Map([['__proto__', imageResource('__proto__')]])
    const result = await hydrateProjectDocument(source)
    expect(Object.getPrototypeOf(result.document.videoItem.images)).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(result.document.videoItem.images, '__proto__')).toBe(true)
    expect(result.document.videoItem.images['__proto__']).toBe(h.instances[0])
    expect(result.document.imageResources.get('__proto__')!.blobUrl).toBe(h.created[0].url)
    result.dispose()
  })
})

describe('工程素材水化：失败原子性与 URL 清理', () => {
  it('后续图片解码失败时释放成功图片和失败图片的 URL，不替换当前工作', async () => {
    const h = imageHarness([{ kind: 'load' }, { kind: 'error' }])
    const source = makeDocument()
    source.imageResources.set('broken', imageResource('broken', new Uint8Array([...PNG_BYTES, 1])))
    const original = structuredClone(source)
    const observer = observeStore()
    try {
      await expect(hydrateProjectDocument(source)).rejects.toThrow('无法解码')
      expect(h.created).toHaveLength(2)
      expect(h.revoked.mock.calls.map(([url]) => url)).toEqual(h.created.map(item => item.url))
      expect(h.instances.every(image => image.onload === null && image.onerror === null)).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
      expect(source).toEqual(original)
      expect(h.fetchMock).not.toHaveBeenCalled()
      observer.assertUntouched()
    } finally {
      observer.unsubscribe()
    }
  })

  it('十秒解码超时使用假时钟验证，取消待解码图片并清理所有本次 URL', async () => {
    const h = imageHarness([{ kind: 'load' }, { kind: 'pending' }])
    const source = makeDocument()
    source.imageResources.set('pending', imageResource('pending', new Uint8Array([...PNG_BYTES, 1])))
    const observer = observeStore()
    try {
      const pending = hydrateProjectDocument(source).catch(error => error as Error)
      await vi.advanceTimersByTimeAsync(0)
      expect(h.created).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(9999)
      expect(h.revoked).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      const error = await pending
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('解码超时')
      expect(h.instances[1].src).toBe('')
      expect(h.instances[1].onload).toBeNull()
      expect(h.instances[1].onerror).toBeNull()
      expect(h.revoked.mock.calls.map(([url]) => url)).toEqual(h.created.map(item => item.url))
      expect(vi.getTimerCount()).toBe(0)
      expect(h.fetchMock).not.toHaveBeenCalled()
      observer.assertUntouched()
    } finally {
      observer.unsubscribe()
    }
  })

  it.each([[0, 1], [1, 0], [8193, 1], [1, 8193], [8192, 4097]])('拒绝非法图片尺寸 %s × %s，释放本次所有 URL', async (width, height) => {
    const h = imageHarness([{ kind: 'load' }, { kind: 'load', width, height }])
    const source = makeDocument()
    source.imageResources.set('oversize', imageResource('oversize', new Uint8Array([...PNG_BYTES, 1])))
    const observer = observeStore()
    try {
      await expect(hydrateProjectDocument(source)).rejects.toThrow('尺寸过大或无效')
      expect(h.revoked.mock.calls.map(([url]) => url)).toEqual(h.created.map(item => item.url))
      expect(h.created).toHaveLength(2)
      expect(vi.getTimerCount()).toBe(0)
      observer.assertUntouched()
    } finally {
      observer.unsubscribe()
    }
  })

  it('缺少资源字节不能改为下载 source URL，且回收之前成功解码的资源', async () => {
    const h = imageHarness()
    const source = makeDocument()
    source.imageResources.set('missing', imageResource('missing', new Uint8Array()))
    const observer = observeStore()
    try {
      await expect(hydrateProjectDocument(source)).rejects.toThrow('缺少图片资源“missing”')
      expect(h.created).toHaveLength(1)
      expect(h.revoked.mock.calls).toEqual([[h.created[0].url]])
      expect(h.fetchMock).not.toHaveBeenCalled()
      expect(h.requests).toEqual([h.created[0].url])
      observer.assertUntouched()
    } finally {
      observer.unsubscribe()
    }
  })

  it('图片资源内放入音频字节会明确失败，不以伪 PNG 交给浏览器', async () => {
    const h = imageHarness()
    const source = makeDocument()
    source.imageResources.set('invalid', imageResource('invalid', AUDIO_BYTES))
    await expect(hydrateProjectDocument(source)).rejects.toThrow('不是可解码的图片')
    expect(h.created).toHaveLength(1)
    expect(h.instances).toHaveLength(1)
    expect(h.revoked.mock.calls).toEqual([[h.created[0].url]])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('后续 Blob URL 创建失败时仍释放之前成功创建的 URL', async () => {
    const h = imageHarness()
    const source = makeDocument()
    source.imageResources.set('extra', imageResource('extra', new Uint8Array([...PNG_BYTES, 1])))
    const actualCreate = h.createUrl.getMockImplementation()!
    h.createUrl.mockImplementationOnce(actualCreate).mockImplementationOnce(() => { throw new Error('URL 分配失败') })
    await expect(hydrateProjectDocument(source)).rejects.toThrow('URL 分配失败')
    expect(h.created).toHaveLength(1)
    expect(h.revoked.mock.calls).toEqual([[h.created[0].url]])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('工程素材水化：插槽图片验证', () => {
  it('验证内嵌 Data URL 的真实图片字节后立即释放临时 URL，不改写可持久化配置', async () => {
    const h = imageHarness([{ kind: 'load' }, { kind: 'load', width: 12, height: 8 }])
    const source = makeDocument()
    const url = imageDataUrl()
    source.slotConfigs.avatar = { type: 'image', name: 'avatar', value: url, imageConfig: { url, scaleMode: 'fill' } }
    const result = await hydrateProjectDocument(source)
    expect(h.created).toHaveLength(2)
    expect(new Uint8Array(await h.created[1].blob.arrayBuffer())).toEqual(PNG_BYTES)
    expect(h.created[1].blob.type).toBe('image/png')
    expect(h.instances[1].src).toBe('')
    expect(h.revoked.mock.calls).toEqual([[h.created[1].url]])
    expect(result.document.slotConfigs).toBe(source.slotConfigs)
    expect(result.document.slotConfigs.avatar.imageConfig!.url).toBe(url)
    expect(h.fetchMock).not.toHaveBeenCalled()
    result.dispose()
    result.dispose()
    expect(h.revoked.mock.calls).toEqual([[h.created[1].url], [h.created[0].url]])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('仅 image 类型的旧 value 图片也必须解码验证', async () => {
    const h = imageHarness()
    const source = makeDocument()
    source.slotConfigs.avatar = { type: 'image', name: 'avatar', value: imageDataUrl() }
    const result = await hydrateProjectDocument(source)
    expect(h.instances).toHaveLength(2)
    expect(h.revoked.mock.calls).toEqual([[h.created[1].url]])
    result.dispose()
  })

  it('imageConfig 优先，兼容旧工程 image 类型 value 保存昵称的情况', async () => {
    const h = imageHarness()
    const source = makeDocument()
    source.slotConfigs.avatar = {
      type: 'image', name: 'avatar', value: '设计师昵称',
      imageConfig: { url: imageDataUrl(), scaleMode: 'fill' },
      textConfig: { text: '设计师昵称', fontFamily: 'Arial', fontSize: 24, color: '#ffffff' }
    }
    const result = await hydrateProjectDocument(source)
    expect(h.created).toHaveLength(2)
    expect(result.document.slotConfigs.avatar.value).toBe('设计师昵称')
    result.dispose()
  })

  it('旧工程 image 类型仅含文案和 textConfig 时不请求相对图片地址，原配置完整保留', async () => {
    const h = imageHarness()
    const source = makeDocument()
    source.slotConfigs.avatar = {
      type: 'image', name: 'avatar', value: '设计师昵称',
      textConfig: { text: '设计师昵称', fontFamily: 'Arial', fontSize: 24, color: '#ffffff' }
    }
    const result = await hydrateProjectDocument(source)
    expect(h.created).toHaveLength(1)
    expect(h.requests).toEqual([h.created[0].url])
    expect(h.fetchMock).not.toHaveBeenCalled()
    expect(result.document.slotConfigs.avatar).toBe(source.slotConfigs.avatar)
    expect(result.document.slotConfigs.avatar.value).toBe('设计师昵称')
    result.dispose()
  })

  it.each(['https://example.test/image.png', 'http://example.test/image.png', 'blob:old-session', 'file:///D:/private.png', '/relative.png'])('拒绝插槽地址 %s，不使用 fetch 或 Image 发起远端读取', async url => {
    const h = imageHarness()
    const source = makeDocument()
    source.slotConfigs.avatar = { type: 'image', name: 'avatar', value: url }
    const observer = observeStore()
    try {
      await expect(hydrateProjectDocument(source)).rejects.toThrow('仅允许归档内的图片 Data URL')
      expect(h.fetchMock).not.toHaveBeenCalled()
      expect(h.requests).toEqual([h.created[0].url])
      expect(h.created).toHaveLength(1)
      expect(h.revoked.mock.calls).toEqual([[h.created[0].url]])
      observer.assertUntouched()
    } finally { observer.unsubscribe() }
  })

  it('imageConfig 的远端地址不能被另一个合法 value 掩盖', async () => {
    const h = imageHarness()
    const source = makeDocument()
    source.slotConfigs.avatar = {
      type: 'image', name: 'avatar', value: imageDataUrl(), imageConfig: { url: 'https://example.test/hidden.png', scaleMode: 'fit' }
    }
    await expect(hydrateProjectDocument(source)).rejects.toThrow('仅允许归档内的图片 Data URL')
    expect(h.fetchMock).not.toHaveBeenCalled()
    expect(h.instances).toHaveLength(1)
    expect(h.revoked.mock.calls).toEqual([[h.created[0].url]])
  })

  it.each([
    'data:image/png;base64,', 'data:image/png;base64,!', 'data:image/png;base64,A',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:text/html;base64,PGI+eDwvYj4=',
    'data:image/png,unescaped-data'
  ])('拒绝无效或不支持的插槽 Data URL：%s', async url => {
    const h = imageHarness()
    const source = makeDocument()
    source.slotConfigs.avatar = { type: 'image', name: 'avatar', value: url }
    await expect(hydrateProjectDocument(source)).rejects.toThrow(/Data URL|Base64/)
    expect(h.created).toHaveLength(1)
    expect(h.revoked.mock.calls).toEqual([[h.created[0].url]])
    expect(h.fetchMock).not.toHaveBeenCalled()
  })

  it('声明为 PNG 的非图片字节不能绕过真实内容校验', async () => {
    const h = imageHarness()
    const source = makeDocument()
    source.slotConfigs.avatar = { type: 'image', name: 'avatar', value: imageDataUrl(AUDIO_BYTES) }
    await expect(hydrateProjectDocument(source)).rejects.toThrow('不是可解码的图片')
    expect(h.created).toHaveLength(1)
    expect(h.revoked.mock.calls).toEqual([[h.created[0].url]])
    expect(h.fetchMock).not.toHaveBeenCalled()
  })

  it('Base64 编码合法但图片解码失败时，释放所有本次 URL 且不替换当前工作', async () => {
    const h = imageHarness([{ kind: 'load' }, { kind: 'error' }])
    const source = makeDocument()
    source.slotConfigs.avatar = { type: 'image', name: 'avatar', value: imageDataUrl() }
    const observer = observeStore()
    try {
      await expect(hydrateProjectDocument(source)).rejects.toThrow('插槽 avatar')
      expect(h.revoked.mock.calls.map(([url]) => url)).toEqual(h.created.map(item => item.url))
      expect(h.instances[1].src).toBe('')
      expect(vi.getTimerCount()).toBe(0)
      observer.assertUntouched()
    } finally { observer.unsubscribe() }
  })

  it('插槽解码超时也回收本次 URL，已验证插槽不会被重复回收', async () => {
    const h = imageHarness([{ kind: 'load' }, { kind: 'load' }, { kind: 'pending' }])
    const source = makeDocument()
    source.slotConfigs.good = { type: 'image', name: 'good', value: imageDataUrl() }
    source.slotConfigs.pending = { type: 'image', name: 'pending', value: imageDataUrl() }
    const pending = hydrateProjectDocument(source).catch(error => error as Error)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.created).toHaveLength(3)
    expect(h.revoked.mock.calls).toEqual([[h.created[1].url]])
    await vi.advanceTimersByTimeAsync(10000)
    expect((await pending as Error).message).toContain('解码超时')
    expect(h.revoked.mock.calls).toEqual([[h.created[1].url], [h.created[0].url], [h.created[2].url]])
    expect(vi.getTimerCount()).toBe(0)
    expect(h.fetchMock).not.toHaveBeenCalled()
  })
})

describe('工程素材水化：解码像素预算与头部预检', () => {
  it('总预算为 64 Mi 像素；同 Key source/resource 复用在边界不重复计数', async () => {
    expect(MAX_PROJECT_DECODED_PIXELS).toBe(64 * 1024 * 1024)
    const h = imageHarness([{ kind: 'load', width: 8192, height: 4096 }, { kind: 'load', width: 8192, height: 4096 }])
    const source = makeDocument()
    const bytes = pngWithDimensions(8192, 4096)
    source.videoItem.buffers = { a: bytes.buffer.slice(0), b: bytes.buffer.slice(0) }
    source.videoItem.movie.images = {}
    source.imageResources = new Map([['a', imageResource('a', bytes)], ['b', imageResource('b', bytes)]])
    const result = await hydrateProjectDocument(source)
    expect(h.created).toHaveLength(2)
    expect(result.document.imageResources.get('a')!.blobUrl).toBe(result.document.videoItem.images.a.src)
    expect(result.document.imageResources.get('b')!.blobUrl).toBe(result.document.videoItem.images.b.src)
    result.dispose()
  })

  it('源图片和独立替换资源共同计入预算，下一张可读尺寸头的图片在创建 Image 前拒绝', async () => {
    const h = imageHarness([{ kind: 'load', width: 8192, height: 4096 }, { kind: 'load', width: 8192, height: 4096 }])
    const source = makeDocument()
    const large = pngWithDimensions(8192, 4096)
    source.videoItem.buffers.avatar = large.buffer.slice(0)
    source.videoItem.movie.images = {}
    source.imageResources.set('avatar', imageResource('avatar', new Uint8Array([...large, 1])))
    source.imageResources.set('excess', imageResource('excess'))
    const observer = observeStore()
    try {
      await expect(hydrateProjectDocument(source)).rejects.toThrow('累计解码像素超过安全上限')
      expect(h.created).toHaveLength(2)
      expect(h.instances).toHaveLength(2)
      expect(h.revoked.mock.calls.map(([url]) => url)).toEqual(h.created.map(item => item.url))
      observer.assertUntouched()
    } finally { observer.unsubscribe() }
  })

  it('已完成的插槽仍计入最终渲染预算，释放临时 URL 不能绕开总像素限制', async () => {
    const h = imageHarness([{ kind: 'load', width: 1, height: 1 }, { kind: 'load', width: 8192, height: 4096 }])
    const source = makeDocument()
    const url = imageDataUrl(pngWithDimensions(8192, 4096))
    source.slotConfigs.first = { type: 'image', name: 'first', value: url }
    source.slotConfigs.second = { type: 'image', name: 'second', value: url }
    await expect(hydrateProjectDocument(source)).rejects.toThrow('累计解码像素超过安全上限')
    expect(h.created).toHaveLength(2)
    expect(h.revoked.mock.calls).toEqual([[h.created[1].url], [h.created[0].url]])
    expect(h.fetchMock).not.toHaveBeenCalled()
  })

  it('浏览器降采样后的自然尺寸更小时仍按文件头的尺寸计入总预算', async () => {
    const h = imageHarness()
    const source = makeDocument()
    const bytes = pngWithDimensions(8192, 4096)
    source.videoItem.buffers = { first: bytes.buffer.slice(0), second: bytes.buffer.slice(0), third: bytes.buffer.slice(0) }
    source.videoItem.movie.images = {}
    source.imageResources = new Map()
    await expect(hydrateProjectDocument(source)).rejects.toThrow('累计解码像素超过安全上限')
    expect(h.instances).toHaveLength(2)
    expect(h.revoked.mock.calls.map(([url]) => url)).toEqual(h.created.map(item => item.url))
  })

  it.each([[0, 1], [1, 0], [8193, 1], [8192, 4097], [0xffffffff, 0xffffffff]])('巨大或非法 PNG 头 %s × %s 在位图解码前被拒绝', async (width, height) => {
    const h = imageHarness()
    const source = makeDocument()
    source.videoItem.buffers.avatar = pngWithDimensions(width, height).buffer
    source.videoItem.movie.images = {}
    await expect(hydrateProjectDocument(source)).rejects.toThrow('尺寸过大或无效')
    expect(h.created).toHaveLength(0)
    expect(h.instances).toHaveLength(0)
    expect(h.revoked).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['gif', 'bmp-core', 'bmp-info', 'bmp-top-down'] as const)('%s 尺寸头预检支持正确字节序和 BMP 负高度', async format => {
    const h = imageHarness()
    const source = makeDocument()
    const bytes = new Uint8Array(54)
    const view = new DataView(bytes.buffer)
    if (format === 'gif') {
      bytes.set([71, 73, 70, 56, 57, 97])
      view.setUint16(6, 8193, true)
      view.setUint16(8, 1, true)
    } else {
      bytes.set([66, 77])
      view.setUint32(14, format === 'bmp-core' ? 12 : 40, true)
      if (format === 'bmp-core') {
        view.setUint16(18, 8193, true)
        view.setUint16(20, 1, true)
      } else {
        view.setInt32(18, 1, true)
        view.setInt32(22, format === 'bmp-top-down' ? -8193 : 8193, true)
      }
    }
    source.videoItem.buffers.avatar = bytes.buffer
    source.videoItem.movie.images = {}
    await expect(hydrateProjectDocument(source)).rejects.toThrow('尺寸过大或无效')
    expect(h.created).toHaveLength(0)
    expect(h.instances).toHaveLength(0)
  })

  it('合法自顶向下 BMP 不会因负高度误判为非法尺寸', async () => {
    const h = imageHarness([{ kind: 'load', width: 2, height: 3 }])
    const source = makeDocument()
    const bytes = new Uint8Array(54)
    const view = new DataView(bytes.buffer)
    bytes.set([66, 77])
    view.setUint32(14, 40, true)
    view.setInt32(18, 2, true)
    view.setInt32(22, -3, true)
    source.videoItem.buffers.avatar = bytes.buffer
    source.videoItem.movie.images = {}
    source.imageResources = new Map()
    const result = await hydrateProjectDocument(source)
    expect(h.created).toHaveLength(1)
    expect(result.document.videoItem.images.avatar).toBe(h.instances[0])
    result.dispose()
  })

  it.each(['jpeg', 'webp'] as const)('%s 暂无尺寸头解析时，仍在解码完成后执行累计预算并回收失败图片', async format => {
    const h = imageHarness([
      { kind: 'load', width: 8192, height: 4096 },
      { kind: 'load', width: 8192, height: 4096 },
      { kind: 'load', width: 1, height: 1 }
    ])
    const source = makeDocument()
    const bytes = format === 'jpeg' ? new Uint8Array([255, 216, 255, 224]) : new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80])
    source.videoItem.buffers = { first: bytes.buffer.slice(0), second: bytes.buffer.slice(0), excess: bytes.buffer.slice(0) }
    source.videoItem.movie.images = {}
    source.imageResources = new Map()
    await expect(hydrateProjectDocument(source)).rejects.toThrow('累计解码像素超过安全上限')
    expect(h.created).toHaveLength(3)
    expect(h.instances[2].src).toBe('')
    expect(h.revoked.mock.calls.map(([url]) => url)).toEqual(h.created.map(item => item.url))
    expect(vi.getTimerCount()).toBe(0)
  })
})
