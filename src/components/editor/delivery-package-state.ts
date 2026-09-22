import { normalizeDeliveryOptions } from '@/core/delivery-archive'
import { sameExportInputs } from '@/core/export-preview'
import type { DeliveryOptions, DeliveryTarget } from '@/types/delivery'
import { previewFileName } from '@/utils/preview-view'

export interface DeliveryForm {
  title: string
  platform: DeliveryTarget['platform']
  player: string
  version: string
  maxFileMiB: string
  maxDecodedImageMiB: string
  includeProject: boolean
}

export function createDeliveryForm(name: string | null): DeliveryForm {
  let source = name
  // 默认标题将进入分享包，不能把 URL 鉴权参数、完整数据地址或本机目录带出去。
  if (!source || /^(?:blob|data):/i.test(source)) source = null
  if (source && /^https?:\/\//i.test(source)) {
    try { new URL(source) } catch { source = null }
  }
  const basename = source ? previewFileName(source).replace(/\.(?:svgaproj|svga)$/i, '').trim() : ''
  const title = Array.from(basename || '动画交付').slice(0, 120).join('')
  return { title, platform: 'unspecified', player: '', version: '', maxFileMiB: '', maxDecodedImageMiB: '', includeProject: false }
}

function budgetBytes(value: string, label: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const amount = Number(trimmed)
  const bytes = Math.round(amount * 1024 * 1024)
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)
    || !Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error(`${label}请填写大于 0 的 MiB 数值，或留空表示不限制。`)
  }
  return bytes
}

export function readDeliveryOptions(form: DeliveryForm): DeliveryOptions {
  if (!form.title.trim()) throw new Error('请填写交付标题。')
  return normalizeDeliveryOptions({
    title: form.title,
    target: {
      platform: form.platform, player: form.player, version: form.version,
      maxFileBytes: budgetBytes(form.maxFileMiB, 'SVGA 文件预算'),
      maxDecodedImageBytes: budgetBytes(form.maxDecodedImageMiB, '图片解码内存预算'),
    },
    includeProject: form.includeProject,
  })
}

/** 用原始表单值判定失效；即使标准化后等价，也不能忽略用户在生成后的修改。 */
export function deliveryFormKey(form: DeliveryForm): string {
  return JSON.stringify([form.title, form.platform, form.player, form.version, form.maxFileMiB, form.maxDecodedImageMiB, form.includeProject])
}

export function patchDeliveryForm(form: DeliveryForm, patch: Partial<DeliveryForm>): DeliveryForm {
  const next = { ...form, ...patch }
  return deliveryFormKey(next) === deliveryFormKey(form) ? form : next
}

export function isDeliverySnapshotCurrent(
  prepared: { inputs: readonly unknown[]; optionsKey: string; optionsChanged?: boolean },
  currentInputs: readonly unknown[],
  form: DeliveryForm,
): boolean {
  return !prepared.optionsChanged && prepared.optionsKey === deliveryFormKey(form) && sameExportInputs(prepared.inputs, currentInputs)
}
