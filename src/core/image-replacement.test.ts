import { afterEach, describe, expect, it, vi } from 'vitest'
import pako from 'pako'
import protobuf from 'protobufjs'
import type { FrameData, ImageResource, Layer, Movie } from '@/types'
import type { ProjectDocument } from '@/types/project'
import { createDefaultTracks } from './layer-factory'
import { getPreset } from './optimizer'
import { encodeQuantizedPng } from './png-quantize'
import { planImageReplacement, getCurrentReplacementLayer, type ImageReplacementState } from './image-replacement'
import { captureReplacementTarget } from './replacement-target'
import { mapSlotsToSourceImages } from './text-export'
import { buildProjectSvga, requiresSvgaMerge } from './project-export'
import { SVGABuilder } from './svga-builder'
import { createProjectArchive, readProjectArchive } from './project-archive'
import { OfficialSvgRenderer } from './renderer.official'
import { HighPerformanceRenderer } from './renderer.high-performance'
import proto from './svga-proto'

const MovieType = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
const params = { viewBoxWidth: 400, viewBoxHeight: 200, fps: 24, frames: 3 }
const png = (color: number, width = 20, height = 10) => new Uint8Array(encodeQuantizedPng(new Uint8Array(width * height * 4).fill(color), width, height, 64))
const dataUrl = (data = png(20)) => `data:image/png;base64,${Buffer.from(data).toString('base64')}`
const encode = (movie: object) => new Uint8Array(pako.deflate(MovieType.encode(MovieType.fromObject(movie)).finish())).buffer
const decode = async (blob: Blob) => MovieType.toObject(MovieType.decode(pako.inflate(new Uint8Array(await blob.arrayBuffer()))), { bytes: Uint8Array, defaults: false })
const frame = (index: number): FrameData => ({ alpha: 1, layout: { x: 2, y: 4, width: 20, height: 10 },
  transform: { a: 1, b: 0, c: 0, d: 1, tx: 31 + index, ty: 42 }, clipPath: 'M0 0L20 0L20 10Z' })

function fixture(): ProjectDocument & ImageReplacementState {
  const movie: Movie = { version: '2.0.0', params: { ...params }, images: { avatar: png(255), badge: png(120) },
    sprites: ['avatar', 'badge', 'avatar'].map((imageKey, index) => ({ imageKey, matteKey: null, frames: [frame(index), frame(index + 1), frame(index + 2)] })) }
  const layers: Layer[] = movie.sprites.map((sprite, index) => ({
    id: `layer-${index}`, editableIndex: index, name: sprite.imageKey, imageKey: sprite.imageKey,
    type: 'image', visible: true, locked: false, expanded: false, opacity: 1, blendMode: 'normal',
    clip: { startFrame: 0, duration: 3 }, tracks: createDefaultTracks(), sprites: structuredClone(sprite)
  }))
  const imageResources = new Map<string, ImageResource>(Object.keys(movie.images).map(key => [key,
    { key, data: new Uint8Array(), width: 20, height: 10, mimeType: 'image/png' }]))
  return {
    formatVersion: 1, name: '独立换图样例', originalBuffer: encode(movie),
    videoItem: { movie, images: {}, buffers: Object.fromEntries(Object.entries(movie.images).map(([key, bytes]) => [key, new Uint8Array(bytes).buffer])) },
    params: { ...params }, customFps: null, customFrames: null, layers, imageResources, audioResources: new Map(),
    slotConfigs: {}, detectedSlots: ['avatar'], compressionConfig: { enabled: false, mode: 'png', quality: 80, resizeEnabled: false, resizePercent: 100 },
    optimizationConfig: structuredClone(getPreset('balanced')!.config), selectedPresetId: 'balanced',
    currentFrame: 1, selectedLayerId: 'layer-2', selectedLayerIds: ['layer-2']
  }
}

function apply(state: ReturnType<typeof fixture>, scope: 'current-layer' | 'all-references' = 'current-layer') {
  const plan = planImageReplacement(state, 'avatar', dataUrl(), scope, state.selectedLayerId, captureReplacementTarget(state, 'avatar'))
  expect(plan, '换图计划应完整通过校验').toMatchObject({ changed: true })
  if (!plan.changed) throw new Error(plan.error)
  return { next: { ...state, ...plan.patch }, plan }
}

