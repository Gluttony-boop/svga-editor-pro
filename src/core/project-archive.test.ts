import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import pako from 'pako'
import protobuf from 'protobufjs'
import type { ProjectDocument } from '@/types/project'
import type { FrameData, ImageResource, Layer, MovieEntity, SlotConfig, SlotTextConfig, Sprite } from '@/types'
import { createDefaultTracks } from './layer-factory'
import { createProjectArchive, MAX_PROJECT_BYTES, readProjectArchive } from './project-archive'
import proto from './svga-proto'

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII='
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_DATA_URL.split(',')[1], 'base64'))
const SOUND_BYTES = new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0])
const Movie = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
const sourceParams = { viewBoxWidth: 320, viewBoxHeight: 240, fps: 24, frames: 4 }

interface AssetReference { asset: string }
interface AssetRecord { path: string; size: number; sha256: string; mimeType?: string }
interface Manifest {
  format: string
  formatVersion: number
  assets: AssetRecord[]
  document: Record<string, unknown> & {
    originalBuffer: AssetReference
    videoItem: { movie: Record<string, unknown>; buffers: Array<{ key: string; data: AssetReference }> }
    imageResources: Array<{ key: string; data: AssetReference }>
    audioResources: Array<{ key: string; data: AssetReference }>
    slotConfigs: Array<{
      key: string
      config: {
        type: string
        name: string
        value: string | null | { asset: AssetReference; mimeType: string }
        imageConfig?: { asset: AssetReference; mimeType?: string; scaleMode: string; url?: string }
        textConfig?: SlotTextConfig
      }
    }>
  }
  [key: string]: unknown
}

const arrayBuffer = (bytes: Uint8Array) => new Uint8Array(bytes).buffer
const frame = (index: number): FrameData => ({
  alpha: (index + 1) / 4,
  layout: { x: 2, y: 3, width: 40, height: 30 },
  transform: { a: 1, b: 0, c: 0, d: 1, tx: index * 8, ty: 10 },
  clipPath: 'M0 0L40 0L40 30Z',
  shapes: [{ type: 'RECT', rect: { x: 0, y: 0, width: 4, height: 3 }, styles: { fill: { r: 1, g: 0, b: 0, a: 1 } } }]
})

function makeDocument(): ProjectDocument {
  const originalMovie = {
    version: '2.0.0', params: { ...sourceParams }, images: { avatar: PNG_BYTES, mask: PNG_BYTES },
    sprites: [
      { imageKey: 'avatar', matteKey: 'mask', frames: Array.from({ length: 4 }, (_, index) => frame(index)) },
      { imageKey: 'mask', matteKey: null, frames: Array.from({ length: 4 }, (_, index) => frame(index)) }
    ]
  }
  const originalBuffer = arrayBuffer(pako.deflate(Movie.encode(Movie.fromObject(originalMovie)).finish()))
  const sprites = structuredClone(originalMovie.sprites)
  sprites[0].imageKey = 'avatar_renamed'
  const layers: Layer[] = sprites.map((sprite, index) => ({
    id: `layer-${index}`, name: index === 0 ? '客户头像' : '头像遮罩', type: 'image',
    visible: true, locked: index === 1, expanded: true, opacity: 0.8, blendMode: 'normal',
    clip: { startFrame: 0, duration: 4 }, timeOffsetFrames: 2,
    imageKey: sprite.imageKey, editableIndex: index, sprites: sprite,
    tracks: createDefaultTracks(), animationTracks: createDefaultTracks(),
    canvasTransform: { x: 17, y: -5, scaleX: 1.5, scaleY: 0.75, rotation: Math.PI / 6 }
  }))
  layers[0].tracks.position.keyframes = [
    { id: 'legacy-position', frameIndex: 1, value: { x: 3, y: 4 }, easing: 'easeInOut' }
  ]
  layers[0].animationTracks!.rotation.keyframes = [
    { id: 'rotation-a', frameIndex: 0, value: 0, easing: 'bezier', bezierControlPoints: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 } },
    { id: 'rotation-b', frameIndex: 3, value: Math.PI / 4, easing: 'hold' }
  ]
  const imageResources = new Map<string, ImageResource>([
    ['avatar_renamed', { key: 'avatar_renamed', data: new Uint8Array(PNG_BYTES), width: 1, height: 1, mimeType: 'image/png', isNew: false }],
    ['mask', { key: 'mask', data: new Uint8Array(PNG_BYTES), width: 1, height: 1, mimeType: 'image/png', isNew: false }],
    ['spare', { key: 'spare', data: new Uint8Array(PNG_BYTES), width: 1, height: 1, mimeType: 'image/png', isNew: true }]
  ])
  return {
    formatVersion: 1,
    name: '客户头像 · 可继续编辑', originalBuffer,
    // 解析器为节省内存会清空 movie.images，归档仍必须保留当前 buffers 中的重命名 Key。
    videoItem: {
      movie: { ...originalMovie, params: { ...sourceParams, viewBoxWidth: 640, viewBoxHeight: 360 }, images: {}, sprites },
      buffers: { avatar_renamed: arrayBuffer(PNG_BYTES), mask: arrayBuffer(PNG_BYTES) }, images: {}
    },
    params: { viewBoxWidth: 640, viewBoxHeight: 360, fps: 30, frames: 12 },
    customFps: 30, customFrames: 12, layers, imageResources,
    audioResources: new Map([['music', { key: 'music', data: new Uint8Array(SOUND_BYTES), startTime: 125, duration: 350, isNew: true }]]),
    slotConfigs: {
      avatar_renamed: {
        type: 'image', name: '头像与昵称', value: '小明',
        imageConfig: { url: PNG_DATA_URL, scaleMode: 'fill' },
        textConfig: {
          text: '小明\n欢迎回来', fontFamily: 'sans-serif', fontSize: 24, color: '#ff8800',
          fontWeight: 'bold', textAlign: 'center', offsetX: 3, offsetY: -4,
          lineHeight: 1.25, enabled: true, replaceImage: false
        }
      }
    },
    detectedSlots: ['avatar_renamed'],
    compressionConfig: { enabled: true, mode: 'png', quality: 88, resizeEnabled: false, resizePercent: 100 },
    optimizationConfig: {
      enabled: true,
      image: { format: 'png', quality: 85, pngColors: 128, resizeEnabled: true, resizePercent: 75, maxWidth: 512, maxHeight: 512, deduplicate: false },
      frames: { simplify: false, keyframeThreshold: 0.01, removeInvisible: false, precision: 6 },
      compression: { level: 9, useBestCompression: true }
    },
    selectedPresetId: 'custom', currentFrame: 5, selectedLayerId: 'layer-0', selectedLayerIds: ['layer-0', 'layer-1']
  }
}

