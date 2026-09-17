import type { SlotConfig } from '@/types'
import { resourceDecodedBytes, summarizeResources, type ResourceMetadata } from './resource-catalog'
import type { ResourceUsage } from './resource-usage'

export const RESOURCE_FILTERS = [
  { id: 'all', label: '全部' }, { id: 'shared', label: '共享' }, { id: 'matte', label: '遮罩' },
  { id: 'unused', label: '未引用' }, { id: 'replaced', label: '已配置' }, { id: 'heavy', label: '高内存' }
] as const
export type ResourceFilter = typeof RESOURCE_FILTERS[number]['id']
// 此阈值仅用于定位值得检查的源图，不代表任何平台的硬性限制。
export const HEAVY_RESOURCE_BYTES = 4 * 1024 * 1024

export function auditResources<T extends ResourceMetadata>(resources: readonly T[], usageIndex: Map<string, ResourceUsage[]>, slots: Record<string, SlotConfig>) {
  const rows = resources.map(resource => {
    const usages = usageIndex.get(resource.key) || []
    const decodedBytes = resourceDecodedBytes(resource)
    const tags: ResourceFilter[] = ['all']
    if (usages.length > 1) tags.push('shared')
    if (usages.some(usage => usage.matte)) tags.push('matte')
    if (!usages.length) tags.push('unused')
    if (Object.prototype.hasOwnProperty.call(slots, resource.key) && slots[resource.key]) tags.push('replaced')
    if (decodedBytes !== null && decodedBytes >= HEAVY_RESOURCE_BYTES) tags.push('heavy')
    return { ...resource, usages, decodedBytes, tags }
  })
  const known = new Set(resources.map(resource => resource.key))
  const missing = [...usageIndex].filter(([key, usages]) => !known.has(key) && usages.length > 0)
    .map(([key, usages]) => ({ key, usages }))
  const counts = Object.fromEntries(RESOURCE_FILTERS.map(({ id }) => [id, rows.filter(row => row.tags.includes(id)).length])) as Record<ResourceFilter, number>
  return { rows, counts, missing, stats: summarizeResources(resources) }
}

export function resourceAdvice(tags: readonly ResourceFilter[], decodedBytes: number | null): string[] {
  const advice: string[] = []
  if (tags.includes('matte')) advice.push('遮罩关联：替换可能改变其他图层的可见区域，请逐帧检查遮挡边缘。')
  if (tags.includes('shared')) advice.push('共享资源：一次换图会影响多个图层，先检查引用列表。')
  if (tags.includes('unused')) advice.push('当前编辑图层未引用：可作为整理候选，不代表可直接删除；仍需核对外部动态插槽约定。')
  if (tags.includes('heavy')) advice.push('源图解码估算达到 4 MiB：建议评估导出降采样，保持画布和动画坐标不变；此阈值不是平台限制。')
  if (tags.includes('replaced')) advice.push('已配置素材替换：统计仍基于源资源；以导出预览检查最终画面和文件体积。')
  if (decodedBytes === null) advice.push('源图尺寸未知，未计入解码内存估算；不要把未知视为零占用。')
  return advice
}

/** 仅输出报告字段，避免把目录项上的图片字节、URL 或本地路径一并序列化。 */
export function createResourceAuditReport(audit: ReturnType<typeof auditResources>, generatedAt = new Date().toISOString()) {
  return {
    schemaVersion: 1, generatedAt,
    scope: '当前编辑的源图片资源；不含替换图像字节、音频和 GPU/帧缓存内存。未引用不等于可安全删除。',
    heavyThresholdBytes: HEAVY_RESOURCE_BYTES, counts: { ...audit.counts }, stats: { ...audit.stats },
    missingReferences: audit.missing.map(({ key, usages }) => ({ key, usages: usages.map(usage => ({ ...usage })) })),
    resources: audit.rows.map(({ key, width, height, byteSize, decodedBytes, tags, usages }) => ({
      key, width, height, byteSize, decodedBytes, tags: [...tags], usages: usages.map(usage => ({ ...usage }))
    }))
  }
}
