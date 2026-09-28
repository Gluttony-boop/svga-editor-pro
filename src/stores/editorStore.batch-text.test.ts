import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureExportInputs } from '@/core/export-preview'
import { normalizeTextConfig } from '@/core/text-preview'
import { mergeSlotTextConfig } from '@/utils/slot-config'
import type { VideoItem } from '@/types'
import { useEditorStore } from './editorStore'

const state = () => useEditorStore.getState()
const inputs = () => captureExportInputs(state())
const video = (keys = ['title$', 'name']): VideoItem => ({
  movie: { version: '2.0', params: { viewBoxWidth: 400, viewBoxHeight: 300, frames: 1, fps: 24 },
    images: {}, sprites: keys.map(imageKey => ({ imageKey, matteKey: null, frames: [{
      alpha: 1, clipPath: null, layout: { x: 0, y: 0, width: 100, height: 40 },
      transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
    }] })) }, images: {}, buffers: {},
})
beforeEach(() => {
  state().reset()
  state().setVideoItem(video())
  state().initializeHistory()
})
afterEach(() => state().reset())

describe('清单文案应用：单次历史与安全边界', () => {
  it('多个 Key 一次应用、撤销和重做，不改变图层与原始动画', () => {
    const before = state()
    expect(state().applySlotTextValues({ 'title$': '2222222222222', name: '设计师' }, inputs())).toEqual({ changed: true })
    expect(state().history.past).toHaveLength(1)
    expect(state().history.past[0].label).toBe('应用清单文案：2 个 Key')
    expect(state().isDirty).toBe(true)
    expect(state().videoItem).toBe(before.videoItem)
    expect(state().layers).toBe(before.layers)
    expect(state().imageResources).toBe(before.imageResources)
    expect(state().slotConfigs['title$'].textConfig).toMatchObject({ text: '2222222222222', enabled: true })
    expect(state().slotConfigs['title$'].textConfig?.exportMode).toBeUndefined()
    state().undo()
    expect(state().slotConfigs).toEqual({})
    state().redo()
    expect(state().slotConfigs.name.value).toBe('设计师')
  })

  it.each(['bake', 'preview'] as const)('保留图片、样式、文字范围和 %s 导出模式，只启用和替换文案', exportMode => {
    const textConfig = normalizeTextConfig({ text: '原文案', fontSize: 32, color: '#123456', fontFamily: 'Arial',
      boxWidth: 320, boxHeight: 60, referenceWidth: 100, referenceHeight: 40, exportMode,
      offsetX: 5, offsetY: 6, enabled: false, replaceImage: true })
    const original = { type: 'image' as const, name: 'title$', value: 'blob:original',
      imageConfig: { url: 'blob:original', scaleMode: 'fill' as const }, textConfig }
    state().setSlotConfig('title$', original)
    state().initializeHistory()
    state().applySlotTextValues({ 'title$': '新文案' }, inputs())
    expect(state().slotConfigs['title$']).toEqual({ ...original, textConfig: { ...textConfig, text: '新文案', enabled: true } })
    state().undo()
    expect(state().slotConfigs['title$']).toEqual(original)
  })

  it('重复应用相同文案不增加历史，不清空重做', () => {
    state().applySlotTextValues({ 'title$': '名称' }, inputs())
    state().applySlotTextValues({ name: '另一项' }, inputs())
    state().undo()
    const before = state()
    expect(state().applySlotTextValues({ 'title$': '名称' }, inputs())).toEqual({ changed: false })
    expect(state()).toBe(before)
    expect(state().canRedo).toBe(true)
  })

  it.each(['constructor', '__proto__', ' id ', '   '])('精确处理特殊 Key %s', key => {
    state().setVideoItem(video([key]))
    const values = Object.fromEntries([[key, '文案']])
    expect(state().applySlotTextValues(values, inputs())).toEqual({ changed: true })
    expect(Object.prototype.hasOwnProperty.call(state().slotConfigs, key)).toBe(true)
    expect(state().slotConfigs[key].textConfig?.text).toBe('文案')
    expect(Object.getPrototypeOf(state().slotConfigs)).toBe(Object.prototype)
    state().undo()
    expect(Object.prototype.hasOwnProperty.call(state().slotConfigs, key)).toBe(false)
  })

  it.each(['missing', 'mask.matte'])('发现不可用 Key %s 后整条拒绝，不部分修改', key => {
    state().setVideoItem(video(['title$', 'mask.matte']))
    const before = state()
    expect(state().applySlotTextValues({ 'title$': '有效', [key]: '无效' }, inputs()).error).toContain('已不可用于文字模拟')
    expect(state()).toBe(before)
  })

  it.each(['', ' \n ', '字'.repeat(501), 123])('无效文案整条拒绝，不静默截断：%s', value => {
    const before = state()
    expect(state().applySlotTextValues({ 'title$': '有效', name: value as string }, inputs()).error).toContain('500 码点')
    expect(state()).toBe(before)
  })

  it('按 Unicode 码点接收 500 个表情并规范化换行', () => {
    expect(state().applySlotTextValues({ 'title$': '😀'.repeat(500), name: '一\r\n二' }, inputs()).changed).toBe(true)
    expect(state().slotConfigs['title$'].textConfig?.text).toBe('😀'.repeat(500))
    expect(state().slotConfigs.name.textConfig?.text).toBe('一\n二')
  })

  it('工程变化后拒绝旧报告，播放帧和视口变化不影响应用', () => {
    const expected = inputs()
    state().setPlaying(true)
    state().setCurrentFrame(0)
    state().setZoom(2)
    expect(state().applySlotTextValues({ name: '当前' }, expected).changed).toBe(true)
    const before = state()
    expect(state().applySlotTextValues({ name: '过期' }, expected).error).toContain('工程内容已变化')
    expect(state()).toBe(before)
  })

  it('关闭或切换工程后拒绝旧报告', () => {
    const expected = inputs()
    state().setVideoItem(video())
    expect(state().applySlotTextValues({ name: '旧工程' }, expected).error).toBeDefined()
    state().reset()
    expect(state().applySlotTextValues({ name: '无工程' }, inputs()).error).toBeDefined()
  })

  it('正在输入的草稿不会被失败应用隐式提交', () => {
    state().beginSlotConfigEdit('title$')
    state().previewSlotConfig('title$', mergeSlotTextConfig(undefined, 'title$', normalizeTextConfig({ text: '草稿' })))
    const before = state()
    expect(state().applySlotTextValues({ name: '替换' }, inputs()).error).toContain('先结束')
    expect(state()).toBe(before)
    expect(state().history.past).toHaveLength(0)
    state().endSlotConfigEdit(false)
    expect(state().slotConfigs).toEqual({})
  })

  it('正在进行画布变换时不隐式提交', () => {
    state().beginCanvasTransform(state().layers[0].id)
    const before = state()
    expect(state().applySlotTextValues({ name: '替换' }, inputs()).error).toContain('先结束')
    expect(state()).toBe(before)
  })

  it('后续 Key 的样式无效也不会写入前面的 Key', () => {
    const textConfig = { ...normalizeTextConfig(), boxWidth: 9000 }
    state().setSlotConfig('name', { type: 'text', name: 'name', value: '旧值', textConfig })
    const before = state()
    expect(state().applySlotTextValues({ 'title$': '新文案', name: '无效' }, inputs()).error).toBeDefined()
    expect(state()).toBe(before)
  })

  it('空映射和超过 128 个 Key 不产生状态修改', () => {
    const before = state()
    expect(state().applySlotTextValues({}, inputs()).error).toBeDefined()
    expect(state().applySlotTextValues(Object.fromEntries(Array.from({ length: 129 }, (_, i) => [String(i), '字'])), inputs()).error).toBeDefined()
    expect(state()).toBe(before)
  })
})
