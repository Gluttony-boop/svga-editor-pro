import { describe, expect, it, vi } from 'vitest'
import { BATCH_TEMPLATE_FORMAT, createBatchQueue, startBatchItem, succeedBatchItem, cancelQueuedBatchItems, type BatchTemplate } from './batch-variants'
import { MAX_BATCH_TASK_BYTES, readBatchTaskFile, writeBatchTaskFile, type BatchTaskData } from './batch-task-file'
import { sha256Bytes } from './content-hash'

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=', 'base64'))
const template: BatchTemplate = { format: BATCH_TEMPLATE_FORMAT, schemaVersion: 1, name: '测试', slotRules: [{ key: '__proto__', kind: 'text', maxLength: 20 }] }
async function data(): Promise<BatchTaskData> {
  const blob = new Blob(['opaque-package']), preview = new Blob([png], { type: 'image/png' })
  let queue = createBatchQueue(template, ['../../CON', '2'].map((id, i) => ({ id, row: i + 2, values: Object.fromEntries([['__proto__', '文字' + i]]) })))
  queue = succeedBatchItem(startBatchItem(queue, '../../CON'), '../../CON', { fileName: '00001.zip', bytes: blob.size, sha256: await sha256Bytes(blob) })
  return { mode: 'bake', queue: cancelQueuedBatchItems(queue), sourceRevision: 'a'.repeat(64), sourceArchive: new Blob(['source']),
    results: new Map([['../../CON', { blob, previews: { actual: preview, design: preview }, previewFrame: 0 }]]) }
}
async function decode(file: Blob) {
  const bytes = new Uint8Array(await file.arrayBuffer()), length = new DataView(bytes.buffer).getUint32(8, true)
  return { header: JSON.parse(new TextDecoder().decode(bytes.subarray(76, 76 + length))), payload: bytes.slice(76 + length) }
}
async function envelope(header: string, payload: Uint8Array) {
  const raw = new TextEncoder().encode(header), prefix = new Uint8Array(76)
  prefix.set(new TextEncoder().encode('SVGABT01'))
  new DataView(prefix.buffer).setUint32(8, raw.length, true)
  prefix.set(new TextEncoder().encode(await sha256Bytes(raw)), 12)
  return new Blob([prefix, raw, new Uint8Array(payload)])
}

