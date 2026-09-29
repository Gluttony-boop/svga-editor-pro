import type { ImageResource, Layer, SlotConfig } from '@/types'
import { detectImageMime } from '@/utils/image-mime'
import { getResourceUsages } from '@/utils/resource-usage'
import { mergeSlotImageConfig } from '@/utils/slot-config'
import { validateReplacementSize } from './image-fit'
import { isReplacementTargetCurrent, type ReplacementResourceState, type ReplacementTarget } from './replacement-target'

export type ImageReplacementScope = 'current-layer' | 'all-references'

export interface ImageReplacementState extends ReplacementResourceState {
  selectedLayerId: string | null
  selectedLayerIds: string[]
  detectedSlots: string[]
}

export type ImageReplacementPlan = {
  changed: true
  patch: { layers?: Layer[]; imageResources?: Map<string, ImageResource>; slotConfigs: Record<string, SlotConfig>; detectedSlots?: string[]; isDirty: true }
  key: string
  layerIds: string[]
} | { changed: false; error: string }

/** 单层拆分只改变图片绑定，不推测多选主图层，也不拆开遮罩或矢量协议关系。 */
export function getCurrentReplacementLayer(state: ImageReplacementState, key: string, expectedLayerId?: string | null): { layer?: Layer; error?: string } {
  const selectedIds = state.selectedLayerIds.length ? Array.from(new Set(state.selectedLayerIds)) : state.selectedLayerId ? [state.selectedLayerId] : []
  if (!state.selectedLayerId || selectedIds.length !== 1 || selectedIds[0] !== state.selectedLayerId) return { error: '请先在图层面板只选中一个引用此图片的图层。' }
  const layer = state.layers.find(item => item.id === selectedIds[0])
  if (!layer || (expectedLayerId !== undefined && layer.id !== expectedLayerId) || layer.imageKey !== key || layer.type !== 'image') {
    return { error: '当前唯一选中图层未引用此图片，请重新选择目标图层。' }
  }
  if (layer.locked) return { error: '当前图层已锁定，请先解锁再进行单层替换。' }
  const original = !layer.isNew && layer.editableIndex !== undefined ? state.videoItem?.movie.sprites[layer.editableIndex] : undefined
  if (/\.(matte|vector)$/i.test(key) || original?.matteKey || layer.sprites?.matteKey ||
    getResourceUsages(key, state.layers, state.videoItem).some(usage => usage.matte) ||
    [original, layer.sprites].some(sprite => sprite?.frames.some(frame => frame.shapes?.length))) {
    return { error: '此图层参与遮罩或矢量绘制，暂不支持单层拆分；可选择所有引用图层，并检查遮罩效果。' }
  }
  if (!layer.isNew && (!Number.isInteger(layer.editableIndex) || !original)) return { error: '无法确定原始图层绑定，不能安全拆分资源。' }
  return { layer }
}

function fittedPng(dataUrl: string, width: number, height: number): Uint8Array {
  validateReplacementSize(width, height)
  if (typeof dataUrl !== 'string' || dataUrl.length > 48 * 1024 * 1024 || !/^data:image\/png;base64,[A-Za-z\d+/]+={0,2}$/.test(dataUrl)) {
    throw new Error('替换必须使用已完成预览且不超过 32 MiB 的静态 PNG。')
  }
  const binary = atob(dataUrl.slice('data:image/png;base64,'.length))
  if (binary.length > 32 * 1024 * 1024 || binary.length < 33) throw new Error('替换预览的 PNG 数据无效或过大。')
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452 ||
    view.getUint32(16) !== width || view.getUint32(20) !== height) throw new Error('替换预览尺寸与原资源不一致，请重新生成预览。')
  return bytes
}

