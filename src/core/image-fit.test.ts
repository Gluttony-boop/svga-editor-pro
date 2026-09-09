import { afterEach, describe, expect, it, vi } from 'vitest'
import { calculateImageFit, fitImageToDataUrl, validateReplacementSize } from './image-fit'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('image replacement fit modes', () => {
  it('fits without cropping and centers the result', () => {
    expect(calculateImageFit(200, 100, 100, 100, 'fit')).toEqual({ sx: 0, sy: 0, sw: 200, sh: 100, dx: 0, dy: 25, dw: 100, dh: 50 })
  })
  it('fills by cropping the overflowing axis', () => {
    expect(calculateImageFit(200, 100, 100, 100, 'fill')).toEqual({ sx: 50, sy: 0, sw: 100, sh: 100, dx: 0, dy: 0, dw: 100, dh: 100 })
  })
  it('stretches all pixels to the destination', () => {
    expect(calculateImageFit(200, 100, 100, 100, 'stretch')).toEqual({ sx: 0, sy: 0, sw: 200, sh: 100, dx: 0, dy: 0, dw: 100, dh: 100 })
  })
  it('rejects invalid dimensions', () => {
    expect(() => calculateImageFit(0, 1, 1, 1, 'fit')).toThrow()
    expect(() => calculateImageFit(1, Infinity, 1, 1, 'fit')).toThrow()
    expect(() => validateReplacementSize(0, 100)).toThrow()
    expect(() => validateReplacementSize(0.5, 100)).toThrow()
    expect(() => validateReplacementSize(4096, 4096)).toThrow('尺寸过大')
  })
  it('fits and crops portrait images on the other axis', () => {
    expect(calculateImageFit(100, 200, 100, 100, 'fit')).toEqual({ sx: 0, sy: 0, sw: 100, sh: 200, dx: 25, dy: 0, dw: 50, dh: 100 })
    expect(calculateImageFit(100, 200, 100, 100, 'fill')).toEqual({ sx: 0, sy: 50, sw: 100, sh: 100, dx: 0, dy: 0, dw: 100, dh: 100 })
  })
  it('enlarges small images without changing aspect ratio', () => {
    expect(calculateImageFit(10, 10, 100, 50, 'fit')).toEqual({ sx: 0, sy: 0, sw: 10, sh: 10, dx: 25, dy: 0, dw: 50, dh: 50 })
  })
})

describe('replacement image processing', () => {
  function environment() {
    const images: MockImage[] = []
    class MockImage {
      naturalWidth = 200
      naturalHeight = 100
      src = ''
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor() { images.push(this) }
    }
    const drawImage = vi.fn()
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toDataURL: vi.fn(() => 'data:image/png;base64,result') }
    vi.stubGlobal('Image', MockImage)
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    vi.stubGlobal('document', { createElement: () => canvas })
    return { images, canvas, drawImage }
  }
  it('encodes the fitted pixels and releases the canvas backing store', async () => {
    const { images, canvas, drawImage } = environment()
    const result = fitImageToDataUrl('blob:fixture', 100, 100, 'fit')
    images[0].onload!()
    await expect(result).resolves.toBe('data:image/png;base64,result')
    expect(drawImage).toHaveBeenCalledWith(images[0], 0, 0, 200, 100, 0, 25, 100, 50)
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/png')
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
  })
  it('aborts a pending decode without producing a replacement', async () => {
    const { images, canvas } = environment()
    const controller = new AbortController()
    const result = fitImageToDataUrl('blob:fixture', 100, 100, 'fill', controller.signal)
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(images[0].src).toBe('')
    expect(images[0].onload).toBeNull()
    expect(canvas.toDataURL).not.toHaveBeenCalled()
  })
  it('rejects invalid image data without silently replacing it with an empty image', async () => {
    const { images, canvas } = environment()
    const result = fitImageToDataUrl('blob:invalid', 100, 100, 'fit')
    images[0].onerror!()
    await expect(result).rejects.toThrow('图片无法解码')
    expect(canvas.toDataURL).not.toHaveBeenCalled()
  })
  it('times out an unfinished decode and removes its callbacks', async () => {
    vi.useFakeTimers()
    const { images, canvas } = environment()
    const result = fitImageToDataUrl('blob:stalled', 100, 100, 'fit')
    const rejection = expect(result).rejects.toThrow('图片加载超时')
    await vi.advanceTimersByTimeAsync(8000)
    await rejection
    expect(images[0].onload).toBeNull()
    expect(images[0].onerror).toBeNull()
    expect(canvas.toDataURL).not.toHaveBeenCalled()
  })
  it('does not start decoding an already cancelled request', async () => {
    const { images } = environment()
    const controller = new AbortController()
    controller.abort()
    await expect(fitImageToDataUrl('blob:unused', 100, 100, 'fit', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(images).toHaveLength(0)
  })
  it('rejects oversized source images before allocating output pixels', async () => {
    const { images, canvas } = environment()
    const result = fitImageToDataUrl('blob:huge', 100, 100, 'fit')
    images[0].naturalWidth = 10000
    images[0].naturalHeight = 10000
    images[0].onload!()
    await expect(result).rejects.toThrow('上传图片过大')
    expect(canvas.toDataURL).not.toHaveBeenCalled()
  })
})
