import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import pako from 'pako'
import protobuf from 'protobufjs'
import type { FrameData, Layer, Movie, Transform, VideoItem } from '@/types'
import { useEditorStore } from '@/stores/editorStore'
import proto from './svga-proto'
import { createAnimationTracks } from './keyframe-editing'
import { createDefaultTracks } from './layer-factory'
import { getLayerBaseFrame, getLayerGeometry } from './layer-transform'
import { HighPerformanceRenderer } from './renderer.high-performance'
import { OfficialSvgRenderer } from './renderer.official'
import { SVGABuilder } from './svga-builder'

const MovieEntity = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
const params = { viewBoxWidth: 320, viewBoxHeight: 240, fps: 24, frames: 4 }
const state = () => useEditorStore.getState()
const sourceFrame = (index: number): FrameData => ({
  alpha: (index + 1) / 4,
  layout: { x: 3, y: 4, width: 40, height: 20 },
  transform: {
    a: index === 2 ? -1 : 1 + index / 4, b: 0.25 + index / 4,
    c: -0.5 + index / 4, d: 1.5 - index / 4, tx: 11 + index * 20, ty: 7 + index * 10
  },
  clipPath: `M0 0L${20 + index} 0L${20 + index} 12L0 12Z`
})

const encode = (value: Movie) => new Uint8Array(pako.deflate(MovieEntity.encode(MovieEntity.fromObject(value)).finish())).buffer
const decode = (buffer: ArrayBuffer): Movie => MovieEntity.toObject(
  MovieEntity.decode(pako.inflate(new Uint8Array(buffer))),
  { bytes: Uint8Array, arrays: true, objects: true, defaults: false, enums: String }
) as Movie

function prepare(withShapes = false) {
  const frames = Array.from({ length: params.frames }, (_, index) => sourceFrame(index))
  if (withShapes) frames[1].shapes = [{ type: 'RECT', rect: { x: 2, y: 3, width: 20, height: 10 }, styles: { fill: { r: 1, g: 0, b: 0, a: 0.5 } } }]
  const buffer = encode({ version: '2.0.0', params, images: { body: new Uint8Array([1, 2, 3]) }, sprites: [{ imageKey: 'body', matteKey: null, frames }] })
  const movie = decode(buffer)
  const image = { width: 40, height: 20, naturalWidth: 40, naturalHeight: 20, complete: true } as HTMLImageElement
  const video: VideoItem = { movie, images: { body: image }, buffers: {} }
  state().setVideoItem(video)
  state().setOriginalBuffer(buffer)
  return { buffer, movie, video, image }
}

function duplicate() {
  const original = state().layers[0]
  const id = state().duplicateLayer(original.id)
  expect(id).toBeTruthy()
  const copy = state().layers.find(layer => layer.id === id)!
  expect(copy.isNew).toBe(true)
  expect(copy.sprites).toBeDefined()
  return { original, copy }
}

async function merge(buffer: ArrayBuffer, layers: Layer[], frameCount: number) {
  const blob = await new SVGABuilder().mergeWithOriginal(buffer, {
    params: { ...params, frames: frameCount }, layers, imageResources: new Map(),
    imageSizes: new Map([['body', { width: 40, height: 20 }]])
  })
  return decode(await blob.arrayBuffer())
}

