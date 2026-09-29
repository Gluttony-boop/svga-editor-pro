import { describe, expect, it } from 'vitest'
import pako from 'pako'
import protobuf from 'protobufjs'
import UPNG from 'upng-js'
import type { Movie } from '@/types'
import { createTaskExample, type StarterTask } from './task-examples'
import proto from './svga-proto'

const MovieType = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
const pngReader = UPNG as unknown as { decode(data: ArrayBuffer): { width: number; height: number }; toRGBA8(png: unknown): ArrayBuffer[] }
const tasks: StarterTask[] = ['profile', 'compress', 'batch', 'delivery']
const decode = (buffer: ArrayBuffer) => MovieType.toObject(MovieType.decode(pako.inflate(new Uint8Array(buffer))), { bytes: Uint8Array, defaults: false }) as unknown as Movie

describe('原创任务示例', () => {
  it.each(tasks)('%s 无浏览器/字体/网络依赖，真实PNG和protobuf可读且关键资源完整', task => {
    const result = createTaskExample(task)
    const movie = decode(result.buffer)
    expect(result.fileName.endsWith('.svga')).toBe(true)
    expect(result.sampleText.length).toBeGreaterThan(0)
    expect(result.nicknameKey).toBe('nickname_text')
    expect(movie.params).toEqual({ viewBoxWidth: 520, viewBoxHeight: 300, fps: 24, frames: 48 })
    expect(movie.sprites.filter(sprite => sprite.imageKey === 'avatar')).toHaveLength(2)
    expect(movie.sprites.some(sprite => sprite.imageKey === result.nicknameKey)).toBe(true)
    expect(movie.sprites).toHaveLength(7)
    for (const sprite of movie.sprites) {
      expect(movie.images[sprite.imageKey]).toBeDefined()
      expect(sprite.frames).toHaveLength(48)
      expect(sprite.matteKey).toBeUndefined()
      for (const frame of sprite.frames) {
        expect(frame.alpha).toBeGreaterThan(0)
        expect(frame.alpha).toBeLessThanOrEqual(1)
        expect(Object.values(frame.transform).every(Number.isFinite)).toBe(true)
      }
    }
    for (const data of Object.values(movie.images)) {
      const png = pngReader.decode(new Uint8Array(data).buffer)
      expect(png.width).toBeGreaterThan(0)
      expect(png.height).toBeGreaterThan(0)
      const pixels = new Uint8Array(pngReader.toRGBA8(png)[0])
      expect(pixels).toHaveLength(png.width * png.height * 4)
      expect(pixels.some((value, index) => index % 4 === 3 && value > 0)).toBe(true)
    }
    const avatarPng = pngReader.decode(new Uint8Array(movie.images.avatar).buffer)
    const avatarPixels = new Uint8Array(pngReader.toRGBA8(avatarPng)[0])
    expect(avatarPixels[3]).toBe(0)
    expect(avatarPixels[(96 * 192 + 96) * 4 + 3]).toBe(255)
    const background = pngReader.decode(new Uint8Array(movie.images.studio_background).buffer)
    expect([background.width, background.height]).toEqual([1040, 600])
    expect(result.buffer.byteLength).toBeGreaterThan(20_000)
    expect(result.buffer.byteLength).toBeLessThan(2 * 1024 * 1024)
  })

  it('四份示例有不同实际图片与文案，同一任务生成可复现', () => {
    const examples = tasks.map(task => createTaskExample(task))
    expect(new Set(examples.map(example => example.sampleText)).size).toBe(4)
    expect(new Set(examples.map(example => Buffer.from(decode(example.buffer).images.studio_background).toString('base64'))).size).toBe(4)
    expect(createTaskExample('profile').buffer).toEqual(examples[0].buffer)
  })

  it('拒绝不支持的任务，包括对象原型属性名称', () => {
    expect(() => createTaskExample('unknown' as StarterTask)).toThrow('不支持')
    expect(() => createTaskExample('constructor' as StarterTask)).toThrow('不支持')
  })
})
