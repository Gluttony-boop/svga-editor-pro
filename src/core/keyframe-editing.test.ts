import { describe, expect, it } from 'vitest'
import pako from 'pako'
import protobuf from 'protobufjs'
import type { FrameData, Keyframe, Layer, LayerTracks, VideoItem } from '@/types'
import proto from './svga-proto'
import { applyEasing } from './animation-engine'
import { applyLayerFrameEdits, getLayerBaseFrame, getLayerGeometry } from './layer-transform'
import { createDefaultTracks } from './layer-factory'
import { ExportEngine } from './exporter'
import { SVGABuilder } from './svga-builder'
import {
  cloneAnimationTracks, createAnimationTracks, getKeyframeEditError, isValidAnimationValue,
  resolveCanvasTransform, resolveLayerOpacity, sampleAnimationValues
} from './keyframe-editing'

const sourceFrame = (index: number): FrameData => ({
  alpha: 0.8,
  layout: { x: 0, y: 0, width: 40, height: 20 },
  transform: { a: 1, b: 0, c: 0, d: 1, tx: 10 + index * 5, ty: 20 },
  clipPath: 'M0 0L40 0L40 20Z'
})
const makeLayer = (updates: Partial<Layer> = {}): Layer => ({
  id: '0', editableIndex: 0, name: '主体', type: 'image', visible: true, locked: false,
  expanded: true, opacity: 0.5, blendMode: 'normal', imageKey: 'body',
  clip: { startFrame: 0, duration: 11 }, tracks: createDefaultTracks(),
  sprites: { imageKey: 'body', matteKey: null, frames: Array.from({ length: 11 }, (_, index) => sourceFrame(index)) },
  ...updates
})
const keys = <T,>(start: T, end: T): Keyframe<T>[] => [
  { id: 'start', frameIndex: 0, value: start, easing: 'linear' },
  { id: 'end', frameIndex: 10, value: end, easing: 'linear' }
]
const withAnimation = (): Layer => {
  const layer = makeLayer({ animationTracks: createAnimationTracks(), canvasTransform: { x: 4, y: 6, scaleX: 2, scaleY: 3, rotation: Math.PI / 6 } })
  layer.animationTracks!.position.keyframes = keys({ x: 0, y: 0 }, { x: 20, y: -10 })
  layer.animationTracks!.scale.keyframes = keys({ scaleX: 1, scaleY: 1 }, { scaleX: 3, scaleY: 2 })
  layer.animationTracks!.rotation.keyframes = keys(0, 120)
  layer.animationTracks!.alpha.keyframes = keys(1, 0)
  return layer
}