let validArchive: ArrayBuffer
beforeAll(async () => { validArchive = await (await createProjectArchive(makeDocument())).arrayBuffer() })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function alterArchive(change: (manifest: Manifest, zip: JSZip) => void | Promise<void>): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(validArchive)
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as Manifest
  await change(manifest, zip)
  zip.file('manifest.json', JSON.stringify(manifest))
  return zip.generateAsync({ type: 'arraybuffer' })
}

interface ZipHeader {
  name: string
  central: number
  local: number
  payload: number
  size: number
  nameLength: number
}

/** 只解析本测试由 JSZip 生成的无注释 ZIP，直接改物理头避免库把攻击载荷提前修正。 */
function inspectZipHeaders(buffer: ArrayBuffer): ZipHeader[] {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  const end = bytes.length - 22
  expect(view.getUint32(end, true)).toBe(0x06054b50)
  const result: ZipHeader[] = []
  let central = view.getUint32(end + 16, true)
  const count = view.getUint16(end + 10, true)
  for (let index = 0; index < count; index++) {
    expect(view.getUint32(central, true)).toBe(0x02014b50)
    const local = view.getUint32(central + 42, true)
    const nameLength = view.getUint16(central + 28, true)
    const name = new TextDecoder().decode(bytes.subarray(central + 46, central + 46 + nameLength))
    const payload = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    result.push({ name, central, local, payload, size: view.getUint32(central + 24, true), nameLength })
    central += 46 + nameLength + view.getUint16(central + 30, true) + view.getUint16(central + 32, true)
  }
  return result
}

async function storedArchive(): Promise<ArrayBuffer> {
  return (await JSZip.loadAsync(validArchive)).generateAsync({ type: 'arraybuffer', compression: 'STORE' })
}

async function replaceOriginalArchive(original: Uint8Array): Promise<ArrayBuffer> {
  return alterArchive(async (manifest, zip) => {
    const path = manifest.document.originalBuffer.asset
    const declaration = manifest.assets.find(asset => asset.path === path)!
    declaration.size = original.byteLength
    const digest = await crypto.subtle.digest('SHA-256', arrayBuffer(original))
    declaration.sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    zip.file(path, original, { createFolders: false })
  })
}