/** 只替代原生图片解码/画布事件；PNG 本身与 SVGA protobuf 保持真实字节，避免伪造回读结果。 */
function pngCanvasHarness() {
  class PngImage {
    width = 0; height = 0; naturalWidth = 0; naturalHeight = 0; complete = false; bytes = new Uint8Array()
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(url: string) {
      void (async () => {
        this.bytes = url.startsWith('data:') ? new Uint8Array(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
          : new Uint8Array(await (await fetch(url)).arrayBuffer())
        const header = new DataView(this.bytes.buffer)
        this.width = this.naturalWidth = header.getUint32(16); this.height = this.naturalHeight = header.getUint32(20)
        this.complete = true
        queueMicrotask(() => this.onload?.())
      })()
    }
  }
  const canvases: Array<{ canvas: HTMLCanvasElement; draws: Array<{ image: PngImage; matrix: number[]; clips: string[] }> }> = []
  const createCanvas = () => {
    let image: PngImage | undefined
    let matrix: number[] = []
    let clips: string[] = []
    const stack: Array<{ matrix: number[]; clips: string[] }> = []
    const draws: Array<{ image: PngImage; matrix: number[]; clips: string[] }> = []
    const context = {
      setTransform: (...values: number[]) => { matrix = values }, clearRect: vi.fn(),
      save: () => { stack.push({ matrix: [...matrix], clips: [...clips] }) },
      restore: () => { const saved = stack.pop()!; matrix = saved.matrix; clips = saved.clips },
      clip: (path: { path: string }) => { clips.push(path.path) },
      drawImage: (value: PngImage) => { image = value; draws.push({ image: value, matrix: [...matrix], clips: [...clips] }) }
    }
    const canvas = { width: 0, height: 0, getContext: () => context,
      toBlob: (callback: (blob: Blob) => void) => callback(new Blob([image!.bytes], { type: 'image/png' })) } as unknown as HTMLCanvasElement
    canvases.push({ canvas, draws })
    return canvas
  }
  vi.stubGlobal('Image', PngImage)
  vi.stubGlobal('document', { createElement: createCanvas })
  vi.stubGlobal('window', { devicePixelRatio: 1 })
  vi.stubGlobal('Path2D', class { constructor(public path: string) {} })
  vi.stubGlobal('createImageBitmap', undefined)
  return { createCanvas, canvases }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('替换图片影响范围计划', () => {
  it('只拆分唯一选中层，保留原图层索引/动画/顺序及原资源/同Key文字，且不突变输入', () => {
    const state = fixture()
    state.slotConfigs.avatar = { type: 'text', name: 'avatar', value: '姓名', textConfig: { text: '姓名', fontSize: 12, fontFamily: 'Arial', color: '#fff' } }
    const before = structuredClone(state)
    const { next, plan } = apply(state)
    expect(plan.layerIds).toEqual(['layer-2'])
    expect(plan.key).toBe('avatar_layer')
    expect(next.layers.map(layer => layer.id)).toEqual(state.layers.map(layer => layer.id))
    expect(next.layers[0]).toBe(state.layers[0])
    expect(next.layers[1]).toBe(state.layers[1])
    expect(next.layers[2]).toEqual({ ...state.layers[2], imageKey: plan.key, resourceDetached: true })
    expect(next.layers[2].isNew).not.toBe(true)
    expect(next.layers[2].sprites).toBe(state.layers[2].sprites)
    expect(next.imageResources.get(plan.key)).toMatchObject({ data: state.videoItem.movie.images.avatar, width: 20, height: 10, isNew: true })
    expect(next.imageResources.get('avatar')).toBe(state.imageResources.get('avatar'))
    expect(next.slotConfigs.avatar).toBe(state.slotConfigs.avatar)
    expect(next.slotConfigs[plan.key].textConfig).toEqual(state.slotConfigs.avatar.textConfig)
    expect(next.slotConfigs[plan.key].textConfig).not.toBe(state.slotConfigs.avatar.textConfig)
    expect(next.detectedSlots).toEqual(['avatar', 'avatar_layer'])
    expect(state).toEqual(before)
  })

  it('全部引用保留图层和资源，明确包括隐藏/锁定引用与遮罩', () => {
    const state = fixture()
    state.layers[0] = { ...state.layers[0], visible: false, locked: true }
    state.videoItem.movie.sprites[1].matteKey = 'avatar'
    const { next, plan } = apply(state, 'all-references')
    expect(plan.layerIds).toEqual(['layer-0', 'layer-1', 'layer-2'])
    expect(next.layers).toBe(state.layers)
    expect(next.imageResources).toBe(state.imageResources)
    expect(next.slotConfigs.avatar.value).toBe(dataUrl())
  })

  it.each(['多选', '未选中', '选错资源', '选中层改变', '锁定', '遮罩消费层', '遮罩源层', '矢量', '未知原索引'])( '%s 不能做单层拆分且不改变输入', reason => {
    const state = fixture()
    if (reason === '多选') state.selectedLayerIds.push('layer-0')
    if (reason === '未选中') { state.selectedLayerId = null; state.selectedLayerIds = [] }
    if (reason === '选错资源') { state.selectedLayerId = 'layer-1'; state.selectedLayerIds = ['layer-1'] }
    if (reason === '选中层改变') { state.selectedLayerId = 'layer-0'; state.selectedLayerIds = ['layer-0'] }
    if (reason === '锁定') state.layers[2].locked = true
    if (reason === '遮罩消费层') state.videoItem.movie.sprites[2].matteKey = 'mask.matte'
    if (reason === '遮罩源层') state.videoItem.movie.sprites[1].matteKey = 'avatar'
    if (reason === '矢量') state.videoItem.movie.sprites[2].frames[0].shapes = [{ type: 'KEEP' }]
    if (reason === '未知原索引') delete state.layers[2].editableIndex
    const before = structuredClone(state)
    expect(planImageReplacement(state, 'avatar', dataUrl(), 'current-layer', 'layer-2')).toMatchObject({ changed: false, error: expect.any(String) })
    expect(state).toEqual(before)
  })

  it('新增图层可以拆分且仍是新增图层；隐藏但未锁定的当前层可拆分', () => {
    const state = fixture()
    state.layers[2] = { ...state.layers[2], isNew: true, editableIndex: undefined, visible: false }
    const { next } = apply(state)
    expect(next.layers[2]).toMatchObject({ isNew: true, resourceDetached: true, visible: false })
  })

  it('最后一个引用拆分时文字配置与检测Key随层迁移，不留下孤立文字容器', () => {
    const state = fixture()
    state.layers = state.layers.slice(1)
    state.slotConfigs.avatar = { type: 'text', name: 'avatar', value: '姓名', textConfig: { text: '姓名', fontSize: 12, fontFamily: 'Arial', color: '#fff',
      boxWidth: 60, boxHeight: 20, referenceWidth: 20, referenceHeight: 10, exportMode: 'preview' } }
    const { next, plan } = apply(state)
    expect(next.slotConfigs.avatar).toBeUndefined()
    expect(next.slotConfigs[plan.key].textConfig).toEqual(state.slotConfigs.avatar.textConfig)
    expect(next.detectedSlots).toEqual([plan.key])
    expect(next.imageResources.get('avatar')).toBe(state.imageResources.get('avatar'))
  })

  it('独立Key避免资源/名称/旧源图/插槽碰撞，并支持原型属性名而不污染对象', () => {
    const state = fixture()
    state.slotConfigs.avatar_layer = { type: 'text', name: '保留', value: '' }
    state.layers[1].name = 'avatar_layer_2'
    state.videoItem.movie.images.avatar_layer_3 = png(70)
    expect(apply(state).plan.key).toBe('avatar_layer_4')
    const special = 'constructor'
    state.imageResources.set(special, { ...state.imageResources.get('avatar')!, key: special })
    const plan = planImageReplacement(state, special, dataUrl(), 'all-references')
    expect(plan.changed && plan.patch.slotConfigs[special]).toMatchObject({ type: 'image', name: special })
    expect({}.constructor).toBe(Object)
  })

  it.each(['大小不符', '地址不是PNG', '无效PNG', '原图字节缺失', '原资源已替换', '增加引用', '减少引用'])( '%s 阻止确认旧预览', reason => {
    const state = fixture()
    const target = captureReplacementTarget(state, 'avatar')
    let url = dataUrl()
    if (reason === '大小不符') url = dataUrl(png(50, 10, 10))
    if (reason === '地址不是PNG') url = 'https://example.com/picture.png'
    if (reason === '无效PNG') url = dataUrl(new Uint8Array(40))
    if (reason === '原图字节缺失') { delete state.videoItem.buffers.avatar; delete state.videoItem.movie.images.avatar }
    if (reason === '原资源已替换') state.imageResources.set('avatar', { ...state.imageResources.get('avatar')! })
    if (reason === '增加引用') state.layers = [...state.layers, { ...state.layers[2], id: 'new' }]
    if (reason === '减少引用') state.layers = state.layers.slice(1)
    expect(planImageReplacement(state, 'avatar', url, 'current-layer', 'layer-2', target)).toMatchObject({ changed: false })
  })

  it('重命名插槽仍映射源Key，独立资源插槽绝不能回写共享Key', () => {
    const state = fixture()
    const { next, plan } = apply(state)
    next.slotConfigs.avatar = { type: 'text', name: 'avatar', value: '共享文案' }
    const mapped = mapSlotsToSourceImages(next.slotConfigs, state.videoItem.movie.sprites, next.layers)
    expect(mapped.avatar).toBe(next.slotConfigs.avatar)
    expect(mapped[plan.key]).toBe(next.slotConfigs[plan.key])
    expect(getCurrentReplacementLayer(next, plan.key).layer?.id).toBe('layer-2')
  })
})

describe('独立换图真实protobuf导出', () => {
  it.each([OfficialSvgRenderer, HighPerformanceRenderer])('%s 实时预览只换选中层，恢复状态时同一帧不会留下独立替换缓存', async Renderer => {
    const h = pngCanvasHarness()
    const state = fixture()
    state.videoItem.images = Object.fromEntries(Object.entries(state.videoItem.movie.images).map(([key, bytes]) => [key,
      { width: 20, height: 10, naturalWidth: 20, naturalHeight: 10, complete: true, bytes } as unknown as HTMLImageElement]))
    const { next } = apply(state)
    const renderer = new Renderer(h.createCanvas())
    await renderer.setVideoItem(state.videoItem, { waitForImages: true })
    await renderer.renderFrameAsync(1, { layers: next.layers, slotConfigs: next.slotConfigs, imageResources: next.imageResources, useFrameCache: false })
    const draws = h.canvases[0].draws
    expect(draws).toHaveLength(3)
    expect(draws.map(draw => draw.image.bytes)).toEqual([png(255), png(120), png(20)])
    expect(draws[2].matrix).toEqual([1, 0, 0, 1, 34, 42])
    expect(draws[2].clips).toEqual(['M0 0L20 0L20 10Z'])
    await renderer.renderFrameAsync(1, { layers: state.layers, slotConfigs: state.slotConfigs, imageResources: state.imageResources, useFrameCache: false })
    expect(draws.slice(-3).map(draw => draw.image.bytes)).toEqual([png(255), png(120), png(255)])
    renderer.destroy()
  })

  it('两个共享层仅目标图片变化，保持原图层顺序、逐帧矩阵、裁切路径和时间范围', async () => {
    pngCanvasHarness()
    const state = fixture()
    state.layers[2].clip = { startFrame: 1, duration: 1 }
    const baseline = await decode(await new SVGABuilder().mergeWithOriginal(state.originalBuffer, {
      params, layers: state.layers, imageResources: state.imageResources, slotConfigs: {}
    }))
    const { next, plan } = apply(state)
    expect(requiresSvgaMerge(next)).toBe(true)
    const artifact = await buildProjectSvga(next)
    const result = await decode(artifact.blob)
    expect(artifact.bindings.map(binding => binding.layerId)).toEqual(['layer-0', 'layer-1', 'layer-2'])
    expect(artifact.bindings.map(binding => binding.originalSpriteIndex)).toEqual([0, 1, 2])
    expect(result.sprites).toHaveLength(3)
    expect(result.sprites[0]).toEqual(baseline.sprites[0])
    expect(result.sprites[1]).toEqual(baseline.sprites[1])
    expect(result.sprites[2].imageKey).not.toBe(result.sprites[0].imageKey)
    expect(result.sprites[2].frames).toEqual(baseline.sprites[2].frames)
    expect(result.sprites[2].frames.map((frame: FrameData) => frame.alpha)).toEqual([0, 1, 0])
    expect(result.sprites[2].frames[1].clipPath).toBe('M0 0L20 0L20 10Z')
    expect(result.images[result.sprites[0].imageKey]).toEqual(state.videoItem.movie.images.avatar)
    expect(result.images[result.sprites[2].imageKey]).toEqual(png(20))
    expect(artifact.bindings[2]).toMatchObject({ sourceImageKey: plan.key, sourceSlotKey: plan.key })
  })

  it('独立资源保存工程后再读回，导出仍只替换同一层', async () => {
    pngCanvasHarness()
    const { next } = apply(fixture())
    const { isDirty, ...document } = next
    expect(isDirty).toBe(true)
    const archive = await createProjectArchive(document)
    const restored = await readProjectArchive(await archive.arrayBuffer())
    expect(restored.layers[2]).toMatchObject({ resourceDetached: true, editableIndex: 2 })
    const result = await decode((await buildProjectSvga(restored)).blob)
    expect(result.images[result.sprites[0].imageKey]).toEqual(png(255))
    expect(result.images[result.sprites[2].imageKey]).toEqual(png(20))
  })

  it('独立拆分后再共享替换旧Key，不会回染独立层', async () => {
    pngCanvasHarness()
    const { next } = apply(fixture())
    const shared = planImageReplacement(next, 'avatar', dataUrl(png(80)), 'all-references')
    if (!shared.changed) throw new Error(shared.error)
    const result = await decode((await buildProjectSvga({ ...next, ...shared.patch })).blob)
    expect(result.images[result.sprites[0].imageKey]).toEqual(png(80))
    expect(result.images[result.sprites[2].imageKey]).toEqual(png(20))
  })
})
