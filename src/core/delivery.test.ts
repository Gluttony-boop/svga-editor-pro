import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDocument } from '@/types/project'
import type { DeliveryOptions } from '@/types/delivery'
import { OPTIMIZATION_PRESETS } from './optimizer'
import { createDefaultTracks } from './layer-factory'

const mock = vi.hoisted(() => ({
  snapshot: vi.fn(), hydrate: vi.fn(), build: vi.fn(), optimize: vi.fn(), validate: vi.fn(), parse: vi.fn(), pack: vi.fn(),
  render: vi.fn(), instances: [] as Array<{ canvas: HTMLCanvasElement; video: unknown; frame?: number; options?: Record<string, unknown>; destroyed: boolean }>,
  disposers: [] as Array<ReturnType<typeof vi.fn>>
}))
vi.mock('./project-revision', async () => ({ ...await vi.importActual<typeof import('./project-revision')>('./project-revision'), prepareDeliverySnapshot: mock.snapshot }))
vi.mock('./project-hydration', () => ({ hydrateProjectDocument: mock.hydrate }))
vi.mock('./project-export', () => ({ buildProjectSvga: mock.build }))
vi.mock('./export-preview', () => ({ generateExportPreview: mock.optimize }))
vi.mock('./delivery-archive', async () => ({ ...await vi.importActual<typeof import('./delivery-archive')>('./delivery-archive'), createDeliveryArchive: mock.pack }))
vi.mock('@/utils/svga-validator', () => ({ SVGAValidator: class { validate = mock.validate } }))
vi.mock('./parser', () => ({ SVGAParser: class { parse = mock.parse } }))
vi.mock('./renderer', () => ({ CanvasRenderer: class {
  private record: typeof mock.instances[number]
  constructor(canvas: HTMLCanvasElement) { this.record = { canvas, video: null, destroyed: false }; mock.instances.push(this.record) }
  setVideoItem(video: unknown) { this.record.video = video }
  renderFrameAsync(frame: number, options: Record<string, unknown>) { this.record.frame = frame; this.record.options = options; return mock.render() }
  exportFrame() { return Promise.resolve(new Blob(['PNG 测试占位'], { type: 'image/png' })) }
  destroy() { this.record.destroyed = true }
} }))

import { generateDeliveryBundle } from './delivery'

function document(): ProjectDocument {
  const params = { viewBoxWidth: 100, viewBoxHeight: 50, fps: 24, frames: 2 }
  const sprite = { imageKey: 'title', matteKey: null, frames: [0, 1].map(() => ({ alpha: 1, layout: { x: 0, y: 0, width: 20, height: 20 }, transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, clipPath: null })) }
  return {
    formatVersion: 1, name: '交付.svgaproj', originalBuffer: new Uint8Array([1, 2]).buffer,
    videoItem: { movie: { version: '2.0.0', params, sprites: [sprite], images: {} }, images: {}, buffers: {} },
    params, customFps: null, customFrames: null, layers: [{ id: '0', editableIndex: 0, type: 'image', imageKey: 'title', name: 'title',
      visible: true, locked: false, expanded: true, opacity: 1, blendMode: 'normal', clip: { startFrame: 0, duration: 2 }, sprites: sprite, tracks: createDefaultTracks() }],
    imageResources: new Map(), audioResources: new Map(), slotConfigs: { title: { type: 'text', name: 'title', value: '设计模拟' } }, detectedSlots: ['title'],
    compressionConfig: { enabled: false, mode: 'png', quality: 90, resizeEnabled: false, resizePercent: 100 },
    optimizationConfig: structuredClone(OPTIMIZATION_PRESETS[0].config), selectedPresetId: 'none', currentFrame: 1, selectedLayerId: null, selectedLayerIds: []
  }
}
const options = (): DeliveryOptions => ({ title: '交付示例', includeProject: false,
  target: { platform: 'unspecified', player: '', version: '', maxFileBytes: null, maxDecodedImageBytes: null } })
