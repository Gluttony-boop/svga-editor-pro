import { beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import protobuf from 'protobufjs'
import pako from 'pako'
import type { ProjectDocument } from '@/types/project'
import type { DeliveryBundleResult } from '@/types/delivery'
import { createDefaultTracks } from './layer-factory'
import { OPTIMIZATION_PRESETS } from './optimizer'
import proto from './svga-proto'
import { createBatchTextExportTask, openBatchTextExportTask } from './batch-text-export'
import { readBatchTaskFile, writeBatchTaskFile } from './batch-task-file'
import { BATCH_TEMPLATE_FORMAT, type BatchTemplate } from './batch-variants'
import { sha256Bytes } from './content-hash'

// 工程压缩、回读、修订与任务文件均走真实实现；单件渲染在浏览器验收。
const mock = vi.hoisted(() => ({ generate: vi.fn() }))
vi.mock('./delivery', () => ({ generateDeliveryBundle: mock.generate }))
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=', 'base64'))
const Movie = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
const template: BatchTemplate = { format: BATCH_TEMPLATE_FORMAT, schemaVersion: 1, name: '恢复测试', slotRules: [{ key: 'title', kind: 'text', maxLength: 20 }] }
const rows = ['A', 'B', 'C'].map((id, i) => ({ id, row: i + 2, values: { title: id } }))
function source(): ProjectDocument {
  const params = { viewBoxWidth: 1, viewBoxHeight: 1, fps: 24, frames: 2 }
  const sprite = { imageKey: 'title', matteKey: null, frames: [0, 1].map(() => ({ alpha: 1,
    layout: { x: 0, y: 0, width: 1, height: 1 }, transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, clipPath: null })) }
  const movie = { version: '2.0', params, images: { title: png }, sprites: [sprite] }
  return { formatVersion: 1, name: '原始工程.svgaproj', params, customFps: null, customFrames: null,
    originalBuffer: new Uint8Array(pako.deflate(Movie.encode(Movie.fromObject(movie)).finish())).buffer,
    videoItem: { movie, images: {}, buffers: { title: new Uint8Array(png).buffer } },
    layers: [{ id: 'layer', name: 'title', imageKey: 'title', editableIndex: 0, type: 'image', visible: true, locked: false,
      expanded: false, opacity: 1, blendMode: 'normal', clip: { startFrame: 0, duration: 2 }, sprites: sprite, tracks: createDefaultTracks() }],
    imageResources: new Map([['title', { key: 'title', width: 1, height: 1, mimeType: 'image/png', data: png, isNew: false }]]), audioResources: new Map(),
    slotConfigs: {}, detectedSlots: ['title'], currentFrame: 0, selectedLayerId: null, selectedLayerIds: [], selectedPresetId: 'none',
    compressionConfig: { enabled: false, mode: 'png', quality: 90, resizeEnabled: false, resizePercent: 100 }, optimizationConfig: structuredClone(OPTIMIZATION_PRESETS[0].config) }
}
function output(document: ProjectDocument): DeliveryBundleResult {
  const text = document.slotConfigs.title.textConfig!
  return { blob: new Blob([text.text]), fileName: 'test.zip', manifest: { previewFrame: document.currentFrame } as DeliveryBundleResult['manifest'],
    report: { format: 'svga-editor-delivery-report', schemaVersion: 1, previewFrame: 0, decodedImageBytesEstimate: 4, checks: [] },
    previews: { actual: new Blob([png]), design: new Blob([png]) },
    slots: [{ sources: [{ sourceSlotKey: 'title', textEffect: text.exportMode === 'bake' ? 'baked' : 'dynamic', text }] }] as DeliveryBundleResult['slots'] }
}
beforeEach(() => { vi.clearAllMocks(); mock.generate.mockImplementation(async (document: ProjectDocument) => output(document)) })

describe('磁盘任务恢复：真实工程归档、队列与执行衔接', () => {
  it.each(['bake', 'dynamic'] as const)('%s 中途保存并重开，只续未完成项且不混入后续工程修改', async mode => {
    const document = source(), original = structuredClone(document), controller = new AbortController()
    const task = await createBatchTextExportTask(document, template, rows, mode)
    await expect(task.run('start', { signal: controller.signal, onChange: view => {
      if (view.queue.items[0].status === 'succeeded') controller.abort()
    } })).rejects.toMatchObject({ name: 'AbortError' })
    expect(task.view().queue.items.map(item => item.status)).toEqual(['succeeded', 'cancelled', 'cancelled'])
    const checkpoint = await task.saveTask(), firstHash = await sha256Bytes(task.result('A')!.blob)
    document.layers[0].name = '后续编辑'; document.slotConfigs.title = { name: 'title', type: 'text', value: '新文案' }
    const loaded = await openBatchTextExportTask(checkpoint)
    expect(loaded.result('A')?.restored).toBe(true)
    expect(loaded.result('A')?.checks).toEqual([])
    const recoveredBlob = loaded.result('A')!.blob
    await loaded.run('resume-cancelled')
    expect(mock.generate).toHaveBeenCalledTimes(3)
    expect(mock.generate.mock.calls.map(call => call[0].slotConfigs.title.value)).toEqual(['A', 'B', 'C'])
    expect(mock.generate.mock.calls.every(call => call[0].layers[0].name === original.layers[0].name)).toBe(true)
    expect(loaded.view().queue.items.map(item => item.attempts)).toEqual([1, 1, 1])
    expect(loaded.result('A')!.blob).toBe(recoveredBlob)
    expect(await sha256Bytes(recoveredBlob)).toBe(firstHash)
    expect(loaded.result('B')!.restored).toBe(false)
    const archive = await JSZip.loadAsync(await (await loaded.archive()).arrayBuffer())
    const manifest = JSON.parse(await archive.file('manifest.json')!.async('string'))
    expect(manifest.rows.map((row: { verification: string }) => row.verification)).toEqual(['restored-integrity-only', 'generated-in-session', 'generated-in-session'])
    expect(manifest.complete).toBe(true)
    const reopened = await openBatchTextExportTask(await loaded.saveTask())
    expect(reopened.view().queue).toEqual(loaded.view().queue)
    expect(reopened.result('B')!.restored).toBe(true)
  })
  it('失败项及原因/次数可恢复，重试不覆盖成功字节', async () => {
    mock.generate.mockImplementation(async (document: ProjectDocument) => { if (document.slotConfigs.title.value === 'B') throw new Error('编码失败'); return output(document) })
    const task = await createBatchTextExportTask(source(), template, rows, 'bake')
    await task.run('start')
    const loaded = await openBatchTextExportTask(await task.saveTask())
    expect(loaded.view().queue.items[1]).toMatchObject({ status: 'failed', attempts: 1, issues: [{ message: '编码失败' }] })
    mock.generate.mockImplementation(async (document: ProjectDocument) => output(document))
    await loaded.run('retry-failed')
    expect(mock.generate).toHaveBeenCalledTimes(4)
    expect(loaded.view().queue.items.map(item => item.attempts)).toEqual([1, 2, 1])
  })
  it('尚未执行也能保存，并从文件中独立开始', async () => {
    const task = await createBatchTextExportTask(source(), template, rows, 'dynamic')
    const loaded = await openBatchTextExportTask(await task.saveTask())
    expect(loaded.view().queue.items.every(item => item.status === 'queued')).toBe(true)
    await loaded.run('start')
    expect(loaded.view().queue.items.every(item => item.status === 'succeeded')).toBe(true)
  })
  it.each(['revision', 'invalid-project', 'preview-frame', 'preview-size', 'missing-key'])('拒绝 %s 不一致，不能伪造已恢复源快照', async kind => {
    const task = await createBatchTextExportTask(source(), template, rows, 'dynamic'); await task.run('start')
    const data = await readBatchTaskFile(await task.saveTask())
    if (kind === 'revision') data.sourceRevision = '0'.repeat(64)
    if (kind === 'invalid-project') data.sourceArchive = new Blob(['invalid-project'])
    if (kind === 'preview-frame') data.results.get('A')!.previewFrame = 1
    if (kind === 'preview-size') {
      const altered = new Uint8Array(png); new DataView(altered.buffer).setUint32(16, 2)
      data.results.get('A')!.previews.actual = new Blob([altered])
    }
    if (kind === 'missing-key') data.queue.items[0].row.values = { unavailable: 'A' }
    await expect(openBatchTextExportTask(await writeBatchTaskFile(data))).rejects.toThrow()
    expect(task.view().queue.items.every(item => item.status === 'succeeded')).toBe(true)
  })
  it('运行时不能同时保存任务；保存/读取取消保留原任务', async () => {
    const task = await createBatchTextExportTask(source(), template, rows, 'bake')
    let release!: () => void
    mock.generate.mockImplementationOnce(async (document: ProjectDocument) => { await new Promise<void>(resolve => { release = resolve }); return output(document) })
    const running = task.run('start')
    await expect(task.saveTask()).rejects.toThrow('正在生成')
    release(); await running
    const file = await task.saveTask(), controller = new AbortController(); controller.abort()
    await expect(task.saveTask(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(openBatchTextExportTask(file, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(task.view().busy).toBe(false)
  })
})
