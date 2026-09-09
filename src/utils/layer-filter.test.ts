import { describe, expect, it } from 'vitest'
import { filterLayers } from './layer-filter'

const layers = [
  { name: '背景', imageKey: 'BG_Image', visible: true, locked: true },
  { name: '星星', imageKey: 'star_01', visible: false, locked: false },
  { name: 'Star Title', visible: true, locked: false }
]

describe('filterLayers', () => {
  it('returns every layer in source order for an empty or whitespace query', () => {
    expect(filterLayers(layers, '  ', 'all').map(({ index }) => index)).toEqual([0, 1, 2])
    expect(filterLayers([], '', 'all')).toEqual([])
  })

  it('searches names and original resource keys ignoring case and surrounding whitespace', () => {
    expect(filterLayers(layers, ' STAR ', 'all').map(({ index }) => index)).toEqual([1, 2])
    expect(filterLayers(layers, 'bg_image', 'all')[0].layer).toBe(layers[0])
    expect(filterLayers(layers, '星', 'all')[0].index).toBe(1)
  })

  it.each([
    ['visible', [0, 2]],
    ['hidden', [1]],
    ['locked', [0]],
    ['unlocked', [1, 2]]
  ] as const)('filters %s layers without renumbering them', (filter, indices) => {
    expect(filterLayers(layers, '', filter).map(({ index }) => index)).toEqual(indices)
  })

  it('combines name and status filters', () => {
    expect(filterLayers(layers, 'star', 'visible').map(({ index }) => index)).toEqual([2])
    expect(filterLayers(layers, 'star', 'locked')).toEqual([])
  })

  it('treats special characters as literal text and handles missing resource keys', () => {
    expect(filterLayers(layers, '.*', 'all')).toEqual([])
    expect(filterLayers(layers, 'Title', 'all')[0].layer).toBe(layers[2])
  })

  it('does not mutate layers or their order', () => {
    const snapshot = structuredClone(layers)
    filterLayers(layers, 'star', 'unlocked')
    expect(layers).toEqual(snapshot)
  })
})
