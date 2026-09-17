import type { Layer, VideoItem } from '@/types'

/** 以当前图层为准，保留隐藏和锁定图层，并把遮罩引用单独标记。 */
export function getResourceUsages(key: string, layers: Layer[], videoItem: VideoItem | null) {
  return buildResourceUsageIndex(layers, videoItem).get(key) || []
}

export interface ResourceUsage {
  id: string
  name: string
  image: boolean
  matte: boolean
  visible: boolean
  locked: boolean
}

/** 一次遍历建立引用索引，避免素材列表逐张扫描全部图层。 */
export function buildResourceUsageIndex(layers: Layer[], videoItem: VideoItem | null): Map<string, ResourceUsage[]> {
  const index = new Map<string, ResourceUsage[]>()
  for (const layer of layers) {
    const original = !layer.isNew && layer.editableIndex !== undefined
      ? videoItem?.movie.sprites[layer.editableIndex]
      : undefined
    const imageKey = layer.imageKey ?? layer.sprites?.imageKey
    const matteKey = original?.matteKey ?? layer.sprites?.matteKey
    for (const key of new Set([imageKey, matteKey])) {
      if (!key) continue
      const usage = { id: layer.id, name: layer.name, image: imageKey === key, matte: matteKey === key, visible: layer.visible, locked: layer.locked }
      const usages = index.get(key)
      if (usages) usages.push(usage)
      else index.set(key, [usage])
    }
  }
  return index
}

export function describeResourceScope(key: string, layers: Layer[], videoItem: VideoItem | null) {
  const usages = getResourceUsages(key, layers, videoItem)
  const matteCount = usages.filter(usage => usage.matte).length
  return usages.length
    ? `作用范围：引用此资源的全部 ${usages.length} 个图层${matteCount ? `（含 ${matteCount} 个遮罩引用）` : ''}，不是仅修改选中图层。隐藏和锁定图层也包含在内。`
    : '作用范围：此资源当前没有图层引用，不会新增图层。'
}