describe('独立动画轨道采样与合成', () => {
  it('旧文件不含 animationTracks 时使用中性值，保留原动画和整段变换', () => {
    const layer = makeLayer()
    layer.tracks.position.keyframes = keys({ x: 100, y: 200 }, { x: 300, y: 400 })
    expect(sampleAnimationValues(layer, 5)).toEqual({ position: { x: 0, y: 0 }, scale: { scaleX: 1, scaleY: 1 }, rotation: 0, alpha: 1 })
    expect(resolveCanvasTransform(layer, 5)).toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 })
    expect(resolveLayerOpacity(layer, 5)).toBe(0.5)
  })

  it('位置相加、缩放相乘、角度转弧度后相加，透明度只乘一次', () => {
    const layer = withAnimation()
    const transform = resolveCanvasTransform(layer, 5)
    expect(transform).toEqual({ x: 14, y: 1, scaleX: 4, scaleY: 4.5, rotation: Math.PI / 2 })
    expect(resolveLayerOpacity(layer, 5)).toBe(0.25)
    expect(sampleAnimationValues(layer, 5).rotation).toBe(60)
  })

  it('输出时间映射源时间，只偏移一次；首尾在关键帧两端停留', () => {
    const layer = withAnimation()
    layer.timeOffsetFrames = 3
    expect(sampleAnimationValues(layer, 8)).toEqual(sampleAnimationValues({ ...layer, timeOffsetFrames: 0 }, 5))
    expect(sampleAnimationValues(layer, 0).position).toEqual({ x: 0, y: 0 })
    expect(sampleAnimationValues(layer, 30).position).toEqual({ x: 20, y: -10 })
  })

  it('单个显式关键帧向两端保持，不凭空补关键帧', () => {
    const layer = makeLayer({ animationTracks: createAnimationTracks() })
    layer.animationTracks!.position.keyframes = [{ id: 'only', frameIndex: 5, value: { x: 10, y: -20 }, easing: 'linear' }]
    expect(sampleAnimationValues(layer, 0).position).toEqual({ x: 10, y: -20 })
    expect(sampleAnimationValues(layer, 10).position).toEqual({ x: 10, y: -20 })
  })

  it('hold 在下一关键帧前维持旧值，到了下一帧才跳变', () => {
    expect(applyEasing(0.99, 'hold')).toBe(0)
    expect(applyEasing(1, 'hold')).toBe(1)
    const layer = withAnimation()
    layer.animationTracks!.position.keyframes[0].easing = 'hold'
    expect(sampleAnimationValues(layer, 9).position).toEqual({ x: 0, y: 0 })
    expect(sampleAnimationValues(layer, 10).position).toEqual({ x: 20, y: -10 })
  })

  it('缓动属于前一个关键帧，easeIn 采样与线性不同', () => {
    const layer = withAnimation()
    layer.animationTracks!.rotation.keyframes[0].easing = 'easeIn'
    expect(sampleAnimationValues(layer, 5).rotation).toBe(30)
  })

  it('基础几何不包含新动画；最终几何包含动画且不会改写源帧', () => {
    const layer = withAnimation()
    const before = JSON.stringify(layer)
    layer.tracks.position.keyframes = [{ id: 'preset', frameIndex: 0, value: { x: 7, y: 3 }, easing: 'linear' }]
    const source = sourceFrame(5)
    expect(getLayerBaseFrame(layer, 5)?.transform.tx).toBe(source.transform.tx + 7)
    const geometry = getLayerGeometry(layer, 5)!
    const edited = applyLayerFrameEdits(source, layer, 5)
    expect(geometry.frame.transform).toEqual(edited.transform)
    expect(edited.alpha).toBeCloseTo(0.2)
    expect(layer.sprites!.frames[5]).toEqual(source)
    expect(JSON.stringify({ ...layer, tracks: createDefaultTracks() })).toBe(before)
  })

  it('旧透明度预设与新透明度关键帧各乘一次，并保持clip隐藏规则', () => {
    const layer = withAnimation()
    layer.tracks.alpha.keyframes = [{ id: 'preset', frameIndex: 0, value: 0.5, easing: 'linear' }]
    expect(applyLayerFrameEdits(sourceFrame(5), layer, 5).alpha).toBeCloseTo(0.1)
    expect(applyLayerFrameEdits(sourceFrame(5), { ...layer, visible: false }, 5).alpha).toBe(0)
    expect(applyLayerFrameEdits(sourceFrame(5), { ...layer, clip: { startFrame: 6, duration: 5 } }, 5).alpha).toBe(0)
  })

  it('深拷贝隔离属性值和曲线点，复制轨道可创建新身份', () => {
    const original = withAnimation().animationTracks!
    original.position.keyframes[0].bezierControlPoints = { x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 }
    let nextId = 0
    const copy = cloneAnimationTracks(original, () => `copy-${++nextId}`)
    copy.position.keyframes[0].value.x = 50
    copy.position.keyframes[0].bezierControlPoints!.x1 = 0.8
    copy.scale.defaultValue.scaleX = 20
    expect(original.position.keyframes[0].value.x).toBe(0)
    expect(original.position.keyframes[0].bezierControlPoints!.x1).toBe(0.1)
    expect(original.scale.defaultValue.scaleX).toBe(1)
    expect(new Set(Object.values(copy).flatMap(track => track.keyframes.map((key: Keyframe) => key.id))).size).toBe(8)
  })
})

