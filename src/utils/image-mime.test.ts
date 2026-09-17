import { describe, expect, it } from 'vitest'
import { detectImageMime } from './image-mime'

describe('源图片格式识别', () => {
  it.each([
    [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
    [[0xff, 0xd8, 0xff], 'image/jpeg'],
    [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
    [[0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 'image/webp']
  ] as const)('优先实际文件头 %s', (bytes, mime) => {
    expect(detectImageMime(new Uint8Array(bytes), 'image/png')).toBe(mime)
  })
  it('无已知头部时不把未知图片误报 PNG', () => {
    expect(detectImageMime(new Uint8Array())).toBe('application/octet-stream')
    expect(detectImageMime(new Uint8Array([1, 2]))).toBe('application/octet-stream')
    expect(detectImageMime(new Uint8Array([1, 2]), 'image/svg+xml')).toBe('image/svg+xml')
  })
})
