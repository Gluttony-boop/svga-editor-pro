export type ResourceSort = 'original' | 'name' | 'size-desc' | 'size-asc' | 'memory-desc'

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
  if (sort === 'memory-desc') result.sort((a, b) => (resourceDecodedBytes(b) ?? -1) - (resourceDecodedBytes(a) ?? -1))
  return result
}

export function resourceDecodedBytes(resource: ResourceMetadata): number | null {
  const { width, height } = resource
  return width && height && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? width * height * 4 : null
}

export function summarizeResources(resources: readonly ResourceMetadata[]) {
  return resources.reduce((stats, resource) => {
    stats.encodedBytes += resource.byteSize
    const decodedBytes = resourceDecodedBytes(resource)
    if (decodedBytes !== null) {
      stats.decodedBytes += decodedBytes
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
