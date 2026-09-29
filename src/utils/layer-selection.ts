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

/** 范围选择只覆盖当前列表中的行，筛选隐藏的图层不会被悄悄加入。 */
export function selectLayerInList(order: readonly string[], selected: readonly string[], target: string,
  anchor: string | null, range: boolean, toggle: boolean): { ids: string[]; anchor: string | null } {
  if (!order.includes(target)) return { ids: [...selected], anchor }
  if (range && anchor && order.includes(anchor)) {
    const a = order.indexOf(anchor), b = order.indexOf(target)
    const slice = order.slice(Math.min(a, b), Math.max(a, b) + 1)
    const ids = toggle ? [...new Set([...selected, ...slice])] : [...slice]
    return { ids: [...ids.filter(id => id !== target), target], anchor }
  }
  return { ids: toggle ? selected.includes(target) ? selected.filter(id => id !== target) : [...selected, target] : [target], anchor: target }
}
