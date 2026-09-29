import type { ImageResource, Layer, SlotConfig, VideoItem } from '@/types'
import { getResourceUsages } from '@/utils/resource-usage'

export interface ReplacementResourceState {
  videoItem: VideoItem | null
  originalBuffer: ArrayBuffer | null
  imageResources: Map<string, ImageResource>
  slotConfigs: Record<string, SlotConfig>
  layers: Layer[]
}

export function captureReplacementTarget(state: ReplacementResourceState, key: string) {
  const referenced = new Set(getResourceUsages(key, state.layers, state.videoItem).map(usage => usage.id))
  return { key, videoItem: state.videoItem, originalBuffer: state.originalBuffer,
    resource: state.imageResources.get(key), buffer: state.videoItem?.buffers?.[key], slot: state.slotConfigs[key],
    layers: state.layers.filter(layer => referenced.has(layer.id)) }
}

export type ReplacementTarget = ReturnType<typeof captureReplacementTarget>

export function isReplacementTargetCurrent(target: ReplacementTarget, state: ReplacementResourceState): boolean {
  const current = captureReplacementTarget(state, target.key)
  return Boolean(current.resource || current.buffer)
    && current.videoItem === target.videoItem && current.originalBuffer === target.originalBuffer
    && current.resource === target.resource && current.buffer === target.buffer && current.slot === target.slot
    // 确认预览看到的影响范围没有悄悄扩大，也不能把旧预览应用到已经改过的图层。
    && current.layers.length === target.layers.length && current.layers.every((layer, index) => layer === target.layers[index])
}
