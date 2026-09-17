import { describe, expect, it } from 'vitest'
import { selectResources, summarizeResources, formatResourceBytes, resourceDecodedBytes } from './resource-catalog'

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
  it('按解码内存降序排列，未知尺寸排在末尾且不改变源顺序', () => {
    const source = Object.freeze([
      { key: 'unknown-first', byteSize: 10000 },
      { key: 'small', byteSize: 9000, width: 8, height: 8 },
      { key: 'large', byteSize: 1, width: 128, height: 128 },
      { key: 'invalid', byteSize: 8000, width: 0, height: 128 },
      { key: 'unknown-last', byteSize: 10000 }
    ])

    const result = selectResources(source, '', 'memory-desc')

    expect(result.map(resource => resource.key)).toEqual(['large', 'small', 'unknown-first', 'invalid', 'unknown-last'])
    expect(result[0]).toBe(source[2])
    expect(source.map(resource => resource.key)).toEqual(['unknown-first', 'small', 'large', 'invalid', 'unknown-last'])
    expect(selectResources(source, 'unknown', 'memory-desc').map(resource => resource.key)).toEqual(['unknown-first', 'unknown-last'])
  })

  it.each([
    { key: 'missing', byteSize: 1 },
    { key: 'partial', byteSize: 1, width: 8 },
    { key: 'zero', byteSize: 1, width: 0, height: 8 },
    { key: 'negative', byteSize: 1, width: 8, height: -8 },
    { key: 'nan', byteSize: 1, width: Number.NaN, height: 8 },
    { key: 'infinite', byteSize: 1, width: 8, height: Number.POSITIVE_INFINITY }
  ])('不将无效尺寸 $key 解释为已知占用', resource => {
    expect(resourceDecodedBytes(resource)).toBeNull()
  })

  it('按有效尺寸估算 RGBA 内存，与编码体积无关', () => {
    expect(resourceDecodedBytes({ key: 'pixel', byteSize: 1000, width: 1, height: 1 })).toBe(4)
    expect(resourceDecodedBytes({ key: 'avatar', byteSize: 1, width: 512, height: 256 })).toBe(524288)
  })
})
