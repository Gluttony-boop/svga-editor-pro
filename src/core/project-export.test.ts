import { afterEach, describe, expect, it, vi } from 'vitest'
import pako from 'pako'
import protobuf from 'protobufjs'
import type { FrameData, Layer, Movie, SlotConfig } from '@/types'
import type { ProjectDocument } from '@/types/project'
import type { ExportSpriteBinding, ProjectSvgaArtifact } from '@/types/export-artifact'
import { createDefaultTracks } from './layer-factory'
import { ExportEngine } from './exporter'
import { getPreset } from './optimizer'
import { encodeQuantizedPng } from './png-quantize'
import { buildProjectSvga, requiresSvgaMerge } from './project-export'
import { SVGABuilder } from './svga-builder'
import proto from './svga-proto'

const MovieType = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
const params = { viewBoxWidth: 400, viewBoxHeight: 200, fps: 24, frames: 2 }
const encode = (movie: object) => new Uint8Array(pako.deflate(MovieType.encode(MovieType.fromObject(movie)).finish())).buffer
const decode = async (blob: Blob) => MovieType.toObject(MovieType.decode(pako.inflate(new Uint8Array(await blob.arrayBuffer()))), { bytes: Uint8Array, defaults: false })
const png = (width = 20, height = 10, color = 255) => new Uint8Array(encodeQuantizedPng(new Uint8Array(width * height * 4).fill(color), width, height, 64))
const frame = (): FrameData => ({ alpha: 1, layout: { x: 2, y: 4, width: 20, height: 10 },
  transform: { a: 1, b: 0, c: 0, d: 1, tx: 31, ty: 42 }, clipPath: 'M0 0L20 0L20 10Z' })

function fixture(keys = ['title']): ProjectDocument {
  const movie: Movie = { version: '2.0.0', params: { ...params }, images: Object.create(null),
    sprites: keys.map(key => ({ imageKey: key, matteKey: null, frames: [frame(), frame()] })) }
  keys.forEach((key, index) => { if (key) movie.images[key] = png(20, 10, 255 - index * 20) })
  const layers: Layer[] = movie.sprites.map((sprite, index) => ({
    id: `layer-${index}`, editableIndex: index, name: sprite.imageKey, imageKey: sprite.imageKey || undefined,
    type: sprite.imageKey ? 'image' : 'shape', visible: true, locked: false, expanded: false, opacity: 1,
    blendMode: 'normal', clip: { startFrame: 0, duration: 2 }, tracks: createDefaultTracks(), sprites: structuredClone(sprite)
  }))
  return {
    formatVersion: 1, name: '交付样例', originalBuffer: encode(movie),
    videoItem: { movie, images: {}, buffers: {} }, params: { ...params }, customFps: null, customFrames: null,
    layers, imageResources: new Map(keys.filter(Boolean).map(key => [key, { key, data: new Uint8Array(), width: 20, height: 10, mimeType: 'image/png' }])),
    audioResources: new Map(), slotConfigs: {}, detectedSlots: [],
    compressionConfig: { enabled: true, mode: 'webp', quality: 12, resizeEnabled: true, resizePercent: 10 },
    optimizationConfig: structuredClone(getPreset('balanced')!.config), selectedPresetId: 'balanced',
    currentFrame: 1, selectedLayerId: null, selectedLayerIds: []
  }
}

function textSlot(exportMode: 'preview' | 'bake' = 'preview'): SlotConfig {
  return { type: 'text', name: '设计师文案', value: null, textConfig: { text: '2222222222222',
    fontSize: 16, fontFamily: 'Arial', color: '#ffffff', boxWidth: 120, boxHeight: 30,
    referenceWidth: 20, referenceHeight: 10, exportMode } }
}

