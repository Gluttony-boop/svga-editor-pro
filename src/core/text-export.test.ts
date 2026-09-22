import { afterEach, describe, expect, it, vi } from 'vitest'
import pako from 'pako'
import protobuf from 'protobufjs'
import UPNG from 'upng-js'
import type { FrameData, Layer, Movie, SlotConfig, VideoItem } from '@/types'
import proto from './svga-proto'
import { createDefaultTracks } from './layer-factory'
import { applyLayerFrameEdits } from './layer-transform'
import { encodeQuantizedPng } from './png-quantize'
import { ExportEngine } from './exporter'
import { SVGABuilder } from './svga-builder'
import { mapSlotsToExportImages, mapSlotsToSourceImages, prepareTextSlotsForExport } from './text-export'

const params = { viewBoxWidth: 500, viewBoxHeight: 300, fps: 24, frames: 2 }
const MovieType = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
const encode = (movie: object) => new Uint8Array(pako.deflate(MovieType.encode(MovieType.fromObject(movie)).finish())).buffer
const decode = async (blob: Blob) => MovieType.toObject(MovieType.decode(pako.inflate(new Uint8Array(await blob.arrayBuffer()))), { bytes: Uint8Array, defaults: false })
const png = (width: number, height: number) => new Uint8Array(encodeQuantizedPng(new Uint8Array(width * height * 4).fill(255), width, height, 64))
const readPng = (bytes: Uint8Array) => (UPNG as unknown as { decode(data: ArrayBuffer): { width: number; height: number } })
  .decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
const sourceBytes = png(80, 30)
const replacementBytes = png(160, 60)
const frame = (width = 80, height = 30): FrameData => ({
  alpha: 0.7, layout: { x: 4, y: 9, width, height },
  transform: { a: 0, b: 1.5, c: -0.75, d: 0, tx: 40, ty: 20 },
  clipPath: 'M0 0L80 0L80 30Z'
})
function slot(overrides: Partial<NonNullable<SlotConfig['textConfig']>> = {}): SlotConfig {
  return { type: 'text', name: 'title', value: null, textConfig: {
    text: '2222222222222', fontFamily: 'Arial', fontSize: 20, color: '#ffffff',
    boxWidth: 300, boxHeight: 40, referenceWidth: 80, referenceHeight: 30, ...overrides
  } }
}
function fixture() {
  const movie: Movie = { version: '2.0.0', params: { ...params }, images: { title: sourceBytes },
    sprites: [{ imageKey: 'title', matteKey: null, frames: [frame(), frame(40, 15)] }] }
  const layer: Layer = {
    id: '0', editableIndex: 0, name: 'title', imageKey: 'title', type: 'image', visible: true, locked: false,
    expanded: true, opacity: 1, blendMode: 'normal', clip: { startFrame: 0, duration: 2 }, tracks: createDefaultTracks(),
    sprites: movie.sprites[0]
  }
  return { movie, layers: [layer] }
}

