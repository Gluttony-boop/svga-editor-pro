import type { MovieParams, VideoItem } from '@/types'
import type { ProjectDocument } from '@/types/project'
import type { DeliveryBundleResult, DeliveryOptions } from '@/types/delivery'
import { SVGAValidator } from '@/utils/svga-validator'
import { getCanvasSizeError } from './canvas-size'
import { createDeliveryArchive, normalizeDeliveryOptions } from './delivery-archive'
import { generateExportPreview } from './export-preview'
import { hydrateProjectDocument } from './project-hydration'
import { buildProjectSvga } from './project-export'
import { assertDeliveryActive, prepareDeliverySnapshot } from './project-revision'
import { MAX_PROJECT_BYTES } from './project-validation'
import { SVGAParser } from './parser'
import { CanvasRenderer, type RenderOptions } from './renderer'

export interface DeliveryJob {
  signal?: AbortSignal
  onPhase?: (message: string) => void
}

const MAX_DELIVERY_FRAME_RECORDS = 2_000_000

async function renderPreview(video: VideoItem, params: MovieParams, frame: number, options: RenderOptions, signal?: AbortSignal): Promise<Blob> {
  assertDeliveryActive(signal)
  const canvas = document.createElement('canvas')
  canvas.width = params.viewBoxWidth
  canvas.height = params.viewBoxHeight
  let renderer: CanvasRenderer | undefined
  try {
    renderer = new CanvasRenderer(canvas)
    renderer.setVideoItem({ ...video, movie: { ...video.movie, params } })
    await renderer.renderFrameAsync(frame, { ...options, useFrameCache: false, shouldRender: () => !signal?.aborted })
    assertDeliveryActive(signal)
    const preview = await renderer.exportFrame('image/png')
    assertDeliveryActive(signal)
    if (!preview.size || preview.type !== 'image/png') throw new Error('交付预览未能生成有效 PNG，未创建交付包。')
    return preview
  } finally {
    renderer?.destroy()
    canvas.width = 0
    canvas.height = 0
  }
}

