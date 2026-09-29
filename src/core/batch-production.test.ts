import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import protobuf from 'protobufjs'
import pako from 'pako'
import type { ProjectDocument } from '@/types/project'
import type { DeliveryBundleResult } from '@/types/delivery'
import { useEditorStore } from '@/stores'
import proto from './svga-proto'
import { createDefaultTracks } from './layer-factory'
import { OPTIMIZATION_PRESETS } from './optimizer'
import { captureExportInputs } from './export-preview'
import { createProjectArchive, MAX_PROJECT_BYTES } from './project-archive'
import { captureBatchProductionTemplate, importBatchProductionTemplate, prepareBatchProductionSession, previewBatchProduction } from './batch-production'
import { applyBatchTextRow, batchTextSessionDocument, isBatchTextSessionCurrent } from './batch-text-session'

const generate = vi.hoisted(() => vi.fn())
vi.mock('./delivery', () => ({ generateDeliveryBundle: generate }))
const Movie = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=', 'base64'))
function source(): ProjectDocument {
  const params = { viewBoxWidth: 200, viewBoxHeight: 100, fps: 24, frames: 2 }
  const sprite = { imageKey: 'title$', matteKey: null, frames: [0, 1].map(() => ({ alpha: 1, clipPath: null,
    layout: { x: 0, y: 0, width: 100, height: 40 }, transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 } })) }
  const movie = { version: '2.0.0', params, images: { 'title$': png }, sprites: [sprite] }
  return { formatVersion: 1, name: '可复用.svgaproj', originalBuffer: new Uint8Array(pako.deflate(Movie.encode(Movie.fromObject(movie)).finish())).buffer,
    params, customFps: null, customFrames: null, videoItem: { movie, images: {}, buffers: { 'title$': new Uint8Array(png).buffer } },
    layers: [{ id: 'title-layer', name: 'title$', imageKey: 'title$', editableIndex: 0, type: 'image', visible: true, locked: false, expanded: false, opacity: 1, blendMode: 'normal', clip: { startFrame: 0, duration: 2 }, sprites: sprite, tracks: createDefaultTracks() }],
    imageResources: new Map([['title$', { key: 'title$', data: png, width: 1, height: 1, mimeType: 'image/png', isNew: false }]]), audioResources: new Map(),
    slotConfigs: { 'title$': { type: 'text', name: 'title$', value: '原文案' } }, detectedSlots: ['title$'],
    currentFrame: 0, selectedLayerId: null, selectedLayerIds: [], selectedPresetId: 'none',
    compressionConfig: { enabled: false, mode: 'png', quality: 90, resizeEnabled: false, resizePercent: 100 }, optimizationConfig: structuredClone(OPTIMIZATION_PRESETS[0].config) }
}
function delivery(document: ProjectDocument): DeliveryBundleResult {
  const text = document.slotConfigs['title$'].textConfig!
  return { blob: new Blob([text.text]), fileName: 'sample.zip', manifest: { previewFrame: 0 } as DeliveryBundleResult['manifest'],
    previews: { actual: new Blob(['actual']), design: new Blob(['design']) }, report: { format: 'svga-editor-delivery-report', schemaVersion: 1, previewFrame: 0, decodedImageBytesEstimate: 0, checks: [] },
    slots: [{ key: 'title$', state: 'referenced', role: 'image', resource: null, spriteIndices: [0], matteForSpriteIndices: [],
      sources: [{ sourceSlotKey: 'title$', sourceImageKey: 'title$', currentImageKey: 'title$', originalSpriteIndex: 0, layerId: 'title-layer', layerName: 'title$', baselineImageKey: 'title$', spriteIndex: 0, textEffect: text.exportMode === 'bake' ? 'baked' : 'dynamic', text }] }] }
}
const data = (content = 'id,title$\n001,甲\n002,乙') => ({ format: 'csv' as const, content, keys: ['title$'], limit: 20 })
const template = () => captureBatchProductionTemplate(source(), captureExportInputs(useEditorStore.getState()))
beforeEach(() => { useEditorStore.getState().reset(); generate.mockReset(); generate.mockImplementation(async (document: ProjectDocument) => delivery(document)) })
afterEach(() => { useEditorStore.getState().reset(); vi.restoreAllMocks() })

