import { afterEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import pako from 'pako'
import protobuf from 'protobufjs'
import { createHash } from 'node:crypto'
import type { DeliveryOptions, DeliverySlot } from '@/types/delivery'
import type { FrameData, Layer, SlotConfig, SlotTextConfig } from '@/types'
import { SVGAValidator } from '@/utils/svga-validator'
import { createDefaultTracks } from './layer-factory'
import { OPTIMIZATION_PRESETS } from './optimizer'
import { createDeliveryArchive, MAX_DELIVERY_BYTES, MAX_DELIVERY_FILE_BYTES, normalizeDeliveryOptions, type DeliveryArchiveInput } from './delivery-archive'
import proto from './svga-proto'

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=', 'base64'))
const Movie = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const copyBuffer = (bytes: Uint8Array) => new Uint8Array(bytes).buffer
const options = (): DeliveryOptions => ({ title: '客户昵称动画', target: { platform: 'android', player: 'SVGAPlayer', version: '2.x', maxFileBytes: null, maxDecodedImageBytes: null }, includeProject: false })
const frame = (): FrameData => ({ alpha: 1, layout: { x: 0, y: 0, width: 100, height: 40 }, transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, clipPath: null })
const fakeImage = (width = 1, height = 1) => ({ width, height, naturalWidth: width, naturalHeight: height }) as HTMLImageElement
const text = (patch: Partial<SlotTextConfig> = {}): SlotTextConfig => ({ text: '设计师小明', fontFamily: 'sans-serif', color: '#fff', fontSize: 24, ...patch })
const textSlot = (config: SlotTextConfig): SlotConfig => ({ type: 'text', name: '昵称插槽', value: config.text, textConfig: config })

async function syncArtifact(input: DeliveryArchiveInput): Promise<void> {
  const encoded = pako.deflate(Movie.encode(Movie.fromObject(input.output.movie)).finish())
  input.animation = new Blob([copyBuffer(encoded)])
  input.validation = await new SVGAValidator().validate(copyBuffer(encoded))
  input.output.buffers = Object.fromEntries(Object.entries(input.output.movie.images).map(([key, bytes]) => [key, copyBuffer(new Uint8Array(bytes))]))
}

async function fixture(): Promise<DeliveryArchiveInput> {
  const params = { viewBoxWidth: 320, viewBoxHeight: 240, fps: 24, frames: 4 }
  const sprite = { imageKey: 'nickname_final', matteKey: null, frames: Array.from({ length: 4 }, frame) }
  const layer: Layer = { id: 'layer-1', name: '昵称', type: 'image', imageKey: 'nickname_current', editableIndex: 0, visible: true, locked: false, expanded: false, opacity: 1, blendMode: 'normal', clip: { startFrame: 0, duration: 4 }, tracks: createDefaultTracks(), sprites: { ...sprite, imageKey: 'nickname_old' } }
  const videoItem = { movie: { version: '2.0.0', params, images: { nickname_old: png }, sprites: [layer.sprites!] }, images: { nickname_old: fakeImage() }, buffers: { nickname_old: copyBuffer(png) } }
  const optimization = structuredClone(OPTIMIZATION_PRESETS[0].config)
  const input: DeliveryArchiveInput = {
    document: {
      formatVersion: 1, name: '源工程', originalBuffer: new ArrayBuffer(0), videoItem, params, customFps: null, customFrames: null, layers: [layer],
      imageResources: new Map(), audioResources: new Map(), slotConfigs: { nickname_current: textSlot(text()) }, detectedSlots: ['nickname_current'],
      compressionConfig: { enabled: false, mode: 'png', quality: 100, resizeEnabled: false, resizePercent: 100 }, optimizationConfig: optimization,
      selectedPresetId: 'none', currentFrame: 1, selectedLayerId: null, selectedLayerIds: []
    },
    options: options(), sourceRevision: 'a'.repeat(64), animation: new Blob(), output: { movie: { version: '2.0.0', params, images: { nickname_final: new Uint8Array(png) }, sprites: [sprite] }, images: { nickname_final: fakeImage() }, buffers: {} },
    bindings: [{ spriteIndex: 0, layerId: 'layer-1', originalSpriteIndex: 0, sourceImageKey: 'nickname_old', sourceSlotKey: 'nickname_current', baselineImageKey: 'nickname_final' }],
    actualPreview: new Blob([copyBuffer(png)], { type: 'image/png' }), designPreview: new Blob([copyBuffer(png)], { type: 'image/png' }),
    optimization, warnings: [], validation: { isValid: true, errors: [], warnings: [], info: { imagesCount: 1, spritesCount: 1 } }
  }
  await syncArtifact(input)
  input.document.originalBuffer = await input.animation.arrayBuffer()
  return input
}

async function readZip(blob: Blob): Promise<JSZip> {
  return JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true })
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('normalizeDeliveryOptions', () => {
  it('修剪名称并保留不修改调用方输入', () => {
    const input = options()
    input.title = '  交付名称  '
    input.target.player = ' Player '
    input.target.version = '  3.0  '
    input.target.maxDecodedImageBytes = 1024 ** 4
    const result = normalizeDeliveryOptions(input)
    expect(result).toEqual({ ...input, title: '交付名称', target: { ...input.target, player: 'Player', version: '3.0' } })
    expect(input.title).toBe('  交付名称  ')
  })

  it.each(['', '  ', '\n标题', '名称\u0000', '名称\u007f', 'a'.repeat(121)])('拒绝空白、控制字符或过长名称 %j', title => {
    expect(() => normalizeDeliveryOptions({ ...options(), title })).toThrow()
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 1024 ** 4 + 1, undefined])('拒绝无效字节预算 %s', value => {
    const input = options()
    input.target.maxFileBytes = value as number
    expect(() => normalizeDeliveryOptions(input)).toThrow('文件体积预算')
    input.target.maxFileBytes = null
    input.target.maxDecodedImageBytes = value as number
    expect(() => normalizeDeliveryOptions(input)).toThrow('图片解码预算')
  })

  it('播放器与版本可为空，但限制长度与控制字符', () => {
    const input = options()
    input.target.player = ' '
    input.target.version = ''
    expect(normalizeDeliveryOptions(input).target.player).toBe('')
    input.target.player = 'a'.repeat(121)
    expect(() => normalizeDeliveryOptions(input)).toThrow('播放器名称')
    input.target.player = 'player'
    input.target.version = '1\n2'
    expect(() => normalizeDeliveryOptions(input)).toThrow('播放器版本')
  })

  it('拒绝非法枚举及附带工程的非布尔值', () => {
    const input = options()
    input.target.platform = 'verified' as DeliveryOptions['target']['platform']
    expect(() => normalizeDeliveryOptions(input)).toThrow('平台')
    input.target.platform = 'web'
    input.includeProject = 'yes' as unknown as boolean
    expect(() => normalizeDeliveryOptions(input)).toThrow('设置')
  })
})