/** PNG 与 protobuf 均真实编解码；测试 canvas 只替代本机字形栅格化和 Image 解码事件。 */
function browserHarness(options: { failImages?: boolean; onImage?: () => void; holdImage?: boolean } = {}) {
  const canvases: Array<{ canvas: HTMLCanvasElement; text: string[]; draws: unknown[] }> = []
  const imageJobs: Array<() => Promise<void>> = []
  const urls = new Map<string, Blob>()
  const revoked: string[] = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
    const url = `blob:project-export-${urls.size}`
    urls.set(url, blob as Blob)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => { revoked.push(url) })
  const createCanvas = () => {
    const text: string[] = []
    const draws: unknown[] = []
    const context = { setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
      drawImage: (image: unknown) => { draws.push(image) }, fillText: (value: string) => { text.push(value) } }
    const canvas = { width: 0, height: 0, getContext: () => context,
      toBlob: (callback: (blob: Blob) => void) => callback(new Blob([png(canvas.width, canvas.height)], { type: 'image/png' }))
    } as unknown as HTMLCanvasElement
    canvases.push({ canvas, text, draws })
    return canvas
  }
  class TestImage {
    width = 20; height = 10; naturalWidth = 20; naturalHeight = 10
    complete = false
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(url: string) {
      const load = async () => {
        if (options.failImages) { this.onerror?.(); return }
        const bytes = new Uint8Array(await (urls.get(url) || new Blob([png(40, 20)])).arrayBuffer())
        const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        this.width = this.naturalWidth = data.getUint32(16)
        this.height = this.naturalHeight = data.getUint32(20)
        this.complete = true
        options.onImage?.()
        this.onload?.()
      }
      if (options.holdImage) imageJobs.push(load)
      else void load()
    }
  }
  vi.stubGlobal('document', { createElement: createCanvas })
  vi.stubGlobal('Image', TestImage)
  vi.stubGlobal('window', { devicePixelRatio: 1 })
  return { canvases, createCanvas, imageJobs, urls, revoked }
}

