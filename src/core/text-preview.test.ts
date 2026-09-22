import { describe, expect, it } from 'vitest'
import type { SlotConfig } from '@/types'
import { applyTextFrameLayout, getTextCompositionGeometry, hasTextBox, hasTextPreview, normalizeTextConfig, getTextPreviewSize } from './text-preview'

describe('文字预览配置', () => {
  it('只对非空且启用的文字配置生效', () => {
    expect(hasTextPreview({ type: 'text', name: 'title', value: 'Hi' })).toBe(true)
    expect(hasTextPreview({ type: 'text', name: 'title', value: '' })).toBe(false)
    expect(hasTextPreview({ type: 'image', name: 'title', value: null })).toBe(false)
    expect(hasTextPreview({ type: 'image', name: 'title', value: null, textConfig: { text: 'Hi', fontSize: 24, color: '#fff', fontFamily: 'Arial' } })).toBe(true)
  })

  it('限制异常配置并保留默认样式', () => {
    const config = normalizeTextConfig({ text: 'a'.repeat(600), fontSize: 9999, color: 'red', fontFamily: 'Arial', enabled: true })
    expect(config.text).toHaveLength(500)
    expect(config.fontSize).toBe(512)
    expect(config.fontWeight).toBe('normal')
    expect(config.textAlign).toBe('center')
  })

  it('优先使用源帧布局而不是替换图片尺寸', () => {
    expect(getTextPreviewSize({ width: 80, height: 30 }, { width: 720, height: 760 })).toEqual({ width: 80, height: 30 })
    expect(getTextPreviewSize(null, { width: 720, height: 760 })).toEqual({ width: 720, height: 760 })
  })
})

const box = { boxWidth: 300, boxHeight: 80, referenceWidth: 100, referenceHeight: 50 }
const slot = (patch = {}): SlotConfig => ({
  type: 'text', name: 'title', value: null,
  textConfig: { text: '2222222222222', fontSize: 24, color: '#fff', fontFamily: 'Arial', ...box, ...patch }
})

describe('文字区域局部坐标与安全边界', () => {
  it('100宽扩到300宽，保持原图100宽与24px字号', () => {
    expect(getTextCompositionGeometry(slot(), { width: 100, height: 50 })).toEqual({
      sourceWidth: 100, sourceHeight: 50, textWidth: 300, textHeight: 80,
      width: 300, height: 80, drawWidth: 300, drawHeight: 80
    })
    expect(normalizeTextConfig(slot().textConfig).fontSize).toBe(24)
  })

  it('逐帧布局和共享引用按原来的比例变化，不重复栅格化或猜首帧尺寸', () => {
    expect(getTextCompositionGeometry(slot(), { width: 200, height: 25 })).toMatchObject({
      sourceWidth: 100, sourceHeight: 50, width: 300, height: 80, drawWidth: 600, drawHeight: 40
    })
  })

  it('底图和文字框各有尺寸；文字框缩小时只裁文字', () => {
    expect(getTextCompositionGeometry(slot({ boxWidth: 40, boxHeight: 20 }), { width: 100, height: 50 })).toMatchObject({
      textWidth: 40, textHeight: 20, width: 100, height: 50
    })
    expect(getTextCompositionGeometry(slot({ boxWidth: 40, boxHeight: 20, replaceImage: true }), { width: 100, height: 50 })).toMatchObject({ width: 40, height: 20 })
  })

  it.each([{ enabled: false }, { text: '' }])('关闭/空文案不隐藏底图，仍保留显式容器扩展', patch => {
    const config = slot({ ...patch, replaceImage: true, boxWidth: 40, boxHeight: 20 })
    expect(getTextCompositionGeometry(config, { width: 100, height: 50 })).toMatchObject({ width: 100, height: 50 })
  })

  it('仅扩容导出不应用仅文字选项，保留原底图', () => {
    expect(getTextCompositionGeometry(slot({ replaceImage: true, boxWidth: 40, boxHeight: 20 }), { width: 100, height: 50 }, { includeText: false })).toMatchObject({ width: 100, height: 50 })
  })

  it('扩展帧布局时保留原矩阵、位置、裁切、透明度并不修改输入', () => {
    const frame = { layout: { x: 7, y: 9, width: 100, height: 50 }, transform: { a: -2, b: 1, c: 0.4, d: 3, tx: 71, ty: 62 }, alpha: 0.5, clipPath: 'M0 0L10 10Z' }
    const next = applyTextFrameLayout(frame, slot())
    expect(next).toEqual({ ...frame, layout: { ...frame.layout, width: 300, height: 80 } })
    expect(next.transform).toBe(frame.transform)
    expect(frame.layout.width).toBe(100)
  })

  it('缺省布局回退原图尺寸，不按扩容后的图重新计算一遍', () => {
    expect(applyTextFrameLayout({ layout: null }, slot(), { width: 100, height: 50 })).toEqual({ layout: { width: 300, height: 80 } })
  })

  it('旧配置不添加新字段、旧帧不被重写，旧文字画布的小数布局保持原绘制宽度', () => {
    const old: SlotConfig = { type: 'text', name: 'title', value: '原文案' }
    expect(hasTextBox(old)).toBe(false)
    expect(normalizeTextConfig()).not.toHaveProperty('boxWidth')
    expect(normalizeTextConfig()).not.toHaveProperty('exportMode')
    const frame = { layout: { width: 100.25, height: 50.5 } }
    expect(applyTextFrameLayout(frame, old)).toBe(frame)
    expect(getTextCompositionGeometry(old, frame.layout)).toMatchObject({ width: 101, height: 51, drawWidth: 100.25, drawHeight: 50.5 })
  })

  it.each([
    { boxWidth: 200 }, { ...box, boxHeight: 0 }, { ...box, boxWidth: -1 },
    { ...box, boxWidth: 12.3 }, { ...box, referenceHeight: Infinity },
    { ...box, boxWidth: 8193 }, { ...box, boxWidth: 8192, boxHeight: 8192 },
    { boxWidth: 8192, boxHeight: 1, referenceWidth: 1, referenceHeight: 8192 },
    { exportMode: 'bake' }, { ...box, exportMode: 'unknown' }
  ])('非法或过大的区域组合明确拒绝：%j', patch => {
    expect(() => normalizeTextConfig(patch as never)).toThrow()
  })

  it('允许总像素边界，删除可选字段可还原默认模式', () => {
    expect(normalizeTextConfig({ boxWidth: 8192, boxHeight: 512, referenceWidth: 100, referenceHeight: 50 }).boxWidth).toBe(8192)
    expect(normalizeTextConfig({ boxWidth: undefined, boxHeight: undefined, referenceWidth: undefined, referenceHeight: undefined })).not.toHaveProperty('boxWidth')
  })
})