/** 使用真实 PNG 与 protobuf 编解码；canvas 调用单独记录，字形像素另由浏览器验收。 */
function harness(options: { decodeFails?: boolean; encodeFails?: boolean; noContext?: boolean; fonts?: object } = {}) {
  const canvases: Array<{ canvas: HTMLCanvasElement; texts: string[]; draws: Array<{ image: unknown; args: number[] }> }> = []
  const urlBlobs = new Map<string, Blob>()
  const urls: string[] = []
  const revoked: string[] = []
  const loadedBytes: Uint8Array[] = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
    const url = `blob:text-export-${urls.length}`
    urls.push(url)
    urlBlobs.set(url, blob as Blob)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => { revoked.push(url) })
  const createCanvas = () => {
    const texts: string[] = []
    const draws: Array<{ image: unknown; args: number[] }> = []
    const ctx = { setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
      drawImage: (image: unknown, ...args: number[]) => { draws.push({ image, args }) },
      fillText: (text: string) => { texts.push(text) } }
    const canvas = {
      width: 10, height: 10, getContext: () => options.noContext ? null : ctx,
      toBlob: (callback: (blob: Blob | null) => void) => callback(options.encodeFails ? null : new Blob([png(canvas.width, canvas.height)], { type: 'image/png' }))
    } as unknown as HTMLCanvasElement
    canvases.push({ canvas, texts, draws })
    return canvas
  }
  class MockImage {
    width = 0; height = 0; naturalWidth = 0; naturalHeight = 0
    complete = false
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(value: string) {
      void (async () => {
        const bytes = value === 'blob:replacement' ? replacementBytes : new Uint8Array(await urlBlobs.get(value)!.arrayBuffer())
        loadedBytes.push(bytes)
        if (options.decodeFails) { this.onerror?.(); return }
        const image = readPng(bytes)
        this.width = this.naturalWidth = image.width
        this.height = this.naturalHeight = image.height
        this.complete = true
        this.onload?.()
      })()
    }
  }
  vi.stubGlobal('document', { createElement: createCanvas, fonts: options.fonts })
  vi.stubGlobal('Image', MockImage)
  vi.stubGlobal('window', { devicePixelRatio: 1 })
  return { canvases, createCanvas, urls, revoked, loadedBytes }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('文字容器导出语义', () => {
  it('preview 写透明扩容底图，不写模拟文字或隐藏原图，按原layout同比例扩展', async () => {
    const h = harness()
    const { movie } = fixture()
    const before = structuredClone(movie)
    const result = await prepareTextSlotsForExport(movie, { title: slot({ replaceImage: true }) })
    expect(result).not.toBe(movie)
    expect(movie).toEqual(before)
    expect(h.canvases).toHaveLength(1)
    expect(h.canvases[0].texts).toEqual([])
    expect(h.canvases[0].draws[0].args).toEqual([0, 0, 80, 30])
    expect(result.sprites[0].frames[0]).toMatchObject({ layout: { x: 4, y: 9, width: 300, height: 40 }, transform: frame().transform, clipPath: frame().clipPath, alpha: 0.7 })
    expect(result.sprites[0].frames[1].layout).toMatchObject({ width: 150, height: 20 })
    expect(readPng(result.images.title)).toMatchObject({ width: 300, height: 40 })
    expect(h.revoked).toEqual(h.urls)
  })

  it('bake 才写文字；同Key所有帧和共享引用复用同一PNG，不拆Key', async () => {
    const h = harness()
    const { movie } = fixture()
    movie.sprites.push({ ...movie.sprites[0], frames: [frame(160, 60), frame(60, 60)] })
    const result = await prepareTextSlotsForExport(movie, { title: slot({ exportMode: 'bake' }) })
    expect(h.canvases).toHaveLength(1)
    expect(h.canvases[0].texts).toEqual(['2222222222222'])
    expect(result.sprites.map(sprite => sprite.imageKey)).toEqual(['title', 'title'])
    expect(Object.keys(result.images)).toEqual(['title'])
    expect(result.sprites[1].frames[0].layout).toMatchObject({ width: 600, height: 80 })
    expect(result.sprites[1].frames[1].layout).toMatchObject({ width: 225, height: 80 })
  })

  it('仅文字有效启用时可使用比原图小的文字范围；禁用或空白保留底图范围', async () => {
    for (const override of [{}, { enabled: false }, { text: ' \n ' }]) {
      const h = harness()
      const { movie } = fixture()
      const result = await prepareTextSlotsForExport(movie, { title: slot({ boxWidth: 40, boxHeight: 20, replaceImage: true, exportMode: 'bake', ...override }) })
      const enabled = !('enabled' in override) && !('text' in override)
      expect(h.canvases[0].canvas.width).toBe(enabled ? 40 : 80)
      expect(h.canvases[0].draws).toHaveLength(enabled ? 0 : 1)
      expect(result.sprites[0].frames[0].layout?.width).toBe(enabled ? 40 : 80)
      vi.restoreAllMocks()
    }
  })

  it('无容器且未显式bake的旧配置保持数据和零额外绘制', async () => {
    const h = harness()
    const { movie } = fixture()
    const old: SlotConfig = { type: 'text', name: 'title', value: '旧标题' }
    expect(await prepareTextSlotsForExport(movie, { title: old })).toBe(movie)
    expect(h.canvases).toHaveLength(0)
    expect(h.urls).toHaveLength(0)
  })

  it('带matte与clip的内容层可扩容，遮罩数据不变', async () => {
    harness()
    const { movie } = fixture()
    movie.sprites[0].matteKey = 'mask'
    movie.images.mask = sourceBytes
    movie.sprites.push({ imageKey: 'mask', matteKey: null, frames: [frame(), frame()] })
    const maskBefore = structuredClone(movie.sprites[1])
    const result = await prepareTextSlotsForExport(movie, { title: slot() })
    expect(result.sprites[0].matteKey).toBe('mask')
    expect(result.sprites[0].frames[0].clipPath).toBe(frame().clipPath)
    expect(result.sprites[1]).toEqual(maskBefore)
    expect(result.images.mask).toEqual(sourceBytes)
  })

  it.each(['mask', 'shape', 'shared-shape'] as const)('%s Key 明确拒绝，不悄悄导出未编辑文件', async kind => {
    const h = harness()
    const { movie } = fixture()
    if (kind === 'mask') movie.sprites.push({ imageKey: 'content', matteKey: 'title', frames: [frame()] })
    else if (kind === 'shape') movie.sprites[0].frames[0].shapes = [{ type: 'RECT', rect: { x: 0, y: 0, width: 80, height: 30, cornerRadius: 0 } }]
    else movie.sprites.push({ imageKey: 'title', matteKey: null, frames: [{ ...frame(), shapes: [{ type: 'KEEP' }] }] })
    await expect(prepareTextSlotsForExport(movie, { title: slot() })).rejects.toThrow('遮罩或矢量')
    expect(h.urls).toHaveLength(0)
  })

  it.each([
    { boxWidth: 0 }, { boxWidth: 100.5 }, { boxWidth: 8193 }, { referenceHeight: undefined },
    { boxWidth: 8192, boxHeight: 8192 }, { boxWidth: 8192, boxHeight: 1, referenceWidth: 1, referenceHeight: 8192 }
  ])('非法尺寸原子组 %j 导出拒绝', async override => {
    const h = harness()
    await expect(prepareTextSlotsForExport(fixture().movie, { title: slot(override) })).rejects.toThrow()
    expect(h.urls).toHaveLength(0)
  })

  it('bake缺少容器坐标时拒绝，不猜测不稳定的逐帧宽度', async () => {
    harness()
    const configured = slot({ exportMode: 'bake' })
    for (const field of ['boxWidth', 'boxHeight', 'referenceWidth', 'referenceHeight'] as const) delete configured.textConfig![field]
    await expect(prepareTextSlotsForExport(fixture().movie, { title: configured })).rejects.toThrow('参考尺寸')
  })

  it('未引用的显式文字Key给出错误，而不是漏掉文字仍报告成功', async () => {
    harness()
    await expect(prepareTextSlotsForExport(fixture().movie, { missing: slot() })).rejects.toThrow('对应图层')
  })

  it.each(['decode', 'encode', 'context'] as const)('%s 失败拒绝并释放已创建URL', async failure => {
    const h = harness({ decodeFails: failure === 'decode', encodeFails: failure === 'encode', noContext: failure === 'context' })
    const { movie } = fixture()
    const before = structuredClone(movie)
    await expect(prepareTextSlotsForExport(movie, { title: slot({ exportMode: 'bake' }) })).rejects.toThrow()
    expect(h.urls).toHaveLength(1)
    expect(h.revoked).toEqual(h.urls)
    expect(movie).toEqual(before)
  })

  it('等待字体ready和指定字形load后才开始烘焙；字体失败明确拒绝', async () => {
    let ready!: () => void
    let loaded!: () => void
    const fontLoad = vi.fn(() => new Promise<void>(resolve => { loaded = resolve }))
    const h = harness({ fonts: { ready: new Promise<void>(resolve => { ready = resolve }), load: fontLoad } })
    const pending = prepareTextSlotsForExport(fixture().movie, { title: slot({ exportMode: 'bake' }) })
    expect(fontLoad).not.toHaveBeenCalled()
    expect(h.canvases).toHaveLength(0)
    ready()
    await Promise.resolve()
    expect(fontLoad).toHaveBeenCalledWith('normal 20px Arial', '2222222222222')
    expect(h.canvases).toHaveLength(0)
    loaded()
    await pending
    expect(h.canvases[0].texts).toHaveLength(1)
    fontLoad.mockRejectedValueOnce(new Error('font failed'))
    await expect(prepareTextSlotsForExport(fixture().movie, { title: slot({ exportMode: 'bake' }) })).rejects.toThrow('字体加载失败')
  })

  it('缺少底图的文字Key仍生成可独立播放PNG，保留稀疏帧坐标', async () => {
    const h = harness()
    const { movie } = fixture()
    movie.images = {}
    movie.sprites[0].frames[0].layout = null
    const result = await prepareTextSlotsForExport(movie, { title: slot({ exportMode: 'bake' }) })
    expect(h.urls).toHaveLength(0)
    expect(h.canvases[0].draws).toHaveLength(0)
    expect(result.sprites[0].frames[0].layout).toEqual({ width: 300, height: 40 })
    expect(result.images.title.byteLength).toBeGreaterThan(0)
  })

  it('超过64Mi累计像素在任何位图分配前拒绝', async () => {
    const h = harness()
    const { movie } = fixture()
    const slots: Record<string, SlotConfig> = {}
    for (let index = 0; index < 17; index++) {
      const key = `title${index}`
      movie.sprites.push({ imageKey: key, matteKey: null, frames: [frame()] })
      slots[key] = slot({ boxWidth: 2048, boxHeight: 2048 })
    }
    await expect(prepareTextSlotsForExport(movie, slots)).rejects.toThrow('64 Mi')
    expect(h.urls).toHaveLength(0)
    expect(h.canvases).toHaveLength(0)
  })

  it('已有图片超过128MiB总预算时，在深拷贝和解码之前拒绝', async () => {
    const h = harness()
    const { movie } = fixture()
    const shared = new Uint8Array(8 * 1024 * 1024)
    for (let index = 0; index < 17; index++) movie.images[`extra${index}`] = shared
    await expect(prepareTextSlotsForExport(movie, { title: slot() })).rejects.toThrow('128 MiB')
    expect(h.urls).toHaveLength(0)
    expect(h.canvases).toHaveLength(0)
  })

  it('压缩体积很小的超大PNG在创建Image URL前拒绝', async () => {
    const h = harness()
    const { movie } = fixture()
    movie.images.title = new Uint8Array(sourceBytes)
    new DataView(movie.images.title.buffer).setUint32(16, 100_000)
    await expect(prepareTextSlotsForExport(movie, { title: slot() })).rejects.toThrow('底图尺寸过大')
    expect(h.urls).toHaveLength(0)
  })

  it('多个底图累计解码超过64Mi时拒绝，并释放之前URL', async () => {
    const h = harness()
    const { movie } = fixture()
    movie.images = {}
    movie.sprites = []
    const slots: Record<string, SlotConfig> = {}
    const data = new Uint8Array(sourceBytes)
    const header = new DataView(data.buffer)
    header.setUint32(16, 4096)
    header.setUint32(20, 4096)
    for (let index = 0; index < 5; index++) {
      const key = `title${index}`
      movie.images[key] = data
      movie.sprites.push({ imageKey: key, matteKey: null, frames: [frame()] })
      slots[key] = slot()
    }
    await expect(prepareTextSlotsForExport(movie, slots)).rejects.toThrow('累计解码像素')
    expect(h.urls).toHaveLength(4)
    expect(h.revoked).toEqual(h.urls)
  })

  it('特殊资源名作为自有键处理，不读写对象原型', async () => {
    harness()
    const { movie } = fixture()
    movie.sprites[0].imageKey = '__proto__'
    movie.images = JSON.parse('{"__proto__":[]}')
    const slots: Record<string, SlotConfig> = Object.create(null)
    slots.__proto__ = slot({ exportMode: 'bake' })
    const result = await prepareTextSlotsForExport(movie, slots)
    expect(Object.getPrototypeOf(result.images)).toBe(null)
    expect(result.images.__proto__).toBeInstanceOf(Uint8Array)
    expect(movie.images.__proto__).toEqual([])
  })
})