const bindings = [{ spriteIndex: 0, layerId: '0', originalSpriteIndex: 0, sourceImageKey: 'title', sourceSlotKey: 'title', baselineImageKey: 'title' }]
const animation = new Blob(['生成的 SVGA 测试占位'])
beforeEach(() => {
  vi.clearAllMocks(); mock.instances.length = 0; mock.disposers.length = 0
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0 }) })
  mock.snapshot.mockImplementation(async input => ({ document: input, sourceRevision: 'a'.repeat(64), archive: new Blob(['工程']) }))
  mock.hydrate.mockImplementation(async input => { const dispose = vi.fn(); mock.disposers.push(dispose); return { document: input, dispose } })
  mock.build.mockResolvedValue({ blob: animation, bindings: structuredClone(bindings) })
  mock.optimize.mockImplementation(async (build, config, _bytes, params, onPhase) => {
    onPhase('测试优化阶段')
    return { baseline: await build(), optimized: animation, params, warnings: [], stats: {}, effectiveConfig: config }
  })
  mock.validate.mockResolvedValue({ isValid: true, errors: [], warnings: [], info: { params: document().params, imagesCount: 0, spritesCount: 1 } })
  mock.parse.mockResolvedValue(document().videoItem)
  mock.render.mockResolvedValue(undefined)
  mock.pack.mockResolvedValue({ blob: new Blob(['交付包']), fileName: '交付.zip' })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('交付任务编排（编解码各自另有真实产物测试）', () => {
  it('只构建一次SVGA，设计图应用编辑，实际图不传编辑层或文字二次烘焙', async () => {
    const input = document()
    await generateDeliveryBundle(input, options())
    expect(mock.build).toHaveBeenCalledOnce()
    expect(mock.instances[0].options).toMatchObject({ layers: input.layers, slotConfigs: input.slotConfigs, applySlots: true })
    expect(mock.instances[1].options).toMatchObject({ applySlots: false })
    expect(mock.instances[1].options).not.toHaveProperty('layers')
    expect(mock.instances[1].options).not.toHaveProperty('slotConfigs')
    expect(mock.parse).toHaveBeenCalledWith(expect.any(ArrayBuffer), { decodeImages: false })
    expect(mock.instances.every(instance => instance.frame === 1 && instance.destroyed && instance.canvas.width === 0)).toBe(true)
    expect(mock.disposers.every(dispose => dispose.mock.calls.length === 1)).toBe(true)
  })

  it('任务保留独立Key，不悄悄改变工程里的跨Key去重配置', async () => {
    const input = document(); input.optimizationConfig.image.deduplicate = true
    await generateDeliveryBundle(input, options())
    expect(input.optimizationConfig.image.deduplicate).toBe(true)
    expect(mock.optimize.mock.calls[0][1].image.deduplicate).toBe(false)
    expect(mock.pack.mock.calls[0][0].warnings).toContain('为保留独立动态 Key，本次交付未执行跨 Key 图片去重；未修改工程中的优化设置。')
  })

  it.each([false, true])('只有includeProject=%s时才传递源工程归档', async includeProject => {
    await generateDeliveryBundle(document(), { ...options(), includeProject })
    expect(Object.prototype.hasOwnProperty.call(mock.pack.mock.calls[0][0], 'projectArchive')).toBe(includeProject)
  })

  it('用户表单后续变化不混入已捕获的交付选项', async () => {
    const settings = options()
    await generateDeliveryBundle(document(), settings, { onPhase: () => { settings.target.player = '之后改动' } })
    expect(mock.pack.mock.calls[0][0].options.target.player).toBe('')
  })

  it('取消后不构建文件', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(generateDeliveryBundle(document(), options(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(mock.snapshot).not.toHaveBeenCalled()
  })

  it('编码阶段取消后释放源素材，不截图、不优化、不发布结果', async () => {
    const controller = new AbortController()
    mock.build.mockImplementation(async () => { controller.abort(); return { blob: animation, bindings } })
    await expect(generateDeliveryBundle(document(), options(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(mock.disposers[0]).toHaveBeenCalledOnce()
    expect(mock.instances).toHaveLength(0)
    expect(mock.optimize).not.toHaveBeenCalled()
    expect(mock.pack).not.toHaveBeenCalled()
  })

  it('截图失败也释放renderer、canvas与源图片', async () => {
    mock.render.mockRejectedValueOnce(new Error('绘制失败'))
    await expect(generateDeliveryBundle(document(), options())).rejects.toThrow('绘制失败')
    expect(mock.instances[0].destroyed).toBe(true)
    expect(mock.instances[0].canvas.width).toBe(0)
    expect(mock.disposers[0]).toHaveBeenCalledOnce()
    expect(mock.pack).not.toHaveBeenCalled()
  })

  it.each(['count', 'key', 'index', 'params', 'validation'] as const)('实际产物的%s不一致时阻止虚假来源报告', async kind => {
    if (kind === 'count') mock.build.mockResolvedValue({ blob: animation, bindings: [] })
    if (kind === 'key') mock.build.mockResolvedValue({ blob: animation, bindings: [{ ...bindings[0], baselineImageKey: '错误Key' }] })
    if (kind === 'index') mock.build.mockResolvedValue({ blob: animation, bindings: [{ ...bindings[0], spriteIndex: 1 }] })
    if (kind === 'params') { const video = document().videoItem; video.movie.params.fps = 30; mock.parse.mockResolvedValue(video) }
    if (kind === 'validation') mock.validate.mockResolvedValue({ isValid: false, errors: ['结构坏了'], info: {} })
    await expect(generateDeliveryBundle(document(), options())).rejects.toThrow()
    expect(mock.pack).not.toHaveBeenCalled()
    expect(mock.disposers[0]).toHaveBeenCalledOnce()
  })

  it('打包失败仍释放实际回读图像与两个渲染器', async () => {
    mock.pack.mockRejectedValueOnce(new Error('包超限'))
    await expect(generateDeliveryBundle(document(), options())).rejects.toThrow('包超限')
    expect(mock.disposers).toHaveLength(2)
    expect(mock.disposers.every(dispose => dispose.mock.calls.length === 1)).toBe(true)
    expect(mock.instances.every(instance => instance.destroyed)).toBe(true)
  })

  it.each(['frame', 'size', 'expansion'] as const)('%s超限在准备位图与构建前停止', async kind => {
    const input = document()
    if (kind === 'frame') input.currentFrame = 9
    if (kind === 'size') input.params.viewBoxWidth = 9999
    if (kind === 'expansion') { input.customFrames = 1_000_000; input.layers.push(input.layers[0], input.layers[0]) }
    await expect(generateDeliveryBundle(input, options())).rejects.toThrow()
    expect(mock.hydrate).not.toHaveBeenCalled()
    expect(mock.build).not.toHaveBeenCalled()
  })
})