function addBothTrackSystems() {
  const tracks = createDefaultTracks()
  tracks.position.keyframes = [
    { id: 'legacy-p0', frameIndex: 0, value: { x: 4, y: -3 }, easing: 'linear' },
    { id: 'legacy-p3', frameIndex: 3, value: { x: 10, y: 3 }, easing: 'linear' }
  ]
  tracks.scale.keyframes = [
    { id: 'legacy-s0', frameIndex: 0, value: { scaleX: 1, scaleY: 0.5 }, easing: 'linear' },
    { id: 'legacy-s3', frameIndex: 3, value: { scaleX: 1.75, scaleY: 1.25 }, easing: 'linear' }
  ]
  tracks.rotation.keyframes = [
    { id: 'legacy-r0', frameIndex: 0, value: 0, easing: 'linear' },
    { id: 'legacy-r3', frameIndex: 3, value: 30, easing: 'linear' }
  ]
  tracks.alpha.keyframes = [
    { id: 'legacy-a0', frameIndex: 0, value: 0.5, easing: 'linear' },
    { id: 'legacy-a3', frameIndex: 3, value: 1, easing: 'linear' }
  ]
  const animationTracks = createAnimationTracks()
  animationTracks.position.keyframes = [
    { id: 'anim-p0', frameIndex: 0, value: { x: 2, y: 3 }, easing: 'linear' },
    { id: 'anim-p3', frameIndex: 3, value: { x: 11, y: -6 }, easing: 'linear' }
  ]
  animationTracks.scale.keyframes = [
    { id: 'anim-s0', frameIndex: 0, value: { scaleX: 1, scaleY: 0.8 }, easing: 'linear' },
    { id: 'anim-s3', frameIndex: 3, value: { scaleX: 1.3, scaleY: 1.4 }, easing: 'linear' }
  ]
  animationTracks.rotation.keyframes = [
    { id: 'anim-r0', frameIndex: 0, value: -15, easing: 'linear' },
    { id: 'anim-r3', frameIndex: 3, value: 45, easing: 'linear' }
  ]
  animationTracks.alpha.keyframes = [
    { id: 'anim-a0', frameIndex: 0, value: 0.75, easing: 'linear' },
    { id: 'anim-a3', frameIndex: 3, value: 0.9, easing: 'linear' }
  ]
  state().updateLayer(state().layers[0].id, {
    tracks, animationTracks, timeOffsetFrames: 2, clip: { startFrame: 1, duration: 3 }, opacity: 0.8,
    canvasTransform: { x: 7, y: -5, scaleX: 1.2, scaleY: 0.9, rotation: Math.PI / 6 }
  })
}

/** 用固定测试输入独立算中心变换，避免预览与导出共享同一错误而相互证明。 */
function expectedMatrix(source: Transform, x: number, y: number, scaleX: number, scaleY: number, degrees: number): Transform {
  const cos = Math.cos(degrees * Math.PI / 180)
  const sin = Math.sin(degrees * Math.PI / 180)
  const a = cos * scaleX * source.a - sin * scaleY * source.b
  const b = sin * scaleX * source.a + cos * scaleY * source.b
  const c = cos * scaleX * source.c - sin * scaleY * source.d
  const d = sin * scaleX * source.c + cos * scaleY * source.d
  return { a, b, c, d,
    tx: source.tx + source.a * 20 + source.c * 10 + x - a * 20 - c * 10,
    ty: source.ty + source.b * 20 + source.d * 10 + y - b * 20 - d * 10
  }
}

function expectedEditedFrame(index: number): FrameData {
  const source = sourceFrame(index)
  const legacy = expectedMatrix(source.transform, 4 + 2 * index, -3 + 2 * index, 1 + index / 4, 0.5 + index / 4, index * 10)
  return {
    ...source,
    transform: expectedMatrix(legacy, 9 + 3 * index, -2 - 3 * index, 1.2 * (1 + index / 10), 0.9 * (0.8 + index / 5), 15 + index * 20),
    alpha: source.alpha * (0.5 + index / 6) * 0.8 * (0.75 + index / 20)
  }
}

function expectMatrix(actual: Transform, expected: Transform) {
  for (const key of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) expect(actual[key], key).toBeCloseTo(expected[key], 4)
}

