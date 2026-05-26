import { describe, expect, it } from 'vitest'
import {
  applyLayerNamesToMovie,
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