describe('导出Key映射', () => {
  it('编辑态重命名映射回原protobuf源Key，包括共享多个引用', () => {
    const { movie, layers } = fixture()
    layers[0].imageKey = 'renamed'
    layers.push({ ...layers[0], id: '1', editableIndex: 1 })
    movie.sprites.push(movie.sprites[0])
    const config = slot()
    expect(Object.keys(mapSlotsToSourceImages({ renamed: config }, movie.sprites, layers))).toEqual(['title'])
    expect(mapSlotsToSourceImages({ renamed: config }, movie.sprites, layers).title).toBe(config)
  })
  it('同源原Key的一对多导出别名都保留文字，不遗漏副本', () => {
    const { layers } = fixture()
    layers.push({ ...layers[0], id: 'copy', isNew: true, name: 'copy' })
    const config = slot()
    const aliases = new Map([['0', 'renamed'], ['copy', 'copy']])
    expect(mapSlotsToExportImages({ title: config }, layers, aliases)).toEqual({ renamed: config, copy: config })
  })

  it('constructor和__proto__插槽只读取自有属性', () => {
    const { movie, layers } = fixture()
    layers[0].imageKey = 'constructor'
    expect(mapSlotsToSourceImages({}, movie.sprites, layers)).toEqual({})
    const config = slot()
    const slots: Record<string, SlotConfig> = { ['__proto__']: config }
    layers[0].imageKey = '__proto__'
    expect(mapSlotsToSourceImages(slots, movie.sprites, layers).title).toBe(config)
    const aliases = new Map([['0', '__proto__']])
    expect(mapSlotsToExportImages(slots, layers, aliases).__proto__).toBe(config)
  })
})

