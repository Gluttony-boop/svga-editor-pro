import type { Layer } from '@/types'

interface SelectionState {
  layers: readonly Pick<Layer, 'id'>[]
  selectedLayerId: string | null
  selectedLayerIds: readonly string[]
}

/** 兼容仍仅写入主选中项的调用方，并剔除已删除的图层。 */
export function getSelectedLayerIds(state: SelectionState): string[] {
  if (!state.selectedLayerId) return []
  const available = new Set(state.layers.map(layer => layer.id))
  const ids = state.selectedLayerIds.includes(state.selectedLayerId) ? state.selectedLayerIds : [state.selectedLayerId]
  return [...new Set(ids)].filter(id => available.has(id))
}

export function selectionForLayers(ids: readonly string[], layers: readonly Pick<Layer, 'id'>[]) {
  const available = new Set(layers.map(layer => layer.id))
  const selectedLayerIds = [...new Set(ids)].filter(id => available.has(id))
  return { selectedLayerIds, selectedLayerId: selectedLayerIds.at(-1) ?? null }
}
