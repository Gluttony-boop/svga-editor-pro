import { describe, expect, it } from 'vitest'
import { calculatePreviewZoom, previewFileName } from './preview-view'

describe('preview viewport', () => {
  it('fits inside both dimensions with room for controls', () => {
    expect(calculatePreviewZoom(1080, 580, 1000, 500)).toBe(0.95)
    expect(calculatePreviewZoom(580, 1080, 1000, 500)).toBe(0.475)
  })
  it('clamps zoom and handles invalid or tiny containers', () => {
    expect(calculatePreviewZoom(10000, 10000, 10, 10)).toBe(5)
    expect(calculatePreviewZoom(20, 20, 1000, 1000)).toBe(0.1)
    expect(calculatePreviewZoom(1000, 1000, 0, 100)).toBe(1)
    expect(calculatePreviewZoom(NaN, 100, 100, 100)).toBe(1)
  })
  it('displays filenames without leaking URL queries into the label', () => {
    expect(previewFileName('https://example.com/path/a%20b.svga?token=secret')).toBe('a b.svga')
    expect(previewFileName('D:\\art\\badge#1.svga')).toBe('badge#1.svga')
    expect(previewFileName(null)).toBe('未命名动画')
    expect(previewFileName('bad%name.svga')).toBe('bad%name.svga')
  })
})