describe('createDeliveryArchive', () => {
  it('生成真实可读ZIP，重算全部摘要，清单没有自引用，默认不泄露源工程', async () => {
    const input = await fixture()
    input.projectArchive = new Blob(['不应打包的源工程'])
    const phases: string[] = []
    const result = await createDeliveryArchive(input, { onPhase: message => phases.push(message) })
    const zip = await readZip(result.blob)
    expect(Object.keys(zip.files).sort()).toEqual(['README.html', 'README.md', 'animation.svga', 'checksums.sha256', 'manifest.json', 'previews/actual.png', 'previews/design.png', 'report.json', 'resources/00001.png', 'slots.json'].sort())
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    expect(manifest).toEqual(result.manifest)
    expect(manifest.params).toEqual(input.output.movie.params)
    expect(manifest.includesProject).toBe(false)
    expect(manifest.independentKeysPreserved).toBe(true)
    expect(manifest.optimization.image.deduplicate).toBe(false)
    expect(manifest.sourceRevision).toEqual({ schemaVersion: 1, algorithm: 'sha256', value: input.sourceRevision })
    expect(manifest.files.map((file: { path: string }) => file.path)).not.toContain('manifest.json')
    expect(manifest.files.map((file: { path: string }) => file.path)).not.toContain('checksums.sha256')
    for (const file of result.manifest.files) {
      const bytes = await zip.file(file.path)!.async('uint8array')
      expect(bytes.length).toBe(file.bytes)
      expect(hash(bytes)).toBe(file.sha256)
    }
    const checksumLines = (await zip.file('checksums.sha256')!.async('string')).trim().split('\n')
    expect(checksumLines).toHaveLength(Object.keys(zip.files).length - 1)
    for (const line of checksumLines) {
      const [expected, path] = line.split('  ')
      expect(hash(await zip.file(path)!.async('uint8array'))).toBe(expected)
      expect(path).not.toBe('checksums.sha256')
    }
    expect(await zip.file('animation.svga')!.async('uint8array')).toEqual(new Uint8Array(await input.animation.arrayBuffer()))
    expect(await zip.file('resources/00001.png')!.async('uint8array')).toEqual(png)
    expect(Object.values(zip.files).every(file => file.date.getUTCFullYear() === 2000 && !file.dir)).toBe(true)
    expect(phases).toEqual(['检查交付快照与来源', '核对真实 Key、文字状态与资源摘要', '生成离线报告与完整性清单', '封装交付 ZIP'])
  })

  it('记录实际输出尺寸和精确重命名来源，目标SDK永远未实测', async () => {
    const input = await fixture()
    input.document.params = { ...input.document.params, viewBoxWidth: 999 }
    input.document.imageResources.set('nickname_current', { key: 'nickname_current', data: png, width: 100, height: 40, mimeType: 'image/png' })
    const { slots, report, manifest } = await createDeliveryArchive(input)
    expect(slots[0]).toMatchObject({ key: 'nickname_final', role: 'image', state: 'referenced', resource: { width: 1, height: 1, bytes: png.length, sha256: hash(png) }, spriteIndices: [0], matteForSpriteIndices: [], sources: [{ ...input.bindings[0], layerName: '昵称', currentImageKey: 'nickname_current', textEffect: 'dynamic', text: { text: '设计师小明' } }] })
    expect(manifest.params.viewBoxWidth).toBe(320)
    expect(report.decodedImageBytesEstimate).toBe(4)
    expect(report.previewFrame).toBe(1)
    expect(report.checks.find(check => check.id === 'target-runtime')?.status).toBe('not-tested')
    expect(report.checks.find(check => check.title === 'Key 已重命名')?.key).toBe('nickname_final')
  })

  it('Key可含路径和原型名称，但ZIP路径固定，HTML全部转义无脚本/远程请求', async () => {
    const input = await fixture()
    const attack = '../../<script src="https://evil.test/a"></script><img src=x onerror="alert(1)">'
    const keys = [attack, 'constructor', ' name with spaces ', 'a\\..\\b']
    input.options.title = '<img src=x onerror="alert(1)">'
    input.options.target.player = '</title><script>alert(1)</script>'
    input.document.layers[0].name = attack
    input.document.slotConfigs.nickname_current = textSlot(text({ text: attack }))
    input.warnings = [attack]
    input.output.movie.images = Object.fromEntries(keys.map(key => [key, new Uint8Array(png)]))
    input.output.images = Object.fromEntries(keys.map(key => [key, fakeImage()]))
    input.output.movie.sprites[0].imageKey = attack
    input.bindings[0].baselineImageKey = attack
    await syncArtifact(input)
    const result = await createDeliveryArchive(input)
    const zip = await readZip(result.blob)
    const html = await zip.file('README.html')!.async('string')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('src="https:')
    expect(html).toContain('&lt;script src=&quot;https://evil.test/a&quot;&gt;')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("script-src 'none'")
    expect(html).toContain("connect-src 'none'")
    expect(html).toContain("font-src 'none'")
    expect([...html.matchAll(/<img\s+src="([^"]+)"/g)].map(match => match[1])).toEqual(['previews/actual.png', 'previews/design.png'])
    expect(Object.keys(zip.files).filter(path => path.startsWith('resources/'))).toEqual(keys.map((_, index) => `resources/${String(index + 1).padStart(5, '0')}.png`))
    expect(Object.keys(zip.files).every(path => !path.includes('..') && !path.includes('\\'))).toBe(true)
    const catalog = JSON.parse(await zip.file('slots.json')!.async('string'))
    expect(catalog.slots.map((slot: DeliverySlot) => slot.key)).toEqual(keys)
    expect(result.fileName).not.toMatch(/[<>:"/\\|?*]/)
  })

  it('收到安全Map的__proto__资源时用数组保留，不把Key用作对象原型', async () => {
    const input = await fixture()
    // protobuf 层是否允许该 Key 由流水线负责；本例单独证明归档层不会吞 Key 或改变原型。
    Object.defineProperty(input.output.movie.images, '__proto__', { value: png, enumerable: true })
    Object.defineProperty(input.output.buffers, '__proto__', { value: copyBuffer(png), enumerable: true })
    Object.defineProperty(input.output.images, '__proto__', { value: fakeImage(), enumerable: true })
    input.validation.info.imagesCount = 2
    const result = await createDeliveryArchive(input)
    const catalog = JSON.parse(await (await readZip(result.blob)).file('slots.json')!.async('string'))
    expect(catalog.slots.find((slot: DeliverySlot) => slot.key === '__proto__')).toMatchObject({ key: '__proto__', state: 'unreferenced', resource: { path: 'resources/00002.png' } })
    expect(Object.getPrototypeOf(input.output.movie.images)).toBe(Object.prototype)
  })

  it.each([
    ['preview', true, 'visible', 'dynamic'], ['bake', true, 'visible', 'baked'],
    ['bake', false, 'visible', 'disabled'], ['bake', true, '  \n ', 'empty'],
    ['preview', false, 'visible', 'disabled'], ['preview', true, '', 'empty']
  ] as const)('文字%s enabled=%s 文案%j正确分类为%s', async (exportMode, enabled, value, effect) => {
    const input = await fixture()
    input.document.slotConfigs.nickname_current = textSlot(text({ exportMode, enabled, text: value, boxWidth: 300, boxHeight: 40, referenceWidth: 100, referenceHeight: 40 }))
    const result = await createDeliveryArchive(input)
    expect(result.slots[0].sources[0].textEffect).toBe(effect)
    expect(result.report.checks.some(check => check.title === '固定字形已写入')).toBe(effect === 'baked')
    expect(result.report.checks.some(check => check.title === '动态文字尚未接入')).toBe(effect === 'dynamic')
    const readme = await (await readZip(result.blob)).file('README.md')!.async('string')
    expect(readme).toContain('不要再次叠字')
  })

  it('兼容旧文字value；无文字配置不猜Key类型', async () => {
    const input = await fixture()
    input.document.slotConfigs.nickname_current = { type: 'text', name: '旧昵称', value: '旧文案' }
    expect((await createDeliveryArchive(input)).slots[0].sources[0]).toMatchObject({ textEffect: 'dynamic', text: { text: '旧文案' } })
    input.document.slotConfigs.nickname_current = { type: 'image', name: '纯图片', value: null }
    const result = await createDeliveryArchive(input)
    expect(result.slots[0].sources[0]).toMatchObject({ textEffect: 'none', text: null })
    expect(result.report.checks.find(check => check.title === '文字候选尚无有效文案')?.status).toBe('warning')
  })

  it('保留共享输出Key的每个来源并标出不同文字配置冲突', async () => {
    const input = await fixture()
    input.document.layers.push({ ...input.document.layers[0], id: 'layer-2', name: '另一来源', imageKey: 'different_source', isNew: true, editableIndex: undefined })
    input.document.slotConfigs.different_source = textSlot(text({ text: '不同昵称' }))
    input.output.movie.sprites.push(structuredClone(input.output.movie.sprites[0]))
    input.bindings.push({ ...input.bindings[0], spriteIndex: 1, layerId: 'layer-2', originalSpriteIndex: null, sourceImageKey: 'different_source', sourceSlotKey: 'different_source' })
    await syncArtifact(input)
    const result = await createDeliveryArchive(input)
    expect(result.slots[0].sources).toHaveLength(2)
    expect(result.slots[0].sources.map(source => source.layerId)).toEqual(['layer-1', 'layer-2'])
    expect(result.slots[0].spriteIndices).toEqual([0, 1])
    expect(result.report.checks.find(check => check.title === '共享 Key 的文字配置冲突')?.status).toBe('failed')
    const html = await (await readZip(result.blob)).file('README.html')!.async('string')
    expect(html).toContain('诊断包')
    expect(html).toContain('不应作为已验收交付')
  })

  it('共享Key配置一致时仍保留所有来源，不误报冲突', async () => {
    const input = await fixture()
    input.output.movie.sprites.push(structuredClone(input.output.movie.sprites[0]))
    input.bindings.push({ ...input.bindings[0], spriteIndex: 1 })
    await syncArtifact(input)
    const result = await createDeliveryArchive(input)
    expect(result.slots[0].sources).toHaveLength(2)
    expect(result.report.checks.some(check => check.title === '共享动态 Key')).toBe(true)
    expect(result.report.checks.some(check => check.title === '共享 Key 的文字配置冲突')).toBe(false)
  })

  it('共享Key的替换图片不同也标失败，不只检测文字冲突', async () => {
    const input = await fixture()
    input.document.layers.push({ ...input.document.layers[0], id: 'layer-2', imageKey: 'second', isNew: true })
    input.document.slotConfigs.second = { ...input.document.slotConfigs.nickname_current, imageConfig: { url: 'data:image/png;base64,AQ==', scaleMode: 'fill' } }
    input.output.movie.sprites.push(structuredClone(input.output.movie.sprites[0]))
    input.bindings.push({ ...input.bindings[0], spriteIndex: 1, layerId: 'layer-2', sourceSlotKey: 'second', originalSpriteIndex: null })
    await syncArtifact(input)
    const result = await createDeliveryArchive(input)
    expect(result.report.checks.find(check => check.title === '共享 Key 的图片配置冲突')?.status).toBe('failed')
    expect(result.report.checks.some(check => check.title === '共享 Key 的文字配置冲突')).toBe(false)
  })

  it('真实区分矢量、遮罩、音轨及未引用资源，纯矢量不误报缺图', async () => {
    const input = await fixture()
    const vectorFrame = frame()
    vectorFrame.shapes = [{ type: 'RECT', rect: { x: 0, y: 0, width: 10, height: 10 }, styles: { fill: { r: 1, g: 0, b: 0, a: 1 } } }]
    input.output.movie.sprites[0].matteKey = 'mask'
    input.output.movie.sprites.push({ imageKey: 'mask', matteKey: null, frames: [frame()] }, { imageKey: 'shape.vector', matteKey: null, frames: [vectorFrame] }, { imageKey: '', matteKey: null, frames: [vectorFrame] })
    for (let index = 1; index < 4; index++) input.bindings.push({ spriteIndex: index, layerId: null, originalSpriteIndex: null, sourceImageKey: null, sourceSlotKey: null, baselineImageKey: input.output.movie.sprites[index].imageKey || null })
    input.output.movie.images.mask = new Uint8Array(png)
    input.output.images.mask = fakeImage()
    input.output.movie.images.unused = new Uint8Array(png)
    input.output.images.unused = fakeImage()
    input.output.movie.images.sound = new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0])
    input.output.movie.audios = [{ audioKey: 'sound', startFrame: 0, endFrame: 4, startTime: 0, totalTime: 166 }] as unknown as typeof input.output.movie.audios
    await syncArtifact(input)
    expect(input.validation.warnings.some(warning => warning.includes('shape.vector'))).toBe(true)
    const result = await createDeliveryArchive(input)
    const slot = (key: string) => result.slots.find(value => value.key === key)
    expect(slot('mask')).toMatchObject({ role: 'matte', state: 'referenced', spriteIndices: [1], matteForSpriteIndices: [0] })
    expect(slot('shape.vector')).toMatchObject({ role: 'vector', state: 'referenced', resource: null, spriteIndices: [2] })
    expect(slot('')).toMatchObject({ role: 'vector', state: 'referenced', resource: null, spriteIndices: [3], sources: [{ spriteIndex: 3 }] })
    expect(slot('sound')).toMatchObject({ role: 'audio', state: 'referenced', resource: { mimeType: 'audio/mpeg', width: null, height: null } })
    expect(slot('unused')).toMatchObject({ role: 'image', state: 'unreferenced' })
    expect(result.report.decodedImageBytesEstimate).toBe(12)
    expect(result.report.checks.some(check => check.title === '引用资源缺失')).toBe(false)
    expect(result.report.checks.some(check => check.detail.includes('引用了不存在的图片: shape.vector'))).toBe(false)
    expect(result.report.checks.find(check => check.title === '音轨参考')?.status).toBe('not-tested')
  })

  it('缺资源、仅同名遮罩图片无sprite、音频与图片冲突都不能伪报通过', async () => {
    const input = await fixture()
    input.output.movie.sprites[0].matteKey = 'mask_without_sprite'
    input.output.movie.images.mask_without_sprite = new Uint8Array(png)
    input.output.images.mask_without_sprite = fakeImage()
    input.output.movie.audios = [{ audioKey: 'nickname_final', startFrame: 0, endFrame: 4 }, { audioKey: 'missing_audio', startFrame: 0, endFrame: 4 }] as unknown as typeof input.output.movie.audios
    await syncArtifact(input)
    const { report, slots } = await createDeliveryArchive(input)
    expect(report.checks.find(check => check.title === '缺少遮罩 sprite')?.status).toBe('failed')
    expect(report.checks.find(check => check.title === '音频与图片 Key 冲突')?.status).toBe('failed')
    expect(slots.find(slot => slot.key === 'missing_audio')).toMatchObject({ role: 'audio', state: 'missing', resource: null })
  })

  it('有矢量后缀但没有形状不能绕过缺图诊断', async () => {
    const input = await fixture()
    input.output.movie.images = {}
    input.output.images = {}
    input.output.movie.sprites[0].imageKey = 'fake.vector'
    input.bindings[0].baselineImageKey = 'fake.vector'
    await syncArtifact(input)
    const { slots, report } = await createDeliveryArchive(input)
    expect(slots[0]).toMatchObject({ role: 'unknown', state: 'missing' })
    expect(report.checks.find(check => check.title === '引用资源缺失')?.status).toBe('failed')
  })

  it('报告未写入的工程新增音频，不把源工程音频冒充实际交付', async () => {
    const input = await fixture()
    input.document.audioResources.set('new_sound', { key: 'new_sound', data: new Uint8Array([73, 68, 51, 4]), startTime: 0, duration: 100, isNew: true })
    input.document.layers.push({ ...input.document.layers[0], id: 'sound-layer', type: 'audio', name: '新增音频', audioKey: 'new_sound', isNew: true })
    const result = await createDeliveryArchive(input)
    expect(result.report.checks.find(check => check.id === 'source-audio-edits')?.status).toBe('not-tested')
    expect(result.report.checks.find(check => check.title === '源工程音频未完全写入')).toMatchObject({ status: 'warning', key: 'new_sound' })
    expect(result.slots.some(slot => slot.key === 'new_sound')).toBe(false)
  })

  it('预算超限仍产可检查诊断包，未完整解码的图片不能通过', async () => {
    const input = await fixture()
    input.options.target.maxFileBytes = 1
    input.options.target.maxDecodedImageBytes = 3
    const result = await createDeliveryArchive(input)
    expect(result.report.checks.find(check => check.id === 'file-budget')?.status).toBe('failed')
    expect(result.report.checks.find(check => check.id === 'image-budget')?.status).toBe('failed')
    expect((await readZip(result.blob)).file('animation.svga')).not.toBeNull()
    input.output.images = {}
    input.options.target.maxDecodedImageBytes = 100
    const incomplete = await createDeliveryArchive(input)
    expect(incomplete.report.checks.find(check => check.title === '图片解码失败')?.status).toBe('failed')
  })

  it('RGBA估算取真实头部/解码较大尺寸，WebP始终要求兼容实测', async () => {
    const input = await fixture()
    input.output.images.nickname_final = fakeImage(2, 3)
    expect((await createDeliveryArchive(input)).report.decodedImageBytesEstimate).toBe(24)
    const webp = new Uint8Array(30)
    webp.set(new TextEncoder().encode('RIFF'), 0)
    webp.set(new TextEncoder().encode('WEBPVP8X'), 8)
    webp[24] = 9
    webp[27] = 19
    input.output.movie.images.nickname_final = webp
    input.output.images.nickname_final = fakeImage(10, 20)
    await syncArtifact(input)
    const result = await createDeliveryArchive(input)
    expect(result.slots[0].resource).toMatchObject({ mimeType: 'image/webp', width: 10, height: 20, path: 'resources/00001.webp' })
    expect(result.report.decodedImageBytesEstimate).toBe(800)
    expect(result.report.checks.find(check => check.title === 'WebP 播放器兼容性')?.status).toBe('not-tested')
  })

  it('只在明确选择时附源工程，缺工程拒绝生成', async () => {
    const input = await fixture()
    input.options.includeProject = true
    await expect(createDeliveryArchive(input)).rejects.toThrow('没有生成源工程')
    input.projectArchive = new Blob(['test project bytes'])
    const result = await createDeliveryArchive(input)
    expect(result.manifest.includesProject).toBe(true)
    expect(await (await readZip(result.blob)).file('project.svgaproj')!.async('string')).toBe('test project bytes')
    expect(result.manifest.files.find(file => file.path === 'project.svgaproj')?.role).toBe('project')
  })

  it.each(['count', 'index', 'key', 'layer', 'original', 'slot', 'duplicate-layer'])('来源%s不一致拒绝生成，不能猜出一个来源', async kind => {
    const input = await fixture()
    if (kind === 'count') input.bindings = []
    if (kind === 'index') input.bindings[0].spriteIndex = 1
    if (kind === 'key') input.bindings[0].baselineImageKey = 'wrong'
    if (kind === 'layer') input.bindings[0].layerId = 'missing-layer'
    if (kind === 'original') input.bindings[0].originalSpriteIndex = 999
    if (kind === 'slot') input.bindings[0].sourceSlotKey = 'missing-slot'
    if (kind === 'duplicate-layer') input.document.layers.push(input.document.layers[0])
    await expect(createDeliveryArchive(input)).rejects.toThrow()
  })

  it.each(['validation', 'validation-count', 'validation-params', 'deduplicate', 'hash', 'frame', 'params', 'buffers', 'bytes', 'preview'])('损坏或不可信%s输入不能生成看似成功的包', async kind => {
    const input = await fixture()
    if (kind === 'validation') input.validation.isValid = false
    if (kind === 'validation-count') input.validation.info.imagesCount = 999
    if (kind === 'validation-params') input.validation.info.params!.fps++
    if (kind === 'deduplicate') input.optimization.image.deduplicate = true
    if (kind === 'hash') input.sourceRevision = 'not-a-hash'
    if (kind === 'frame') input.document.currentFrame = 4
    if (kind === 'params') input.output.movie.params.frames = 0
    if (kind === 'buffers') input.output.buffers.nickname_final = new Uint8Array([1, 2]).buffer
    if (kind === 'bytes') input.output.movie.images.nickname_final = [-1]
    if (kind === 'preview') input.actualPreview = new Blob(['not png'], { type: 'image/png' })
    await expect(createDeliveryArchive(input)).rejects.toThrow()
  })

  it('拒绝128MiB单项，256MiB累计及5000条目上限，限制先于大载荷读取', async () => {
    const input = await fixture()
    const huge = new Blob(['small'])
    Object.defineProperty(huge, 'size', { value: MAX_DELIVERY_FILE_BYTES + 1 })
    const read = vi.spyOn(huge, 'arrayBuffer')
    input.animation = huge
    await expect(createDeliveryArchive(input)).rejects.toThrow('128 MiB')
    expect(read).not.toHaveBeenCalled()
    const normal = await fixture()
    const bounded = new Blob(['small'])
    Object.defineProperty(bounded, 'size', { value: MAX_DELIVERY_BYTES / 2 })
    normal.animation = bounded
    normal.options.includeProject = true
    normal.projectArchive = bounded
    await expect(createDeliveryArchive(normal)).rejects.toThrow('256 MiB')
    const many = await fixture()
    many.output.movie.images = Object.fromEntries(Array.from({ length: 4992 }, (_, index) => [`key-${index}`, png]))
    many.output.buffers = {}
    many.validation.info.imagesCount = 4992
    await expect(createDeliveryArchive(many)).rejects.toThrow('5000')
  })

  it.each(['before', 'resources', 'report', 'zip'])('取消%s阶段不返回半成品', async when => {
    const input = await fixture()
    const abort = new AbortController()
    if (when === 'before') abort.abort()
    const phrases: Record<string, string> = { resources: '核对真实', report: '生成离线', zip: '封装交付' }
    await expect(createDeliveryArchive(input, { signal: abort.signal, onPhase: message => { if (phrases[when] && message.startsWith(phrases[when])) abort.abort() } })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('等待哈希时取消或摘要能力失败不会返回ZIP', async () => {
    const input = await fixture()
    const controller = new AbortController()
    const realDigest = crypto.subtle.digest.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, bytes) => { controller.abort(); return realDigest(algorithm, bytes) })
    await expect(createDeliveryArchive(input, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    vi.restoreAllMocks()
    vi.stubGlobal('crypto', {})
    await expect(createDeliveryArchive(input)).rejects.toThrow('内容校验')
  })

  it('最终ZIP实际开始发送条目后取消也拒绝，不从JSZip回调抛错或返回半成品', async () => {
    const input = await fixture()
    const controller = new AbortController()
    const generate = JSZip.prototype.generateInternalStream
    let flowingChunks = 0
    vi.spyOn(JSZip.prototype, 'generateInternalStream').mockImplementation(function (this: JSZip, options) {
      const stream = generate.call(this, options)
      stream.on('data', (_chunk, metadata) => {
        if (metadata.percent > 0 && !controller.signal.aborted) { flowingChunks++; controller.abort() }
      })
      return stream
    })
    await expect(createDeliveryArchive(input, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(flowingChunks).toBe(1)
  })

  it('文件名处理保留名和路径字符，报告保留真实标题', async () => {
    const input = await fixture()
    input.options.title = 'CON'
    const result = await createDeliveryArchive(input)
    expect(result.fileName).toBe('_CON.delivery.zip')
    expect(result.manifest.title).toBe('CON')
  })
})