type DrawRecord = { image: unknown; matrix: number[]; alpha: number; clipPath: string | null }
function renderingHarness() {
  const draws: DrawRecord[] = []
  class ClipPath { constructor(public value: string) {} }
  const createCanvas = () => {
    let matrix = [1, 0, 0, 1, 0, 0]
    let clipPath: string | null = null
    const stack: Array<{ matrix: number[]; alpha: number; clipPath: string | null }> = []
    const ctx = {
      globalAlpha: 1, globalCompositeOperation: 'source-over',
      setTransform: (...values: number[]) => { matrix = values },
      clearRect: vi.fn(), transform: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
      clip: (value: ClipPath) => { clipPath = value.value },
      save: () => { stack.push({ matrix, alpha: ctx.globalAlpha, clipPath }) },
      restore: () => { const saved = stack.pop()!; matrix = saved.matrix; clipPath = saved.clipPath; ctx.globalAlpha = saved.alpha },
      drawImage: (image: unknown) => { draws.push({ image, matrix: [...matrix], alpha: ctx.globalAlpha, clipPath }) }
    }
    return { width: 320, height: 240, getContext: () => ctx } as unknown as HTMLCanvasElement
  }
  vi.stubGlobal('document', { createElement: createCanvas })
  vi.stubGlobal('window', { devicePixelRatio: 1 })
  vi.stubGlobal('Path2D', ClipPath)
  return { draws, createCanvas }
}

