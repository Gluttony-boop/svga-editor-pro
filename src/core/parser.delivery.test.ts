import { afterEach, describe, expect, it, vi } from 'vitest'
import protobuf from 'protobufjs'
import pako from 'pako'
import proto from './svga-proto'
import { SVGAParser } from './parser'

const Movie = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
function source() {
  const bytes = new Uint8Array(64 * 1024).fill(7)
  const movie = { version: '2.0.0', params: { viewBoxWidth: 100, viewBoxHeight: 50, fps: 24, frames: 1 }, images: { image: bytes }, sprites: [] }
  return { bytes, buffer: new Uint8Array(pako.deflate(Movie.encode(Movie.fromObject(movie)).finish())).buffer }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('交付回读先取紧凑字节再限额解码', () => {
  it('decodeImages=false不分配Image/URL，原资源保持Uint8Array而非Number数组', async () => {
    const input = source()
    const image = vi.fn(); vi.stubGlobal('Image', image)
    const createUrl = vi.spyOn(URL, 'createObjectURL')
    const onImageUrlCreated = vi.fn()
    const output = await new SVGAParser().parse(input.buffer, { decodeImages: false, onImageUrlCreated })
    expect(output.movie.images.image).toBeInstanceOf(Uint8Array)
    expect(output.movie.images.image).toEqual(input.bytes)
    expect(new Uint8Array(output.buffers.image)).toEqual(input.bytes)
    expect(Object.keys(output.images)).toHaveLength(0)
    expect(image).not.toHaveBeenCalled()
    expect(createUrl).not.toHaveBeenCalled()
    expect(onImageUrlCreated).not.toHaveBeenCalled()
  })

  it('默认导入仍委托原图片解码路径，未改变现有调用约定', async () => {
    const parser = new SVGAParser()
    const decodeImages = vi.spyOn(parser as unknown as { parseImages: (...args: unknown[]) => Promise<object> }, 'parseImages').mockResolvedValue({})
    const output = await parser.parse(source().buffer)
    expect(decodeImages).toHaveBeenCalledOnce()
    expect(Array.isArray(output.movie.images.image)).toBe(true)
  })
})