describe('批量生产独立模板、规则与真实管线抽样', () => {
  it('当前模板真实归档回读隔离数据，不增加撤销记录', async () => {
    const document = source(), before = useEditorStore.getState(), input = captureExportInputs(before)
    const selected = await captureBatchProductionTemplate(document, input)
    expect(selected).toMatchObject({ origin: 'current', name: '可复用.svgaproj', editorInputs: input })
    expect(selected.sourceRevision).toMatch(/^[a-f0-9]{64}$/)
    document.layers[0].name = '后续编辑'; document.slotConfigs['title$'].value = '之后文字'
    expect(selected.document.layers[0].name).toBe('title$')
    expect(selected.document.slotConfigs['title$'].value).toBe('原文案')
    expect(useEditorStore.getState()).toBe(before)
  })
  it('导入真实 .svgaproj 模板而不替换当前工程', async () => {
    const archive = await createProjectArchive(source()), before = useEditorStore.getState()
    const selected = await importBatchProductionTemplate(Object.assign(archive, { name: '客户模板.svgaproj' }))
    expect(selected.origin).toBe('file'); expect(selected.name).toBe('客户模板.svgaproj')
    expect(selected.editorInputs).toBeUndefined()
    expect(selected.document.slotConfigs['title$'].value).toBe('原文案')
    expect(useEditorStore.getState()).toBe(before)
  })
  it.each([['bad.zip', 3], ['empty.svgaproj', 0], ['large.svgaproj', MAX_PROJECT_BYTES + 1]])('文件 %s 超出契约时不读取内容', async (name, size) => {
    const arrayBuffer = vi.fn()
    await expect(importBatchProductionTemplate({ name, size, arrayBuffer } as unknown as Blob & { name: string })).rejects.toThrow('128 MiB')
    expect(arrayBuffer).not.toHaveBeenCalled()
  })
  it('损坏模板和已取消导入不返回可用模板', async () => {
    await expect(importBatchProductionTemplate(Object.assign(new Blob(['bad']), { name: 'bad.svgaproj' }))).rejects.toThrow()
    const controller = new AbortController(); controller.abort()
    await expect(captureBatchProductionTemplate(source(), [], controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('独立模板在画布切换后仍可生产，但禁止直接写回画布', async () => {
    const selected = await template(), session = prepareBatchProductionSession(selected, data())
    useEditorStore.getState().setVideoItem(source().videoItem)
    const before = useEditorStore.getState()
    expect(isBatchTextSessionCurrent(session)).toBe(true)
    expect(batchTextSessionDocument(session)).toBe(selected.document)
    expect(() => applyBatchTextRow(session, 2)).toThrow('独立批量模板不能写回')
    expect(useEditorStore.getState()).toBe(before)
  })
  it('选中精确 Key 仍校验清单额外列和重复编号', async () => {
    const selected = await template()
    const extra = prepareBatchProductionSession(selected, data('id,title$,unknown\n001,甲,错误'))
    const duplicate = prepareBatchProductionSession(selected, data('id,title$\n001,甲\n001,乙'))
    expect(extra.report.valid).toBe(false); expect(duplicate.report.valid).toBe(false)
    await expect(previewBatchProduction(duplicate, 2, 'dynamic')).rejects.toThrow('全部数据问题')
    expect(generate).not.toHaveBeenCalled()
  })
  it('在导入阶段明确拒绝超过 100 条，避免用户到生成才失败', async () => {
    const selected = await template()
    expect(() => prepareBatchProductionSession(selected, data('id,title$\n' + Array.from({ length: 101 }, (_, i) => `${i},文案`).join('\n')))).toThrow('最多 100 条')
  })
  it('拒绝空数据、无效上限或重复 Key', async () => {
    const selected = await template()
    expect(() => prepareBatchProductionSession(selected, data('id,title$'))).toThrow('没有数据')
    expect(() => prepareBatchProductionSession(selected, { ...data(), limit: 0 })).toThrow('1–500')
    expect(() => prepareBatchProductionSession(selected, { ...data(), keys: ['title$', 'title$'] })).toThrow('不重复')
  })
  it.each(['dynamic', 'bake'] as const)('%s 抽样仅生成所选记录，复用正式管线并不执行整批', async mode => {
    const selected = await template(), session = prepareBatchProductionSession(selected, data())
    const before = useEditorStore.getState()
    const preview = await previewBatchProduction(session, 3, mode)
    expect(preview).toMatchObject({ session, row: 3, mode })
    expect(generate).toHaveBeenCalledOnce()
    expect(generate.mock.calls[0][0].slotConfigs['title$'].value).toBe('乙')
    expect(generate.mock.calls[0][0].slotConfigs['title$'].textConfig.exportMode).toBe(mode === 'bake' ? 'bake' : 'preview')
    expect(await preview.result.blob.text()).toBe('乙')
    expect(await preview.result.previews.actual.text()).toBe('actual')
    expect(session.rows).toHaveLength(2)
    expect(selected.document.slotConfigs['title$'].value).toBe('原文案')
    expect(useEditorStore.getState()).toBe(before)
  })
  it('不能用旧报告或不存在的记录绕过数据验证', async () => {
    const session = prepareBatchProductionSession(await template(), data())
    await expect(previewBatchProduction(session, 999, 'bake')).rejects.toThrow('未找到')
    session.rows[0].values['title$'] = ''
    await expect(previewBatchProduction(session, 3, 'bake')).rejects.toThrow('全部数据问题')
    expect(generate).not.toHaveBeenCalled()
  })
  it('取消抽样不接受迟到成功或篡改当前工程', async () => {
    const session = prepareBatchProductionSession(await template(), data()), controller = new AbortController()
    const before = useEditorStore.getState()
    generate.mockImplementation(async (document: ProjectDocument) => { controller.abort(); return delivery(document) })
    await expect(previewBatchProduction(session, 2, 'dynamic', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(useEditorStore.getState()).toBe(before)
  })
})
