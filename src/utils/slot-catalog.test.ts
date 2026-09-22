import { describe, expect, it } from 'vitest'
import { LayerFactory } from '@/core/layer-factory'
import type { FrameData, ImageResource, Layer, SlotConfig, VideoItem } from '@/types'
import { buildSlotCatalog, isTextKeyCandidate } from './slot-catalog'

const png = (width = 16, height = 8): Uint8Array => {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

const image = (key: string, options: Partial<Layer> = {}): Layer => ({
  ...LayerFactory.createImageLayer({ key, data: png(), width: 16, height: 8, mimeType: 'image/png' }),
  ...options,
})

const video = (overrides: Partial<VideoItem['movie']> = {}): VideoItem => ({
  movie: {
    version: '2.0', params: { viewBoxWidth: 100, viewBoxHeight: 100, fps: 24, frames: 2 },
    images: {}, sprites: [], ...overrides,
  }, images: {}, buffers: {},
})

const frame = (width = 16, height = 8): FrameData => ({
  alpha: 1, layout: { x: 0, y: 0, width, height },
  transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, clipPath: null,
})

const resource = (key: string, extra: Partial<ImageResource> = {}): ImageResource => ({
  key, data: png(), width: 16, height: 8, mimeType: 'image/png', ...extra,
})

describe('插槽 Key catalog', () => {
  it('保留图片 Key 的精确字符串，不将 $ 或 @ 后缀拆成另一个 Key', () => {
    const key = '$user@name text'
    const layer = image(key, { id: 'layer-1', sprites: { imageKey: key, matteKey: null, frames: [] } })
    const result = buildSlotCatalog(video(), [layer], new Map(), {})
    expect(result.map(entry => entry.key)).toEqual([key])
    expect(result[0]).toMatchObject({ referenceLayerIds: ['layer-1'], textCandidate: true })
  })

  it('当前图层删除后不从原始 sprite 列表复活旧 Key，但仍列出实际资源和孤立配置', () => {
    const stale = 'deleted-original'
    const config: Record<string, SlotConfig> = Object.create(null)
    config.orphan = { type: 'text', name: 'orphan', value: null, textConfig: { text: '测试', fontSize: 20, color: '#fff', fontFamily: 'sans-serif' } }
    const result = buildSlotCatalog(video({
      sprites: [{ imageKey: stale, matteKey: null, frames: [] }],
      images: { resourceOnly: png() },
    }), [], new Map([['map-only', { key: 'map-only', data: png(), width: 16, height: 8, mimeType: 'image/png' }]]), config)
    expect(result.map(entry => entry.key)).toEqual(['resourceOnly', 'map-only', 'orphan'])
    expect(result.some(entry => entry.key === stale)).toBe(false)
    expect(result.find(entry => entry.key === 'orphan')).toMatchObject({ textConfigured: true, canSimulateText: false })
  })

  it('只把真实图片或有效图片签名标记为可用，音频 Key 不进入 catalog', () => {
    const result = buildSlotCatalog(video({
      images: { audio: new Uint8Array([0x49, 0x44, 0x33]), notImage: new Uint8Array([1, 2, 3]) },
      audios: [{ key: 'audio', data: new Uint8Array([1]), startTime: 0, duration: 100 }],
    }), [image('notImage')], new Map([
      ['valid', { key: 'valid', data: png(4, 3), width: 4, height: 3, mimeType: 'image/png' }],
      ['invalid', { key: 'invalid', data: new Uint8Array([1, 2]), width: 4, height: 3, mimeType: 'image/png' }],
    ]), {})
    expect(result.map(entry => entry.key)).toEqual(['notImage', 'valid', 'invalid'])
    expect(result.find(entry => entry.key === 'valid')).toMatchObject({ imageAvailable: true, width: 4, height: 3 })
    expect(result.find(entry => entry.key === 'invalid')).toMatchObject({ imageAvailable: false })
    expect(result.some(entry => entry.key === 'audio')).toBe(false)
  })

  it('区分遮罩、矢量、共享引用和尺寸警告，避免误称为文字 Key', () => {
    const vector = image('shape', { id: 'vector-layer', type: 'shape', sprites: { imageKey: 'shape', matteKey: null, frames: [{ alpha: 1, layout: { x: 0, y: 0, width: 20, height: 10 }, transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, clipPath: null, shapes: [{ type: 'RECT' }] }] } })
    const masked = image('avatar_text', { id: 'masked-layer', sprites: { imageKey: 'avatar_text', matteKey: 'mask', frames: [{ alpha: 1, layout: { x: 0, y: 0, width: 20, height: 10 }, transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, clipPath: null }] } })
    const second = image('avatar_text', { id: 'second-layer' })
    const result = buildSlotCatalog(video(), [vector, masked, second], new Map(), {})
    expect(result.find(entry => entry.key === 'mask')).toMatchObject({ isMatte: true, canSimulateText: false, referenceLayerIds: ['masked-layer'] })
    expect(result.find(entry => entry.key === 'shape')).toMatchObject({ isVector: true, canSimulateText: false })
    expect(result.find(entry => entry.key === 'avatar_text')).toMatchObject({ textCandidate: true, canSimulateText: true, referenceLayerIds: ['masked-layer', 'second-layer'] })
  })

  it('不信任原型链 Key，并在资源与布局尺寸冲突时给出提示', () => {
    const resources = new Map<string, ImageResource>([['__proto__', { key: '__proto__', data: png(4, 3), width: 4, height: 3, mimeType: 'image/png' }]])
    const layer = image('__proto__', { id: 'safe', sprites: { imageKey: '__proto__', matteKey: null, frames: [{ alpha: 1, layout: { x: 0, y: 0, width: 5, height: 6 }, transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, clipPath: null }] } })
    const result = buildSlotCatalog(video(), [layer], resources, Object.create(null))
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ key: '__proto__', referenceLayerIds: ['safe'], width: 5, height: 6, imageAvailable: true })
    expect(result[0].warning).toContain('尺寸')
  })

  it('当前层与资源映射同时列出，空图层不是加载旧图层的信号', () => {
    const source = video({ images: { '2': png(), png: png() } })
    source.buffers = { buffer: png(5, 6).buffer as ArrayBuffer }
    source.images = { decoded: { src: 'blob:decoded', width: 9, height: 10 } as HTMLImageElement }
    const resources = new Map([['external', resource('external')]])
    const config = { missing: { type: 'text', name: 'missing', value: null } } satisfies Record<string, SlotConfig>
    const layers = [image('active')]
    expect(buildSlotCatalog(source, layers, resources, config).map(entry => entry.key)).toEqual(['active', '2', 'png', 'buffer', 'decoded', 'external', 'missing'])
    const withoutLayers = buildSlotCatalog(source, [], resources, config)
    expect(withoutLayers.every(entry => entry.referenceLayerIds.length === 0 && !entry.canSimulateText)).toBe(true)
    expect(withoutLayers.find(entry => entry.key === 'buffer')).toMatchObject({ imageAvailable: true, width: 5, height: 6 })
    expect(withoutLayers.find(entry => entry.key === 'decoded')).toMatchObject({ imageAvailable: true, width: 9, height: 10 })
  })

  it('显示名称和图片 Key 分离，重命名层不新增 Key，共享引用按 id 去重', () => {
    const layers = [image('same', { id: 'a', name: 'renamed', visible: false, locked: true }),
      image('same', { id: 'b', name: 'renamed' }), image('same', { id: 'a', name: 'duplicate-id' })]
    const [entry] = buildSlotCatalog(null, layers, new Map([['same', resource('same')]]), {})
    expect(entry.referenceLayerIds).toEqual(['a', 'b'])
    expect(entry.canSimulateText).toBe(true)
    expect(entry.warning).toContain('2 个图片图层')
  })

  it('当前图片 Key 优先于旧精灵 Key，保留精确空白，不将空字符串回退成旧 Key', () => {
    const source = video({ sprites: [{ imageKey: 'old', matteKey: null, frames: [frame()] }] })
    const result = buildSlotCatalog(source, [
      image('new', { isNew: false, editableIndex: 0, sprites: { imageKey: 'stale', matteKey: null, frames: [frame()] } }),
      image('', { id: 'empty', sprites: { imageKey: 'removed', matteKey: null, frames: [frame()] } }),
      image('  ', { id: 'spaces' }),
      image('fallback', { id: 'fallback', imageKey: undefined, isNew: false, editableIndex: 0 }),
    ], new Map(), {})
    expect(result.map(entry => entry.key)).toEqual(['new', '  ', 'old'])
    expect(result[0]).toMatchObject({ width: 16, height: 8, canSimulateText: true })
  })

  it('原始遮罩关系仅用于仍然存在的旧图层，新层不借用相同索引的遮罩', () => {
    const source = video({ sprites: [
      { imageKey: 'before', matteKey: 'original-mask', frames: [frame()] },
      { imageKey: 'deleted', matteKey: 'deleted-mask', frames: [frame()] },
    ] })
    const result = buildSlotCatalog(source, [
      image('after', { id: 'retained', isNew: false, editableIndex: 0 }),
      image('new', { id: 'added', isNew: true, editableIndex: 1, sprites: { imageKey: 'new', matteKey: 'new-mask', frames: [frame()] } }),
    ], new Map(), {})
    expect(result.map(entry => entry.key)).toEqual(['after', 'original-mask', 'new', 'new-mask'])
    expect(result.find(entry => entry.key === 'after')).toMatchObject({ isMatte: false, canSimulateText: true })
    expect(result.find(entry => entry.key === 'original-mask')).toMatchObject({ isMatte: true, referenceLayerIds: ['retained'] })
  })

  it('使用 mask Key 的普通图片层和 .matte Key 都为只读，vector 不能伪装成位图', () => {
    const layers = [
      image('content', { sprites: { imageKey: 'content', matteKey: 'mask', frames: [frame()] } }),
      image('mask'), image('logo.matte'),
      image('vector', { sprites: { imageKey: 'vector', matteKey: null, frames: [{ ...frame(), shapes: [{ type: 'RECT' }] }] } }),
    ]
    const entries = buildSlotCatalog(null, layers, new Map(layers.map(layer => [layer.imageKey!, resource(layer.imageKey!)])), {})
    expect(entries.filter(entry => entry.canSimulateText).map(entry => entry.key)).toEqual(['content'])
    expect(entries.find(entry => entry.key === 'vector')).toMatchObject({ isVector: true, imageAvailable: false })
    expect(entries.find(entry => entry.key === 'logo.matte')).toMatchObject({ isMatte: true })
  })

  it('任何引用中含矢量帧都禁止文字模拟，不只检查首个引用', () => {
    const entries = buildSlotCatalog(null, [image('shared'), image('shared', {
      sprites: { imageKey: 'shared', matteKey: null, frames: [{ ...frame(), shapes: [{ type: 'KEEP' }] }] },
    })], new Map([['shared', resource('shared')]]), {})
    expect(entries[0]).toMatchObject({ isVector: true, imageAvailable: false, canSimulateText: false })
  })

  it('矢量后缀在形状数据缺失时也只读，不当作位图文字插槽', () => {
    const entry = buildSlotCatalog(null, [image('title.vector', { sprites: { imageKey: 'title.vector', matteKey: null, frames: [frame()] } })], new Map(), {})[0]
    expect(entry).toMatchObject({ isVector: true, canSimulateText: false, imageAvailable: false })
  })

  it('音频同时支持 protobuf audioKey、编辑态 key、音频层和头格式', () => {
    const rawAudio = [{ audioKey: 'proto-audio' }] as unknown as NonNullable<VideoItem['movie']['audios']>
    const source = video({ images: { 'proto-audio': png(), ogg: [79, 103, 103, 83], wav: [82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69], flac: [102, 76, 97, 67], mp3: [255, 251], mp3likeName: png() }, audios: rawAudio })
    const entries = buildSlotCatalog(source, [image('ignored-image-field', { type: 'audio', audioKey: 'layer-audio' })],
      new Map([['layer-audio', resource('layer-audio')]]), {})
    expect(entries.map(entry => entry.key)).toEqual(['mp3likeName'])
  })

  it.each([
    ['empty', new Uint8Array()], ['random', new Uint8Array([3, 1, 4])],
    ['short-png', new Uint8Array([137, 80, 78, 71])], ['invalid-array', [500, 0]],
  ])('不能只因 MIME 或资源存在就标记有效图片：%s', (key, data) => {
    const entries = buildSlotCatalog(video({ images: { [key]: data } }), [image(key)], new Map(), {})
    expect(entries[0]).toMatchObject({ imageAvailable: false, width: 0, height: 0, canSimulateText: false })
  })

  it.each([
    ['jpeg', [255, 216, 255, 224]], ['gif', [71, 73, 70, 56, 57, 97, 10, 0, 20, 0]],
    ['webp', [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]],
  ])('识别图片头而不依赖 Key 命名：%s', (key, data) => {
    expect(buildSlotCatalog(video({ images: { [key]: data } }), [], new Map(), {})[0].imageAvailable).toBe(true)
  })

  it('实际图片来源/bitmap 可用，单独 metadata 不能证明存在图片', () => {
    const entries = buildSlotCatalog(null, [image('layer-src', { imageSource: { type: 'url', value: 'https://example.com/image.png' } })], new Map([
      ['metadata', resource('metadata', { data: new Uint8Array() })],
      ['blob', resource('blob', { data: new Uint8Array(), blobUrl: 'blob:local' })],
      ['bitmap', resource('bitmap', { data: new Uint8Array(), bitmap: { width: 7, height: 8 } as ImageBitmap })],
      ['unsafe', resource('unsafe', { data: new Uint8Array(), source: { type: 'url', value: 'javascript:alert(1)' } })],
      ['audio-data', resource('audio-data', { data: new Uint8Array(), source: { type: 'dataUrl', value: 'data:audio/mpeg;base64,a' } })],
    ]), {})
    expect(entries.filter(entry => entry.imageAvailable).map(entry => entry.key)).toEqual(['layer-src', 'blob', 'bitmap'])
  })

  it('配置文字不要求非空，图片替换中的文字配置也能识别', () => {
    const configs: Record<string, SlotConfig> = {
      empty: { type: 'text', name: 'empty', value: '' },
      both: { type: 'image', name: 'both', value: 'blob:image', textConfig: { text: '', fontSize: 20, fontFamily: 'Arial', color: '#fff' } },
      imageOnly: { type: 'image', name: 'imageOnly', value: 'blob:only' },
    }
    expect(buildSlotCatalog(null, [], new Map(), configs).filter(entry => entry.textConfigured).map(entry => entry.key)).toEqual(['empty', 'both'])
  })

  it('安全处理数字字符串与 __proto__/constructor 等自有 Key，不读取原型配置', () => {
    const images = JSON.parse('{"__proto__":[137,80,78,71,13,10,26,10],"0":[137,80,78,71,13,10,26,10]}') as VideoItem['movie']['images']
    const configs = Object.create({ constructor: { type: 'text', value: 'inherited' }, inherited: { type: 'text' } }) as Record<string, SlotConfig>
    Object.defineProperty(configs, '__proto__', { value: { type: 'text', value: '' }, enumerable: true })
    const entries = buildSlotCatalog(video({ images }), [image('constructor'), image('toString')], new Map(), configs)
    expect(entries.map(entry => entry.key)).toEqual(['constructor', 'toString', '0', '__proto__'])
    expect(entries.find(entry => entry.key === 'constructor')).toMatchObject({ textConfigured: false, imageAvailable: false })
    expect(entries.find(entry => entry.key === '__proto__')).toMatchObject({ textConfigured: true, imageAvailable: true })
    expect(Object.getPrototypeOf(configs).constructor.value).toBe('inherited')
  })

  it.each([[0, 8], [-1, 8], [Infinity, 8], [8, NaN]])('无效布局 %s×%s 不用于预览', (width, height) => {
    const layer = image('x', { sprites: { imageKey: 'x', matteKey: null, frames: [frame(width, height)] } })
    expect(buildSlotCatalog(null, [layer], new Map(), {})[0]).toMatchObject({ width: 0, height: 0, canSimulateText: false })
  })

  it.each([[8193, 1], [4096, 2048], [8192, 512.1]])('预览尺寸 %s×%s 超过分配上限时禁用模拟', (width, height) => {
    const layer = image('x', { sprites: { imageKey: 'x', matteKey: null, frames: [frame(width, height)] } })
    const entry = buildSlotCatalog(null, [layer], new Map(), {})[0]
    expect(entry.canSimulateText).toBe(false)
    expect(entry.reason).toContain('超限')
  })

  it('不修改输入对象，重复调用保持稳定顺序', () => {
    const layers = [image('b'), image('a')]
    const source = video({ images: { unreferenced: png() } })
    const resources = new Map([['c', resource('c')]])
    const configs = { orphan: { type: 'text', name: 'orphan', value: '' } } satisfies Record<string, SlotConfig>
    const before = structuredClone({ layers, source, resources, configs })
    const first = buildSlotCatalog(source, layers, resources, configs)
    expect(buildSlotCatalog(source, layers, resources, configs)).toEqual(first)
    expect({ layers, source, resources, configs }).toEqual(before)
  })
})

describe('文字 Key 命名提示', () => {
  it.each(['text_user', 'userName', '昵称', 'label-01', 'TITLE', '$text@2', 'TEXT_01', 'displayName', 'user_name', 'text12', '名字.文字', 'name', 'name_1'])('识别明显的文字命名 %s', key => {
    expect(isTextKeyCandidate(key)).toBe(true)
  })

  it.each(['contexture/button_name', 'button_icon', 'avatar', 'image_01', 'contexture', 'filename', 'usernames', 'titlebar', 'buttonName', 'rename', '0', '__proto__'])('不把普通图片命名 %s 误判为文字', key => {
    expect(isTextKeyCandidate(key)).toBe(false)
  })
})