beforeEach(() => { state().reset() })
afterEach(() => { state().reset(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('复制导入层的实时预览与真实 SVGA 合并导出', () => {
  it('保留逐帧原矩阵、透明度和 clipPath，不把副本重建成静态图片', async () => {
    const input = prepare()
    const originalBefore = JSON.stringify(state().layers[0])
    const { original, copy } = duplicate()
    const exported = await merge(input.buffer, [original, copy], params.frames)
    expect(exported.sprites).toHaveLength(2)
    for (let index = 0; index < params.frames; index++) {
      expect(exported.sprites[0].frames[index]).toEqual(input.movie.sprites[0].frames[index])
      expect(exported.sprites[1].frames[index]).toEqual(input.movie.sprites[0].frames[index])
      expect(getLayerBaseFrame(copy, index, input.video)).toEqual(getLayerBaseFrame(original, index, input.video))
      expectMatrix(getLayerGeometry(copy, index, input.video)!.frame.transform, input.movie.sprites[0].frames[index].transform)
    }
    expect(exported.images[exported.sprites[1].imageKey]).toEqual(input.movie.images.body)
    expect(JSON.stringify(state().layers[0])).toBe(originalBefore)
    expect(decode(input.buffer)).toEqual(input.movie)
  })

  it.each([
    { offset: 2, clipStart: 0, duration: 4, total: 7 },
    { offset: -1, clipStart: 1, duration: 3, total: 5 }
  ])('偏移 $offset 帧后按源裁切取帧，副本尾部不会保持末帧', async ({ offset, clipStart, duration, total }) => {
    const input = prepare()
    state().updateLayer('0', { timeOffsetFrames: offset, clip: { startFrame: clipStart, duration } })
    const { original, copy } = duplicate()
    const exported = await merge(input.buffer, [original, copy], total)
    expect(exported.params.frames).toBe(total)
    expect(exported.sprites[1].frames).toHaveLength(total)
    for (let output = 0; output < total; output++) {
      const source = output - offset
      const frame = exported.sprites[1].frames[output]
      if (source < clipStart || source >= clipStart + duration || source < 0 || source >= params.frames) {
        expect(frame.alpha).toBe(0)
        expect(getLayerBaseFrame(copy, output, input.video)).toBeNull()
      } else {
        expect(frame).toEqual(input.movie.sprites[0].frames[source])
        expect(getLayerBaseFrame(copy, output, input.video)).toEqual(input.movie.sprites[0].frames[source])
      }
      expect(frame).toEqual(exported.sprites[0].frames[output])
    }
  })

  it.each(['high', 'official'] as const)('%s 副本与原层叠加旧轨道、新关键帧和静态变换恰好一次，预览及导出数值一致', async mode => {
    const input = prepare()
    addBothTrackSystems()
    const originalBefore = JSON.stringify(state().layers[0])
    const sourceBefore = JSON.stringify(input.movie)
    const { original, copy } = duplicate()
    const exported = await merge(input.buffer, [original, copy], 8)
    const h = renderingHarness()
    const renderer = mode === 'high' ? new HighPerformanceRenderer(h.createCanvas()) : new OfficialSvgRenderer(h.createCanvas())
    await renderer.setVideoItem(input.video, { waitForImages: true })

    for (let output = 0; output < 8; output++) {
      const source = output - 2
      const actual = exported.sprites[1].frames[output]
      expect(actual).toEqual(exported.sprites[0].frames[output])
      for (const layer of [original, copy]) {
        h.draws.length = 0
        await renderer.renderFrameAsync(output, { layers: [layer], useFrameCache: false })
        if (source < 1 || source > 3) {
          expect(actual.alpha).toBe(0)
          expect(h.draws).toHaveLength(0)
          expect(getLayerGeometry(layer, output, input.video)).toBeNull()
          continue
        }
        const expected = expectedEditedFrame(source)
        expectMatrix(actual.transform, expected.transform)
        expect(actual.alpha).toBeCloseTo(expected.alpha)
        expect(actual.clipPath).toBe(expected.clipPath)
        expect(actual.layout).toEqual(expected.layout)
        expectMatrix(getLayerGeometry(layer, output, input.video)!.frame.transform, expected.transform)
        expect(h.draws).toHaveLength(1)
        const draw = h.draws[0]
        expect(draw.image).toBe(input.image)
        expectMatrix({ a: draw.matrix[0], b: draw.matrix[1], c: draw.matrix[2], d: draw.matrix[3], tx: draw.matrix[4], ty: draw.matrix[5] }, expected.transform)
        expect(draw.alpha).toBeCloseTo(expected.alpha)
        expect(draw.clipPath).toBe(expected.clipPath)
      }
    }
    expect(JSON.stringify(state().layers[0])).toBe(originalBefore)
    expect(JSON.stringify(input.movie)).toBe(sourceBefore)
    expect(decode(input.buffer)).toEqual(input.movie)
  })

  it('副本获得独立关键帧 ID 和嵌套数据，编辑副本不影响原层或原输入', async () => {
    const input = prepare(true)
    addBothTrackSystems()
    const originalBefore = JSON.stringify(state().layers[0])
    const inputBefore = JSON.stringify(input.movie)
    const { original, copy } = duplicate()
    const originalIds = new Set([...Object.values(original.tracks), ...Object.values(original.animationTracks!)].flatMap(track => track.keyframes.map((key: { id: string }) => key.id)))
    const copyIds = [...Object.values(copy.tracks), ...Object.values(copy.animationTracks!)].flatMap(track => track.keyframes.map((key: { id: string }) => key.id))
    expect(copyIds).toHaveLength(originalIds.size)
    expect(new Set(copyIds).size).toBe(copyIds.length)
    expect(copyIds.every(id => !originalIds.has(id))).toBe(true)
    expect(copy.clip).not.toBe(original.clip)
    expect(copy.canvasTransform).not.toBe(original.canvasTransform)
    expect(copy.sprites!.frames[1].shapes![0].rect).not.toBe(original.sprites!.frames[1].shapes![0].rect)
    expect(copy.sprites!.frames[1].shapes![0].styles!.fill).not.toBe(original.sprites!.frames[1].shapes![0].styles!.fill)
    const exportedBefore = await merge(input.buffer, [original, copy], 8)
    expect(exportedBefore.sprites[1].frames[3].shapes).toEqual(input.movie.sprites[0].frames[1].shapes)

    copy.tracks.position.keyframes[0].value.x = 99
    copy.animationTracks!.position.keyframes[0].value.y = -200
    copy.sprites!.frames[1].transform.tx = 999
    copy.sprites!.frames[1].layout!.width = 123
    copy.sprites!.frames[1].shapes![0].rect!.x = 66
    copy.sprites!.frames[1].shapes![0].styles!.fill!.a = 0.2
    copy.clip.duration = 2
    copy.canvasTransform!.x = 88
    expect(JSON.stringify(original)).toBe(originalBefore)
    expect(JSON.stringify(input.movie)).toBe(inputBefore)
    const exportedAfter = await merge(input.buffer, [original, copy], 8)
    expect(exportedAfter.sprites[0].frames).toEqual(exportedBefore.sprites[0].frames)
    expect(exportedAfter.sprites[1].frames).not.toEqual(exportedBefore.sprites[1].frames)
    expect(decode(input.buffer)).toEqual(input.movie)
  })
})
