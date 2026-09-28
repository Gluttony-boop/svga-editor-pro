import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useEditorStore } from '@/stores'
import { captureExportInputs, sameExportInputs } from './export-preview'
import { BATCH_TEMPLATE_FORMAT, parseVariantCsv, validateBatchRows, type BatchTemplate } from './batch-variants'
import { applyBatchTextRow, type BatchTextSession } from './batch-text-session'

const state = () => useEditorStore.getState()
function prepare(source = 'id,title$\n001,甲\n002,文字过长\n003,乙'): BatchTextSession {
  const rows = parseVariantCsv(source)
  const template: BatchTemplate = { format: BATCH_TEMPLATE_FORMAT, schemaVersion: 1, name: '测试',
    slotRules: [{ key: 'title$', kind: 'text' as const, required: true, maxLength: 2 }] }
  return { inputs: captureExportInputs(state()), rows, template, report: validateBatchRows(template, rows) }
}
beforeEach(() => {
  state().reset()
  state().setVideoItem({ movie: { version: '2.0', params: { viewBoxWidth: 100, viewBoxHeight: 40, frames: 1, fps: 24 },
    images: {}, sprites: [{ imageKey: 'title$', matteKey: null, frames: [{ alpha: 1, clipPath: null,
      layout: { x: 0, y: 0, width: 100, height: 40 }, transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 } }] }] },
    images: {}, buffers: {} })
  state().initializeHistory()
})
afterEach(() => state().reset())

describe('批量文案连续应用会话', () => {
  it('接纳自身修改后连续切换，每条独立撤销且不修改原会话', () => {
    const original = prepare()
    const first = applyBatchTextRow(original, 2)
    expect(first.rows).toBe(original.rows)
    expect(sameExportInputs(first.inputs, captureExportInputs(state()))).toBe(true)
    expect(sameExportInputs(original.inputs, first.inputs)).toBe(false)
    const second = applyBatchTextRow(first, 4)
    expect(state().slotConfigs['title$'].value).toBe('乙')
    expect(state().history.past).toHaveLength(2)
    state().undo()
    expect(state().slotConfigs['title$'].value).toBe('甲')
    expect(() => applyBatchTextRow(second, 4)).toThrow('工程内容已变化')
    state().undo()
    expect(state().slotConfigs).toEqual({})
    expect(original.rows[0].values['title$']).toBe('甲')
  })

  it('手动修改后不会用新引用自动放行旧会话', () => {
    const session = applyBatchTextRow(prepare(), 2)
    state().updateLayer(state().layers[0].id, { opacity: 0.5 })
    const before = state()
    expect(() => applyBatchTextRow(session, 4)).toThrow('工程内容已变化')
    expect(state()).toBe(before)
  })

  it('重新预检后可继续，保留手动修改', () => {
    applyBatchTextRow(prepare(), 2)
    state().updateLayer(state().layers[0].id, { opacity: 0.5 })
    applyBatchTextRow(prepare(), 4)
    expect(state().layers[0].opacity).toBe(0.5)
    expect(state().slotConfigs['title$'].value).toBe('乙')
  })

  it('问题行不阻塞通过行，但自身不能被应用', () => {
    const session = prepare()
    expect(session.report.valid).toBe(false)
    const before = state()
    expect(() => applyBatchTextRow(session, 3)).toThrow('未通过预检')
    expect(state()).toBe(before)
    expect(() => applyBatchTextRow(session, 2)).not.toThrow()
  })

  it('重复编号的首条也拒绝，不能借单行应用绕过完整预检', () => {
    const session = prepare('id,title$\n001,甲\n001,乙')
    const before = state()
    expect(() => applyBatchTextRow(session, 2)).toThrow('未通过预检')
    expect(state()).toBe(before)
  })

  it('不信任旧报告，应用时重新检查清单', () => {
    const session = prepare()
    session.rows[0].values['title$'] = '超过上限'
    expect(() => applyBatchTextRow(session, 2)).toThrow('未通过预检')
    expect(state().history.past).toHaveLength(0)
  })

  it('不存在的行号拒绝，重复应用同一行不增加历史', () => {
    let session = prepare()
    expect(() => applyBatchTextRow(session, 999)).toThrow('未通过预检')
    session = applyBatchTextRow(session, 2)
    const before = state()
    applyBatchTextRow(session, 2)
    expect(state()).toBe(before)
  })

  it('播放和缩放不使会话过期', () => {
    const session = applyBatchTextRow(prepare(), 2)
    state().setPlaying(true)
    state().setZoom(2)
    expect(() => applyBatchTextRow(session, 4)).not.toThrow()
  })

  it('活动文字事务不被连续应用提交', () => {
    const session = prepare()
    state().beginSlotConfigEdit('title$')
    const before = state()
    expect(() => applyBatchTextRow(session, 2)).toThrow('先结束')
    expect(state()).toBe(before)
  })

  it('工程关闭后旧会话不能应用', () => {
    const session = prepare()
    state().reset()
    expect(() => applyBatchTextRow(session, 2)).toThrow('工程内容已变化')
    expect(state().slotConfigs).toEqual({})
  })
})
