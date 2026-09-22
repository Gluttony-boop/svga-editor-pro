import { afterEach, describe, expect, it, vi } from 'vitest'
import protobuf from 'protobufjs'
import pako from 'pako'
import proto from './svga-proto'
import { SVGAOptimizer, getPreset } from './optimizer'

const Movie = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
const frame = { alpha: 1, layout: { x: 5, y: 7, width: 200, height: 100 }, transform: { a: 1, b: 0, c: 0, d: 1, tx: 31, ty: 47 } }
const make = (extra = {}) => ({ version: '2.0', params: { viewBoxWidth: 400, viewBoxHeight: 300, fps: 24, frames: 1 }, images: {}, sprites: [{ imageKey: 'image', frames: [frame] }], ...extra })
const encode = (movie: object) => new Uint8Array(pako.deflate(Movie.encode(Movie.create(movie)).finish())).buffer
const decode = async (blob: Blob) => Movie.toObject(Movie.decode(pako.inflate(new Uint8Array(await blob.arrayBuffer()))), { bytes: Uint8Array, defaults: false })
const config = () => structuredClone(getPreset('light')!.config)

function browserCodec() {
  class MockImage {
    width = 200; height = 100; naturalWidth = 200; naturalHeight = 100
    onload: (() => void) | null = null
    set src(_value: string) { queueMicrotask(() => this.onload?.()) }
  }
  const dimensions: number[][] = []
  vi.stubGlobal('Image', MockImage)
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ clearRect: () => {}, drawImage: () => {} }),
    toBlob(callback: (blob: Blob) => void) { dimensions.push([this.width, this.height]); callback(new Blob([new Uint8Array(4)], { type: 'image/png' })) }
  }) })
  return dimensions
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('export compression regressions', () => {
  it('texture compression preserves canvas dimensions and sprite geometry', async () => {
    browserCodec()
    const input = make({ images: { image: new Uint8Array(100) } })
    const options = config(); options.image.resizeEnabled = true; options.image.resizePercent = 50
    const output = await decode(await new SVGAOptimizer().optimize(encode(input), options))
    expect(output.params).toEqual(input.params)
    expect(output.sprites[0].frames[0]).toEqual(frame)
  })
  it('applies max texture size even when the scale percentage is 100', async () => {
    const dimensions = browserCodec()
    const options = config(); options.image.resizeEnabled = true; options.image.resizePercent = 100; options.image.maxWidth = 50
    await new SVGAOptimizer().optimize(encode(make({ images: { image: new Uint8Array(100) } })), options)
    expect(dimensions).toContainEqual([50, 25])
  })
  it('applies an explicitly enabled target size independently of percentage resizing and never upscales', async () => {
    const dimensions = browserCodec()
    const input = make({ images: { image: new Uint8Array(10_000) } })
    const options = config()
    options.image.resizeEnabled = false
    options.image.sizeLimitEnabled = true
    options.image.maxWidth = 80
    options.image.maxHeight = 60
    await new SVGAOptimizer().optimize(encode(input), options)
    expect(dimensions).toContainEqual([80, 40])

    const largerLimitDimensions = browserCodec()
    options.image.maxWidth = 500
    options.image.maxHeight = 500
    await new SVGAOptimizer().optimize(encode(input), options)
    expect(largerLimitDimensions).toContainEqual([200, 100])
  })
  it('uses the embedded viewBox when automatic canvas resizing has no explicit canvas argument', async () => {
    const dimensions = browserCodec()
    const input = make({ params: { viewBoxWidth: 50, viewBoxHeight: 50, fps: 24, frames: 1 }, images: { image: new Uint8Array(10_000) } })
    const options = config()
    options.image.autoResizeToCanvas = true
    await new SVGAOptimizer().optimize(encode(input), options)
    expect(dimensions).toContainEqual([50, 25])
  })
  it('automatically caps texture dimensions by the export canvas without changing authored geometry', async () => {
    const dimensions = browserCodec()
    const input = make({
      params: { viewBoxWidth: 400, viewBoxHeight: 300, fps: 24, frames: 1 },
      images: { image: new Uint8Array(10_000) },
      sprites: [{ imageKey: 'image', frames: [{ ...frame, layout: null }] }]
    })
    const options = config()
    options.image.autoResizeToCanvas = true
    options.image.resizeEnabled = false
    const output = await decode(await new SVGAOptimizer().optimize(encode(input), options, undefined, { width: 50, height: 50 }))
    expect(dimensions).toContainEqual([50, 25])
    expect(output.params).toEqual(input.params)
    // 缺少 layout 时，导出仍显式保留原图片固有显示尺寸，避免纹理降采样导致画面缩小。
    expect(output.sprites[0].frames[0].layout).toEqual({ width: 200, height: 100 })
  })
  it('fills only missing dimensions in a partial layout and keeps authored coordinates', async () => {
    browserCodec()
    const input = make({
      images: { image: new Uint8Array(10_000) },
      sprites: [{ imageKey: 'image', frames: [{ ...frame, layout: { x: 9, width: 80 } }] }]
    })
    const options = config()
    options.image.autoResizeToCanvas = true
    const output = await decode(await new SVGAOptimizer().optimize(encode(input), options, undefined, { width: 50, height: 50 }))
    expect(output.sprites[0].frames[0].layout).toMatchObject({ x: 9, width: 80, height: 100 })
  })
  it('does not use a resized matte key to invent dimensions for its content sprite', async () => {
    browserCodec()
    const input = make({
      images: { content: new Uint8Array([1]), matte: new Uint8Array(10_000) },
      sprites: [
        { imageKey: 'content', matteKey: 'matte', frames: [{ ...frame, layout: null }] },
        { imageKey: 'matte', frames: [{ ...frame, layout: null }] }
      ]
    })
    const options = config()
    options.image.autoResizeToCanvas = true
    const output = await decode(await new SVGAOptimizer().optimize(encode(input), options, undefined, { width: 50, height: 50 }))
    expect(output.sprites[0].frames[0].layout).toBeUndefined()
    expect(output.sprites[1].frames[0].layout).toEqual({ width: 200, height: 100 })
  })
  it('never merges different bytes just because a sampled hash collides', async () => {
    browserCodec()
    const a = new Uint8Array(2000), b = new Uint8Array(2000); b[101] = 1
    const options = config(); options.image.deduplicate = true
    const output = await decode(await new SVGAOptimizer().optimize(encode(make({ images: { a, b }, sprites: [{ imageKey: 'a', frames: [frame] }, { imageKey: 'b', frames: [frame] }] })), options))
    expect(output.sprites.map((sprite: { imageKey: string }) => sprite.imageKey)).toEqual(['a', 'b'])
  })
  it('retains the identity of matte resources when deduplication is selected', async () => {
    browserCodec()
    const options = config(); options.image.deduplicate = true
    const input = make({ images: { mask1: new Uint8Array([1]), mask2: new Uint8Array([1]), image: new Uint8Array([2]) }, sprites: [
      { imageKey: 'mask1', frames: [frame] }, { imageKey: 'mask2', frames: [frame] }, { imageKey: 'image', matteKey: 'mask2', frames: [frame] }
    ] })
    const output = await decode(await new SVGAOptimizer().optimize(encode(input), options))
    expect(output.images.mask2).toBeDefined()
    expect(output.sprites.some((sprite: {imageKey: string}) => sprite.imageKey === output.sprites[2].matteKey)).toBe(true)
  })
  it('does not replace changing clipping paths with the preceding frame', async () => {
    const options = config(); options.frames.simplify = true
    const input = make({ params: { viewBoxWidth: 400, viewBoxHeight: 300, fps: 24, frames: 2 }, sprites: [{ imageKey: '', frames: [{ ...frame, clipPath: 'M0 0L10 10Z' }, { ...frame, clipPath: 'M0 0L50 50Z' }] }] })
    const output = await decode(await new SVGAOptimizer().optimize(encode(input), options))
    expect(output.sprites[0].frames[1].clipPath).toBe('M0 0L50 50Z')
  })
  it('leaves audio bytes unchanged while processing image resources', async () => {
    browserCodec()
    const audio = new Uint8Array(100).fill(7)
    const output = await decode(await new SVGAOptimizer().optimize(encode(make({ images: {image:new Uint8Array(100), sound:audio}, audios:[{audioKey:'sound',startFrame:0,endFrame:1}] })), config()))
    expect(output.images.sound).toEqual(audio)
  })
  it('never returns a larger complete file just to claim optimization', async () => {
    const input = encode(make({sprites:[]}))
    const output = await new SVGAOptimizer().optimize(input, config())
    expect(output.size).toBeLessThanOrEqual(input.byteLength)
  })
})