describe('可移植批量任务：有界容器与不可信输入', () => {
  it('源快照、精确 Key/编号、队列和成功字节往返，不依赖路径或编辑器', async () => {
    const source = await data(), file = await writeBatchTaskFile(source), loaded = await readBatchTaskFile(file)
    expect(loaded.queue).toEqual(source.queue)
    expect(loaded.mode).toBe('bake')
    expect(await loaded.sourceArchive.text()).toBe('source')
    expect(await loaded.results.get('../../CON')!.blob.text()).toBe('opaque-package')
    expect(await loaded.results.get('../../CON')!.previews.actual.arrayBuffer()).toEqual(png.buffer)
    expect(Object.getPrototypeOf(loaded.queue.items[0].row.values)).toBeNull()
    expect(loaded.queue.items[0].row.values.__proto__).toBe('文字0')
  })
  it('零成功任务仍可保存并恢复，running 队列只在读取时恢复为 queued', async () => {
    const source = await data()
    source.queue = createBatchQueue(template, [source.queue.items[1].row]); source.results.clear()
    const file = await writeBatchTaskFile(source)
    expect((await readBatchTaskFile(file)).queue.items[0].status).toBe('queued')
    const { header, payload } = await decode(file)
    const queue = JSON.parse(header.queue); queue.items[0].status = 'running'; queue.items[0].attempts = 1; header.queue = JSON.stringify(queue)
    expect((await readBatchTaskFile(await envelope(JSON.stringify(header), payload))).queue.items[0]).toMatchObject({ status: 'queued', attempts: 1 })
    source.queue = startBatchItem(source.queue, '2')
    await expect(writeBatchTaskFile(source)).rejects.toThrow('停止任务')
  })
  it.each(['header', 'source', 'bundle', 'actual', 'design'])('%s 位损坏不会被当作正常恢复', async part => {
    const file = await writeBatchTaskFile(await data()), { header } = await decode(file)
    const bytes = new Uint8Array(await file.arrayBuffer()), start = 76 + new DataView(bytes.buffer).getUint32(8, true)
    const offset = part === 'header' ? 78 : start + (part === 'source' ? 0 : header.source.bytes +
      (part === 'bundle' ? 0 : header.results[0].bundle.bytes + (part === 'actual' ? 0 : header.results[0].actual.bytes)))
    bytes[offset] ^= 1
    await expect(readBatchTaskFile(new Blob([bytes]))).rejects.toThrow('摘要不匹配')
  })
  it.each(['version', 'extra', 'mode', 'index', 'negative', 'too-large', 'duplicate-result', 'missing-result', 'wrong-artifact', 'file-name', 'frame'])('拒绝 %s 结构矛盾（即使重新计算头摘要）', async kind => {
    const { header, payload } = await decode(await writeBatchTaskFile(await data()))
    if (kind === 'version') header.schemaVersion = 2
    if (kind === 'extra') header.unknown = true
    if (kind === 'mode') header.mode = 'preview'
    if (kind === 'index') header.results[0].index = 1
    if (kind === 'negative') header.source.bytes = -1
    if (kind === 'too-large') header.results[0].actual.bytes = 33 * 1024 * 1024
    if (kind === 'duplicate-result') header.results.push(header.results[0])
    if (kind === 'missing-result') header.results = []
    if (kind === 'wrong-artifact' || kind === 'file-name') {
      const queue = JSON.parse(header.queue)
      if (kind === 'wrong-artifact') queue.items[0].artifact.sha256 = '0'.repeat(64)
      else queue.items[0].artifact.fileName = 'other.zip'
      header.queue = JSON.stringify(queue)
    }
    if (kind === 'frame') header.results[0].previewFrame = 0.5
    await expect(readBatchTaskFile(await envelope(JSON.stringify(header), payload))).rejects.toThrow()
  })
  it('缺失、尾随载荷、超大声明和非任务文件在分配前拒绝', async () => {
    const file = await writeBatchTaskFile(await data())
    await expect(readBatchTaskFile(file.slice(0, file.size - 1))).rejects.toThrow('载荷')
    await expect(readBatchTaskFile(new Blob([file, 'tail']))).rejects.toThrow('载荷')
    await expect(readBatchTaskFile(new Blob(['ZIP']))).rejects.toThrow('截断')
    const oversized = new Blob(['x']); Object.defineProperty(oversized, 'size', { value: MAX_BATCH_TASK_BYTES + 1 })
    const slice = vi.spyOn(oversized, 'slice')
    await expect(readBatchTaskFile(oversized)).rejects.toThrow('上限'); expect(slice).not.toHaveBeenCalled()
    const prefix = new Uint8Array(await file.slice(0, 76).arrayBuffer()); new DataView(prefix.buffer).setUint32(8, 0xffffffff, true)
    await expect(readBatchTaskFile(new Blob([prefix, 'x']))).rejects.toThrow('清单长度')
  })
  it('拒绝重复 JSON 字段和极深嵌套', async () => {
    const { header, payload } = await decode(await writeBatchTaskFile(await data()))
    await expect(readBatchTaskFile(await envelope(JSON.stringify(header).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'), payload))).rejects.toThrow('重复 Key')
    await expect(readBatchTaskFile(await envelope('['.repeat(17) + '0' + ']'.repeat(17), payload))).rejects.toThrow('嵌套')
  })
  it.each(['html', 'apng', 'dimensions', 'trailing', 'truncated'])('禁止显示 %s 伪预览', async kind => {
    const source = await data(), stored = source.results.get('../../CON')!
    let preview = new Uint8Array(png)
    if (kind === 'html') preview = new TextEncoder().encode('<svg onload="alert(1)"></svg>')
    if (kind === 'apng') preview.set(new TextEncoder().encode('acTL'), 37)
    if (kind === 'dimensions') new DataView(preview.buffer).setUint32(16, 0x7fffffff)
    if (kind === 'trailing') preview = new Uint8Array([...preview, 0])
    if (kind === 'truncated') preview = preview.slice(0, -1)
    stored.previews.actual = new Blob([preview])
    await expect(writeBatchTaskFile(source)).rejects.toThrow('预览')
  })
  it('写入、读取取消不会输出半份任务', async () => {
    const source = await data(), file = await writeBatchTaskFile(source), controller = new AbortController()
    controller.abort()
    await expect(writeBatchTaskFile(source, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(readBatchTaskFile(file, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(source.results.size).toBe(1)
  })
  it('任务与缓存不一致不能保存', async () => {
    const source = await data(); source.results.get('../../CON')!.blob = new Blob(['changed'])
    await expect(writeBatchTaskFile(source)).rejects.toThrow('不一致')
    source.results.clear()
    await expect(writeBatchTaskFile(source)).rejects.toThrow('缺少产物')
  })
})
