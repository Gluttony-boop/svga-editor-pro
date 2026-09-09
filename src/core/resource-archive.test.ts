import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { createResourceArchive, getResourceExtension, getResourceFileName, loadResourceImage } from './resource-archive'

describe('resource extraction', () => {
  it('falls back to source buffers when the resource is only a metadata placeholder', async () => {
    const buffer = new Uint8Array([1, 2, 3]).buffer
    const blob = await loadResourceImage({ data: new Uint8Array(), buffer, mimeType: 'image/png' })
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array(buffer))
  })
  it('prefers edited resource bytes over original buffers', async () => {
    const blob = await loadResourceImage({ data: new Uint8Array([4]), buffer: new Uint8Array([1]).buffer, mimeType: 'image/png' })
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([4]))
  })
  it('reads replacement data URLs locally and preserves their MIME type', async () => {
    const blob = await loadResourceImage({ data: new Uint8Array([1]), mimeType: 'image/png', replacementUrl: 'data:image/jpeg;base64,/9gBAg==' })
    expect(blob.type).toBe('image/jpeg')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([255, 216, 1, 2]))
    const svg = await loadResourceImage({ mimeType: 'image/png', replacementUrl: 'data:image/svg+xml,%3Csvg%2F%3E' })
    expect(await svg.text()).toBe('<svg/>')
  })
  it('uses image signatures rather than misleading MIME types', () => {
    expect(getResourceExtension(new Uint8Array([0xff, 0xd8, 0xff]), 'image/png')).toBe('jpg')
    expect(getResourceExtension(new TextEncoder().encode('RIFF0000WEBP'), 'image/png')).toBe('webp')
    expect(() => getResourceExtension(new Uint8Array(), 'text/html')).toThrow()
  })
  it('sanitizes paths, Windows reserved names and case-insensitive collisions', () => {
    const used = new Set<string>()
    expect(getResourceFileName('../a/b.png', 'png', used)).toBe('_a_b.png')
    expect(getResourceFileName('CON', 'png', used)).toBe('_CON.png')
    expect(getResourceFileName('Star.png', 'jpg', used)).toBe('Star.jpg')
    expect(getResourceFileName('star', 'jpg', used)).toBe('star_2.jpg')
    expect(getResourceFileName('..', 'png', used)).toBe('image.png')
  })
  it('preserves original bytes and writes a key-to-file manifest', async () => {
    const data = new Uint8Array([0xff, 0xd8, 1, 2])
    const progress: number[] = []
    const archive = await createResourceArchive([
      { key: 'badge', load: async () => new Blob([data], { type: 'image/jpeg' }) },
      { key: 'Badge', load: async () => new Blob([data], { type: 'image/jpeg' }) }
    ], (done) => progress.push(done))
    const zip = await JSZip.loadAsync(await archive.arrayBuffer())
    expect(await zip.file('badge.jpg')!.async('uint8array')).toEqual(data)
    expect(zip.file('Badge_2.jpg')).not.toBeNull()
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    expect(manifest.resources.map((r: { key: string }) => r.key)).toEqual(['badge', 'Badge'])
    expect(progress).toEqual([1, 2])
  })
  it('rejects empty or failing resources rather than silently exporting a partial archive', async () => {
    await expect(createResourceArchive([])).rejects.toThrow('没有可提取')
    await expect(createResourceArchive([{ key: 'bad', load: async () => new Blob() }])).rejects.toThrow('bad')
    await expect(createResourceArchive([{ key: 'bad', load: async () => { throw new Error('unavailable') } }])).rejects.toThrow('unavailable')
  })
})
