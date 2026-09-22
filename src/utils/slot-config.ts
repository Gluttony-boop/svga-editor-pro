import type { SlotConfig, SlotTextConfig } from '@/types'
import { normalizeTextConfig } from '@/core/text-preview'

/** 图片来源与文字模拟彼此独立，旧配置的文字 value 绝不能被当作图片 URL。 */
export const getSlotImageUrl = (slot?: SlotConfig): string => {
  if (slot?.imageConfig?.url) return slot.imageConfig.url
  if (slot?.type !== 'image' || typeof slot.value !== 'string') return ''
  // 旧版文字/图片切换可能把文案留在 value；不能把它当相对网址请求网络。
  if (slot.textConfig && !/^(?:data:|blob:|https?:|file:)/i.test(slot.value)) return ''
  return slot.value
}

const getTextConfig = (existing: SlotConfig | undefined): SlotTextConfig | undefined => {
  if (existing?.textConfig) return { ...existing.textConfig }
  // 旧版本把纯文字放在 value 中；替换图片前补全配置，避免丢掉文字。
  if (existing?.type === 'text') return normalizeTextConfig(undefined, existing.value)
  return undefined
}

const hasImageConfig = (existing: SlotConfig | undefined): existing is SlotConfig =>
  Boolean(existing && (existing.type === 'image' || existing.imageConfig))

/** 同一个 key 的文字与图片可共存；value 始终匹配 type，兼容现有图片导出路径。 */
export const mergeSlotTextConfig = (
  existing: SlotConfig | undefined,
  key: string,
  textConfig: SlotTextConfig
): SlotConfig => {
  if (hasImageConfig(existing)) {
    return {
      ...existing,
      type: 'image',
      name: key,
      value: existing.imageConfig?.url || existing.value,
      imageConfig: existing.imageConfig ? { ...existing.imageConfig } : undefined,
      textConfig: { ...textConfig }
    }
  }
  return { type: 'text', name: key, value: textConfig.text, textConfig: { ...textConfig } }
}

export const withoutSlotTextConfig = (existing: SlotConfig | undefined): SlotConfig | undefined => {
  if (!hasImageConfig(existing)) return undefined
  return {
    type: 'image',
    name: existing.name,
    value: existing.imageConfig?.url || existing.value,
    ...(existing.imageConfig ? { imageConfig: { ...existing.imageConfig } } : {})
  }
}

export const mergeSlotImageConfig = (
  existing: SlotConfig | undefined,
  key: string,
  url: string,
  scaleMode: 'fit' | 'fill' | 'stretch' = 'fit'
): SlotConfig => {
  const textConfig = getTextConfig(existing)
  return {
    type: 'image', name: key, value: url,
    imageConfig: { url, scaleMode },
    ...(textConfig ? { textConfig } : {})
  }
}

export const withoutSlotImageConfig = (existing: SlotConfig | undefined): SlotConfig | undefined => {
  const textConfig = getTextConfig(existing)
  if (!existing || !textConfig) return undefined
  return { type: 'text', name: existing.name, value: textConfig.text, textConfig }
}