async function expectExactBindings(artifact: ProjectSvgaArtifact) {
  const movie = await decode(artifact.blob)
  expect(artifact.bindings).toHaveLength(movie.sprites?.length ?? 0)
  artifact.bindings.forEach((binding, index) => {
    expect(binding.spriteIndex).toBe(index)
    expect(binding.baselineImageKey).toBe(movie.sprites[index].imageKey || null)
  })
  return movie
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('工程导出分流与快照', () => {
  it('未增删改名或加关键帧时沿用 Lite，并不启动旧压缩或修改文档', async () => {
    const h = browserHarness()
    const doc = fixture()
    const before = structuredClone(doc)
    const merge = vi.spyOn(SVGABuilder.prototype, 'mergeWithOriginal')
    const lite = vi.spyOn(ExportEngine.prototype, 'exportSVGALite')
    const destroyed = vi.spyOn(ExportEngine.prototype, 'destroy')
    expect(requiresSvgaMerge(doc)).toBe(false)
    const artifact = await buildProjectSvga(doc)
    const output = await expectExactBindings(artifact)
    expect(lite).toHaveBeenCalledOnce()
    expect(merge).not.toHaveBeenCalled()
    expect(output.params).toEqual(params)
    expect(output.images.title).toEqual(doc.videoItem.movie.images.title)
    expect(doc).toEqual(before)
    expect(destroyed).toHaveBeenCalledOnce()
    expect(h.canvases[0].canvas).toMatchObject({ width: 0, height: 0 })
  })

  it.each(['删除图层', '新图层', '新图片', '动画轨道', '独立动画轨道', '改显示名称'])( '%s 使用合并，不重建丢掉原始协议数据', reason => {
    const doc = fixture(['one', 'two'])
    if (reason === '删除图层') doc.layers.pop()
    if (reason === '新图层') doc.layers.push({ ...doc.layers[0], id: 'new', isNew: true })
    if (reason === '新图片') doc.imageResources.get('one')!.isNew = true
    if (reason === '动画轨道') doc.layers[0].tracks.rotation.keyframes.push({ id: 'k', frameIndex: 1, value: 20, easing: 'linear' })
    if (reason === '独立动画轨道') {
      doc.layers[0].animationTracks = createDefaultTracks()
      doc.layers[0].animationTracks.rotation.keyframes.push({ id: 'k', frameIndex: 1, value: 20, easing: 'linear' })
    }
    if (reason === '改显示名称') doc.layers[0].name = '设计命名'
    expect(requiresSvgaMerge(doc)).toBe(true)
  })

  it.each([false, true])('自定义fps/frames覆盖原params，merge=%s', async merge => {
    browserHarness()
    const doc = fixture()
    if (merge) doc.layers[0].name = 'newName'
    doc.customFps = 60
    doc.customFrames = 4
    const output = await expectExactBindings(await buildProjectSvga(doc))
    expect(output.params).toEqual({ ...params, fps: 60, frames: 4 })
    expect(output.sprites[0].frames).toHaveLength(4)
    expect(doc.params).toEqual(params)
  })

  it.each([false, true])('绑定sidecar不改变既有Blob字节，merge=%s', async merge => {
    const h = browserHarness()
    const doc = fixture(['title', 'badge'])
    if (merge) doc.layers[0].name = 'renamed'
    const actual = await buildProjectSvga(doc)
    let legacy: Blob
    if (merge) {
      legacy = await new SVGABuilder().mergeWithOriginal(doc.originalBuffer, {
        params, layers: doc.layers, imageResources: doc.imageResources, slotConfigs: doc.slotConfigs,
        imageSizes: new Map(Array.from(doc.imageResources).map(([key, image]) => [key, { width: image.width, height: image.height }]))
      })
    } else {
      const engine = new ExportEngine(h.createCanvas())
      engine.setVideoItem(doc.videoItem)
      try { legacy = await engine.exportSVGALite(doc.originalBuffer, { ...params, layers: doc.layers, slotConfigs: doc.slotConfigs, compression: { ...doc.compressionConfig, enabled: false } }) }
      finally { engine.destroy() }
    }
    expect(new Uint8Array(await actual.blob.arrayBuffer())).toEqual(new Uint8Array(await legacy.arrayBuffer()))
    await expectExactBindings(actual)
  })
})

describe('导出来源来自实际发出的 sprite', () => {
  it('删除前层后只压缩输出序号，不挪用被删层或按当前层数组顺序猜身份', async () => {
    const doc = fixture(['deleted', 'middle', 'last'])
    doc.layers = [doc.layers[2], doc.layers[1]]
    const artifact = await buildProjectSvga(doc)
    await expectExactBindings(artifact)
    expect(artifact.bindings).toEqual([
      { spriteIndex: 0, originalSpriteIndex: 1, layerId: 'layer-1', sourceImageKey: 'middle', sourceSlotKey: null, baselineImageKey: 'middle' },
      { spriteIndex: 1, originalSpriteIndex: 2, layerId: 'layer-2', sourceImageKey: 'last', sourceSlotKey: null, baselineImageKey: 'last' }
    ])
  })

  it('复制已重命名原层保留原图片来源，但不伪造副本原sprite索引', async () => {
    const doc = fixture()
    doc.layers[0].imageKey = 'currentKey'
    doc.layers[0].name = 'currentKey'
    const copy = { ...structuredClone(doc.layers[0]), id: 'copy', editableIndex: undefined, isNew: true, name: 'duplicate' }
    doc.layers.push(copy)
    doc.slotConfigs.currentKey = { type: 'image', name: '业务插槽', value: null }
    const before = structuredClone(doc)
    const artifact = await buildProjectSvga(doc)
    const output = await expectExactBindings(artifact)
    expect(artifact.bindings).toEqual([
      { spriteIndex: 0, originalSpriteIndex: 0, layerId: 'layer-0', sourceImageKey: 'title', sourceSlotKey: 'currentKey', baselineImageKey: 'currentKey' },
      { spriteIndex: 1, originalSpriteIndex: null, layerId: 'copy', sourceImageKey: 'title', sourceSlotKey: 'currentKey', baselineImageKey: 'duplicate' }
    ])
    expect(output.images.currentKey).toEqual(output.images.duplicate)
    expect(output.sprites[1].frames).toEqual(output.sprites[0].frames)
    expect(doc).toEqual(before)
  })

  it('同显示名但不同源图片碰撞时以实际分配别名为准', async () => {
    const doc = fixture(['left', 'right'])
    doc.layers.forEach(layer => { layer.name = 'same' })
    doc.slotConfigs.left = { type: 'image', name: 'same', value: null }
    doc.slotConfigs.right = { type: 'image', name: 'same', value: null }
    const artifact = await buildProjectSvga(doc)
    await expectExactBindings(artifact)
    expect(artifact.bindings.map(binding => [binding.sourceSlotKey, binding.baselineImageKey])).toEqual([['left', 'same'], ['right', 'same_2']])
  })

  it.each([false, true])('shape、无Key sprite、clip/matte和音频原样保留，merge=%s', async merge => {
    browserHarness()
    const doc = fixture(['mask', 'title', ''])
    const movie = doc.videoItem.movie
    movie.images['sound.mp3'] = new Uint8Array([73, 68, 51, 4, 0, 0])
    movie.audios = [{ audioKey: 'sound.mp3', startFrame: 0, endFrame: 1, startTime: 23, totalTime: 88 }] as unknown as Movie['audios']
    movie.sprites[1].matteKey = 'mask'
    movie.sprites[2].frames[0].shapes = [{ type: 'RECT', rect: { x: 1, y: 2, width: 20, height: 10, cornerRadius: 3 } }]
    doc.layers[1].sprites = structuredClone(movie.sprites[1])
    doc.layers[2].sprites = structuredClone(movie.sprites[2])
    doc.originalBuffer = encode(movie)
    if (merge) doc.layers[1].name = 'renamed'
    const original = await decode(new Blob([doc.originalBuffer]))
    const artifact = await buildProjectSvga(doc)
    const output = await expectExactBindings(artifact)
    expect(output.audios).toEqual(original.audios)
    expect(output.images['sound.mp3']).toEqual(original.images['sound.mp3'])
    expect(output.sprites[1].matteKey).toBe('mask')
    expect(output.sprites[1].frames[0].clipPath).toBe(movie.sprites[1].frames[0].clipPath)
    expect(output.sprites[2].frames[0].shapes).toEqual(original.sprites[2].frames[0].shapes)
    expect(artifact.bindings[2]).toEqual({ spriteIndex: 2, originalSpriteIndex: 2, layerId: 'layer-2', sourceImageKey: null, sourceSlotKey: null, baselineImageKey: null })
  })

  it('直接Lite导出缺编辑层元数据时仍保留原sprite，来源layerId为null', async () => {
    const h = browserHarness()
    const doc = fixture(['', 'title'])
    let bindings: ExportSpriteBinding[] = []
    const engine = new ExportEngine(h.createCanvas())
    engine.setVideoItem(doc.videoItem)
    const blob = await engine.exportSVGALite(doc.originalBuffer, { ...params, onBindings: result => { bindings = result } })
    engine.destroy()
    await expectExactBindings({ blob, bindings })
    expect(bindings.map(binding => [binding.layerId, binding.originalSpriteIndex, binding.sourceImageKey])).toEqual([[null, 0, null], [null, 1, 'title']])
  })

  it.each(['current', 'source', 'alias'])('来源槽优先级与文字导出共用，回退到%s', async kind => {
    const doc = fixture()
    doc.layers[0].imageKey = 'current'
    doc.layers[0].name = 'alias'
    if (kind === 'current') doc.slotConfigs.current = { type: 'image', name: 'not-a-key', value: null }
    if (kind !== 'alias') doc.slotConfigs.title = { type: 'image', name: 'not-a-key', value: null }
    doc.slotConfigs.alias = { type: 'image', name: 'not-a-key', value: null }
    const artifact = await buildProjectSvga(doc)
    await expectExactBindings(artifact)
    expect(artifact.bindings[0].sourceSlotKey).toBe(kind === 'source' ? 'title' : kind)
  })

  it.each(['__proto__', 'constructor', 'toString', '中文 Key', `iVBORw0KGgo${'X'.repeat(210)}`])('特殊编辑Key %s 用安全真实规范化Key联结', async key => {
    browserHarness()
    const doc = fixture(['title', 'image_1'])
    doc.layers[0].imageKey = key
    doc.layers[0].name = key
    doc.slotConfigs = { [key]: { type: 'image', name: '不得猜测', value: null } }
    const artifact = await buildProjectSvga(doc)
    const output = await expectExactBindings(artifact)
    expect(artifact.bindings[0].sourceSlotKey).toBe(key)
    expect(artifact.bindings[0].sourceImageKey).toBe('title')
    expect(artifact.bindings[0].baselineImageKey).not.toBe('__proto__')
    expect(output.images[artifact.bindings[0].baselineImageKey!]).toEqual(doc.videoItem.movie.images.title)
    expect(output.images.image_1).toEqual(doc.videoItem.movie.images.image_1)
  })

  it('继承的constructor等属性不是配置，不误报文字或动态槽', async () => {
    browserHarness()
    const doc = fixture(['constructor'])
    doc.slotConfigs = Object.create({ constructor: textSlot('bake') })
    const artifact = await buildProjectSvga(doc)
    await expectExactBindings(artifact)
    expect(artifact.bindings[0].sourceSlotKey).toBeNull()
  })

  it('全部图层删除时输出空绑定，不保留被删除的sprite', async () => {
    const doc = fixture()
    doc.layers = []
    const artifact = await buildProjectSvga(doc)
    const output = await expectExactBindings(artifact)
    expect(output.sprites || []).toEqual([])
    expect(artifact.bindings).toEqual([])
  })

  it('全新图片只记录真实新图层；音频编辑层不会凭空产生sprite绑定', async () => {
    const doc = fixture()
    const layer: Layer = { ...structuredClone(doc.layers[0]), id: 'added-image', editableIndex: undefined,
      isNew: true, imageKey: 'new_resource', name: '业务头像', sprites: undefined }
    doc.layers.push(layer, { ...structuredClone(layer), id: 'added-audio', type: 'audio', imageKey: undefined, name: 'audio' })
    doc.imageResources.set('new_resource', { key: 'new_resource', data: png(32, 24), width: 32, height: 24, mimeType: 'image/png', isNew: true })
    doc.slotConfigs.new_resource = { type: 'image', name: '头像', value: null }
    const artifact = await buildProjectSvga(doc)
    const output = await expectExactBindings(artifact)
    expect(artifact.bindings).toHaveLength(2)
    expect(artifact.bindings[1]).toEqual({ spriteIndex: 1, originalSpriteIndex: null, layerId: 'added-image', sourceImageKey: 'new_resource', sourceSlotKey: 'new_resource', baselineImageKey: '业务头像' })
    expect(output.sprites[1].frames[0].layout).toMatchObject({ width: 32, height: 24 })
    expect(output.images['业务头像']).toEqual(doc.imageResources.get('new_resource')!.data)
  })

  it.each([false, true])('原始__proto__被protobuf decoder丢失时显式拒绝而非发布错误来源，merge=%s', async merge => {
    browserHarness()
    const doc = fixture()
    doc.videoItem.movie.images = { ['__proto__']: png() }
    doc.videoItem.movie.sprites[0].imageKey = '__proto__'
    // create保留特殊Key供协议编码；fromObject也会触发普通对象的原型setter。
    doc.originalBuffer = new Uint8Array(pako.deflate(MovieType.encode(MovieType.create(doc.videoItem.movie)).finish())).buffer
    doc.layers[0].imageKey = '__proto__'
    doc.layers[0].name = merge ? 'renamed' : '__proto__'
    await expect(buildProjectSvga(doc)).rejects.toThrow('源文件中改名')
  })
})

describe('文字、异步资源与任务隔离', () => {
  it.each([
    { mode: 'preview', merge: false }, { mode: 'bake', merge: false },
    { mode: 'preview', merge: true }, { mode: 'bake', merge: true }
  ] as const)('文字$mode按同一Key应用扩容，来源保留工程Key，merge=$merge', async ({ mode, merge }) => {
    const h = browserHarness()
    const doc = fixture()
    doc.layers[0].imageKey = '__proto__'
    doc.layers[0].name = merge ? 'named_text' : '__proto__'
    doc.slotConfigs = { ['__proto__']: textSlot(mode) }
    const before = structuredClone(doc)
    const artifact = await buildProjectSvga(doc)
    const output = await expectExactBindings(artifact)
    expect(artifact.bindings[0]).toMatchObject({ sourceImageKey: 'title', sourceSlotKey: '__proto__', baselineImageKey: merge ? 'named_text' : 'image_1' })
    expect(output.sprites[0].frames[0].layout).toMatchObject({ width: 120, height: 30 })
    expect(h.canvases.flatMap(entry => entry.text)).toEqual(mode === 'bake' ? ['2222222222222'] : [])
    expect(h.revoked).toEqual(Array.from(h.urls.keys()))
    expect(doc).toEqual(before)
  })

  it('提前取消不分配canvas或开始构建', async () => {
    const h = browserHarness()
    const controller = new AbortController()
    controller.abort()
    await expect(buildProjectSvga(fixture(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.canvases).toHaveLength(0)
  })

  it.each([false, true])('异步替换后取消不返回artifact，merge=%s', async merge => {
    const controller = new AbortController()
    const h = browserHarness({ onImage: () => controller.abort() })
    const doc = fixture()
    if (merge) doc.layers[0].name = 'renamed'
    doc.slotConfigs.title = { type: 'image', name: 'title', value: 'blob:replacement' }
    const before = structuredClone(doc)
    await expect(buildProjectSvga(doc, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(doc).toEqual(before)
    for (const { canvas } of h.canvases) expect(canvas).toMatchObject({ width: 0, height: 0 })
  })

  it('错误路径也释放renderer与顶层canvas，不返回半成品', async () => {
    const h = browserHarness({ failImages: true })
    const destroy = vi.spyOn(ExportEngine.prototype, 'destroy')
    const doc = fixture()
    doc.slotConfigs.title = { type: 'image', name: 'title', value: 'blob:missing' }
    await expect(buildProjectSvga(doc)).rejects.toThrow('title')
    expect(destroy).toHaveBeenCalledOnce()
    expect(h.canvases[0].canvas).toMatchObject({ width: 0, height: 0 })
  })

  it('并行构建两份不同工程，不共享任务中的绑定数组和可变引擎状态', async () => {
    const h = browserHarness({ holdImage: true })
    const a = fixture(['alpha'])
    const b = fixture(['beta'])
    a.layers[0].name = 'a_alias'
    b.layers[0].name = 'b_alias'
    a.slotConfigs.alpha = { type: 'image', name: 'a', value: 'blob:a' }
    b.slotConfigs.beta = { type: 'image', name: 'b', value: 'blob:b' }
    const pendingA = buildProjectSvga(a)
    const pendingB = buildProjectSvga(b)
    await vi.waitFor(() => expect(h.imageJobs).toHaveLength(2))
    await h.imageJobs[1]()
    const artifactB = await pendingB
    await h.imageJobs[0]()
    const artifactA = await pendingA
    await expectExactBindings(artifactA)
    await expectExactBindings(artifactB)
    expect(artifactA.bindings[0]).toMatchObject({ sourceImageKey: 'alpha', sourceSlotKey: 'alpha', baselineImageKey: 'a_alias' })
    expect(artifactB.bindings[0]).toMatchObject({ sourceImageKey: 'beta', sourceSlotKey: 'beta', baselineImageKey: 'b_alias' })
    expect(artifactA.bindings).not.toBe(artifactB.bindings)
  })
})
