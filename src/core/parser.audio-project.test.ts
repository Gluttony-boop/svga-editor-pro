import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MovieEntity } from '@/types'
import { SVGAParser } from './parser'
import { audioManager } from './audio-manager'

afterEach(() => { vi.restoreAllMocks() })

describe('工程原始音频资源映射', () => {
  it('从真实audioKey和资源表取字节，不产生undefined key或空资源', async () => {
    const parse = vi.spyOn(audioManager, 'parseAudioTracks').mockImplementation(async list => (list || []).map(audio => ({ ...audio })))
    const movie = {
      params: { viewBoxWidth: 100, viewBoxHeight: 100, fps: 20, frames: 50 },
      images: { song: [73, 68, 51, 4] }, sprites: [], version: '2.0',
      audios: [{ audioKey: 'song', startFrame: 10, endFrame: 30, startTime: 400, totalTime: 5000 }]
    } as unknown as MovieEntity
    const before = JSON.stringify(movie)
    const resources = await new SVGAParser().parseAudios(movie)
    expect(resources[0]).toMatchObject({ key: 'song', data: new Uint8Array([73, 68, 51, 4]), startTime: 500, duration: 1000 })
    expect(parse).toHaveBeenCalledOnce()
    expect(JSON.stringify(movie)).toBe(before)
  })
  it('兼容编辑态key/data，并跳过缺少真实字节的非法音轨', async () => {
    vi.spyOn(audioManager, 'parseAudioTracks').mockImplementation(async list => (list || []).map(audio => ({ ...audio })))
    const movie = { params: { fps: 24 }, images: {}, audios: [
      { key: 'music', data: new Uint8Array([1, 2]), startTime: 100, duration: 300 }, { audioKey: 'missing', startFrame: 0 }, {}
    ] } as unknown as MovieEntity
    expect(await new SVGAParser().parseAudios(movie)).toEqual([{ key: 'music', data: new Uint8Array([1, 2]), startTime: 100, duration: 300 }])
  })
})
