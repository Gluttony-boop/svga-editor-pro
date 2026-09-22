import JSZip from 'jszip'
import type { ProjectDocument } from '@/types/project'
import { createProjectArchive, readProjectArchive } from './project-archive'
import { validateProjectManifest, type ProjectManifest } from './project-validation'
import { sha256Bytes } from './content-hash'

export function assertDeliveryActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('已取消交付包生成。', 'AbortError')
}

/** 不用 localeCompare，避免同一工程在不同系统语言下产生不同字典顺序。 */
const compareKey = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (!value || typeof value !== 'object') throw new Error('工程修订包含不可序列化的内容。')
  const object = value as Record<string, unknown>
  return '{' + Object.keys(object).sort(compareKey).map(key => JSON.stringify(key) + ':' + canonicalJson(object[key])).join(',') + '}'
}

async function manifestRevision(manifest: ProjectManifest): Promise<string> {
  validateProjectManifest(manifest)
  const assets = new Map(manifest.assets.map(asset => [asset.path, asset]))
  const document = structuredClone(manifest.document)
  // 这些仅影响会话视图或磁盘文件显示名称，不改变交付内容；图层名字会改输出 Key，必须保留。
  const projection = document as unknown as Record<string, unknown>
  for (const field of ['name', 'currentFrame', 'selectedLayerId', 'selectedLayerIds']) delete projection[field]
  for (const layer of document.layers) delete layer.expanded
  document.videoItem.buffers.sort((a, b) => compareKey(a.key, b.key))
  document.imageResources.sort((a, b) => compareKey(a.key as string, b.key as string))
  document.audioResources.sort((a, b) => compareKey(a.key as string, b.key as string))
  document.slotConfigs.sort((a, b) => compareKey(a.key, b.key))
  document.detectedSlots.sort(compareKey)

  const content = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(content)
    if (!value || typeof value !== 'object') return value
    const object = value as Record<string, unknown>
    if (Object.keys(object).length === 1 && typeof object.asset === 'string') {
      const asset = assets.get(object.asset)
      if (!asset) throw new Error('工程修订包含无法定位的素材。')
      // 引用资产内容，不引用随字典插入顺序变化的 assets/00001.bin 编号。
      return { sha256: asset.sha256, size: asset.size }
    }
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, content(item)]))
  }
  return sha256Bytes(new TextEncoder().encode(canonicalJson({ revisionSchema: 1, document: content(document) })))
}

/**
 * 先用现有工程格式物化本机素材，再建立任务专属数据，避免异步交付依赖已撤销的 Blob URL。
 * 仅对本函数刚生成并校验的 ZIP 读取清单；不是另一个不受限的工程导入入口。
 */
export async function prepareDeliverySnapshot(document: ProjectDocument, signal?: AbortSignal): Promise<{
  document: ProjectDocument
  archive: Blob
  sourceRevision: string
}> {
  assertDeliveryActive(signal)
  const archive = await createProjectArchive(document, { signal })
  assertDeliveryActive(signal)
  const bytes = await archive.arrayBuffer()
  const restored = await readProjectArchive(bytes)
  assertDeliveryActive(signal)
  const zip = await JSZip.loadAsync(bytes)
  const entry = zip.file('manifest.json')
  if (!entry) throw new Error('本次工程快照缺少清单，未生成交付包。')
  const manifest = JSON.parse(await entry.async('string')) as ProjectManifest
  const sourceRevision = await manifestRevision(manifest)
  assertDeliveryActive(signal)
  return { document: restored, archive, sourceRevision }
}
