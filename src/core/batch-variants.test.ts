import { describe, expect, it } from 'vitest'
import {
  createBatchQueue, failBatchItem, nextBatchItem, parseBatchQueue, parseVariantCsv, parseVariantJson,
  recoverBatchQueue, retryFailedBatchItems, serializeBatchQueue, startBatchItem, succeedBatchItem,
  cancelQueuedBatchItems, validateBatchRows, MAX_BATCH_ROWS, MAX_BATCH_JSON_BYTES,
  type BatchTemplate, type BatchQueueState, type BatchVariantRow,
} from './batch-variants'

const template: BatchTemplate = {
  format: 'svga-editor-batch-template', schemaVersion: 1, name: '文案模板',
  slotRules: [{ key: 'title$', kind: 'text', maxLength: 5 }],
}
const input = (id = 'a', title = '示例') => ({ id, values: { 'title$': title } })
const rows = (...values: ReturnType<typeof input>[]) => parseVariantJson(JSON.stringify(values))
const artifact = { fileName: 'a.svga', bytes: 12, sha256: 'a'.repeat(64) }
const queue = () => createBatchQueue(template, rows(input('a'), input('b'), input('c')))
const image = { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png', byteSize: 8, width: 100, height: 100 }
const imageTemplate: BatchTemplate = { ...template, slotRules: [{ key: 'avatar', kind: 'image', maxBytes: 10, maxWidth: 200, allowedMimeTypes: ['image/png'] }] }

describe('批量清单精确解析', () => {
  it('CSV 的 BOM、转义、逗号、多行、前导零与空格均保持原值', () => {
    const parsed = parseVariantCsv('\uFEFFid, name ,title$\r\n001,"a,""b""","第一行\r\n第二行"\r\n')
    expect(parsed).toEqual([{ row: 2, id: '001', values: { ' name ': 'a,"b"', 'title$': '第一行\r\n第二行' } }])
  })
  it('默认不会吞掉 name、variantId 或名称；可显式选择编号列或保留 id Key', () => {
    expect(parseVariantCsv('name,variantId,名称\n甲,乙,丙')[0].values).toEqual({ name: '甲', variantId: '乙', 名称: '丙' })
    expect(parseVariantCsv('id,title$\nx,y', { idColumn: null })[0].values).toEqual({ id: 'x', 'title$': 'y' })
    expect(parseVariantCsv('编号,title$\n001,甲', { idColumn: '编号' })[0].id).toBe('001')
    expect(() => parseVariantCsv('id,title$\na,甲', { idColumn: 'absent' })).toThrow('编号列不存在')
  })
  it.each(['id,title$,title$\na,b,c', 'id,,title$\na,b,c', 'id,title$\na,b,c', 'id,title$\na,"broken'])('拒绝歧义表头或坏记录：%s', source => {
    expect(() => parseVariantCsv(source)).toThrow()
  })
  it('中间空行和显式空行不丢失；只移除结束换行产生的记录', () => {
    expect(parseVariantCsv('id,title$\na,甲\n\nb,乙\n').map(row => row.row)).toEqual([2, 3, 4])
    expect(parseVariantCsv('title$\n""')).toHaveLength(1)
    expect(() => parseVariantCsv('title$\n,\n')).toThrow('多出列')
  })
  it('空记录参与必填校验，不静默跳过', () => {
    const report = validateBatchRows(template, parseVariantCsv('id,title$\na,甲\n\nb,乙'))
    expect(report.rows[1]).toMatchObject({ row: 3, valid: false })
  })
  it('JSON 嵌套 values 的 id/name/values/特殊资源名不丢失、不污染原型', () => {
    const parsed = parseVariantJson('[{"id":"001","values":{"id":"甲","name":"乙","values":"丙","__proto__":"丁","constructor":"戊"," title$ ":"己"}}]')
    expect(Object.getPrototypeOf(parsed[0].values)).toBeNull()
    expect(Object.keys(parsed[0].values)).toHaveLength(6)
    expect(parsed[0].values.__proto__).toBe('丁')
    expect(parseVariantJson('[{"id":"a","name":"昵称"}]')[0].values).toEqual({ name: '昵称' })
  })
  it.each(['[{"id":1,"values":{}}]', '[{"id":"a","values":null}]', '[{"id":"a","values":[]}]',
    '[{"id":"a","values":{},"extra":true}]', '{"rows":[],"extra":1}',
    '[{"id":"a","values":{"title$":"a","title$":"b"}}]',
    '[{"id":"a","values":{"name":"a","\\u006eame":"b"}}]',
  ])('拒绝无效、歧义或未知 JSON 字段：%s', source => expect(() => parseVariantJson(source)).toThrow())
  it('BOM JSON 和 rows 封装可读；空清单不算通过', () => {
    expect(parseVariantJson('\uFEFF{"rows":[' + JSON.stringify(input()) + ']}')).toHaveLength(1)
    expect(validateBatchRows(template, []).valid).toBe(false)
  })
  it('数量与嵌套限额在导入阶段生效', () => {
    expect(() => parseVariantCsv('id,title$\n' + 'a,b\n'.repeat(MAX_BATCH_ROWS + 1))).toThrow('10000')
    expect(() => parseVariantCsv(Array.from({ length: 129 }, (_, i) => 'k' + i).join(','))).toThrow('128')
    expect(() => parseVariantJson('['.repeat(17) + '0' + ']'.repeat(17))).toThrow('嵌套')
    expect(() => parseVariantJson(' '.repeat(MAX_BATCH_JSON_BYTES + 1))).toThrow('8 MiB')
  })
})

describe('逐行预检', () => {
  it('20 行清单准确标出 3 个坏行；不修改输入', () => {
    const parsed = rows(...Array.from({ length: 20 }, (_, i) => input(String(i))))
    parsed[2].values.other = '未知 Key'
    delete parsed[7].values['title$']
    parsed[16].values['title$'] = '2222222222222'
    const before = JSON.stringify(parsed)
    const report = validateBatchRows(template, parsed, new Set(['title$']))
    expect(report.rows.filter(row => row.valid)).toHaveLength(17)
    expect(report.issues.map(issue => [issue.row, issue.key, issue.code])).toEqual([
      [3, 'other', 'unknown-key'], [8, 'title$', 'missing-value'], [17, 'title$', 'text-too-long'],
    ])
    expect(JSON.stringify(parsed)).toBe(before)
    expect(() => createBatchQueue(template, parsed)).toThrow('预检')
  })
  it('重复编号的所有行均失败，前一行也不能被偷偷放行', () => {
    const report = validateBatchRows(template, rows(input('a'), input('a')))
    expect(report.rows.map(row => row.valid)).toEqual([false, false])
    expect(report.issues.every(issue => issue.code === 'duplicate-id')).toBe(true)
  })
  it('当前工程缺 Key、必填、可选值和 Unicode 长度规则明确', () => {
    expect(validateBatchRows(template, rows(input()), new Set()).issues[0].code).toBe('missing-key')
    expect(() => createBatchQueue(template, rows(input()), new Set())).toThrow('预检')
    expect(validateBatchRows(template, rows(input('a', '😀😀😀😀😀'))).valid).toBe(true)
    expect(validateBatchRows(template, rows(input('a', '😀😀😀😀😀😀'))).issues[0].code).toBe('text-too-long')
    expect(validateBatchRows({ ...template, slotRules: [{ key: 'title$', kind: 'text', required: false }] }, rows(input('a', ''))).valid).toBe(true)
  })
  it.each([null, 1, {}, { row: -1, id: 'a', values: {} }, { row: 1, id: ' ', values: {} }])('外部无效行不崩溃：%s', value => {
    expect(validateBatchRows(template, [value as BatchVariantRow]).valid).toBe(false)
  })
  it.each([{ required: 'false' }, { maxLength: 0 }, { allowedMimeTypes: 'png' }, { extra: 1 }])('拒绝坏模板：%s', patch => {
    expect(() => validateBatchRows({ ...template, slotRules: [{ ...template.slotRules[0], ...patch }] } as BatchTemplate, rows(input()))).toThrow()
  })
  it.each(['C:\\avatar.png', 'https://example.test/a.png', { ...image, byteSize: 1 }, { ...image, dataUrl: 'data:image/png;base64,!!!!' },
    { ...image, mimeType: 'image/webp' }, { ...image, dataUrl: 'data:image/svg+xml;base64,AA==' }, null,
  ])('图片路径、伪报字节或格式不会误通过：%s', value => {
    const report = validateBatchRows(imageTemplate, [{ row: 1, id: 'a', values: { avatar: value as never } }])
    expect(report.valid).toBe(false)
    expect(report.issues[0].code).toBe('invalid-image')
  })
  it('即使元数据正确也明确阻止尚未真实解码的图片执行', () => {
    const parsed = parseVariantJson(JSON.stringify([{ id: 'a', values: { avatar: image } }]))
    expect(validateBatchRows(imageTemplate, parsed).issues[0].code).toBe('image-not-verified')
    expect(() => createBatchQueue(imageTemplate, parsed)).toThrow('预检')
  })
})

describe('队列状态的纯数据契约（不等于磁盘持久化）', () => {
  it('创建后不共享调用者的模板和文案对象', () => {
    const data = rows(input())
    const rules = structuredClone(template)
    const state = createBatchQueue(rules, data)
    data[0].values['title$'] = 'changed'
    rules.slotRules[0].maxLength = 1
    expect(state.items[0].row.values['title$']).toBe('示例')
    expect(state.template.slotRules[0].maxLength).toBe(5)
  })
  it('20 项第 12 项中断，往返后从第 12 项继续、成功项不重跑', () => {
    let state = createBatchQueue(template, rows(...Array.from({ length: 20 }, (_, i) => input(String(i + 1)))))
    for (let i = 1; i <= 11; i++) {
      state = succeedBatchItem(startBatchItem(state, String(i)), String(i), { ...artifact, fileName: i + '.svga' })
    }
    state = startBatchItem(state, '12')
    expect(nextBatchItem(state)).toBeUndefined()
    const restored = parseBatchQueue(serializeBatchQueue(state), template)
    expect(restored.items.filter(item => item.status === 'succeeded')).toHaveLength(11)
    expect(nextBatchItem(restored)?.row.id).toBe('12')
    expect(restored.items[11].attempts).toBe(1)
    expect(() => startBatchItem(restored, '1')).toThrow()
    expect(() => succeedBatchItem(restored, '12', artifact)).toThrow()
  })
  it('失败定位严格属于本行；仅重试失败项并保留成功产物', () => {
    let state = succeedBatchItem(startBatchItem(queue(), 'a'), 'a', artifact)
    state = startBatchItem(state, 'b')
    expect(() => failBatchItem(state, 'b', [{ code: 'write-failed', row: 99, message: '失败' }])).toThrow()
    state = failBatchItem(state, 'b', [{ code: 'write-failed', row: 2, key: 'title$', message: '写入失败' }])
    state = cancelQueuedBatchItems(state)
    const restored = parseBatchQueue(serializeBatchQueue(state))
    const retried = retryFailedBatchItems(restored)
    expect(retried.items.map(item => item.status)).toEqual(['succeeded', 'queued', 'cancelled'])
    expect(retried.items[0].artifact).toEqual(artifact)
    expect(retried.items[1].attempts).toBe(1)
  })
  it('串行执行禁止并发启动；取消未开始项不伪装已取消原生写入', () => {
    const state = startBatchItem(queue(), 'a')
    expect(() => startBatchItem(state, 'b')).toThrow('正在执行')
    expect(cancelQueuedBatchItems(state).items.map(item => item.status)).toEqual(['running', 'cancelled', 'cancelled'])
    expect(recoverBatchQueue(state).items[0].status).toBe('queued')
  })
  it('相同名字的新模板规则也拒绝恢复', () => {
    expect(() => parseBatchQueue(serializeBatchQueue(queue()), { ...template, slotRules: [{ ...template.slotRules[0], maxLength: 4 }] })).toThrow('不一致')
  })
  it.each(['../a.svga', 'C:\\a.svga', 'a/b.svga', 'CON.svga', '.svga', 'a.png', 'a.svga '])('拒绝不安全产物文件名 %s', fileName => {
    expect(() => succeedBatchItem(startBatchItem(queue(), 'a'), 'a', { ...artifact, fileName })).toThrow()
  })
  it('空产物、坏摘要和重名文件都拒绝记为成功', () => {
    const state = startBatchItem(queue(), 'a')
    expect(() => succeedBatchItem(state, 'a', { ...artifact, bytes: 0 })).toThrow()
    expect(() => succeedBatchItem(state, 'a', { ...artifact, sha256: 'x' })).toThrow()
    const next = startBatchItem(succeedBatchItem(state, 'a', artifact), 'b')
    expect(() => succeedBatchItem(next, 'b', { ...artifact, fileName: 'A.SVGA' })).toThrow('重复')
  })
  it.each([
    (s: BatchQueueState) => { s.items[0].status = 'succeeded'; s.items[0].attempts = 1 },
    (s: BatchQueueState) => { s.items[0].status = 'failed'; s.items[0].attempts = 1 },
    (s: BatchQueueState) => { s.items[0].artifact = artifact },
    (s: BatchQueueState) => { s.items[0].row.id = ' ' },
    (s: BatchQueueState) => { s.items[0].row.values['title$'] = '2'.repeat(20) },
    (s: BatchQueueState) => { s.items[1].row.row = 1 },
    (s: BatchQueueState) => { s.template.slotRules[0].maxLength = 1 },
    (s: BatchQueueState) => { (s as unknown as Record<string, unknown>).unknown = 1 },
  ])('坏快照在读写两端均拒绝 %#', change => {
    const state = queue()
    change(state)
    expect(() => serializeBatchQueue(state)).toThrow()
    expect(() => parseBatchQueue(JSON.stringify(state))).toThrow()
  })
})
