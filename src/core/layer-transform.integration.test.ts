import { afterEach, describe, expect, it, vi } from 'vitest'
import pako from 'pako'
import protobuf from 'protobufjs'
import type { FrameData, ImageResource, Layer, SlotConfig, VideoItem } from '@/types'
import proto from './svga-proto'
import { createDefaultTracks } from './layer-factory'
import { applyCanvasTransform, getFrameTransform } from './layer-transform'
import { ExportEngine } from './exporter'
import { SVGABuilder } from './svga-builder'
import { CanvasRenderer } from './renderer'
import { HighPerformanceRenderer } from './renderer.high-performance'
import { OfficialSvgRenderer } from './renderer.official'

const Movie = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
const params = { viewBoxWidth: 400, viewBoxHeight: 300, fps: 24, frames: 2 }
const edit = { x: 13, y: -17, scaleX: 1.5, scaleY: 0.7, rotation: Math.PI / 3 }
const frame = (tx = 40): FrameData => ({ alpha: 0.8, layout: { x: 0, y: 0, width: 100, height: 50 },
  transform: { a: 1.2, b: 0.4, c: 0.3, d: -0.8, tx, ty: 60 }, clipPath: 'M0 0L100 0L100 50Z' })
const encode = (value: object) => new Uint8Array(pako.deflate(Movie.encode(Movie.fromObject(value)).finish())).buffer
const decodeBuffer = (buffer: ArrayBuffer) => Movie.toObject(Movie.decode(pako.inflate(new Uint8Array(buffer))), { bytes: Uint8Array, defaults: false, enums: String })
const decode = async (blob: Blob) => decodeBuffer(await blob.arrayBuffer())
const makeInput = () => ({ version: '2.0.0', params, images: { shared: new Uint8Array([1, 2, 3]), mask: new Uint8Array([4, 5]) },
  sprites: [
    { imageKey: 'shared', matteKey: 'mask', frames: [{ ...frame(), shapes: [{ type: 'RECT', rect: { x: 0, y: 0, width: 10, height: 12 } }] }, frame(85)] },
    { imageKey: 'shared', frames: [frame(), frame(70)] },
    { imageKey: 'mask', frames: [frame(), frame()] }
  ], audios: [{ audioKey: 'sound', startFrame: 0, endFrame: 2, startTime: 0, totalTime: 90 }] })
