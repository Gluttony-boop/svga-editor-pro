import type { Layer } from '@/types'

export type LayerFilter = 'all' | 'visible' | 'hidden' | 'locked' | 'unlocked'

type SearchableLayer = Pick<Layer, 'name' | 'imageKey' | 'visible' | 'locked'>

/** Keep source indices so filtering never changes layer numbering or edit targets. */
export function filterLayers<T extends SearchableLayer>(
  layers: readonly T[],
  query: string,
  filter: LayerFilter
): { layer: T; index: number }[] {
  const keyword = query.trim().toLocaleLowerCase()
  return layers.flatMap((layer, index) => {
    const matchesName = !keyword || [layer.name, layer.imageKey ?? '']
      .some((value) => value.toLocaleLowerCase().includes(keyword))
    const matchesStatus = filter === 'all'
      || (filter === 'visible' && layer.visible)
      || (filter === 'hidden' && !layer.visible)
      || (filter === 'locked' && layer.locked)
      || (filter === 'unlocked' && !layer.locked)
    return matchesName && matchesStatus ? [{ layer, index }] : []
  })
}