describe.each(['exportSVGA', 'exportSVGALite', 'mergeWithOriginal', 'build'] as const)('%s 实际protobuf回读', method => {
  async function exportFixture(options: {
    text: SlotConfig; rename?: boolean | string; duplicate?: boolean; sourceName?: string;
    missingLayout?: boolean; missingImage?: boolean; sourceDimensions?: { width: number; height: number }
  }) {
    const h = harness()
    const { movie, layers } = fixture()
    if (options.sourceName) {
      movie.images = { [options.sourceName]: sourceBytes }
      movie.sprites[0].imageKey = options.sourceName
      layers[0].imageKey = options.sourceName
      layers[0].name = options.sourceName
    }
    if (options.sourceDimensions) movie.images[movie.sprites[0].imageKey] = png(options.sourceDimensions.width, options.sourceDimensions.height)
    if (options.missingImage) movie.images = {}
    if (options.missingLayout) movie.sprites[0].frames[0].layout = null
    layers[0].canvasTransform = { x: 7, y: -4, scaleX: 1.2, scaleY: 0.8, rotation: Math.PI / 6 }
    const fallbackSize = options.missingImage ? { width: options.text.textConfig!.referenceWidth!, height: options.text.textConfig!.referenceHeight! }
      : options.sourceDimensions || { width: 80, height: 30 }
    const expectedFrame = applyLayerFrameEdits(movie.sprites[0].frames[0], layers[0], 0, fallbackSize)
    if (options.rename) {
      layers[0].imageKey = typeof options.rename === 'string' ? options.rename : 'renamed'
      layers[0].name = typeof options.rename === 'string' ? options.rename : 'design_title'
    }
    if (options.duplicate) layers.push({ ...layers[0], id: 'copy', editableIndex: undefined, isNew: true, name: 'duplicate_title' })
    const slots = { [layers[0].imageKey!]: options.text }
    const before = structuredClone({ movie, slots, layers })
    let output: Blob
    if (method === 'exportSVGA' || method === 'exportSVGALite') {
      const engine = new ExportEngine(h.createCanvas())
      const video: VideoItem = { movie, images: {}, buffers: {} }
      engine.setVideoItem(video)
      output = await engine[method](encode(movie), { fps: params.fps, frames: params.frames, layers, slotConfigs: slots })
    } else {
      const builder = new SVGABuilder()
      const config = { params, layers, imageResources: new Map(), slotConfigs: slots, originalImages: movie.images }
      output = method === 'build' ? await builder.build(config) : await builder.mergeWithOriginal(encode(movie), config)
    }
    expect({ movie, slots, layers }).toEqual(before)
    return { decoded: await decode(output), h, expectedFrame }
  }

  it('扩展范围进入protobuf，源底图保持80×30绘制且模拟文字不写入', async () => {
    const { decoded, h, expectedFrame } = await exportFixture({ text: slot() })
    expect(decoded.sprites[0].frames[0].layout).toMatchObject({ width: 300, height: 40 })
    expect(decoded.sprites[0].frames[1].layout).toMatchObject({ width: 150, height: 20 })
    const outputTransform = decoded.sprites[0].frames[0].transform
    for (const key of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) expect(outputTransform[key]).toBeCloseTo(expectedFrame.transform[key], 4)
    expect(decoded.sprites[0].frames[0].clipPath).toBe(frame().clipPath)
    expect(h.canvases.flatMap(item => item.texts)).toEqual([])
    expect(h.canvases.find(item => item.canvas.width === 300)?.draws[0].args).toEqual([0, 0, 80, 30])
    const pngInfo = readPng(decoded.images.title)
    expect(pngInfo).toMatchObject({ width: 300, height: 40 })
  })

  it('显式烘焙写入PNG，实际替换图为底图，保留命名后的Key', async () => {
    const text = { ...slot({ exportMode: 'bake' }), type: 'image' as const, value: 'blob:replacement' }
    // build 没有原protobuf身份，图片资源的Key须来自当前编辑态。
    const { decoded, h } = await exportFixture({ text, rename: method !== 'build', duplicate: method === 'mergeWithOriginal' })
    const target = method === 'build' ? 'title' : 'design_title'
    expect(decoded.sprites[0].imageKey).toBe(target)
    expect(h.canvases.flatMap(item => item.texts)).toContain('2222222222222')
    expect(h.loadedBytes.some(bytes => bytes.length === replacementBytes.length && bytes.every((value, index) => value === replacementBytes[index]))).toBe(true)
    expect(readPng(decoded.images[target])).toMatchObject({ width: 300, height: 40 })
    if (method === 'mergeWithOriginal') {
      expect(decoded.sprites).toHaveLength(2)
      expect(decoded.sprites[1].frames[0].layout.width).toBe(300)
      expect(readPng(decoded.images[decoded.sprites[1].imageKey])).toMatchObject({ width: 300, height: 40 })
      const compositions = h.canvases.filter(item => item.canvas.width === 300)
      expect(compositions).toHaveLength(2)
      for (const composition of compositions) {
        expect(composition.draws).toHaveLength(1)
        expect(composition.draws[0].image).toMatchObject({ width: 160, height: 60 })
      }
    }
  })

  it('缺layout时用替换前天然尺寸作回退，不把reference或替换图尺寸当原运动中心', async () => {
    const text = { ...slot({ referenceWidth: 100, referenceHeight: 50, boxWidth: 300, boxHeight: 50, exportMode: 'bake' }), type: 'image' as const, value: 'blob:replacement' }
    const { decoded, expectedFrame } = await exportFixture({ text, missingLayout: true, sourceDimensions: { width: 600, height: 200 } })
    expect(decoded.sprites[0].frames[0].layout).toEqual({ width: 1800, height: 200 })
    for (const key of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) {
      expect(decoded.sprites[0].frames[0].transform[key]).toBeCloseTo(expectedFrame.transform[key], 4)
    }
    expect(readPng(decoded.images.title)).toMatchObject({ width: 300, height: 50 })
  })

  it('缺原图且缺layout才回退reference，扩容后文字仍可见且保持该运动中心', async () => {
    const { decoded, expectedFrame } = await exportFixture({ text: slot({ exportMode: 'bake' }), missingLayout: true, missingImage: true })
    expect(decoded.sprites[0].frames[0].layout).toEqual({ width: 300, height: 40 })
    for (const key of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) {
      expect(decoded.sprites[0].frames[0].transform[key]).toBeCloseTo(expectedFrame.transform[key], 4)
    }
  })

  it.each(['title.vector', 'title.matte'])('保留配置后重命名为%s时拒绝烘焙，不能经原Key映射绕过', async renamed => {
    await expect(exportFixture({ text: slot({ exportMode: 'bake' }), rename: renamed })).rejects.toThrow('遮罩或矢量')
  })

  if (method !== 'build') it('普通Key不因历史protobuf名称带.vector而被误拒绝', async () => {
    const { decoded } = await exportFixture({ text: slot({ exportMode: 'bake' }), sourceName: 'historical.vector', rename: true })
    expect(decoded.sprites[0].imageKey).toBe('design_title')
    expect(readPng(decoded.images.design_title)).toMatchObject({ width: 300, height: 40 })
  })

  it.each(['__proto__', 'constructor'])('重命名为%s的烘焙结果可回读，保留实际底图且不修改输入Key', async name => {
    const text = { ...slot({ exportMode: 'bake' }), type: 'image' as const, value: 'blob:replacement' }
    const { decoded, h } = await exportFixture({ text, rename: name })
    const expectedKey = name === '__proto__' ? 'image_1' : name
    expect(decoded.sprites[0].imageKey).toBe(expectedKey)
    expect(Object.prototype.hasOwnProperty.call(decoded.images, expectedKey)).toBe(true)
    expect(readPng(decoded.images[expectedKey])).toMatchObject({ width: 300, height: 40 })
    const composition = h.canvases.find(item => item.canvas.width === 300)!
    expect(composition.draws[0].image).toMatchObject({ width: 160, height: 60 })
    expect(composition.texts).toEqual(['2222222222222'])
  })

  if (method !== 'build') it('原proto含decoder不能安全保留的__proto__时明确拒绝，不输出丢图SVGA', async () => {
    const h = harness()
    const { movie, layers } = fixture()
    movie.images = { ['__proto__']: sourceBytes }
    movie.sprites[0].imageKey = '__proto__'
    layers[0].imageKey = '__proto__'
    layers[0].name = '__proto__'
    const bytes = new Uint8Array(pako.deflate(MovieType.encode(MovieType.create(movie)).finish())).buffer
    const slots = { ['__proto__']: slot({ exportMode: 'bake' }) }
    if (method === 'mergeWithOriginal') {
      await expect(new SVGABuilder().mergeWithOriginal(bytes, { params, layers, imageResources: new Map(), slotConfigs: slots })).rejects.toThrow('无法安全解码')
    } else {
      const engine = new ExportEngine(h.createCanvas())
      engine.setVideoItem({ movie, images: {}, buffers: {} })
      await expect(engine[method](bytes, { fps: params.fps, frames: params.frames, layers, slotConfigs: slots })).rejects.toThrow('无法安全解码')
    }
  })
})
