export type ResourceSort = 'original' | 'name' | 'size-desc' | 'size-asc'

export interface ResourceMetadata {
  key: string
  byteSize: number
  width?: number
  height?: number
}

export function selectResources<T extends ResourceMetadata>(resources: readonly T[], query: string, sort: ResourceSort): T[] {
  const keyword = query.trim().toLocaleLowerCase()
  const result = resources.filter((resource) => resource.key.toLocaleLowerCase().includes(keyword))
  if (sort === 'name') result.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }))
  if (sort === 'size-desc') result.sort((a, b) => b.byteSize - a.byteSize)
  if (sort === 'size-asc') result.sort((a, b) => a.byteSize - b.byteSize)
  return result
}

export function summarizeResources(resources: readonly ResourceMetadata[]) {
  return resources.reduce((stats, resource) => {
    stats.encodedBytes += resource.byteSize
    if (resource.width && resource.height && resource.width > 0 && resource.height > 0) {
      stats.decodedBytes += resource.width * resource.height * 4
    } else {
      stats.unknownDimensions += 1
    }
    return stats
  }, { encodedBytes: 0, decodedBytes: 0, unknownDimensions: 0 })
}

export function formatResourceBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}
