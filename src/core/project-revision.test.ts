import { afterEach, describe, expect, it, vi } from 'vitest'
import protobuf from 'protobufjs'
import pako from 'pako'
import UPNG from 'upng-js'
import type { ProjectDocument } from '@/types/project'
import { createDefaultTracks } from './layer-factory'
import proto from './svga-proto'
import { prepareDeliverySnapshot } from './project-revision'
import { sha256Bytes } from './content-hash'
import { OPTIMIZATION_PRESETS } from './optimizer'

const Movie = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=', 'base64'))
const pngEncoder = UPNG as unknown as { encode(frames: ArrayBuffer[], width: number, height: number, colors: number): ArrayBuffer }
const otherPng = new Uint8Array(pngEncoder.encode([new Uint8Array([255, 0, 0, 255]).buffer], 1, 1, 0))
function document(): ProjectDocument {
  const params = { viewBoxWidth: 200, viewBoxHeight: 100, fps: 24, frames: 2 }
  const sprites = ['avatar', 'title'].map((imageKey, index) => ({ imageKey, matteKey: null, frames: [0, 1].map(frame => ({
    alpha: 1, layout: { x: 0, y: 0, width: 20, height: 20 },
    transform: { a: 1, b: 0, c: 0, d: 1, tx: index * 20 + frame, ty: 0 }, clipPath: null
  })) }))
  const movie = { version: '2.0.0', params, sprites, images: { avatar: png, title: otherPng } }
  return {
    formatVersion: 1, name: '项目.svgaproj', originalBuffer: new Uint8Array(pako.deflate(Movie.encode(Movie.fromObject(movie)).finish())).buffer,
    videoItem: { movie: structuredClone(movie), images: {}, buffers: { avatar: new Uint8Array(png).buffer, title: new Uint8Array(otherPng).buffer } },
    params: { ...params }, customFps: null, customFrames: null,
    layers: sprites.map((sprite, index) => ({ id: String(index), editableIndex: index, name: sprite.imageKey, imageKey: sprite.imageKey,
      type: 'image', visible: true, locked: false, expanded: false, opacity: 1, blendMode: 'normal',
      clip: { startFrame: 0, duration: 2 }, sprites: structuredClone(sprite), tracks: createDefaultTracks() })),
    imageResources: new Map(['avatar', 'title'].map(key => [key, { key, data: new Uint8Array(key === 'avatar' ? png : otherPng), width: 1, height: 1, mimeType: 'image/png' as const, isNew: false }])),
    audioResources: new Map(), slotConfigs: {
      avatar: { type: 'text', name: 'avatar', value: '头像' }, title: { type: 'text', name: 'title', value: '称号' }
    }, detectedSlots: ['avatar', 'title'], compressionConfig: { enabled: false, mode: 'png', quality: 90, resizeEnabled: false, resizePercent: 100 },
    optimizationConfig: structuredClone(OPTIMIZATION_PRESETS[0].config), selectedPresetId: 'none',
    currentFrame: 0, selectedLayerId: null, selectedLayerIds: []
  }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('工程内容修订与任务专属快照', () => {
  it('摘要算法使用实际SHA256，不是时间戳或弱校验值', async () => {
    expect(await sha256Bytes(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('ZIP写入日期、项目显示名、选中帧、选区与图层展开不改变内容修订', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'))
    const input = document()
    const first = await prepareDeliverySnapshot(input)
    vi.setSystemTime(new Date('2026-09-21T00:00:00Z'))
    input.name = '另一文件名.svgaproj'; input.currentFrame = 1
    input.selectedLayerId = '1'; input.selectedLayerIds = ['1']; input.layers[0].expanded = true
    const second = await prepareDeliverySnapshot(input)
    expect(second.sourceRevision).toBe(first.sourceRevision)
    expect(await sha256Bytes(second.archive)).not.toBe(await sha256Bytes(first.archive))
  })

  it('资源/插槽字典插入顺序不影响修订，图层顺序仍属于编辑内容', async () => {
    const input = document(), first = await prepareDeliverySnapshot(input)
    input.imageResources = new Map([...input.imageResources].reverse())
    input.videoItem.movie.images = Object.fromEntries(Object.entries(input.videoItem.movie.images).reverse())
    input.videoItem.buffers = Object.fromEntries(Object.entries(input.videoItem.buffers).reverse())
    input.slotConfigs = Object.fromEntries(Object.entries(input.slotConfigs).reverse())
    input.detectedSlots.reverse()
    expect((await prepareDeliverySnapshot(input)).sourceRevision).toBe(first.sourceRevision)
    input.layers.reverse()
    expect((await prepareDeliverySnapshot(input)).sourceRevision).not.toBe(first.sourceRevision)
  })

  it.each(['text', 'name', 'size', 'recipe'] as const)('%s 编辑变化产生新修订', async kind => {
    const input = document(), first = await prepareDeliverySnapshot(input)
    if (kind === 'text') input.slotConfigs.title.value = '新文案'
    if (kind === 'name') input.layers[0].name = '新输出Key'
    if (kind === 'size') { input.params.viewBoxWidth = 300; input.videoItem.movie.params.viewBoxWidth = 300 }
    if (kind === 'recipe') input.optimizationConfig.image.quality = 70
    expect((await prepareDeliverySnapshot(input)).sourceRevision).not.toBe(first.sourceRevision)
  })

  it('快照和归档不借用源字节/配置，后续编辑不会污染任务数据', async () => {
    const input = document(), snapshot = await prepareDeliverySnapshot(input)
    input.layers[0].name = '之后编辑'; input.imageResources.get('avatar')!.data[0] = 0
    expect(snapshot.document.layers[0].name).toBe('avatar')
    expect(snapshot.document.imageResources.get('avatar')!.data[0]).toBe(137)
    expect(snapshot.document.slotConfigs).not.toBe(input.slotConfigs)
  })

  it('本机Blob素材变成任务内Data URL，修订不依赖其临时地址', async () => {
    const input = document()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png, { headers: { 'content-type': 'image/png' } })))
    input.slotConfigs.avatar = { name: 'avatar', type: 'image', value: 'blob:first' }
    const first = await prepareDeliverySnapshot(input)
    input.slotConfigs.avatar.value = 'blob:second'
    const second = await prepareDeliverySnapshot(input)
    expect(first.sourceRevision).toBe(second.sourceRevision)
    expect(first.document.slotConfigs.avatar.value).toMatch(/^data:image\/png;base64,/)
  })

  it('拒绝远程素材；不会借交付生成偷偷下载网络图片', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const input = document()
    input.slotConfigs.avatar = { name: 'avatar', type: 'image', value: 'https://example.com/private.png' }
    await expect(prepareDeliverySnapshot(input)).rejects.toThrow('远程图片')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('已取消的任务不开始读取或生成快照', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(prepareDeliverySnapshot(document(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('冻结本机Blob时取消会中断读取，不再继续压缩快照', async () => {
    const input = document(), controller = new AbortController()
    input.slotConfigs.avatar = { name: 'avatar', type: 'image', value: 'blob:pending' }
    const fetch = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new DOMException('已取消读取', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetch)
    const task = prepareDeliverySnapshot(input, controller.signal)
    const rejection = expect(task).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).toHaveBeenCalledWith('blob:pending', { signal: controller.signal })
    controller.abort()
    await rejection
  })
})