const layersFor = (movie: ReturnType<typeof decodeBuffer>): Layer[] => movie.sprites.map((sprite: Layer['sprites'], index: number) => ({
  id: String(index), editableIndex: index, name: sprite!.imageKey, imageKey: sprite!.imageKey,
  type: 'image', visible: true, locked: false, expanded: true, opacity: 1, blendMode: 'normal',
  clip: { startFrame: 0, duration: params.frames }, tracks: createDefaultTracks(), sprites: sprite,
  canvasTransform: index === 0 ? edit : undefined
}))
const expectMatrix = (actual: FrameData['transform'], expected: FrameData['transform']) => {
  for (const key of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) expect(actual[key]).toBeCloseTo(expected[key], 4)
}
const addImportedPresets = (layer: Layer) => {
  const keys = <T,>(a: T, b: T) => [
    { id: 'start', frameIndex: 0, value: a, easing: 'linear' as const },
    { id: 'end', frameIndex: 1, value: b, easing: 'linear' as const }
  ]
  layer.tracks.position.keyframes = keys({ x: 10, y: 20 }, { x: -30, y: 40 })
  layer.tracks.scale.keyframes = keys({ scaleX: 1.2, scaleY: 0.8 }, { scaleX: 0.6, scaleY: 1.4 })
  layer.tracks.rotation.keyframes = keys(15, 90)
  layer.tracks.alpha.keyframes = keys(0.25, 0.75)
  layer.opacity = 0.5
}
const expectedPresetFrame = (base: FrameData, index: number) => {
  const tracked = applyCanvasTransform(base, index === 0
    ? { x: 10, y: 20, scaleX: 1.2, scaleY: 0.8, rotation: 15 * Math.PI / 180 }
    : { x: -30, y: 40, scaleX: 0.6, scaleY: 1.4, rotation: Math.PI / 2 })
  return applyCanvasTransform(tracked, edit)
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('真实SVGA编码回读', () => {
  it.each(['exportSVGA', 'exportSVGALite', 'builder'] as const)('%s保留原运动、共享层独立性、遮罩、路径、形状和音频', async method => {
    const buffer = encode(makeInput())
    const source = decodeBuffer(buffer)
    const layers = layersFor(source)
    let blob: Blob
    if (method === 'builder') {
      blob = await new SVGABuilder().mergeWithOriginal(buffer, { params, layers: [layers[1], layers[0], layers[2]], imageResources: new Map() })
    } else {
      const canvas = { getContext: () => ({}) } as unknown as HTMLCanvasElement
      const engine = new ExportEngine(canvas)
      engine.setVideoItem({ movie: source, images: {}, buffers: {} } as VideoItem)
      blob = await engine[method](buffer, { fps: 24, frames: 2, layers: [layers[1], layers[0], layers[2]] })
    }
    const output = await decode(blob)
    for (let index = 0; index < 2; index++) {
      expectMatrix(output.sprites[0].frames[index].transform, applyCanvasTransform(source.sprites[0].frames[index], edit).transform)
      expect(output.sprites[1].frames[index]).toEqual(source.sprites[1].frames[index])
    }
    expect(output.sprites[0].matteKey).toBe('mask')
    expect(output.sprites[0].frames[0].shapes).toEqual(source.sprites[0].frames[0].shapes)
    expect(output.sprites[0].frames[0].clipPath).toBe(source.sprites[0].frames[0].clipPath)
    expect(output.audios).toEqual(source.audios)
    expect(decodeBuffer(buffer)).toEqual(source)
  })

  it('protobuf继承的零默认值不能把稀疏矩阵变成零缩放', async () => {
    const input = makeInput()
    input.sprites[0].frames[0].transform = { tx: 0 } as FrameData['transform']
    input.sprites[0].frames[0].layout!.y = 9
    const buffer = encode(input)
    const source = decodeBuffer(buffer)
    const layers = layersFor(source)
    layers[0].canvasTransform = { x: 5, y: 6, scaleX: 1, scaleY: 1, rotation: 0 }
    const engine = new ExportEngine({ getContext: () => ({}) } as unknown as HTMLCanvasElement)
    engine.setVideoItem({ movie: source, images: {}, buffers: {} } as VideoItem)
    const output = await decode(await engine.exportSVGALite(buffer, { fps: 24, frames: 2, layers }))
    expect(output.sprites[0].frames[0].transform).toEqual({ a: 1, b: 0, c: 0, d: 1, tx: 5, ty: 15 })
  })

  it('新增图片先计算轨道，再且仅再应用一次画布调整', async () => {
    const buffer = encode(makeInput())
    const source = decodeBuffer(buffer)
    const layers = layersFor(source)
    const added: Layer = { ...layers[1], id: 'new', editableIndex: undefined, isNew: true, sprites: undefined,
      name: 'added', imageKey: 'added', tracks: createDefaultTracks(), canvasTransform: edit }
    added.tracks.position.defaultValue = { x: 21, y: 30 }
    const resources = new Map<string, ImageResource>([['added', { key: 'added', data: new Uint8Array([3, 4]), width: 80, height: 40, mimeType: 'image/png', isNew: true }]])
    const output = await decode(await new SVGABuilder().mergeWithOriginal(buffer, { params, layers: [...layers, added], imageResources: resources }))
    const base: FrameData = { alpha: 1, layout: { x: 0, y: 0, width: 80, height: 40 }, transform: { a: 1, b: 0, c: 0, d: 1, tx: 21, ty: 30 }, clipPath: null }
    expectMatrix(output.sprites[3].frames[0].transform, applyCanvasTransform(base, edit).transform)
  })

  it.each(['exportSVGA', 'exportSVGALite', 'builder'] as const)('%s按层烘焙透明度/隐藏，短sprite补透明而非复制最后一帧', async method => {
    const input = makeInput()
    input.sprites[0].frames = input.sprites[0].frames.slice(0, 1)
    const buffer = encode(input)
    const source = decodeBuffer(buffer)
    const layers = layersFor(source)
    layers[0].opacity = 0.5
    layers[1].visible = false
    let blob: Blob
    if (method === 'builder') {
      blob = await new SVGABuilder().mergeWithOriginal(buffer, { params, layers, imageResources: new Map() })
    } else {
      const engine = new ExportEngine({ getContext: () => ({}) } as unknown as HTMLCanvasElement)
      engine.setVideoItem({ movie: source, images: {}, buffers: {} } as VideoItem)
      blob = await engine[method](buffer, { fps: 24, frames: 2, layers })
    }
    const output = await decode(blob)
    expect(output.sprites[0].frames[0].alpha).toBeCloseTo(0.4)
    expect(output.sprites[0].frames[1].alpha).toBe(0)
    expect(output.sprites[1].frames.every((frame: FrameData) => frame.alpha === 0)).toBe(true)
    expect(output.sprites[2].frames[0].alpha).toBeCloseTo(0.8)
    expect(source.sprites[0].frames[0].alpha).toBeCloseTo(0.8)
  })

  it.each(['exportSVGA', 'exportSVGALite', 'builder'] as const)('%s保留导入层淡入、位移、旋转预设并在其后应用画布调整', async method => {
    const buffer = encode(makeInput())
    const source = decodeBuffer(buffer)
    const layers = layersFor(source)
    addImportedPresets(layers[0])
    let blob: Blob
    if (method === 'builder') {
      blob = await new SVGABuilder().mergeWithOriginal(buffer, { params, layers, imageResources: new Map() })
    } else {
      const engine = new ExportEngine({ getContext: () => ({}) } as unknown as HTMLCanvasElement)
      engine.setVideoItem({ movie: source, images: {}, buffers: {} } as VideoItem)
      blob = await engine[method](buffer, { fps: 24, frames: 2, layers })
    }
    const output = await decode(blob)
    for (let index = 0; index < 2; index++) {
      expectMatrix(output.sprites[0].frames[index].transform, expectedPresetFrame(source.sprites[0].frames[index], index).transform)
      expect(output.sprites[0].frames[index].alpha).toBeCloseTo(index === 0 ? 0.1 : 0.3)
      expect(output.sprites[1].frames[index]).toEqual(source.sprites[1].frames[index])
      expect(output.sprites[0].frames[index].clipPath).toBe(source.sprites[0].frames[index].clipPath)
    }
    expect(output.sprites[0].frames[0].shapes).toEqual(source.sprites[0].frames[0].shapes)
    expect(output.sprites[0].matteKey).toBe('mask')
  })

  it.each(['exportSVGA', 'exportSVGALite'] as const)('%s缺少layout时使用源图尺寸确定旋转中心', async method => {
    const input = makeInput()
    input.sprites[0].frames[0].layout = null
    const buffer = encode(input)
    const source = decodeBuffer(buffer)
    const layers = layersFor(source)
    const engine = new ExportEngine({ getContext: () => ({}) } as unknown as HTMLCanvasElement)
    engine.setVideoItem({ movie: source, images: { shared: { naturalWidth: 100, naturalHeight: 50 } }, buffers: {} } as unknown as VideoItem)
    const output = await decode(await engine[method](buffer, { fps: 24, frames: 2, layers }))
    expectMatrix(output.sprites[0].frames[0].transform, applyCanvasTransform(source.sprites[0].frames[0], edit, { width: 100, height: 50 }).transform)
  })
})

type DrawRecord = { image: unknown; matrix: number[]; composite: string; alpha: number }
function canvasHarness() {
  const canvases: Array<{ records: DrawRecord[]; canvas: HTMLCanvasElement }> = []
  const createCanvas = () => {
    const records: DrawRecord[] = []
    let matrix = [1, 0, 0, 1, 0, 0]
    const stack: Array<{ matrix: number[]; alpha: number; composite: string }> = []
    const ctx = {
      globalAlpha: 1, globalCompositeOperation: 'source-over',
      setTransform: (...values: number[]) => { matrix = values },
      transform: vi.fn(),
      clearRect: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), fill: vi.fn(), stroke: vi.fn(), clip: vi.fn(),
      save: () => { stack.push({ matrix, alpha: ctx.globalAlpha, composite: ctx.globalCompositeOperation }) },
      restore: () => { const state = stack.pop()!; matrix = state.matrix; ctx.globalAlpha = state.alpha; ctx.globalCompositeOperation = state.composite },
      drawImage: (image: unknown) => { records.push({ image, matrix: [...matrix], composite: ctx.globalCompositeOperation, alpha: ctx.globalAlpha }) }
    }
    const canvas = { width: 400, height: 300, getContext: () => ctx,
      toBlob: (callback: (blob: Blob) => void) => callback(new Blob(['encoded-pixels']))
    } as unknown as HTMLCanvasElement
    canvases.push({ records, canvas })
    return canvas
  }
  vi.stubGlobal('document', { createElement: () => createCanvas() })
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  vi.stubGlobal('Path2D', class {})
  const pending = new Map<string, () => void>()
  class MockImage {
    complete = false; width = 100; height = 50; naturalWidth = 100; naturalHeight = 50
    onload: (() => void) | null = null
    srcValue = ''
    set src(url: string) { this.srcValue = url; pending.set(url, () => { this.complete = true; this.onload?.() }) }
  }
  vi.stubGlobal('Image', MockImage)
  const image = { width: 100, height: 50, naturalWidth: 100, naturalHeight: 50, complete: true }
  const input = makeInput()
  input.sprites = input.sprites.slice(1, 2)
  const source = decodeBuffer(encode(input))
  const video = { movie: source, images: { shared: image }, buffers: {} } as unknown as VideoItem
  return { canvases, createCanvas, image, video, layers: layersFor(source), pending }
}

