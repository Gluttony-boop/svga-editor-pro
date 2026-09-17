import { afterEach, describe, expect, it, vi } from 'vitest'
import pako from 'pako'
import protobuf from 'protobufjs'
import type { FrameData, ImageResource, Layer, VideoItem } from '@/types'
import proto from './svga-proto'
import { createDefaultTracks } from './layer-factory'
import { getLayerOutputRange, getLayerSourceFrame, getLayerTimeOffset } from './layer-time'
import { getLayerBaseFrame, getLayerGeometry } from './layer-transform'
import { ExportEngine } from './exporter'
import { SVGABuilder } from './svga-builder'
import { CanvasRenderer } from './renderer'
import { HighPerformanceRenderer } from './renderer.high-performance'
import { OfficialSvgRenderer } from './renderer.official'

const Movie = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
const params = { viewBoxWidth: 320, viewBoxHeight: 240, fps: 24, frames: 4 }
const frame = (index: number): FrameData => ({
  alpha: (index + 1) / 4,
  layout: { x: 0, y: 0, width: 20, height: 10 },
  transform: { a: 1, b: 0, c: 0, d: 1, tx: 10 + index * 10, ty: 20 },
  clipPath: null
})
const makeInput = () => ({
  version: '2.0.0', params,
  images: { body: new Uint8Array([1]), mask: new Uint8Array([2]), sound: new Uint8Array([3]) },
  sprites: [
    { imageKey: 'body', matteKey: 'mask', frames: Array.from({ length: 4 }, (_, index) => ({
      ...frame(index), clipPath: `M0 0L${index + 1} 0L0 3Z`,
      shapes: [{ type: 'RECT', rect: { x: index, y: 0, width: 10, height: 5 } }]
    })) },
    { imageKey: 'mask', frames: Array.from({ length: 4 }, (_, index) => frame(index)) }
  ],
  audios: [{ audioKey: 'sound', startFrame: 0, endFrame: 4, startTime: 0, totalTime: 160 }]
})
const encode = (value: object) => new Uint8Array(pako.deflate(Movie.encode(Movie.fromObject(value)).finish())).buffer
const decode = (buffer: ArrayBuffer) => Movie.toObject(Movie.decode(pako.inflate(new Uint8Array(buffer))), { bytes: Uint8Array, defaults: false, enums: String })
const layersFor = (movie: ReturnType<typeof decode>): Layer[] => movie.sprites.map((sprite: Layer['sprites'], index: number) => ({
  id: String(index), editableIndex: index, name: sprite!.imageKey, imageKey: sprite!.imageKey,
  type: 'image', visible: true, locked: false, expanded: true, opacity: 1, blendMode: 'normal',
  clip: { startFrame: 0, duration: params.frames }, tracks: createDefaultTracks(), sprites: sprite
}))
const applyTracks = (layer: Layer) => {
  layer.tracks.position.keyframes = [
    { id: 'p0', frameIndex: 0, value: { x: 5, y: 0 }, easing: 'linear' },
    { id: 'p3', frameIndex: 3, value: { x: 11, y: 0 }, easing: 'linear' }
  ]
  layer.tracks.alpha.keyframes = [
    { id: 'a0', frameIndex: 0, value: 0.5, easing: 'linear' },
    { id: 'a3', frameIndex: 3, value: 1, easing: 'linear' }
  ]
  layer.canvasTransform = { x: 3, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }
  layer.opacity = 0.5
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('时间偏移与真实 SVGA 导出回读', () => {
  it('默认偏移兼容旧工程，输出结束帧使用排他边界', () => {
    expect(getLayerTimeOffset({})).toBe(0)
    for (const value of [NaN, Infinity, 1.2]) expect(getLayerTimeOffset({ timeOffsetFrames: value })).toBe(0)
    expect(getLayerSourceFrame({ timeOffsetFrames: 3 }, 5)).toBe(2)
    expect(getLayerOutputRange({ clip: { startFrame: 2, duration: 4 }, timeOffsetFrames: -1 })).toEqual({ startFrame: 1, endFrame: 5 })
  })

  it.each(['exportSVGA', 'exportSVGALite', 'builder'] as const)('%s按目标帧数烘焙延后尾帧，保留轨道/形状/裁剪/遮罩/音频', async method => {
    const buffer = encode(makeInput())
    const source = decode(buffer)
    const layers = layersFor(source)
    layers.forEach(layer => { layer.timeOffsetFrames = 2 })
    applyTracks(layers[0])
    const before = JSON.stringify(layers)
    let blob: Blob
    if (method === 'builder') {
      blob = await new SVGABuilder().mergeWithOriginal(buffer, { params: { ...params, frames: 6 }, layers, imageResources: new Map() })
    } else {
      const engine = new ExportEngine({ getContext: () => ({}) } as unknown as HTMLCanvasElement)
      engine.setVideoItem({ movie: source, images: {}, buffers: {} } as VideoItem)
      blob = await engine[method](buffer, { fps: params.fps, frames: 6, layers })
    }
    const result = decode(await blob.arrayBuffer())
    expect(result.params.frames).toBe(6)
    expect(result.sprites[0].frames).toHaveLength(6)
    expect(result.sprites[0].frames.slice(0, 2).every((value: FrameData) => value.alpha === 0)).toBe(true)
    for (let index = 0; index < 4; index++) {
      const output = result.sprites[0].frames[index + 2]
      expect(output.transform.tx).toBeCloseTo(18 + index * 12)
      expect(output.alpha).toBeCloseTo((index + 1) / 4 * (0.5 + index / 6) * 0.5)
      expect(output.clipPath).toBe(source.sprites[0].frames[index].clipPath)
      expect(output.shapes).toEqual(source.sprites[0].frames[index].shapes)
      expect(result.sprites[1].frames[index + 2]).toEqual(source.sprites[1].frames[index])
    }
    expect(result.sprites[0].matteKey).toBe('mask')
    expect(result.audios).toEqual(source.audios)
    expect(decode(buffer)).toEqual(source)
    expect(JSON.stringify(layers)).toBe(before)
  })

  it.each(['exportSVGA', 'exportSVGALite', 'builder'] as const)('%s负偏移遵守源裁切且短 sprite 不保持末帧', async method => {
    const input = makeInput()
    input.sprites[1].frames = input.sprites[1].frames.slice(0, 3)
    const buffer = encode(input)
    const source = decode(buffer)
    const layers = layersFor(source)
    layers.forEach(layer => { layer.timeOffsetFrames = -1; layer.clip = { startFrame: 2, duration: 2 } })
    let blob: Blob
    if (method === 'builder') {
      blob = await new SVGABuilder().mergeWithOriginal(buffer, { params, layers, imageResources: new Map() })
    } else {
      const engine = new ExportEngine({ getContext: () => ({}) } as unknown as HTMLCanvasElement)
      engine.setVideoItem({ movie: source, images: {}, buffers: {} } as VideoItem)
      blob = await engine[method](buffer, { fps: params.fps, frames: 4, layers })
    }
    const result = decode(await blob.arrayBuffer())
    expect(result.sprites[0].frames.map((value: FrameData) => value.alpha)).toEqual([0, 0.75, 1, 0])
    expect(result.sprites[1].frames.map((value: FrameData) => value.alpha)).toEqual([0, 0.75, 0, 0])
    expect(result.sprites[0].frames[1].transform.tx).toBe(30)
  })

  it.each(['build', 'merge'] as const)('新增图层 %s 轨道只按源帧计算一次', async method => {
    const buffer = encode(makeInput())
    const source = decode(buffer)
    const added: Layer = { ...layersFor(source)[0], id: 'new', name: 'added', imageKey: 'added', isNew: true,
      editableIndex: undefined, sprites: undefined, timeOffsetFrames: 2 }
    applyTracks(added)
    const resources = new Map<string, ImageResource>([['added', {
      key: 'added', data: new Uint8Array([4]), width: 20, height: 10, mimeType: 'image/png', isNew: true
    }]])
    const config = { params: { ...params, frames: 7 }, layers: [added], imageResources: resources, imageSizes: new Map([['added', { width: 20, height: 10 }]]) }
    const builder = new SVGABuilder()
    const blob = method === 'build' ? await builder.build(config) : await builder.mergeWithOriginal(buffer, config)
    const frames = decode(await blob.arrayBuffer()).sprites[0].frames
    expect(frames.map((value: FrameData) => value.alpha)).toEqual([0, 0, 0.25, expect.closeTo(1 / 3), expect.closeTo(5 / 12), 0.5, 0])
    expect(frames[2].transform.tx).toBe(8)
    expect(frames[5].transform.tx).toBe(14)
  })

  it('几何边界与排程源帧同步，范围外没有画布手柄', () => {
    const source = decode(encode(makeInput()))
    const layer = layersFor(source)[0]
    layer.timeOffsetFrames = 2
    applyTracks(layer)
    expect(getLayerBaseFrame(layer, 1)).toBeNull()
    expect(getLayerGeometry(layer, 6)).toBeNull()
    expect(getLayerBaseFrame(layer, 5)!.transform.tx).toBe(51)
    expect(getLayerGeometry(layer, 5)!.frame.transform.tx).toBe(54)
  })
})

type DrawRecord = { image: unknown; matrix: number[]; alpha: number; composite: string }
function canvasHarness() {
  const draws: DrawRecord[] = []
  const createCanvas = () => {
    let matrix = [1, 0, 0, 1, 0, 0]
    const stack: Array<{ matrix: number[]; alpha: number; composite: string }> = []
    const ctx = {
      globalAlpha: 1, globalCompositeOperation: 'source-over',
      setTransform: (...values: number[]) => { matrix = values }, transform: vi.fn(), clearRect: vi.fn(),
      beginPath: vi.fn(), rect: vi.fn(), fill: vi.fn(), stroke: vi.fn(), clip: vi.fn(),
      save: () => { stack.push({ matrix, alpha: ctx.globalAlpha, composite: ctx.globalCompositeOperation }) },
      restore: () => { const state = stack.pop()!; matrix = state.matrix; ctx.globalAlpha = state.alpha; ctx.globalCompositeOperation = state.composite },
      drawImage: (image: unknown) => { draws.push({ image, matrix: [...matrix], alpha: ctx.globalAlpha, composite: ctx.globalCompositeOperation }) }
    }
    return { width: 320, height: 240, getContext: () => ctx } as unknown as HTMLCanvasElement
  }
  vi.stubGlobal('document', { createElement: createCanvas })
  vi.stubGlobal('window', { devicePixelRatio: 1 })
  vi.stubGlobal('Path2D', class {})
  const image = { width: 20, height: 10, naturalWidth: 20, naturalHeight: 10, complete: true } as HTMLImageElement
  const input = makeInput()
  input.sprites[0].frames = Array.from({ length: 4 }, (_, index) => frame(index)) as typeof input.sprites[0]['frames']
  const source = decode(encode(input))
  const maskImage = { ...image } as HTMLImageElement
  const video = { movie: source, images: { body: image, mask: maskImage }, buffers: {} } as unknown as VideoItem
  return { draws, createCanvas, image, maskImage, video, layers: layersFor(source) }
}

describe('实时渲染的排程取帧与遮罩保护', () => {
  it.each(['high', 'official', 'canvas'] as const)('%s内容和遮罩各按自己的源时间，边界外不能露图', async mode => {
    const h = canvasHarness()
    h.layers[0].timeOffsetFrames = 1
    h.layers[1].timeOffsetFrames = 2
    applyTracks(h.layers[0])
    const renderer = mode === 'high' ? new HighPerformanceRenderer(h.createCanvas()) : mode === 'official'
      ? new OfficialSvgRenderer(h.createCanvas()) : new CanvasRenderer(h.createCanvas())
    await renderer.setVideoItem(h.video, { waitForImages: true })
    for (const index of [0, 1, 5, 6]) {
      h.draws.length = 0
      await renderer.renderFrameAsync(index, { layers: h.layers, useFrameCache: false })
      expect(h.draws).toHaveLength(0)
    }
    await renderer.renderFrameAsync(3, { layers: h.layers, useFrameCache: false })
    const content = h.draws.find(value => value.image === h.image)!
    const mask = h.draws.find(value => value.image === h.maskImage)!
    expect(content.matrix[4]).toBe(42)
    expect(content.alpha).toBeCloseTo(0.75 * (0.5 + 2 / 6) * 0.5)
    expect(mask.matrix[4]).toBe(20)
    expect(mask.composite).toBe('destination-in')
    expect(mask.alpha).toBe(0.5)
  })

  it.each(['high', 'official', 'canvas'] as const)('%s裁切或删除遮罩不会退回未遮罩内容', async mode => {
    const h = canvasHarness()
    const renderer = mode === 'high' ? new HighPerformanceRenderer(h.createCanvas()) : mode === 'official'
      ? new OfficialSvgRenderer(h.createCanvas()) : new CanvasRenderer(h.createCanvas())
    await renderer.setVideoItem(h.video, { waitForImages: true })
    h.layers[1].clip = { startFrame: 2, duration: 1 }
    await renderer.renderFrameAsync(0, { layers: h.layers, useFrameCache: false })
    expect(h.draws).toHaveLength(0)
    await renderer.renderFrameAsync(2, { layers: [h.layers[0]], useFrameCache: false })
    expect(h.draws).toHaveLength(0)
  })

  it.each(['high', 'official'] as const)('%s偏移修改使相同输出帧的缓存失效', async mode => {
    const h = canvasHarness()
    h.video.movie.sprites[0].matteKey = null
    h.video.movie.sprites = h.video.movie.sprites.slice(0, 1)
    const renderer = mode === 'high' ? new HighPerformanceRenderer(h.createCanvas()) : new OfficialSvgRenderer(h.createCanvas())
    await renderer.setVideoItem(h.video, { waitForImages: true })
    await renderer.renderFrameAsync(2, { layers: [h.layers[0]], useFrameCache: true })
    expect(h.draws.find(value => value.image === h.image)!.matrix[4]).toBe(30)
    h.draws.length = 0
    await renderer.renderFrameAsync(2, { layers: [{ ...h.layers[0], timeOffsetFrames: 1 }], useFrameCache: true })
    expect(h.draws.find(value => value.image === h.image)!.matrix[4]).toBe(20)
  })
})