/** 只消费一次工程快照；所有网络素材已由工程归档拒绝，不触碰全局编辑状态。 */
export async function generateDeliveryBundle(document: ProjectDocument, options: DeliveryOptions, job: DeliveryJob = {}): Promise<DeliveryBundleResult> {
  const phase = (message: string) => {
    assertDeliveryActive(job.signal)
    job.onPhase?.(message)
    assertDeliveryActive(job.signal)
  }
  assertDeliveryActive(job.signal)
  const normalized = normalizeDeliveryOptions(options)
  phase('正在冻结工程内容与本机素材…')
  const snapshot = await prepareDeliverySnapshot(document, job.signal)
  const source = snapshot.document
  const params = { ...source.params, fps: source.customFps ?? source.params.fps, frames: source.customFrames ?? source.params.frames }
  const canvasError = getCanvasSizeError({ width: params.viewBoxWidth, height: params.viewBoxHeight })
  if (canvasError) throw new Error(canvasError)
  if (!Number.isFinite(params.fps) || params.fps <= 0 || !Number.isSafeInteger(params.frames) || params.frames < 1) throw new Error('交付帧率或帧数无效。')
  if (!Number.isSafeInteger(source.currentFrame) || source.currentFrame < 0 || source.currentFrame >= params.frames) throw new Error('请先将播放头移动到有效帧，再生成交付预览。')
  const spriteCount = Math.max(source.layers.length, source.videoItem.movie.sprites?.length ?? 0)
  if (params.frames * spriteCount > MAX_DELIVERY_FRAME_RECORDS) throw new Error('交付任务展开后超过 200 万条逐帧记录，请减少图层或帧数后重试。')
  let preparedSource: Awaited<ReturnType<typeof hydrateProjectDocument>> | undefined
  let preparedOutput: Awaited<ReturnType<typeof hydrateProjectDocument>> | undefined
  try {
    phase('正在准备任务专属素材…')
    preparedSource = await hydrateProjectDocument(source, job.signal)
    phase('正在生成包含当前编辑的 SVGA 与图层来源…')
    const artifact = await buildProjectSvga(preparedSource.document, { signal: job.signal })
    if (!artifact.blob.size || artifact.blob.size > MAX_PROJECT_BYTES) throw new Error('交付 SVGA 为空或超过 128 MiB。')
    phase(`正在生成设计模拟图（第 ${source.currentFrame + 1} 帧）…`)
    const designPreview = await renderPreview(preparedSource.document.videoItem, params, source.currentFrame, {
      layers: preparedSource.document.layers, imageResources: preparedSource.document.imageResources,
      slotConfigs: preparedSource.document.slotConfigs, applySlots: true
    }, job.signal)
    preparedSource.dispose()
    preparedSource = undefined

    // 两个相同占位图仍可能分别承载昵称/头像；专业交付优先保留每个 Key 的独立接入能力。
    const optimization = structuredClone(source.optimizationConfig)
    const warnings: string[] = []
    if (optimization.image.deduplicate) warnings.push('为保留独立动态 Key，本次交付未执行跨 Key 图片去重；未修改工程中的优化设置。')
    optimization.image.deduplicate = false
    const preview = await generateExportPreview(() => Promise.resolve(artifact.blob), optimization,
      source.originalBuffer.byteLength, params, phase)
    if (preview.optimized.size > MAX_PROJECT_BYTES) throw new Error('优化后的交付 SVGA 超过 128 MiB，未生成交付包。')
    phase('正在校验并回读真正交付的 SVGA…')
    const bytes = await preview.optimized.arrayBuffer()
    const validation = await new SVGAValidator().validate(bytes)
    if (!validation.isValid || !validation.info.params) throw new Error('交付 SVGA 结构校验失败：' + validation.errors.join('；'))
    const actual = await new SVGAParser().parse(bytes, { decodeImages: false })
    const actualParams = actual.movie.params
    if (!actualParams || Object.keys(params).some(key => actualParams[key as keyof MovieParams] !== params[key as keyof MovieParams])) {
      throw new Error('实际导出的画布、帧率或帧数与工程快照不一致，未生成交付包。')
    }
    const sprites = actual.movie.sprites || []
    if (artifact.bindings.length !== sprites.length || artifact.bindings.some((binding, index) =>
      binding.spriteIndex !== index || binding.baselineImageKey !== (sprites[index].imageKey || null))) {
      throw new Error('实际导出 Key 或图层顺序无法与编码来源一致核对，未生成交付包。')
    }
    phase('正在顺序解码实际交付素材并检查像素上限…')
    // 回读图像另受工程解码预算约束，不向截图重新传入编辑图层或文字，防止重复烘焙。
    preparedOutput = await hydrateProjectDocument({
      ...source, videoItem: actual, params: actualParams, layers: [],
      imageResources: new Map(), audioResources: new Map(), slotConfigs: {}, detectedSlots: []
    }, job.signal)
    phase(`正在生成实际产物图（第 ${source.currentFrame + 1} 帧，无二次文字叠加）…`)
    const actualPreview = await renderPreview(preparedOutput.document.videoItem, actualParams, source.currentFrame, { applySlots: false }, job.signal)
    phase('正在打包清单、素材、检查报告和校验值…')
    const result = await createDeliveryArchive({
      document: source, options: normalized, sourceRevision: snapshot.sourceRevision,
      animation: preview.optimized, output: preparedOutput.document.videoItem, bindings: artifact.bindings,
      actualPreview, designPreview, ...(normalized.includeProject ? { projectArchive: snapshot.archive } : {}),
      optimization, warnings: [...warnings, ...preview.warnings], validation
    }, { signal: job.signal, onPhase: phase })
    assertDeliveryActive(job.signal)
    return result
  } finally {
    preparedSource?.dispose()
    preparedOutput?.dispose()
  }
}