describe('关键帧编辑边界', () => {
  it.each([-1, 11, 0.5, NaN, Infinity])('拒绝越界或非整数输出帧 %s', frame => {
    expect(getKeyframeEditError(makeLayer(), frame, 11)).toBeTruthy()
  })

  it.each([0, -1, NaN, Infinity, 11.5])('拒绝非法总帧数 %s', count => {
    expect(getKeyframeEditError(makeLayer(), 0, count)).toBeTruthy()
  })

  it.each<Partial<Layer>>([
    { locked: true }, { visible: false }, { type: 'audio' },
    { clip: { startFrame: 2, duration: 4 } }, { clip: { startFrame: -1, duration: 4 } },
    { clip: { startFrame: 0, duration: NaN } }, { clip: { startFrame: 0, duration: 0 } },
    { timeOffsetFrames: 0.5 }, { timeOffsetFrames: NaN }, { timeOffsetFrames: 2 }
  ])('拒绝不可编辑图层 %o', updates => {
    expect(getKeyframeEditError(makeLayer(updates), 0, 11)).toBeTruthy()
  })

  it('裁切范围和原sprite范围独立校验，结束使用排他边界', () => {
    const layer = makeLayer({ timeOffsetFrames: 3, clip: { startFrame: 2, duration: 5 } })
    expect(getKeyframeEditError(layer, 5, 14)).toBeNull()
    expect(getKeyframeEditError(layer, 9, 14)).toBeNull()
    expect(getKeyframeEditError(layer, 10, 14)).toBeTruthy()
    const short = makeLayer({ clip: { startFrame: 0, duration: 20 } })
    expect(getKeyframeEditError(short, 11, 20)).toBeTruthy()
    expect(getKeyframeEditError({ ...short, isNew: true, sprites: undefined }, 11, 20)).toBeNull()
  })

  it.each<[keyof LayerTracks, unknown]>([
    ['position', { x: NaN, y: 0 }], ['position', null], ['position', { x: 0 }],
    ['scale', { scaleX: -1, scaleY: 1 }], ['scale', { scaleX: 1, scaleY: Infinity }],
    ['rotation', Infinity], ['rotation', '10'], ['alpha', -0.1], ['alpha', 1.1]
  ])('拒绝错误属性值 %s %s', (track, value) => {
    expect(isValidAnimationValue(track, value)).toBe(false)
  })

  it('允许缩放至零与多圈旋转', () => {
    expect(isValidAnimationValue('scale', { scaleX: 0, scaleY: 0 })).toBe(true)
    expect(isValidAnimationValue('rotation', 720)).toBe(true)
  })
})

describe('附加关键帧真实 SVGA 编码回读', () => {
  it.each(['exportSVGA', 'exportSVGALite', 'builder'] as const)('%s合成原逐帧动画、旧预设、新关键帧和时间偏移且保留独立图层', async method => {
    const Movie = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
    const layer = withAnimation()
    layer.timeOffsetFrames = 2
    layer.tracks.alpha.keyframes = [{ id: 'old-alpha', frameIndex: 0, value: 0.5, easing: 'linear' }]
    layer.tracks.position.keyframes = [{ id: 'old-position', frameIndex: 0, value: { x: 8, y: 4 }, easing: 'linear' }]
    const params = { viewBoxWidth: 320, viewBoxHeight: 240, frames: 11, fps: 24 }
    const source = { version: '2.0.0', params, images: { body: new Uint8Array([1, 2]) }, sprites: [layer.sprites!, { ...layer.sprites! }] }
    const buffer = new Uint8Array(pako.deflate(Movie.encode(Movie.fromObject(source)).finish())).buffer
    const other = makeLayer({ id: '1', editableIndex: 1, opacity: 1 })
    const layers = [layer, other]
    let blob: Blob
    if (method === 'builder') {
      blob = await new SVGABuilder().mergeWithOriginal(buffer, { params: { ...params, frames: 13 }, layers, imageResources: new Map() })
    } else {
      const engine = new ExportEngine({ getContext: () => ({}) } as unknown as HTMLCanvasElement)
      engine.setVideoItem({ movie: source, images: {}, buffers: {} } as VideoItem)
      blob = await engine[method](buffer, { fps: 24, frames: 13, layers })
    }
    const result = Movie.toObject(Movie.decode(pako.inflate(new Uint8Array(await blob.arrayBuffer()))), { bytes: Uint8Array, defaults: false, enums: String })
    expect(result.params.frames).toBe(13)
    expect(result.sprites[0].frames[0].alpha).toBe(0)
    expect(result.sprites[0].frames[1].alpha).toBe(0)
    const expected = applyLayerFrameEdits(sourceFrame(5), layer, 7)
    const actual = result.sprites[0].frames[7]
    for (const key of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) expect(actual.transform[key]).toBeCloseTo(expected.transform[key], 4)
    expect(actual.alpha).toBeCloseTo(0.1)
    expect(actual.clipPath).toBe(expected.clipPath)
    expect(result.sprites[1].frames[7].transform.tx).toBe(sourceFrame(7).transform.tx)
    expect(result.sprites[1].frames[7].alpha).toBeCloseTo(0.8)
    expect(layer.sprites!.frames[5]).toEqual(sourceFrame(5))
  })
})
