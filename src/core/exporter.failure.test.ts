import { afterEach, describe, expect, it, vi } from 'vitest'
import pako from 'pako'
import protobuf from 'protobufjs'
import proto from './svga-proto'
import { ExportEngine } from './exporter'

afterEach(() => { vi.unstubAllGlobals() })
describe('failed edited resources', () => {
  it.each(['exportSVGA', 'exportSVGALite'] as const)('%s does not silently export the original when a replacement cannot load', async (method) => {
    const canvas = { width: 100, height: 100, getContext: () => ({setTransform: () => {}}) }
    vi.stubGlobal('document', { createElement: () => canvas })
    vi.stubGlobal('Image', class { onerror?: () => void; set src(_value: string) { queueMicrotask(() => this.onerror?.()) } })
    const Movie = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
    const buffer = new Uint8Array(pako.deflate(Movie.encode(Movie.create({ version: '2.0', params: { viewBoxWidth: 100, viewBoxHeight: 100, frames: 1, fps: 24 }, images: { badge: [1, 2, 3] }, sprites: [] })).finish())).buffer
    const engine = new ExportEngine(canvas as unknown as HTMLCanvasElement)
    vi.stubGlobal('window', { devicePixelRatio: 1 })
    engine.setVideoItem({movie: {version:'2.0',params:{viewBoxWidth:100,viewBoxHeight:100,frames:1,fps:24},images:{},sprites:[]},images:{},buffers:{}})
    await expect(engine[method](buffer, {fps:24,frames:1,slotConfigs: {badge: {type: 'image', name:'badge', value:'blob:revoked'}}})).rejects.toThrow('badge')
  })
})
