import { describe, expect, it } from 'vitest'
import type { SlotConfig, SlotTextConfig } from '@/types'
import {
  mergeSlotImageConfig,
  mergeSlotTextConfig,
  withoutSlotImageConfig,
  withoutSlotTextConfig
} from './slot-config'

const textConfig: SlotTextConfig = {
  text: '你好', fontSize: 32, color: '#fff', fontFamily: 'sans-serif',
  fontWeight: 'bold', textAlign: 'right', offsetX: 12, offsetY: -3, lineHeight: 1.5,
  enabled: false, replaceImage: true
}

describe('插槽配置合并工具', () => {
  it('文字预览保留同 key 的图片配置且不修改原对象', () => {
    const original: SlotConfig = {
      type: 'image', name: 'title', value: 'data:image/png;base64,old',
      imageConfig: { url: 'data:image/png;base64,old', scaleMode: 'fit' }
    }
    const next = mergeSlotTextConfig(original, 'title', textConfig)
    expect(next).toMatchObject({ type: 'image', name: 'title', value: original.value, imageConfig: original.imageConfig, textConfig })
    expect(next).not.toBe(original)
    expect(next.imageConfig).not.toBe(original.imageConfig)
    expect(original.textConfig).toBeUndefined()
  })

  it('图片替换保留文字样式且图片 value 必须是新 URL，恢复图片后再恢复文字 value', () => {
    const original: SlotConfig = { type: 'text', name: 'title', value: null, textConfig }
    const next = mergeSlotImageConfig(original, 'title', 'data:image/png;base64,new', 'fill')
    expect(next).toMatchObject({ type: 'image', name: 'title', value: 'data:image/png;base64,new', textConfig, imageConfig: { url: 'data:image/png;base64,new', scaleMode: 'fill' } })
    expect(withoutSlotImageConfig(next)).toMatchObject({ type: 'text', value: textConfig.text, textConfig })
  })

  it('纯文字更新保持 value 与 textConfig.text 一致，包括清空', () => {
    const original: SlotConfig = { type: 'text', name: 'title', value: '旧文字', textConfig }
    expect(mergeSlotTextConfig(original, 'title', { ...textConfig, text: '新文字' }).value).toBe('新文字')
    expect(mergeSlotTextConfig(original, 'title', { ...textConfig, text: '' }).value).toBe('')
  })

  it('只有旧版 value 的文字配置在替换图片后也能保留和恢复', () => {
    const original: SlotConfig = { type: 'text', name: 'title', value: '旧版名称' }
    const image = mergeSlotImageConfig(original, 'title', 'data:new')
    expect(image.value).toBe('data:new')
    expect(image.textConfig).toMatchObject({ text: '旧版名称', fontSize: 24, fontFamily: 'Arial' })
    expect(withoutSlotImageConfig(image)).toMatchObject({ type: 'text', value: '旧版名称' })
    expect(withoutSlotImageConfig(original)).toMatchObject({ type: 'text', value: '旧版名称' })
    expect(original.textConfig).toBeUndefined()
  })

  it('重复替换图片不会丢失文字，也不会继续使用上一次图片 URL', () => {
    const first = mergeSlotTextConfig(undefined, 'title', textConfig)
    const second = mergeSlotImageConfig(first, 'title', 'data:first')
    const last = mergeSlotImageConfig(second, 'title', 'data:last', 'stretch')
    expect(last.value).toBe('data:last')
    expect(last.imageConfig).toEqual({ url: 'data:last', scaleMode: 'stretch' })
    expect(last.textConfig).toEqual(textConfig)
    expect(last.textConfig).not.toBe(second.textConfig)
  })

  it('移除文字只移除文字，移除图片只移除图片', () => {
    const config = mergeSlotImageConfig(mergeSlotTextConfig(undefined, 'key', textConfig), 'key', 'data:image')
    const image = withoutSlotTextConfig(config)!
    const text = withoutSlotImageConfig(config)!
    expect(image.type).toBe('image')
    expect(image.value).toBe('data:image')
    expect(image.textConfig).toBeUndefined()
    expect(text.type).toBe('text')
    expect(text.value).toBe(textConfig.text)
    expect(text.imageConfig).toBeUndefined()
    expect(config.imageConfig).toEqual({ url: 'data:image', scaleMode: 'fit' })
    expect(config.textConfig).toEqual(textConfig)
  })

  it('缺省配置可直接新增图片或文字，移除不存在的配置无副作用', () => {
    expect(mergeSlotTextConfig(undefined, 'title', textConfig)).toEqual({ type: 'text', name: 'title', value: textConfig.text, textConfig })
    expect(mergeSlotImageConfig(undefined, 'avatar', 'data:image')).toEqual({ type: 'image', name: 'avatar', value: 'data:image', imageConfig: { url: 'data:image', scaleMode: 'fit' } })
    expect(withoutSlotImageConfig(undefined)).toBeUndefined()
    expect(withoutSlotTextConfig(undefined)).toBeUndefined()
  })

  it('旧版只有图片 value 时文字预览和恢复文字都保留图片', () => {
    const image: SlotConfig = { type: 'image', name: 'key', value: 'blob:existing' }
    const result = mergeSlotTextConfig(image, 'key', textConfig)
    expect(result.value).toBe('blob:existing')
    expect(withoutSlotTextConfig(result)).toEqual(image)
  })

  it('修改返回对象的嵌套样式不会污染原始配置', () => {
    const original = mergeSlotImageConfig(mergeSlotTextConfig(undefined, 'key', textConfig), 'key', 'data:image')
    const next = mergeSlotTextConfig(original, 'key', textConfig)
    next.textConfig!.color = '#000'
    next.imageConfig!.scaleMode = 'stretch'
    expect(original.textConfig!.color).toBe('#fff')
    expect(original.imageConfig!.scaleMode).toBe('fit')
  })

  it('没有另一种替换时删除配置返回 undefined', () => {
    expect(withoutSlotTextConfig({ type: 'text', name: 'title', value: 'x', textConfig })).toBeUndefined()
    expect(withoutSlotImageConfig({ type: 'image', name: 'title', value: 'x' })).toBeUndefined()
    expect(withoutSlotTextConfig({ type: 'image', name: 'title', value: 'x', imageConfig: { url: 'u', scaleMode: 'fit' } })).toMatchObject({ type: 'image' })
  })

  it('动态 key 不会触发原型污染', () => {
    const key = '__proto__'
    const result = mergeSlotTextConfig(undefined, key, textConfig)
    expect(result.name).toBe(key)
    expect(Object.prototype).not.toHaveProperty('polluted')
    expect(mergeSlotImageConfig(result, key, 'data:image').name).toBe(key)
  })
})
