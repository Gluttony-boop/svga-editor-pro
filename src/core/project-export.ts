import type { ProjectDocument } from '@/types/project'
import type { ExportSpriteBinding, ProjectSvgaArtifact } from '@/types/export-artifact'
import { ExportEngine } from './exporter'
import { throwIfExportAborted } from './export-provenance'
import { SVGABuilder } from './svga-builder'

/** 与交互导出保持同一分流规则；不能重建整个 Movie 而丢掉源动画与音频。 */
export function requiresSvgaMerge(document: ProjectDocument): boolean {
  const { layers, imageResources, videoItem } = document
  const originalLayerCount = videoItem.movie.sprites?.length ?? 0
  const activeOriginalLayerCount = layers.filter(layer => !layer.isNew && layer.editableIndex !== undefined).length
  const hasDeletedOriginalLayers = activeOriginalLayerCount < originalLayerCount
  const hasNewLayers = layers.some(layer => layer.isNew)
  const hasNewImages = Array.from(imageResources.values()).some(resource => resource.isNew)
  const hasAnimations = layers.some(layer =>
    [...Object.values(layer.tracks), ...Object.values(layer.animationTracks || {})].some(track => track.keyframes.length > 0)
  )
  const hasLayerNameChanges = layers.some(layer => {
    const nextName = layer.name.trim()
    return layer.imageKey && nextName.length > 0 && nextName !== layer.imageKey
  })
  return hasDeletedOriginalLayers || hasNewLayers || hasNewImages || hasAnimations || hasLayerNameChanges
}

/** 只读取捕获好的工程快照；不依赖 store、全局构建器或旧压缩配置。 */
export async function buildProjectSvga(
  document: ProjectDocument,
  options: { signal?: AbortSignal } = {}
): Promise<ProjectSvgaArtifact> {
  throwIfExportAborted(options.signal)
  if (!document.originalBuffer.byteLength) throw new Error('没有原始 SVGA 数据')
  const params = { ...document.params, fps: document.customFps ?? document.params.fps, frames: document.customFrames ?? document.params.frames }
  let bindings: ExportSpriteBinding[] | undefined
  const trace = { signal: options.signal, onBindings: (value: ExportSpriteBinding[]) => { bindings = value } }
  let blob: Blob
  if (requiresSvgaMerge(document)) {
    const imageSizes = new Map<string, { width: number; height: number }>()
    document.imageResources.forEach((resource, key) => {
      if (resource.width > 0 && resource.height > 0) imageSizes.set(key, { width: resource.width, height: resource.height })
    })
    blob = await new SVGABuilder().mergeWithOriginal(document.originalBuffer, {
      params, layers: document.layers, imageResources: document.imageResources,
      slotConfigs: document.slotConfigs, imageSizes, ...trace
    })
  } else {
    const canvas = globalThis.document.createElement('canvas')
    let engine: ExportEngine | undefined
    try {
      canvas.width = params.viewBoxWidth
      canvas.height = params.viewBoxHeight
      engine = new ExportEngine(canvas)
      engine.setVideoItem(document.videoItem)
      blob = await engine.exportSVGALite(document.originalBuffer, {
        ...params, layers: document.layers, slotConfigs: document.slotConfigs,
        compression: { ...document.compressionConfig, enabled: false }, ...trace
      })
    } finally {
      engine?.destroy()
      canvas.width = 0
      canvas.height = 0
    }
  }
  throwIfExportAborted(options.signal)
  if (!bindings) throw new Error('未生成可验证的导出图层来源，已取消导出')
  return { blob, bindings }
}
