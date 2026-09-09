import { describe, expect, it } from 'vitest'
import { selectResources, summarizeResources, formatResourceBytes } from './resource-catalog'

const resources = [
  { key: 'Image_10', byteSize: 200, width: 20, height: 10 },
  { key: 'Image_2', byteSize: 100, width: 10, height: 10 },
  { key: '徽章', byteSize: 300 }
]

describe('resource catalog', () => {
  it('searches without case sensitivity and retains source references', () => {
    expect(selectResources(resources, ' IMAGE_2 ', 'original')).toEqual([resources[1]])
    expect(selectResources(resources, '徽', 'original')[0]).toBe(resources[2])
    expect(selectResources(resources, 'missing', 'original')).toEqual([])
  })
  it('sorts a copy by encoded size or natural name', () => {
    expect(selectResources(resources, '', 'size-desc').map(r => r.byteSize)).toEqual([300, 200, 100])
    expect(selectResources(resources, '', 'size-asc').map(r => r.byteSize)).toEqual([100, 200, 300])
    expect(selectResources(resources, 'image', 'name').map(r => r.key)).toEqual(['Image_2', 'Image_10'])
    expect(resources[0].key).toBe('Image_10')
  })
  it('separates encoded bytes from estimated decoded RGBA memory', () => {
    expect(summarizeResources(resources)).toEqual({ encodedBytes: 600, decodedBytes: 1200, unknownDimensions: 1 })
    expect(summarizeResources([])).toEqual({ encodedBytes: 0, decodedBytes: 0, unknownDimensions: 0 })
  })
  it('uses binary units consistently', () => {
    expect(formatResourceBytes(0)).toBe('0 B')
    expect(formatResourceBytes(1024)).toBe('1.0 KiB')
    expect(formatResourceBytes(1048576)).toBe('1.00 MiB')
  })
})