describe('工程归档：真实 ZIP 往返', () => {
  it('原始 SVGA 字节、全部编辑轨道、画布、时间范围及当前选择可无损恢复', async () => {
    const input = makeDocument()
    const output = await readProjectArchive(await (await createProjectArchive(input)).arrayBuffer())
    expect(new Uint8Array(output.originalBuffer)).toEqual(new Uint8Array(input.originalBuffer))
    expect(output).toMatchObject({
      formatVersion: 1, name: input.name, params: input.params,
      customFps: 30, customFrames: 12, layers: input.layers,
      compressionConfig: input.compressionConfig, optimizationConfig: input.optimizationConfig,
      selectedPresetId: 'custom', currentFrame: 5, selectedLayerId: 'layer-0', selectedLayerIds: ['layer-0', 'layer-1'],
      detectedSlots: input.detectedSlots
    })
    expect(output.layers).toEqual(input.layers)
    expect(output.layers).not.toBe(input.layers)
    expect(output.imageResources).toEqual(input.imageResources)
    expect(output.audioResources).toEqual(input.audioResources)
    expect(output.slotConfigs).toEqual(input.slotConfigs)
  })

  it('保留当前重命名 Key 的 buffers 并恢复 movie.images，不重新使用原始 Key', async () => {
    const result = await readProjectArchive(validArchive)
    expect(Object.keys(result.videoItem.buffers).sort()).toEqual(['avatar_renamed', 'mask'])
    expect(Object.keys(result.videoItem.movie.images).sort()).toEqual(['avatar_renamed', 'mask'])
    expect(new Uint8Array(result.videoItem.buffers.avatar_renamed)).toEqual(PNG_BYTES)
    expect(result.videoItem.movie.images.avatar_renamed).toEqual(PNG_BYTES)
    expect(result.videoItem.movie.sprites[0].imageKey).toBe('avatar_renamed')
    expect(result.videoItem.images).toEqual({})
  })

  it('普通 SVGA 导入后的空资源占位从同 Key buffers 取回字节', async () => {
    const input = makeDocument()
    input.imageResources.get('avatar_renamed')!.data = new Uint8Array()
    input.imageResources.get('mask')!.data = new Uint8Array()
    const output = await readProjectArchive(await (await createProjectArchive(input)).arrayBuffer())
    expect(output.imageResources.get('avatar_renamed')?.data).toEqual(PNG_BYTES)
    expect(output.imageResources.get('mask')?.data).toEqual(PNG_BYTES)
    expect(input.imageResources.get('avatar_renamed')!.data).toHaveLength(0)
  })

  it('将资源集中为带摘要的二进制资产，不把字节数组和运行时 URL 塞入 manifest', async () => {
    const zip = await JSZip.loadAsync(validArchive)
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as Manifest
    expect(manifest.format).toBe('svga-editor-project')
    expect(manifest.formatVersion).toBe(1)
    expect(manifest.document.originalBuffer.asset).toMatch(/^assets\/[^/]+\.bin$/)
    expect(manifest.document.videoItem.movie).not.toHaveProperty('images')
    expect(manifest.document.slotConfigs[0].config.imageConfig).not.toHaveProperty('url')
    expect(manifest.document.slotConfigs[0].config.imageConfig?.asset.asset).toMatch(/^assets\//)
    for (const asset of manifest.assets) {
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/i)
      expect(await zip.file(asset.path)!.async('uint8array')).toHaveLength(asset.size)
    }
    expect(await zip.file('manifest.json')!.async('string')).not.toContain('data:image/')
  })

  it('剥离图片与音频的运行时对象和本地路径，且不修改当前工程对象', async () => {
    const input = makeDocument()
    const image = input.imageResources.get('avatar_renamed')!
    image.blobUrl = 'blob:private-image-cache'
    image.bitmap = { marker: 'bitmap-runtime' } as unknown as ImageBitmap
    image.source = { type: 'file', value: 'C:\\private\\client-photo.png' }
    const audio = input.audioResources.get('music')!
    audio.blobUrl = 'blob:private-audio-cache'
    audio.audioBuffer = { marker: 'audio-runtime' } as unknown as AudioBuffer
    audio.source = { type: 'file', value: 'C:\\private\\client-audio.mp3' }
    input.videoItem.images.avatar_renamed = { src: 'blob:private-decoded-image' } as HTMLImageElement
    const blob = await createProjectArchive(input)
    const output = await readProjectArchive(await blob.arrayBuffer())
    expect(output.imageResources.get('avatar_renamed')).not.toHaveProperty('blobUrl')
    expect(output.imageResources.get('avatar_renamed')).not.toHaveProperty('bitmap')
    expect(output.imageResources.get('avatar_renamed')).not.toHaveProperty('source')
    expect(output.audioResources.get('music')).not.toHaveProperty('blobUrl')
    expect(output.audioResources.get('music')).not.toHaveProperty('audioBuffer')
    expect(output.audioResources.get('music')).not.toHaveProperty('source')
    expect(output.videoItem.images).toEqual({})
    expect(image.blobUrl).toBe('blob:private-image-cache')
    expect(image.source?.value).toBe('C:\\private\\client-photo.png')
    expect(audio.audioBuffer).toBeDefined()
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    const manifestText = await zip.file('manifest.json')!.async('string')
    expect(manifestText).not.toContain('private')
    expect(manifestText).not.toContain('runtime')
  })

  it('保存 Blob 插槽图片为内部资产，读回 data URL 并保留共存文字', async () => {
    const input = makeDocument()
    const url = URL.createObjectURL(new Blob([PNG_BYTES], { type: 'image/png' }))
    input.slotConfigs.avatar_renamed.imageConfig!.url = url
    try {
      const archive = await createProjectArchive(input)
      URL.revokeObjectURL(url)
      const fetchSpy = vi.fn(() => { throw new Error('导入不应访问任何 URL') })
      vi.stubGlobal('fetch', fetchSpy)
      const output = await readProjectArchive(await archive.arrayBuffer())
      expect(output.slotConfigs.avatar_renamed.imageConfig).toEqual({ url: PNG_DATA_URL, scaleMode: 'fill' })
      expect(output.slotConfigs.avatar_renamed.textConfig).toEqual(input.slotConfigs.avatar_renamed.textConfig)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally { URL.revokeObjectURL(url) }
  })

  it('特殊图片 Key、空白 Key 和插槽 Key 按字面保留，不改变对象原型', async () => {
    const input = makeDocument()
    const specialKeys = ['__proto__', 'constructor', '   ']
    for (const key of specialKeys) {
      input.videoItem.buffers = Object.fromEntries([...Object.entries(input.videoItem.buffers), [key, arrayBuffer(PNG_BYTES)]])
      input.imageResources.set(key, { key, data: new Uint8Array(PNG_BYTES), width: 1, height: 1, mimeType: 'image/png' })
      const slot: SlotConfig = { type: 'text', name: key, value: null, textConfig: { text: key, fontSize: 16, fontFamily: 'sans-serif', color: '#ffffff' } }
      input.slotConfigs = Object.fromEntries([...Object.entries(input.slotConfigs), [key, slot]])
    }
    input.detectedSlots.push(...specialKeys)
    const output = await readProjectArchive(await (await createProjectArchive(input)).arrayBuffer())
    for (const key of specialKeys) {
      expect(Object.prototype.hasOwnProperty.call(output.videoItem.buffers, key)).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(output.videoItem.movie.images, key)).toBe(true)
      expect(new Uint8Array(output.videoItem.buffers[key])).toEqual(PNG_BYTES)
      expect(output.imageResources.get(key)?.key).toBe(key)
      expect(Object.prototype.hasOwnProperty.call(output.slotConfigs, key)).toBe(true)
      expect(output.slotConfigs[key].textConfig?.text).toBe(key)
    }
    expect(Object.prototype).not.toHaveProperty('asset')
  })

  it('没有自定义帧率/时长、无选择及无插槽的工程仍可正常往返', async () => {
    const input = makeDocument()
    input.customFps = null
    input.customFrames = null
    input.selectedLayerId = null
    input.selectedLayerIds = []
    input.slotConfigs = {}
    input.detectedSlots = []
    const output = await readProjectArchive(await (await createProjectArchive(input)).arrayBuffer())
    expect(output.customFps).toBeNull()
    expect(output.customFrames).toBeNull()
    expect(output.selectedLayerId).toBeNull()
    expect(output.selectedLayerIds).toEqual([])
    expect(output.slotConfigs).toEqual({})
  })

  it.each(['preview', 'bake', undefined] as const)('文字框、固定参考尺寸与 %s 导出模式在真实归档往返后完整保留', async exportMode => {
    const input = makeDocument()
    Object.assign(input.slotConfigs.avatar_renamed.textConfig!, {
      text: '2222222222222', boxWidth: 300, boxHeight: 60,
      referenceWidth: 100, referenceHeight: 50,
      ...(exportMode !== undefined ? { exportMode } : {})
    })
    const output = await readProjectArchive(await (await createProjectArchive(input)).arrayBuffer())
    expect(output.slotConfigs.avatar_renamed).toEqual(input.slotConfigs.avatar_renamed)
    expect(output.layers).toEqual(input.layers)
    expect(output.imageResources).toEqual(input.imageResources)
    if (exportMode === undefined) expect(output.slotConfigs.avatar_renamed.textConfig).not.toHaveProperty('exportMode')
  })

  it('旧工程没有文字框和导出模式时仍可打开，不擅自补尺寸或改为写入文字', async () => {
    const output = await readProjectArchive(validArchive)
    const text = output.slotConfigs.avatar_renamed.textConfig!
    for (const key of ['boxWidth', 'boxHeight', 'referenceWidth', 'referenceHeight', 'exportMode']) {
      expect(text).not.toHaveProperty(key)
    }
    expect(text).toEqual(makeDocument().slotConfigs.avatar_renamed.textConfig)
  })

  it('文字框边长和面积恰为上限时允许保存，不将范围缩小', async () => {
    const input = makeDocument()
    Object.assign(input.slotConfigs.avatar_renamed.textConfig!, {
      boxWidth: 8192, boxHeight: 512, referenceWidth: 8192, referenceHeight: 512, exportMode: 'bake'
    })
    const output = await readProjectArchive(await (await createProjectArchive(input)).arrayBuffer())
    expect(output.slotConfigs.avatar_renamed.textConfig).toEqual(input.slotConfigs.avatar_renamed.textConfig)
  })
})