function independentKey(state: ImageReplacementState, key: string): string {
  const occupied = new Set([
    ...state.imageResources.keys(), ...Object.keys(state.videoItem?.buffers || {}), ...Object.keys(state.videoItem?.movie.images || {}),
    ...Object.keys(state.slotConfigs), ...state.detectedSlots, ...state.layers.flatMap(layer => [layer.imageKey || '', layer.name]),
    ...(state.videoItem?.movie.sprites || []).flatMap(sprite => [sprite.imageKey, sprite.matteKey || ''])
  ])
  const base = `${key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'image'}_layer`
  let candidate = base
  for (let index = 2; occupied.has(candidate); index++) candidate = `${base}_${index}`
  return candidate
}

/** 所有校验在写入前完成；调用者用一次历史事务提交返回补丁，失败不修改工程。 */
export function planImageReplacement(
  state: ImageReplacementState,
  key: string,
  dataUrl: string,
  scope: ImageReplacementScope,
  layerId?: string | null,
  expectedTarget?: ReplacementTarget
): ImageReplacementPlan {
  try {
    if (scope !== 'current-layer' && scope !== 'all-references') throw new Error('请选择有效的替换范围。')
    if (expectedTarget && (expectedTarget.key !== key || !isReplacementTargetCurrent(expectedTarget, state))) throw new Error('原素材、插槽或引用图层已变化，请重新选择替换目标。')
    const resource = state.imageResources.get(key)
    const buffer = state.videoItem?.buffers[key]
    if (!resource && !buffer) throw new Error('原素材已不存在，不能应用替换。')
    const width = resource?.width || state.videoItem?.images[key]?.naturalWidth || 0
    const height = resource?.height || state.videoItem?.images[key]?.naturalHeight || 0
    fittedPng(dataUrl, width, height)
    const slot = Object.prototype.hasOwnProperty.call(state.slotConfigs, key) ? state.slotConfigs[key] : undefined
    const slotConfigs = Object.assign(Object.create(null), state.slotConfigs) as Record<string, SlotConfig>
    if (scope === 'all-references') {
      slotConfigs[key] = mergeSlotImageConfig(slot, key, dataUrl, 'stretch')
      return { changed: true, key, layerIds: getResourceUsages(key, state.layers, state.videoItem).map(usage => usage.id), patch: { slotConfigs, isDirty: true } }
    }
    const current = getCurrentReplacementLayer(state, key, layerId)
    if (!current.layer) throw new Error(current.error)
    const sourceData = resource?.data.byteLength ? resource.data : buffer ? new Uint8Array(buffer) : state.videoItem?.movie.images[key]
    if (!sourceData?.length) throw new Error('原图片字节缺失，不能创建可恢复的独立资源。')
    const data = new Uint8Array(sourceData)
    const mimeType = detectImageMime(data, resource?.mimeType) as ImageResource['mimeType']
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) throw new Error('原图片格式不支持独立资源，请先转成 PNG、JPEG 或 WebP。')
    const nextKey = independentKey(state, key)
    const imageResources = new Map(state.imageResources)
    // 保留原图字节，恢复原图只影响这个独立 Key；拟合结果仍与共享换图沿用同一插槽路径。
    imageResources.set(nextKey, { key: nextKey, data, width, height, mimeType, isNew: true })
    slotConfigs[nextKey] = mergeSlotImageConfig(slot, nextKey, dataUrl, 'stretch')
    const layers = state.layers.map(layer => layer.id === current.layer!.id ? { ...layer, imageKey: nextKey, resourceDetached: true } : layer)
    const hasRemainingReferences = getResourceUsages(key, layers, state.videoItem).length > 0
    // 最后一个引用转移后，文字插槽必须随层迁移，不能留下无法导出的孤立文字容器。
    if (!hasRemainingReferences) delete slotConfigs[key]
    const detectedSlots = state.detectedSlots.includes(key)
      ? [...state.detectedSlots.filter(item => hasRemainingReferences || item !== key), nextKey]
      : state.detectedSlots
    return { changed: true, key: nextKey, layerIds: [current.layer.id], patch: { layers, imageResources, slotConfigs, detectedSlots, isDirty: true } }
  } catch (error) {
    return { changed: false, error: error instanceof Error ? error.message : String(error) }
  }
}
