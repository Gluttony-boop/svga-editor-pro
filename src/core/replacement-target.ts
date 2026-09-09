import type { useEditorStore } from '@/stores'

type ResourceState = Pick<ReturnType<typeof useEditorStore.getState>, 'videoItem' | 'originalBuffer' | 'imageResources' | 'slotConfigs'>

export function captureReplacementTarget(state: ResourceState, key: string) {
  return { key, videoItem: state.videoItem, originalBuffer: state.originalBuffer,
    resource: state.imageResources.get(key), buffer: state.videoItem?.buffers?.[key], slot: state.slotConfigs[key] }
}

export function isReplacementTargetCurrent(target: ReturnType<typeof captureReplacementTarget>, state: ResourceState): boolean {
  const current = captureReplacementTarget(state, target.key)
  return Boolean(current.resource || current.buffer)
    && current.videoItem === target.videoItem && current.originalBuffer === target.originalBuffer
    && current.resource === target.resource && current.buffer === target.buffer && current.slot === target.slot
}