describe('工程归档：文字显示范围边界', () => {
  const box = { boxWidth: 300, boxHeight: 60, referenceWidth: 100, referenceHeight: 50 }

  it.each(['boxWidth', 'boxHeight', 'referenceWidth', 'referenceHeight'])('拒绝缺少 %s 的部分尺寸组', async key => {
    const buffer = await alterArchive(manifest => {
      const config = manifest.document.slotConfigs[0].config.textConfig!
      Object.assign(config, box)
      delete (config as unknown as Record<string, unknown>)[key]
    })
    await expect(readProjectArchive(buffer)).rejects.toThrow('文字框与参考尺寸必须同时保存')
  })

  it.each([
    ['零宽度', { boxWidth: 0 }],
    ['负高度', { boxHeight: -1 }],
    ['非整数文字框', { boxWidth: 300.5 }],
    ['非整数参考尺寸', { referenceHeight: 50.5 }],
    ['超长文字框', { boxWidth: 8193 }],
    ['超长参考尺寸', { referenceWidth: 8193 }],
    ['文本数值', { boxWidth: '300' }],
    ['空值参考尺寸', { referenceHeight: null }],
    ['文字框面积超限', { boxWidth: 4096, boxHeight: 2048 }],
    ['参考尺寸面积超限', { referenceWidth: 4096, referenceHeight: 2048 }],
    ['各自合法但合成面积超限', { boxWidth: 8192, boxHeight: 1, referenceWidth: 1, referenceHeight: 8192 }],
    ['未知导出模式', { exportMode: 'dynamic' }],
    ['空值导出模式', { exportMode: null }]
  ] as Array<[string, Record<string, unknown>]>)('拒绝%s，不将不安全配置交给画布分配或隐式修改导出策略', async (_name, patch) => {
    const buffer = await alterArchive(manifest => {
      Object.assign(manifest.document.slotConfigs[0].config.textConfig!, box, patch)
    })
    await expect(readProjectArchive(buffer)).rejects.toThrow('工程文件无效')
  })

  it('拒绝写入文字却未保存参考尺寸的配置，避免各动画帧被不一致栅格化', async () => {
    const buffer = await alterArchive(manifest => { manifest.document.slotConfigs[0].config.textConfig!.exportMode = 'bake' })
    await expect(readProjectArchive(buffer)).rejects.toThrow('必须包含完整文字框与参考尺寸')
  })

  it('仅模拟模式没有尺寸时仍保持旧行为', async () => {
    const buffer = await alterArchive(manifest => { manifest.document.slotConfigs[0].config.textConfig!.exportMode = 'preview' })
    const output = await readProjectArchive(buffer)
    expect(output.slotConfigs.avatar_renamed.textConfig!.exportMode).toBe('preview')
    expect(output.slotConfigs.avatar_renamed.textConfig).not.toHaveProperty('boxWidth')
  })

  it('保存入口也拒绝非法尺寸，不生成只有下次打开才报错的工程', async () => {
    const input = makeDocument()
    Object.assign(input.slotConfigs.avatar_renamed.textConfig!, box, { boxWidth: 8193 })
    await expect(createProjectArchive(input)).rejects.toThrow('数值无效')
  })
})

