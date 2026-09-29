import { beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import type { ProjectDocument } from '@/types/project'
import type { DeliveryBundleResult } from '@/types/delivery'
import { OPTIMIZATION_PRESETS } from './optimizer'
import { createDefaultTracks } from './layer-factory'
import { normalizeTextConfig } from './text-preview'
import { BATCH_TEMPLATE_FORMAT, type BatchTemplate, type BatchVariantRow } from './batch-variants'
import { batchTextDocument, createBatchTextExportTask, MAX_BATCH_EXPORT_BYTES } from './batch-text-export'
import { sha256Bytes } from './content-hash'

const mock = vi.hoisted(() => ({ snapshot: vi.fn(), generate: vi.fn() }))
vi.mock('./project-revision', async () => ({ ...await vi.importActual<typeof import('./project-revision')>('./project-revision'), prepareDeliverySnapshot: mock.snapshot }))
vi.mock('./delivery', () => ({ generateDeliveryBundle: mock.generate }))

const template: BatchTemplate = { format: BATCH_TEMPLATE_FORMAT, schemaVersion: 1, name: '文案任务', slotRules: [{ key: 'title', kind: 'text', maxLength: 20 }] }
const rows = (n = 3): BatchVariantRow[] => Array.from({ length: n }, (_, i) => ({ row: i + 2, id: String(i + 1), values: { title: `设计师${i + 1}` } }))
function source(key = 'title'): ProjectDocument {
  const params = { viewBoxWidth: 200, viewBoxHeight: 100, fps: 24, frames: 2 }
  const sprite = { imageKey: key, matteKey: null, frames: [0, 1].map(() => ({ alpha: 1, layout: { x: 0, y: 0, width: 100, height: 40 }, transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, clipPath: null })) }
  return { formatVersion: 1, name: '测试.svgaproj', originalBuffer: new Uint8Array([1]).buffer,
    params, customFps: null, customFrames: null,
    videoItem: { movie: { version: '2.0', params, images: {}, sprites: [sprite] }, images: {}, buffers: {} },
    layers: [{ id: 'layer', name: key, imageKey: key, editableIndex: 0, type: 'image', visible: true, locked: false, expanded: false, opacity: 1, blendMode: 'normal', clip: { startFrame: 0, duration: 2 }, sprites: sprite, tracks: createDefaultTracks() }],
    imageResources: new Map(), audioResources: new Map(), slotConfigs: {}, detectedSlots: [key],
    currentFrame: 0, selectedLayerId: null, selectedLayerIds: [], selectedPresetId: 'none',
    compressionConfig: { enabled: false, mode: 'png', quality: 90, resizeEnabled: false, resizePercent: 100 }, optimizationConfig: structuredClone(OPTIMIZATION_PRESETS[0].config) }
}
function output(document: ProjectDocument): DeliveryBundleResult {
  const config = document.slotConfigs.title.textConfig!
  return { blob: new Blob([config.text]), fileName: '单条.zip', manifest: { previewFrame: 0 } as DeliveryBundleResult['manifest'],
    previews: { actual: new Blob(['actual']), design: new Blob(['design']) },
    report: { format: 'svga-editor-delivery-report', schemaVersion: 1, previewFrame: 0, decodedImageBytesEstimate: 0, checks: [] },
    slots: [{ key: 'renamed-title', state: 'referenced', role: 'image', resource: null, spriteIndices: [0], matteForSpriteIndices: [], sources: [{ sourceSlotKey: 'title', sourceImageKey: 'title', currentImageKey: 'title', originalSpriteIndex: 0, layerId: 'layer', layerName: 'title', baselineImageKey: 'renamed-title', spriteIndex: 0, textEffect: config.exportMode === 'bake' ? 'baked' : 'dynamic', text: config }] }] }
}
beforeEach(() => {
  vi.clearAllMocks()
  mock.snapshot.mockImplementation(async (input: ProjectDocument) => ({ document: structuredClone(input), sourceRevision: 'a'.repeat(64), archive: new Blob(['project']) }))
  mock.generate.mockImplementation(async (input: ProjectDocument) => output(input))
})

describe('批量文字任务：串行与隔离（实际编解码在交付测试和浏览器验收）', () => {
  it('首次固定字形导出建立完整参考框，换行按单件导出规范化', () => {
    const output = batchTextDocument(source(), { row: 1, id: 'a', values: { title: '甲\r\n乙' } }, 'bake')
    expect(output.slotConfigs.title.textConfig).toMatchObject({ boxWidth: 100, boxHeight: 40, referenceWidth: 100, referenceHeight: 40, text: '甲\n乙', exportMode: 'bake' })
    expect(() => normalizeTextConfig(output.slotConfigs.title.textConfig)).not.toThrow()
  })
  it.each(['dynamic', 'bake'] as const)('%s 模式明确改变任务副本，保留文字范围与替换图片', mode => {
    const document = source()
    document.slotConfigs.title = { type: 'image', name: 'title', value: 'data:image/png;base64,eA==', imageConfig: { url: 'data:image/png;base64,eA==', scaleMode: 'fill' }, textConfig: { ...normalizeTextConfig(), fontSize: 25, boxWidth: 250, boxHeight: 50, referenceWidth: 100, referenceHeight: 40, enabled: false } }
    const before = structuredClone(document)
    const changed = batchTextDocument(document, rows()[0], mode)
    expect(changed.slotConfigs.title.textConfig).toMatchObject({ text: '设计师1', enabled: true, fontSize: 25, boxWidth: 250, boxHeight: 50, exportMode: mode === 'bake' ? 'bake' : 'preview' })
    expect(changed.slotConfigs.title.imageConfig).toEqual(before.slotConfigs.title.imageConfig)
    expect(document).toEqual(before)
  })
  it.each(['__proto__', 'constructor', ' name ', 'id'])('特殊 Key %s 不变成路径或对象原型', key => {
    const document = source(key)
    const values = Object.fromEntries([[key, '测试']])
    const changed = batchTextDocument(document, { row: 1, id: '../CON', values }, 'bake')
    expect(Object.prototype.hasOwnProperty.call(changed.slotConfigs, key)).toBe(true)
    expect(changed.slotConfigs[key].textConfig?.text).toBe('测试')
    expect(Object.getPrototypeOf(changed.slotConfigs)).toBe(Object.prototype)
    expect(document.slotConfigs).toEqual({})
  })
  it('20 条真实队列顺序生成、单次冻结、每个交付使用同一导出入口且不附源工程', async () => {
    const input = source(), before = structuredClone(input)
    let active = 0, max = 0
    mock.generate.mockImplementation(async (doc: ProjectDocument) => { active++; max = Math.max(max, active); await Promise.resolve(); active--; return output(doc) })
    const task = await createBatchTextExportTask(input, template, rows(20), 'bake')
    await task.run('start')
    expect(task.view().queue.items.every(item => item.status === 'succeeded' && item.attempts === 1)).toBe(true)
    expect(mock.generate).toHaveBeenCalledTimes(20)
    expect(mock.generate.mock.calls.map(call => call[0].slotConfigs.title.value)).toEqual(rows(20).map(row => row.values.title))
    expect(mock.generate.mock.calls.every(call => call[1].includeProject === false)).toBe(true)
    expect(mock.snapshot).toHaveBeenCalledOnce()
    expect(max).toBe(1)
    expect(input).toEqual(before)
  })
  it('源文档、模板、清单和返回视图后续修改不污染任务', async () => {
    const input = source(), data = rows(), rules = structuredClone(template)
    const task = await createBatchTextExportTask(input, rules, data, 'dynamic')
    input.layers[0].name = '另一次编辑'; data[0].values.title = '新文案'; rules.slotRules[0].key = '其他'
    task.view().queue.items[0].row.values.title = '外部视图改动'
    await task.run('start')
    expect(mock.generate.mock.calls[0][0].layers[0].name).toBe('title')
    expect(task.view().queue.items[0].row.values.title).toBe('设计师1')
    task.result('1')!.slots[0].sources[0].textEffect = 'none'
    expect(task.result('1')!.slots[0].sources[0].textEffect).toBe('dynamic')
  })
  it('失败不会回滚其他结果，仅重试失败项保持成功 Blob 与次数', async () => {
    mock.generate.mockImplementation(async (doc: ProjectDocument) => { if (doc.slotConfigs.title.value === '设计师2') throw new Error('编码失败'); return output(doc) })
    const task = await createBatchTextExportTask(source(), template, rows(), 'bake')
    await task.run('start')
    expect(task.view().queue.items.map(item => item.status)).toEqual(['succeeded', 'failed', 'succeeded'])
    const first = task.result('1')!.blob
    mock.generate.mockImplementation(async (doc: ProjectDocument) => output(doc))
    await task.run('retry-failed')
    expect(mock.generate).toHaveBeenCalledTimes(4)
    expect(task.view().queue.items.map(item => item.attempts)).toEqual([1, 2, 1])
    expect(task.result('1')!.blob).toBe(first)
  })
  it('编码中取消不接受迟到成功，停止后续并可继续已停止项', async () => {
    const abort = new AbortController()
    mock.generate.mockImplementation(async (doc: ProjectDocument) => { if (doc.slotConfigs.title.value === '设计师2') abort.abort(); return output(doc) })
    const task = await createBatchTextExportTask(source(), template, rows(), 'bake')
    await expect(task.run('start', { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(task.view().queue.items.map(item => item.status)).toEqual(['succeeded', 'cancelled', 'cancelled'])
    expect(task.result('2')).toBeUndefined()
    mock.generate.mockImplementation(async (doc: ProjectDocument) => output(doc))
    await task.run('resume-cancelled')
    expect(task.view().queue.items.map(item => item.attempts)).toEqual([1, 2, 1])
    expect(mock.generate).toHaveBeenCalledTimes(4)
  })
  it('进度观察器异常不遗留 running，恢复时仍可以继续', async () => {
    const task = await createBatchTextExportTask(source(), template, rows(), 'bake')
    await expect(task.run('start', { onChange: () => { throw new Error('界面卸载') } })).rejects.toThrow('界面卸载')
    expect(task.view().busy).toBe(false)
    expect(task.view().queue.items.map(item => item.status)).toEqual(['cancelled', 'cancelled', 'cancelled'])
    await task.run('resume-cancelled')
    expect(task.view().queue.items.every(item => item.status === 'succeeded')).toBe(true)
  })
  it('串行运行和打包不能相互重入', async () => {
    const task = await createBatchTextExportTask(source(), template, rows(1), 'bake')
    let release!: () => void
    mock.generate.mockImplementation(async (doc: ProjectDocument) => { await new Promise<void>(resolve => { release = resolve }); return output(doc) })
    const running = task.run('start')
    await expect(task.run('start')).rejects.toThrow('正在生成')
    await expect(task.archive()).rejects.toThrow('正在生成')
    release(); await running
  })
  it.each(['failed-check', 'missing-key', 'wrong-mode', 'wrong-text', 'empty-blob', 'too-large'])('%s 不记为成功', async kind => {
    mock.generate.mockImplementation(async (doc: ProjectDocument) => {
      const value = output(doc)
      if (kind === 'failed-check') value.report.checks.push({ id: 'fail', status: 'failed', title: '失败', detail: '失败' })
      if (kind === 'missing-key') value.slots = []
      if (kind === 'wrong-mode') value.slots[0].sources[0].textEffect = 'dynamic'
      if (kind === 'wrong-text') value.slots[0].sources[0].text = { ...value.slots[0].sources[0].text!, text: '错误文案' }
      if (kind === 'empty-blob') value.blob = new Blob()
      if (kind === 'too-large') Object.defineProperty(value.blob, 'size', { value: MAX_BATCH_EXPORT_BYTES + 1 })
      return value
    })
    const task = await createBatchTextExportTask(source(), template, rows(1), 'bake')
    await task.run('start')
    expect(task.view().queue.items[0].status).toBe('failed')
    expect(task.result('1')).toBeUndefined()
    await expect(task.archive()).rejects.toThrow('还没有')
  })
  it('取消或过多/重复/缺值/不可用 Key 的清单在冻结前拒绝', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(createBatchTextExportTask(source(), template, rows(), 'bake', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(createBatchTextExportTask(source(), template, rows(101), 'bake')).rejects.toThrow('100')
    await expect(createBatchTextExportTask(source(), template, [rows()[0], rows()[0]], 'bake')).rejects.toThrow('预检')
    await expect(createBatchTextExportTask(source(), template, [{ row: 1, id: 'a', values: {} }], 'bake')).rejects.toThrow('预检')
    await expect(createBatchTextExportTask(source('other'), template, rows(), 'bake')).rejects.toThrow('预检')
    await expect(createBatchTextExportTask(source(), template, rows(), '' as never)).rejects.toThrow('选择')
    expect(mock.snapshot).not.toHaveBeenCalled()
  })
  it('汇总 ZIP 只含成功条目，安全路径、编号映射、完整性标记及真实 SHA-256 均正确', async () => {
    const data = rows(3); data[0].id = '../../CON'; data[1].id = '失败'
    mock.generate.mockImplementation(async (doc: ProjectDocument) => { if (doc.slotConfigs.title.value === '设计师2') throw new Error('secret-local-path'); return output(doc) })
    const task = await createBatchTextExportTask(source(), template, data, 'dynamic')
    await task.run('start')
    const zip = await JSZip.loadAsync(await (await task.archive()).arrayBuffer())
    expect(Object.keys(zip.files).sort()).toEqual(['README.txt', 'checksums.sha256', 'manifest.json', 'variants/00001.zip', 'variants/00003.zip'])
    const raw = await zip.file('manifest.json')!.async('string')
    const manifest = JSON.parse(raw)
    expect(manifest).toMatchObject({ complete: false, mode: 'dynamic', includesProject: false, sourceRevision: 'a'.repeat(64) })
    expect(manifest.rows[0]).toMatchObject({ id: '../../CON', file: { path: 'variants/00001.zip' } })
    expect(manifest.rows[1]).not.toHaveProperty('file')
    expect(raw).not.toContain('secret-local-path')
    expect(raw).not.toContain('设计师')
    for (const line of (await zip.file('checksums.sha256')!.async('string')).trim().split('\n')) {
      const [hash, file] = line.split('  ')
      expect(await sha256Bytes(await zip.file(file)!.async('uint8array'))).toBe(hash)
    }
    expect(manifest.rows[0].file.sha256).toBe(await sha256Bytes(await zip.file('variants/00001.zip')!.async('uint8array')))
    expect(task.view().busy).toBe(false)
  })
  it('打包取消保留结果，可再次保存', async () => {
    const task = await createBatchTextExportTask(source(), template, rows(1), 'bake')
    await task.run('start')
    const controller = new AbortController(); controller.abort()
    await expect(task.archive(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(task.result('1')).toBeDefined()
    expect((await task.archive()).size).toBeGreaterThan(0)
  })
})