describe('预览与图像输出共享变换', () => {
  it.each(['high', 'official', 'canvas'] as const)('%s导入层关键帧按附加轨道绘制，透明度只乘一次', async mode => {
    const h = canvasHarness()
    addImportedPresets(h.layers[0])
    const canvas = h.createCanvas()
    const renderer = mode === 'high' ? new HighPerformanceRenderer(canvas) : mode === 'official' ? new OfficialSvgRenderer(canvas) : new CanvasRenderer(canvas)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    for (let index = 0; index < 2; index++) {
      await renderer.renderFrameAsync(index, { layers: h.layers, useFrameCache: false })
      const record = h.canvases[0].records.filter(item => item.image === h.image).at(-1)!
      const matrix = expectedPresetFrame(h.video.movie.sprites[0].frames[index], index).transform
      expect(record.matrix).toEqual([matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty])
      expect(record.alpha).toBeCloseTo(index === 0 ? 0.1 : 0.3)
    }
  })

  it('CanvasRenderer清空缓存后重新准备预计算帧', async () => {
    const h = canvasHarness()
    const renderer = new CanvasRenderer(h.createCanvas())
    renderer.setVideoItem(h.video)
    await renderer.renderFrameAsync(0, { layers: h.layers, useFrameCache: false })
    renderer.clearAllCaches()
    await renderer.renderFrameAsync(0, { layers: h.layers, useFrameCache: false })
    expect(h.canvases[0].records.filter(item => item.image === h.image)).toHaveLength(2)
  })

  it.each(['high', 'official', 'canvas'] as const)('%s绘制使用与SVGA导出一致的矩阵', async mode => {
    const h = canvasHarness()
    const canvas = h.createCanvas()
    const renderer = mode === 'high' ? new HighPerformanceRenderer(canvas) : mode === 'official' ? new OfficialSvgRenderer(canvas) : new CanvasRenderer(canvas)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    await renderer.renderFrameAsync(0, { layers: h.layers, useFrameCache: false })
    const record = h.canvases[0].records.find(item => item.image === h.image)!
    const matrix = getFrameTransform(applyCanvasTransform(h.video.movie.sprites[0].frames[0], edit))
    expect(record.matrix).toEqual([matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty])
  })

  it.each(['high', 'official'] as const)('%s等待替换解码、丢弃旧请求并可恢复源图', async mode => {
    const h = canvasHarness()
    const canvas = h.createCanvas()
    const renderer = mode === 'high' ? new HighPerformanceRenderer(canvas) : new OfficialSvgRenderer(canvas)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    const slots: Record<string, SlotConfig> = { shared: { type: 'image', name: 'shared', value: 'blob:new' } }
    let current = true
    const request = renderer.renderFrameAsync(0, { slotConfigs: slots, layers: h.layers, shouldRender: () => current, useFrameCache: false })
    expect(h.canvases[0].records).toHaveLength(0)
    current = false
    h.pending.get('blob:new')!()
    await request
    expect(h.canvases[0].records).toHaveLength(0)
    await renderer.renderFrameAsync(0, { slotConfigs: slots, layers: h.layers, useFrameCache: false })
    expect(h.canvases[0].records.at(-1)!.image).not.toBe(h.image)
    await renderer.renderFrameAsync(0, { slotConfigs: {}, layers: h.layers, useFrameCache: false })
    expect(h.canvases[0].records.at(-1)!.image).toBe(h.image)
  })

  it.each(['high', 'official', 'canvas'] as const)('%s使用遮罩自身变换且不跳过全透明遮罩', async mode => {
    const h = canvasHarness()
    const maskImage = { ...h.image }
    const maskFrame = { ...frame(90), alpha: 0 }
    h.video.movie.sprites[0].matteKey = 'mask'
    h.video.movie.sprites.push({ imageKey: 'mask', matteKey: null, frames: [maskFrame, maskFrame] })
    h.video.images.mask = maskImage as HTMLImageElement
    const maskLayer: Layer = { ...h.layers[0], id: '1', editableIndex: 1, name: 'mask', imageKey: 'mask', sprites: h.video.movie.sprites[1],
      canvasTransform: { x: -20, y: 10, scaleX: 1, scaleY: 1, rotation: 0 } }
    const canvas = h.createCanvas()
    const renderer = mode === 'high' ? new HighPerformanceRenderer(canvas) : mode === 'official' ? new OfficialSvgRenderer(canvas) : new CanvasRenderer(canvas)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    await renderer.renderFrameAsync(0, { layers: [...h.layers, maskLayer], useFrameCache: false })
    const records = h.canvases.flatMap(item => item.records)
    const maskDraw = records.find(item => item.image === maskImage)!
    expect(maskDraw.composite).toBe('destination-in')
    expect(maskDraw.alpha).toBe(0)
    const matrix = applyCanvasTransform(maskFrame, maskLayer.canvasTransform).transform
    expect(maskDraw.matrix).toEqual([matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty])
  })
})