describe('工程归档：拒绝损坏、不受支持和不安全的输入', () => {
  it('公开与导入一致的 128 MiB 上限', () => {
    expect(MAX_PROJECT_BYTES).toBe(128 * 1024 * 1024)
  })

  it.each([
    ['不支持的版本', (manifest: Manifest) => { manifest.formatVersion = 2 }],
    ['错误格式', (manifest: Manifest) => { manifest.format = 'unrelated-zip' }],
    ['未知根字段', (manifest: Manifest) => { manifest.executable = 'run-me' }],
    ['未知文档字段', (manifest: Manifest) => { manifest.document.surprise = true }],
    ['错误摘要', (manifest: Manifest) => { manifest.assets[0].sha256 = '0'.repeat(64) }],
    ['错误资源大小', (manifest: Manifest) => { manifest.assets[0].size += 1 }],
    ['缺失原始输入资源', (manifest: Manifest) => { manifest.document.originalBuffer.asset = 'assets/missing.bin' }],
    ['重复资源声明', (manifest: Manifest) => { manifest.assets.push({ ...manifest.assets[0] }) }],
    ['重复图片 Key', (manifest: Manifest) => { manifest.document.imageResources.push({ ...manifest.document.imageResources[0] }) }],
    ['重复音频 Key', (manifest: Manifest) => { manifest.document.audioResources.push({ ...manifest.document.audioResources[0] }) }],
    ['重复缓存 Key', (manifest: Manifest) => { manifest.document.videoItem.buffers.push({ ...manifest.document.videoItem.buffers[0] }) }],
    ['重复插槽 Key', (manifest: Manifest) => { manifest.document.slotConfigs.push({ ...manifest.document.slotConfigs[0] }) }],
    ['无效画布尺寸', (manifest: Manifest) => { manifest.document.params = { ...sourceParams, viewBoxWidth: -1 } }]
  ])('%s 必须明确拒绝，不能部分恢复', async (_name, change) => {
    await expect(readProjectArchive(await alterArchive(change))).rejects.toThrow()
  })

  it('资源字节被替换后即使 ZIP CRC 正确也因 SHA-256 不匹配拒绝', async () => {
    const buffer = await alterArchive(async (manifest, zip) => {
      const asset = manifest.assets[0]
      const data = await zip.file(asset.path)!.async('uint8array')
      data[0] ^= 0xff
      zip.file(asset.path, data)
    })
    await expect(readProjectArchive(buffer)).rejects.toThrow()
  })

  it('声明资产不在 ZIP 中时拒绝，不回退到原始动画中的旧资源', async () => {
    const buffer = await alterArchive((manifest, zip) => { zip.remove(manifest.document.imageResources[0].data.asset) })
    await expect(readProjectArchive(buffer)).rejects.toThrow()
  })

  it.each(['../outside.bin', '/absolute.bin', 'assets/../../outside.bin', 'assets\\outside.bin', 'C:/outside.bin'])('拒绝 ZIP 中不安全的路径 %s', async path => {
    const buffer = await alterArchive((_manifest, zip) => { zip.file(path, new Uint8Array([1])) })
    await expect(readProjectArchive(buffer)).rejects.toThrow()
  })

  it.each(['https://example.com/image.png', 'http://127.0.0.1/private', 'file:///C:/private/photo.png'])('保存时拒绝远程或文件插槽地址 %s，且不发送请求', async url => {
    const input = makeDocument()
    input.slotConfigs.avatar_renamed.imageConfig!.url = url
    const fetchSpy = vi.fn(() => { throw new Error('不应请求不受信任的 URL') })
    vi.stubGlobal('fetch', fetchSpy)
    await expect(createProjectArchive(input)).rejects.toThrow()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('导入遇到远程资源引用或私自夹带 URL 时拒绝，且绝不 fetch', async () => {
    const buffer = await alterArchive(manifest => {
      manifest.document.slotConfigs[0].config.imageConfig!.url = 'https://example.com/untrusted.png'
    })
    const fetchSpy = vi.fn(() => { throw new Error('导入不应读取外部资源') })
    vi.stubGlobal('fetch', fetchSpy)
    await expect(readProjectArchive(buffer)).rejects.toThrow()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('资源引用不是归档内部路径时拒绝，即使地址看起来可下载也不请求', async () => {
    const buffer = await alterArchive(manifest => {
      manifest.document.originalBuffer.asset = 'https://example.com/original.svga'
    })
    const fetchSpy = vi.fn(() => { throw new Error('不允许从工程内加载远程文件') })
    vi.stubGlobal('fetch', fetchSpy)
    await expect(readProjectArchive(buffer)).rejects.toThrow()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('非 ZIP、截断 ZIP、缺失清单和无效 JSON 均拒绝', async () => {
    await expect(readProjectArchive(arrayBuffer(new TextEncoder().encode('not a project')))).rejects.toThrow()
    await expect(readProjectArchive(validArchive.slice(0, 40))).rejects.toThrow()
    const missing = await new JSZip().file('readme.txt', 'not a project').generateAsync({ type: 'arraybuffer' })
    await expect(readProjectArchive(missing)).rejects.toThrow()
    const invalid = await new JSZip().file('manifest.json', '{broken').generateAsync({ type: 'arraybuffer' })
    await expect(readProjectArchive(invalid)).rejects.toThrow()
  })

  it('保存时拒绝非 SVGA 原始字节，不能产生未来无法恢复的工程', async () => {
    const input = makeDocument()
    input.originalBuffer = arrayBuffer(new TextEncoder().encode('not svga'))
    await expect(createProjectArchive(input)).rejects.toThrow()
  })
})

describe('工程归档：真实解析器数据和旧格式兼容', () => {
  it('保留 protobuf 省略矩阵字段与数字枚举，不把不存在的 tx 或 alpha 补成零', async () => {
    const input = makeDocument()
    const sparseSprite = {
      imageKey: 'avatar_renamed', matteKey: 'mask', frames: [
        {},
        { alpha: 1, layout: { width: 40, height: 30 }, transform: { a: 1, d: 1, ty: 9 } },
        { shapes: [{ type: 'RECT', rect: { width: 5, height: 6 }, styles: { lineCap: 'LineCap_ROUND', lineJoin: 'LineJoin_BEVEL' } }] },
        { transform: { tx: 0 } }
      ]
    }
    const encoded = Movie.encode(Movie.fromObject({
      ...input.videoItem.movie,
      images: { avatar_renamed: PNG_BYTES, mask: PNG_BYTES },
      sprites: [sparseSprite, input.videoItem.movie.sprites[1]]
    })).finish()
    const decoded = Movie.toObject(Movie.decode(encoded), {
      bytes: Uint8Array, defaults: false, arrays: true, objects: true
    }) as unknown as MovieEntity
    input.originalBuffer = arrayBuffer(pako.deflate(encoded))
    input.videoItem.movie = decoded
    input.layers.forEach((layer, index) => { layer.sprites = decoded.sprites[index] })
    const output = await readProjectArchive(await (await createProjectArchive(input)).arrayBuffer())
    expect(output.videoItem.movie.sprites).toEqual(decoded.sprites)
    expect(output.layers[0].sprites).toEqual(decoded.sprites[0])
    const frames = output.videoItem.movie.sprites[0].frames
    expect(frames[0]).not.toHaveProperty('alpha')
    expect(frames[0]).not.toHaveProperty('transform')
    expect(frames[1].transform).not.toHaveProperty('tx')
    expect(frames[2].shapes?.[0].type).toBe(1)
    expect(frames[2].shapes?.[0].styles?.lineCap).toBe(1)
    expect(frames[2].shapes?.[0].styles?.lineJoin).toBe(2)
    expect(frames[3].transform).toEqual({ tx: 0 })
  })

  it('保留桌面 Rust 解析器的 Option 空字段和 shapeD 路径', async () => {
    const input = makeDocument()
    const nativeSprite = {
      imageKey: 'avatar_renamed', matteKey: null,
      frames: [{
        alpha: 1, layout: { x: null, y: 0, width: 40, height: 30 },
        transform: { a: null, d: 1, tx: null },
        shapes: [{ type: 0, shapeD: 'M0 0L40 0L40 30Z', rect: null, ellipse: null }]
      }]
    } as unknown as Sprite
    input.videoItem.movie.sprites[0] = nativeSprite
    input.layers[0].sprites = nativeSprite
    const output = await readProjectArchive(await (await createProjectArchive(input)).arrayBuffer())
    expect(output.videoItem.movie.sprites[0]).toEqual(nativeSprite)
    expect(output.layers[0].sprites).toEqual(nativeSprite)
  })

  it('桌面解析器未返回 movie.version 时恢复为既有 2.0.0 默认值', async () => {
    const input = makeDocument()
    delete (input.videoItem.movie as Partial<MovieEntity>).version
    const output = await readProjectArchive(await (await createProjectArchive(input)).arrayBuffer())
    expect(output.videoItem.movie.version).toBe('2.0.0')
  })

  it.each(['raw-protobuf', 'svga-header-v1', 'svga-header-v2'] as const)('原始输入 %s 能通过真实解码验证并原样保存', async kind => {
    const input = makeDocument()
    const protoBytes = pako.inflate(new Uint8Array(input.originalBuffer))
    if (kind === 'raw-protobuf') input.originalBuffer = arrayBuffer(protoBytes)
    else {
      const payload = kind === 'svga-header-v1' ? protoBytes : pako.deflate(protoBytes)
      const withHeader = new Uint8Array(8 + payload.byteLength)
      withHeader.set([83, 86, 71, 65, kind === 'svga-header-v1' ? 1 : 2, 0, 0, 0])
      withHeader.set(payload, 8)
      input.originalBuffer = withHeader.buffer
    }
    const output = await readProjectArchive(await (await createProjectArchive(input)).arrayBuffer())
    expect(new Uint8Array(output.originalBuffer)).toEqual(new Uint8Array(input.originalBuffer))
    expect(output.layers).toEqual(input.layers)
  })

  it('旧版仅存 value 的图片 URL 归档为资产，并保留独立文字模拟', async () => {
    const input = makeDocument()
    const config = input.slotConfigs.avatar_renamed
    config.value = PNG_DATA_URL
    delete config.imageConfig
    const archive = await createProjectArchive(input)
    const zip = await JSZip.loadAsync(await archive.arrayBuffer())
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as Manifest
    expect(manifest.document.slotConfigs[0].config.value).toMatchObject({ asset: { asset: expect.stringMatching(/^assets\//) }, mimeType: 'image/png' })
    expect(manifest.document.slotConfigs[0].config).not.toHaveProperty('imageConfig')
    const fetchSpy = vi.fn(() => { throw new Error('导入不可发起请求') })
    vi.stubGlobal('fetch', fetchSpy)
    const output = await readProjectArchive(await archive.arrayBuffer())
    expect(output.slotConfigs.avatar_renamed.value).toBe(PNG_DATA_URL)
    expect(output.slotConfigs.avatar_renamed.textConfig).toEqual(config.textConfig)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('图片 Key 仅有文字值而尚未替换图片时，不把普通文字当作图片地址', async () => {
    const input = makeDocument()
    delete input.slotConfigs.avatar_renamed.imageConfig
    const fetchSpy = vi.fn(() => { throw new Error('纯文字不应访问网络') })
    vi.stubGlobal('fetch', fetchSpy)
    const output = await readProjectArchive(await (await createProjectArchive(input)).arrayBuffer())
    expect(output.slotConfigs.avatar_renamed.value).toBe('小明')
    expect(output.slotConfigs.avatar_renamed.textConfig).toEqual(input.slotConfigs.avatar_renamed.textConfig)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('文字插槽中的网址只是文字，不会触发图片下载', async () => {
    const input = makeDocument()
    const config = input.slotConfigs.avatar_renamed
    config.type = 'text'
    config.value = 'https://design.example/team'
    config.textConfig!.text = config.value
    delete config.imageConfig
    const fetchSpy = vi.fn(() => { throw new Error('展示网址不应发起请求') })
    vi.stubGlobal('fetch', fetchSpy)
    const output = await readProjectArchive(await (await createProjectArchive(input)).arrayBuffer())
    expect(output.slotConfigs.avatar_renamed).toEqual(config)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('同时存在 imageConfig、旧 value 图片和 textConfig 时三者都保留', async () => {
    const input = makeDocument()
    input.slotConfigs.avatar_renamed.value = PNG_DATA_URL
    const output = await readProjectArchive(await (await createProjectArchive(input)).arrayBuffer())
    expect(output.slotConfigs.avatar_renamed).toEqual(input.slotConfigs.avatar_renamed)
  })
})

describe('工程归档：物理 ZIP 边界和嵌套数据限制', () => {
  it('STORE 条目中央目录和本地头同时伪造 CRC，仍按真实字节校验', async () => {
    const buffer = await storedArchive()
    const entry = inspectZipHeaders(buffer).find(item => item.name.startsWith('assets/'))!
    const view = new DataView(buffer)
    expect(view.getUint16(entry.central + 10, true)).toBe(0)
    const forgedCrc = (view.getUint32(entry.central + 16, true) ^ 0x80000000) >>> 0
    view.setUint32(entry.central + 16, forgedCrc, true)
    view.setUint32(entry.local + 14, forgedCrc, true)
    await expect(readProjectArchive(buffer)).rejects.toThrow('内容校验失败')
  })

  it('STORE 实际字节被改动而 CRC、大小与 SHA 声明不变时拒绝', async () => {
    const buffer = await storedArchive()
    const entry = inspectZipHeaders(buffer).find(item => item.name.startsWith('assets/'))!
    new Uint8Array(buffer)[entry.payload] ^= 0xff
    await expect(readProjectArchive(buffer)).rejects.toThrow('内容校验失败')
  })

  it.each(['名称', '压缩方式', '大小', 'CRC', '标志位'] as const)('ZIP 中央目录与本地头%s不一致时拒绝', async field => {
    const buffer = await storedArchive()
    const entry = inspectZipHeaders(buffer)[0]
    const view = new DataView(buffer)
    if (field === '名称') new Uint8Array(buffer)[entry.local + 30] ^= 1
    if (field === '压缩方式') view.setUint16(entry.local + 8, 8, true)
    if (field === '大小') view.setUint32(entry.local + 22, entry.size + 1, true)
    if (field === 'CRC') view.setUint32(entry.local + 14, (view.getUint32(entry.local + 14, true) + 1) >>> 0, true)
    if (field === '标志位') view.setUint16(entry.local + 6, view.getUint16(entry.local + 6, true) ^ 1, true)
    await expect(readProjectArchive(buffer)).rejects.toThrow(/本地.*不匹配/)
  })

  it('两个真实条目改成同名时拒绝，不采用 JSZip 最后一个覆盖的行为', async () => {
    const buffer = await storedArchive()
    const [first, second] = inspectZipHeaders(buffer).filter(item => item.name.startsWith('assets/'))
    expect(first.nameLength).toBe(second.nameLength)
    const data = new Uint8Array(buffer)
    const duplicateName = new TextEncoder().encode(first.name)
    data.set(duplicateName, second.central + 46)
    data.set(duplicateName, second.local + 30)
    await expect(readProjectArchive(buffer)).rejects.toThrow('重复条目')
  })

  it('路径合法但未在 manifest 声明的资产也拒绝', async () => {
    const buffer = await alterArchive((_manifest, zip) => {
      zip.file('assets/99999.bin', new Uint8Array([1, 2, 3]), { createFolders: false })
    })
    await expect(readProjectArchive(buffer)).rejects.toThrow('未声明资源')
  })

  it('DEFLATE 条目伪称极小解压长度时，按真实产出中止而不是相信声明', async () => {
    const buffer = validArchive.slice(0)
    const entry = inspectZipHeaders(buffer).find(item => item.name === 'manifest.json')!
    const view = new DataView(buffer)
    expect(view.getUint16(entry.central + 10, true)).toBe(8)
    view.setUint32(entry.central + 24, 1, true)
    view.setUint32(entry.local + 22, 1, true)
    await expect(readProjectArchive(buffer)).rejects.toThrow(/manifest.json.*实际解压大小超过安全上限/)
  })

  it('声明资产超过 128 MiB 时在解压前拒绝，无需构造巨大输入数组', async () => {
    const buffer = validArchive.slice(0)
    const entry = inspectZipHeaders(buffer).find(item => item.name.startsWith('assets/'))!
    const view = new DataView(buffer)
    view.setUint32(entry.central + 24, MAX_PROJECT_BYTES + 1, true)
    view.setUint32(entry.local + 22, MAX_PROJECT_BYTES + 1, true)
    await expect(readProjectArchive(buffer)).rejects.toThrow('ZIP 解压声明超过安全上限')
  })

  it.each(['movie', 'layer'] as const)('拒绝 %s 的未知 sprite 字段，不能静默丢弃后继续保存', async location => {
    const buffer = await alterArchive(manifest => {
      const sprite = location === 'movie'
        ? (manifest.document.videoItem.movie.sprites as Array<Record<string, unknown>>)[0]
        : (manifest.document.layers as Array<{ sprites: Record<string, unknown> }>)[0].sprites
      sprite.unrecognizedMotion = { expression: 'something' }
    })
    await expect(readProjectArchive(buffer)).rejects.toThrow('不受支持的字段')
  })

  it.each([
    ['超出单边上限', { viewBoxWidth: 8193, viewBoxHeight: 1 }],
    ['超出总像素上限', { viewBoxWidth: 4096, viewBoxHeight: 2048 }],
    ['当前文档与 movie 画布不一致', { viewBoxWidth: 641, viewBoxHeight: 360 }]
  ])('拒绝%s，不把危险尺寸交给后续画布分配', async (name, dimensions) => {
    const buffer = await alterArchive(manifest => {
      manifest.document.params = { ...(manifest.document.params as object), ...dimensions }
      // 上限用例保持两份尺寸一致，确保因真实尺寸上限拒绝，而非被不一致检查提前挡住。
      if (name !== '当前文档与 movie 画布不一致') {
        manifest.document.videoItem.movie.params = { ...(manifest.document.videoItem.movie.params as object), ...dimensions }
      }
    })
    await expect(readProjectArchive(buffer)).rejects.toThrow()
  })

  it('源矩阵可省略数值，但用户可编辑轨道不能含 null', async () => {
    const buffer = await alterArchive(manifest => {
      const layers = manifest.document.layers as Array<{ animationTracks: { position: { currentValue: { x: unknown; y: number } } } }>
      layers[0].animationTracks.position.currentValue.x = null
    })
    await expect(readProjectArchive(buffer)).rejects.toThrow('数值无效')
  })

  it('嵌套原始 SVGA 的真实 zlib 输出超过 128 MiB 时，在建立完整结果前停止', async () => {
    const Deflate = (pako as unknown as {
      Deflate: new (options: { level: number }) => { push: (data: Uint8Array, last: boolean) => void; err: number; result: Uint8Array }
    }).Deflate
    const deflater = new Deflate({ level: 9 })
    // 复用 1 MiB 输入块，不在测试构造阶段分配 128 MiB 原始数组。
    const zeroChunk = new Uint8Array(1024 * 1024)
    for (let count = 0; count < 128; count++) deflater.push(zeroChunk, false)
    deflater.push(new Uint8Array([0]), true)
    expect(deflater.err).toBe(0)
    expect(deflater.result.byteLength).toBeLessThan(200 * 1024)
    const buffer = await replaceOriginalArchive(deflater.result)
    await expect(readProjectArchive(buffer)).rejects.toThrow(/原始 SVGA.*解压大小超过安全上限/)
  }, 20000)

  it('解析 JSON 前拒绝过深嵌套，不先创建巨大的递归对象', async () => {
    const zip = new JSZip()
    zip.file('manifest.json', `${'['.repeat(40)}0${']'.repeat(40)}`)
    const buffer = await zip.generateAsync({ type: 'arraybuffer' })
    await expect(readProjectArchive(buffer)).rejects.toThrow('JSON 嵌套超过安全上限')
  })

  it('清单字节虽小，百万个空对象也必须在 JSON.parse 之前拒绝', async () => {
    const zip = new JSZip()
    zip.file('manifest.json', `[${'{},'.repeat(1_000_000)}{}]`)
    const buffer = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })
    await expect(readProjectArchive(buffer)).rejects.toThrow('JSON 结构数量超过安全上限')
  })
})
