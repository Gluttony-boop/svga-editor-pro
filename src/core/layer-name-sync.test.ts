import { describe, expect, it } from 'vitest'
import {
  applyLayerNamesToMovie,
  assertDecodedImageReferences,
  createLayerImageAliases,
  getCompatibleImageKey,
  hasIncompatibleMovieImageReferences,
  normalizeMovieImageReferences
} from './layer-name-sync'
import type { Layer } from '@/types'

function createLayer(overrides: Partial<Layer>): Layer {
  return {
    id: '0',
    name: 'layer_0',
    type: 'image',
    visible: true,
    locked: false,
    expanded: true,
    opacity: 1,
    blendMode: 'normal',
    imageKey: 'old_key',
    clip: { startFrame: 0, duration: 1 },
    tracks: {
      position: {
        keyframes: [],
        currentValue: { x: 0, y: 0 },
        defaultValue: { x: 0, y: 0 }
      },
      scale: {
        keyframes: [],
        currentValue: { scaleX: 1, scaleY: 1 },
        defaultValue: { scaleX: 1, scaleY: 1 }
      },
      rotation: {
        keyframes: [],
        currentValue: 0,
        defaultValue: 0
      },
      alpha: {
        keyframes: [],
        currentValue: 1,
        defaultValue: 1
      }
    },
    ...overrides
  }
}

describe('layer-name-sync', () => {
  it('特殊__proto__使用兼容名称，constructor与普通Key保持原样', () => {
    expect(getCompatibleImageKey('__proto__', '__proto__', 0)).toBe('image_1')
    expect(getCompatibleImageKey('constructor', 'constructor', 0)).toBe('constructor')
    expect(getCompatibleImageKey('title', 'title', 0)).toBe('title')
  })

  it('规范化__proto__处理名称碰撞并同时更新sprite和matte引用', () => {
    const images: Record<string, Uint8Array> = Object.create(null)
    const original = new Uint8Array([1, 2, 3])
    images.__proto__ = original
    images.image_1 = new Uint8Array([4, 5, 6])
    images.content = new Uint8Array([7])
    const movie = { images, sprites: [{ imageKey: '__proto__' }, { imageKey: 'content', matteKey: '__proto__' }] }
    const result = normalizeMovieImageReferences(movie)
    expect(result).toEqual({ changed: true, missingImageKeys: [] })
    expect(movie.sprites[0].imageKey).toBe('image_1_1')
    expect(movie.sprites[1].matteKey).toBe('image_1_1')
    expect(images.image_1_1).toBe(original)
    expect(images.image_1).toEqual(new Uint8Array([4, 5, 6]))
    expect(Object.prototype.hasOwnProperty.call(images, '__proto__')).toBe(false)
    expect(Object.getPrototypeOf(images)).toBe(null)
  })

  it('已被旧protobuf decoder丢失的__proto__不能当透明图片继续导出', () => {
    const images: Record<string, Uint8Array> = {}
    Object.setPrototypeOf(images, new Uint8Array([1, 2, 3]))
    expect(() => assertDecodedImageReferences({ images, sprites: [{ imageKey: '__proto__' }] })).toThrow('源文件中改名')
    const safe = { ['__proto__']: new Uint8Array([1, 2, 3]) }
    expect(() => assertDecodedImageReferences({ images: safe, sprites: [{ imageKey: '__proto__' }] })).not.toThrow()
  })

  it('normalizes inline image data keys to player-compatible names', () => {
    const inlineWebpKey = `UklGR${'A'.repeat(220)}==`

    expect(getCompatibleImageKey(inlineWebpKey, inlineWebpKey, 2)).toBe('image_3')
  })

  it('copies image bytes when replacing inline image data keys', () => {
    const inlineWebpKey = `UklGR${'B'.repeat(220)}==`
    const imageBytes = new Uint8Array([1, 2, 3])
    const images = { [inlineWebpKey]: imageBytes }
    const layers = [
      createLayer({
        id: '0',
        name: inlineWebpKey,
        imageKey: inlineWebpKey,
        editableIndex: 0
      })
    ]

    const aliases = createLayerImageAliases(images, layers)

    expect(aliases.get('0')).toBe('image_1')
    expect(images.image_1).toBe(imageBytes)
  })

  it('rewrites sprite imageKey and removes stale inline image entries', () => {
    const inlineWebpKey = `UklGR${'C'.repeat(220)}==`
    const imageBytes = new Uint8Array([4, 5, 6])
    const movie = {
      images: { [inlineWebpKey]: imageBytes },
      sprites: [{ imageKey: inlineWebpKey }]
    }
    const layers = [
      createLayer({
        id: '0',
        name: inlineWebpKey,
        imageKey: inlineWebpKey,
        editableIndex: 0
      })
    ]

    const changed = applyLayerNamesToMovie(movie, layers)

    expect(changed).toBe(true)
    expect(movie.sprites[0].imageKey).toBe('image_1')
    expect(movie.images.image_1).toBe(imageBytes)
    expect(movie.images[inlineWebpKey]).toBeUndefined()
  })

  it('detects and normalizes incompatible sprite references without layer metadata', () => {
    const inlinePngKey = `iVBORw0KGgo${'D'.repeat(220)}==`
    const imageBytes = new Uint8Array([7, 8, 9])
    const movie = {
      images: { [inlinePngKey]: imageBytes },
      sprites: [{ imageKey: inlinePngKey }]
    }

    expect(hasIncompatibleMovieImageReferences(movie)).toBe(true)

    const result = normalizeMovieImageReferences(movie)

    expect(result.changed).toBe(true)
    expect(result.missingImageKeys).toEqual([])
    expect(movie.sprites[0].imageKey).toBe('image_1')
    expect(movie.images.image_1).toBe(imageBytes)
    expect(movie.images[inlinePngKey]).toBeUndefined()
  })

  it('reports sprite references that do not exist in the images table', () => {
    const movie = {
      images: {},
      sprites: [{ imageKey: 'missing_key' }]
    }

    const result = normalizeMovieImageReferences(movie)

    expect(result.changed).toBe(false)
    expect(result.missingImageKeys).toEqual(['missing_key'])
  })
})
