import React from 'react'
import { Panel, Button, Icon, Slider, Select } from '@/components/ui'
import { useEditorStore, useCanExport, useCurrentParams } from '@/stores'
import { ExportEngine, saveGeneratedFile, createSaveFileTarget, svgaBuilder, OPTIMIZATION_PRESETS } from '@/core'
import { captureExportInputs, sameExportInputs, generateExportPreview, ExportInputsChangedError, type ExportPreviewResult } from '@/core/export-preview'
import { ExportPreviewDialog } from '@/components/editor/ExportPreviewDialog'
import { DeliveryPackageDialog } from '@/components/editor/DeliveryPackageDialog'
import { cn } from '@/utils/cn'
import { SVGAValidator } from '@/utils/svga-validator'
import { OperationStatus, type OperationStatusValue } from '@/components/ui/OperationStatus'
import { hasTextPreview } from '@/core/text-preview'
import { ImageResizeControls } from './ImageResizeControls'
import { ExportSizeBudget } from './ExportSizeBudget'

interface ExportPanelProps {
  className?: string
  collapsible?: boolean
  defaultCollapsed?: boolean
  onBusyChange?: (busy: boolean) => void
}

export const ExportPanel: React.FC<ExportPanelProps> = ({ className, collapsible = true, defaultCollapsed = false, onBusyChange }) => {
  const canExport = useCanExport()
  const videoItem = useEditorStore((s) => s.videoItem)
  const originalBuffer = useEditorStore((s) => s.originalBuffer)
  const compressionConfig = useEditorStore((s) => s.compressionConfig)
  const slotConfigs = useEditorStore((s) => s.slotConfigs)
  const layers = useEditorStore((s) => s.layers)
  const imageResources = useEditorStore((s) => s.imageResources)
  useEditorStore((s) => s.audioResources)
  const currentFrame = useEditorStore((s) => s.playback.currentFrame)
  const params = useCurrentParams()
  
  // 优化相关状态
  const optimizationConfig = useEditorStore((s) => s.optimizationConfig)
  const specifiedSizeEnabled = optimizationConfig.image.sizeLimitEnabled
    ?? (optimizationConfig.image.resizeEnabled && (optimizationConfig.image.maxWidth > 0 || optimizationConfig.image.maxHeight > 0))
  const selectedPresetId = useEditorStore((s) => s.selectedPresetId)
  const optimizationStats = useEditorStore((s) => s.optimizationStats)
  const setOptimizationConfig = useEditorStore((s) => s.setOptimizationConfig)
  const setSelectedPresetId = useEditorStore((s) => s.setSelectedPresetId)
  const setOptimizationStats = useEditorStore((s) => s.setOptimizationStats)

  const [isExporting, setIsExporting] = React.useState(false)
  const [exportStatus, setExportStatus] = React.useState<OperationStatusValue | null>(null)
  const [showAdvanced, setShowAdvanced] = React.useState(false)
  const [showOtherFormats, setShowOtherFormats] = React.useState(false)
  const [showMoreExports, setShowMoreExports] = React.useState(false)
  const [preview, setPreview] = React.useState<{ inputs: readonly unknown[]; result: ExportPreviewResult } | null>(null)
  const [showPreview, setShowPreview] = React.useState(false)
  const [showDelivery, setShowDelivery] = React.useState(false)
  const busyRef = React.useRef(false)
  const mountedRef = React.useRef(true)
  const previewIsCurrent = !!preview && sameExportInputs(preview.inputs, captureExportInputs(useEditorStore.getState()))

  React.useEffect(() => {
    const open = () => { if (useEditorStore.getState().videoItem && !busyRef.current) setShowDelivery(true) }
    window.addEventListener('svga-open-delivery', open)
    return () => window.removeEventListener('svga-open-delivery', open)
  }, [])

  React.useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  React.useEffect(() => { onBusyChange?.(isExporting); return () => onBusyChange?.(false) }, [isExporting, onBusyChange])

  React.useEffect(() => {
    setPreview(null)
    setShowPreview(false)
    setExportStatus(null)
    setOptimizationStats(null)
  }, [videoItem, originalBuffer, setOptimizationStats])

  React.useEffect(() => {
    if (preview && !previewIsCurrent) {
      setOptimizationStats(null)
      setExportStatus({ kind: 'stale', message: '编辑内容或导出配置已变化，请重新生成预览。' })
    }
  }, [preview, previewIsCurrent, setOptimizationStats])

  // 检查是否存在需要重建合并的编辑内容
  const hasNewContent = React.useMemo(() => {
    const originalLayerCount = videoItem?.movie.sprites?.length ?? 0
    const activeOriginalLayerCount = layers.filter(
      (layer) => !layer.isNew && layer.editableIndex !== undefined
    ).length
    const hasDeletedOriginalLayers = activeOriginalLayerCount < originalLayerCount
    const hasNewLayers = layers.some(l => l.isNew || l.resourceDetached)
    const hasNewImages = Array.from(imageResources.values()).some(r => r.isNew)
    const hasAnimations = layers.some(l =>
      [...Object.values(l.tracks), ...Object.values(l.animationTracks || {})].some(track => track.keyframes.length > 0)
    )
    const hasLayerNameChanges = layers.some(l => {
      const nextName = l.name.trim()
      return l.imageKey && nextName.length > 0 && nextName !== l.imageKey
    })
    return hasDeletedOriginalLayers || hasNewLayers || hasNewImages || hasAnimations || hasLayerNameChanges
  }, [videoItem, layers, imageResources])

  const buildSvgaBlob = async (exportCompression = compressionConfig): Promise<Blob> => {
    if (!videoItem || !params || !originalBuffer) {
      throw new Error('没有原始 SVGA 数据')
    }

    const canvas = document.createElement('canvas')
    canvas.width = params.viewBoxWidth
    canvas.height = params.viewBoxHeight
    const engine = new ExportEngine(canvas)
    engine.setVideoItem(videoItem)

    if (hasNewContent) {
      const imageSizes = new Map<string, { width: number; height: number }>()
      imageResources.forEach((resource, key) => {
        if (resource.width > 0 && resource.height > 0) {
          imageSizes.set(key, { width: resource.width, height: resource.height })
        }
      })

      const originalImages: Record<string, Uint8Array> = {}
      if (videoItem.buffers) {
        Object.entries(videoItem.buffers).forEach(([key, buffer]) => {
          originalImages[key] = new Uint8Array(buffer)
        })
      }

      return svgaBuilder.mergeWithOriginal(originalBuffer, {
        params,
        layers,
        imageResources,
        originalImages,
        slotConfigs,
        imageSizes
      })
    }

    return engine.exportSVGALite(originalBuffer, {
      viewBoxWidth: params.viewBoxWidth,
      viewBoxHeight: params.viewBoxHeight,
      fps: params.fps,
      frames: params.frames,
      compression: exportCompression,
      slotConfigs,
      layers
    })
  }

  // 当预设改变时更新配置
  const handlePresetChange = (presetId: string) => {
    setSelectedPresetId(presetId)
  }

  const preparePreview = async () => {
    useEditorStore.getState().endCanvasTransform(true)
    const inputs = captureExportInputs(useEditorStore.getState())
    if (preview && sameExportInputs(preview.inputs, inputs)) return preview
    if (!params || !originalBuffer) throw new Error('没有原始 SVGA 数据')
    const result = await generateExportPreview(
      () => buildSvgaBlob({ ...compressionConfig, enabled: false }),
      optimizationConfig,
      originalBuffer.byteLength,
      params,
      (phase) => {
        if (!mountedRef.current || !sameExportInputs(inputs, captureExportInputs(useEditorStore.getState()))) {
          throw new ExportInputsChangedError()
        }
        setExportStatus({ kind: 'processing', message: phase })
      }
    )
    setExportStatus({ kind: 'processing', message: '正在校验导出文件结构…' })
    const validation = await new SVGAValidator().validate(await result.optimized.arrayBuffer())
    const outputParams = validation.info.params
    if (!validation.isValid || !outputParams || !Object.values(outputParams).every(value => Number.isFinite(value) && value > 0)) {
      throw new Error(`导出校验失败：${validation.errors.join('；') || '动画参数无效'}`)
    }
    result.warnings.push(...validation.warnings)
    result.stats.warnings = [...new Set([...(result.stats.warnings ?? []), ...validation.warnings])]
    if (!mountedRef.current || !sameExportInputs(inputs, captureExportInputs(useEditorStore.getState()))) {
      throw new ExportInputsChangedError()
    }
    const prepared = { inputs, result }
    setPreview(prepared)
    setOptimizationStats(result.stats)
    return prepared
  }

  const savePreparedPreview = async (prepared: NonNullable<typeof preview>, kind: 'optimized' | 'baseline') => {
    if (!sameExportInputs(prepared.inputs, captureExportInputs(useEditorStore.getState()))) throw new ExportInputsChangedError()
    setExportStatus({ kind: 'processing', message: '请选择保存位置…' })
    const save = await createSaveFileTarget(kind === 'optimized' ? 'export.svga' : 'export-unoptimized.svga')
    if (!save) { setExportStatus({ kind: 'cancelled', message: '已取消保存，预览结果仍可使用' }); return }
    if (!mountedRef.current || !sameExportInputs(prepared.inputs, captureExportInputs(useEditorStore.getState()))) throw new ExportInputsChangedError()
    setExportStatus({ kind: 'processing', message: '正在保存预览中的文件…' })
    await save(prepared.result[kind])
    if (mountedRef.current) setExportStatus({ kind: 'success', message: '已保存预览中的文件' })
  }

  const runOptimizedAction = async (action: 'preview' | 'save') => {
    if (!videoItem || busyRef.current) return
    busyRef.current = true
    setIsExporting(true)
    try {
      const prepared = await preparePreview()
      if (action === 'preview') {
        useEditorStore.getState().setPlaying(false)
        setShowPreview(true)
        setExportStatus({ kind: 'ready', message: '预览文件已就绪；生成预览不会保存文件，点击保存将使用同一文件，不会再次压缩' })
      } else {
        await savePreparedPreview(prepared, 'optimized')
      }
    } catch (error) {
      if (mountedRef.current) setExportStatus(error instanceof ExportInputsChangedError
        ? { kind: 'stale', message: error.message }
        : { kind: 'error', message: `导出预览/保存失败: ${(error as Error).message}` })
    } finally {
      busyRef.current = false
      if (mountedRef.current) setIsExporting(false)
    }
  }

  const handleSavePreview = async (kind: 'optimized' | 'baseline') => {
    if (!preview || busyRef.current) return
    busyRef.current = true
    setIsExporting(true)
    try {
      await savePreparedPreview(preview, kind)
    } catch (error) {
      if (mountedRef.current) setExportStatus(error instanceof ExportInputsChangedError
        ? { kind: 'stale', message: error.message }
        : { kind: 'error', message: `保存失败: ${(error as Error).message}。预览结果仍保留，可重试保存。` })
    } finally {
      busyRef.current = false
      if (mountedRef.current) setIsExporting(false)
    }
  }

  const handleExport = async (format: 'svga' | 'png-sequence' | 'webp') => {
    if (!videoItem || !params || busyRef.current) return
    if (format === 'svga' && !originalBuffer) {
      setExportStatus({ kind: 'error', message: '导出失败: 没有原始数据' })
      return
    }

    const defaultName = format === 'png-sequence'
      ? 'frames.zip'
      : format === 'webp'
        ? 'frame.webp'
        : 'export.svga'

    busyRef.current = true
    setIsExporting(true)
    setExportStatus({ kind: 'processing', message: '正在生成导出文件…' })
    
    try {
      // 创建离屏 canvas
      const canvas = document.createElement('canvas')
      canvas.width = params.viewBoxWidth
      canvas.height = params.viewBoxHeight

      const engine = new ExportEngine(canvas)
      engine.setVideoItem(videoItem)

      let blob: Blob

      switch (format) {
        case 'svga':
          if (!originalBuffer) throw new Error('没有原始数据')

          blob = await buildSvgaBlob({ ...compressionConfig, enabled: false })
          break

        case 'png-sequence':
          blob = await engine.exportPNGSequence({ 
            scale: 1,
            slotConfigs,
            layers
          })
          break

        case 'webp':
          blob = await engine.exportWebP({ 
            quality: compressionConfig.enabled ? compressionConfig.quality : 90, 
            scale: 1,
            frameIndex: currentFrame,
            slotConfigs,
            layers
          })
          break

        default:
          throw new Error('不支持的格式')
      }

      setExportStatus({ kind: 'processing', message: '文件已生成，正在保存…' })
      const saved = await saveGeneratedFile(blob, defaultName)
      if (!saved) {
        setExportStatus({ kind: 'cancelled', message: '已取消导出' })
        return
      }

      setExportStatus({ kind: 'success', message: '导出成功' })
    } catch (error) {
      console.error('导出失败:', error)
      setExportStatus({ kind: 'error', message: `导出失败: ${(error as Error).message}` })
    } finally {
      busyRef.current = false
      setIsExporting(false)
    }
  }

  return (
    <>
    <Panel
      title="导出"
      icon={<Icon name="export" size={16} />}
      className={className}
      collapsible={collapsible}
      defaultCollapsed={defaultCollapsed}
    >
      <div className="space-y-3">
        <p className="rounded border border-border bg-bg-tertiary p-2 text-[11px] text-text-secondary">此处导出播放器产物；继续编辑请用顶部“保存工程”备份 .svgaproj。导出不会清除工程未保存标记。</p>
        {Object.values(slotConfigs).some(hasTextPreview) && <p role="status" className="rounded border border-warning/30 bg-warning/5 p-2 text-[11px] leading-relaxed text-warning">文字框扩展会写入 SVGA。文案仅在该 Key 选择“转图片写入 SVGA”时包含于文件及导出对比，成为不能动态改字的图片；其余文案仅模拟。PNG 序列 / WebP 包含当前预览文字。可编辑文案请另存 .svgaproj 工程。</p>}
        {/* 编辑内容提示 */}
        {hasNewContent && (
          <div className="text-xs bg-accent/10 text-accent px-2 py-1.5 rounded">
            <div className="flex items-center gap-1 mb-1">
              <Icon name="info" size={12} />
              <span className="font-medium">检测到编辑内容</span>
            </div>
            <ul className="text-text-muted ml-4 list-disc">
              {layers.filter(l => l.isNew).length > 0 && (
                <li>{layers.filter(l => l.isNew).length} 个新图层</li>
              )}
              {Array.from(imageResources.values()).filter(r => r.isNew).length > 0 && (
                <li>{Array.from(imageResources.values()).filter(r => r.isNew).length} 张新图片</li>
              )}
              {layers.filter(l => [...Object.values(l.tracks), ...Object.values(l.animationTracks || {})].some(t => t.keyframes.length > 0)).length > 0 && (
                <li>{layers.filter(l => [...Object.values(l.tracks), ...Object.values(l.animationTracks || {})].some(t => t.keyframes.length > 0)).length} 个图层有动画</li>
              )}
              {layers.filter(l => l.imageKey && l.name.trim() && l.name.trim() !== l.imageKey).length > 0 && (
                <li>{layers.filter(l => l.imageKey && l.name.trim() && l.name.trim() !== l.imageKey).length} 个图层已改名</li>
              )}
            </ul>
          </div>
        )}

        {/* 优化预设选择 */}
        <div className="space-y-2 rounded-xl border border-border bg-bg-primary/40 p-3">
          <label className="text-xs font-medium text-text-secondary">压缩方案</label>
          <Select
            value={selectedPresetId}
            onChange={handlePresetChange}
            options={OPTIMIZATION_PRESETS.map(p => ({
              value: p.id,
              label: p.name
            }))}
          />
          {(
            <p className="text-xs leading-relaxed text-text-muted">
              {OPTIMIZATION_PRESETS.find(p => p.id === selectedPresetId)?.description}
            </p>
          )}
          <ImageResizeControls
            image={optimizationConfig.image}
            canvasSize={params ? { width: params.viewBoxWidth, height: params.viewBoxHeight } : null}
            disabled={isExporting}
            onChange={image => setOptimizationConfig({ image })}
          />
        </div>

        <ExportSizeBudget actualBytes={preview?.result.optimized.size} stale={!!preview && !previewIsCurrent} disabled={isExporting} />

        {/* 主导出按钮 */}
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          disabled={!canExport || isExporting}
          loading={isExporting}
          onClick={() => runOptimizedAction('save')}
        >
          {!isExporting && <Icon name="export" size={18} />}
          导出 SVGA
        </Button>

        <Button variant="secondary" className="w-full" disabled={!canExport || isExporting} onClick={() => runOptimizedAction('preview')}>
          <Icon name="eye-open" size={16} />
          {previewIsCurrent ? '查看导出预览' : '生成导出预览'}
        </Button>
        {preview && !previewIsCurrent && <p className="text-xs text-warning">编辑或配置已变化，请重新生成导出预览。</p>}

        <div className="space-y-1.5 rounded-lg border border-accent/25 bg-accent/5 p-2">
          <Button variant="secondary" className="w-full" disabled={!canExport || isExporting} onClick={() => setShowDelivery(true)}>
            <Icon name="export" size={16} />
            专业交付包…
          </Button>
          <p className="px-1 text-[11px] leading-relaxed text-text-muted">SVGA + Key / 文字清单 + 预览 + 检查报告，一包交付开发团队。</p>
        </div>

        {/* 高级配置切换 */}
        <p className="text-[11px] text-text-muted">主导出使用此配置；未优化副本不压缩素材。预设不改变画布和动画坐标，手动精简帧数据需验证效果。</p>
        {optimizationConfig.enabled && <p className="text-xs text-text-secondary">当前：{optimizationConfig.image.format === 'webp' ? `WebP ${optimizationConfig.image.quality}%` : (optimizationConfig.image.pngColors ? `PNG ${optimizationConfig.image.pngColors} 色（有损）` : 'PNG 全彩')} · 图片分辨率 {optimizationConfig.image.resizeEnabled ? optimizationConfig.image.resizePercent : 100}%{specifiedSizeEnabled && (optimizationConfig.image.maxWidth > 0 || optimizationConfig.image.maxHeight > 0) ? ` · 最大 ${optimizationConfig.image.maxWidth || '不限'} × ${optimizationConfig.image.maxHeight || '不限'} px` : ''}{optimizationConfig.image.autoResizeToCanvas ? ' · 按当前画布自动缩图' : ''}</p>}
        {!!optimizationStats?.warnings?.length && <div role="status" className="space-y-1 text-xs text-warning">{optimizationStats.warnings.slice(0, 5).map((warning, index) => <p key={index}>{warning}</p>)}</div>}
        <button
          type="button"
          className="flex w-full items-center justify-between rounded border border-border/70 bg-bg-tertiary px-2 py-2 text-xs text-text-secondary hover:border-border-light hover:text-text-primary"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          <span className="flex items-center gap-1.5">
            <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} size={12} />
            高级配置
          </span>
          <span className="text-text-muted">{selectedPresetId === 'custom' ? '自定义' : '可选'}</span>
        </button>

        {/* 高级配置面板 */}
        {showAdvanced && (
          <div className="space-y-3 pl-2 border-l-2 border-border">
            {/* 图片优化 */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-text-primary">图片优化</label>
              
              <div className="flex items-center gap-2">
                <label className="text-xs text-text-muted w-16">格式</label>
                <Select
                  value={optimizationConfig.image.format}
                  onChange={(v) => setOptimizationConfig({
                    image: { ...optimizationConfig.image, format: v as 'webp' | 'png' | 'auto' }
                  })}
                  options={[
                    { value: 'auto', label: '自动' },
                    { value: 'webp', label: 'WebP' },
                    { value: 'png', label: 'PNG' }
                  ]}
                />
              </div>

              {optimizationConfig.image.format !== 'webp' && <div className="space-y-1">
                <label className="text-xs text-text-muted">PNG 色数（不是质量百分比）</label>
                <Select value={String(optimizationConfig.image.pngColors ?? 0)} onChange={value => setOptimizationConfig({ image: { ...optimizationConfig.image, pngColors: Number(value) as 0 | 64 | 128 | 256 } })} options={[
                  { value: '0', label: '全彩 · 不量化颜色' }, { value: '256', label: '256 色 · 均衡' }, { value: '128', label: '128 色 · 更小' }, { value: '64', label: '64 色 · 明显有损' }
                ]} />
                <p className="text-[10px] text-warning">量化包含透明度，辉光、渐变和边缘可能变化。更小才替换。</p>
              </div>}
              {optimizationConfig.image.format !== 'png' && <div className="flex items-center gap-2">
                <label className="text-xs text-text-muted w-16">WebP 质量</label>
                <div className="flex-1">
                  <Slider
                    value={optimizationConfig.image.quality}
                    onChange={(v) => setOptimizationConfig({
                      image: { ...optimizationConfig.image, quality: v }
                    })}
                    min={10}
                    max={100}
                    step={5}
                  />
                </div>
                <span className="text-xs text-text-muted w-8">{optimizationConfig.image.quality}%</span>
              </div>}

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={optimizationConfig.image.resizeEnabled}
                  onChange={(e) => setOptimizationConfig({
                    image: { ...optimizationConfig.image, resizeEnabled: e.target.checked }
                  })}
                  className="rounded"
                />
                <label className="text-xs text-text-muted">降低图片分辨率（不缩画布）</label>
                {optimizationConfig.image.resizeEnabled && (
                  <div className="flex items-center gap-1 ml-2">
                    <input
                      type="number"
                      value={optimizationConfig.image.resizePercent}
                      onChange={(e) => setOptimizationConfig({
                        image: { ...optimizationConfig.image, resizePercent: Math.max(10, Math.min(100, parseInt(e.target.value) || 100)) }
                      })}
                      className="w-14 px-1 py-0.5 text-xs bg-bg-primary border border-border rounded"
                      min={10}
                      max={100}
                    />
                    <span className="text-xs text-text-muted">%</span>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={optimizationConfig.image.deduplicate}
                  onChange={(e) => setOptimizationConfig({
                    image: { ...optimizationConfig.image, deduplicate: e.target.checked }
                  })}
                  className="rounded"
                />
                <label className="text-xs text-text-muted">去重相同图片（会合并 Key，遮罩除外）</label>
              </div>
            </div>

            {/* 帧数据优化 */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-text-primary">帧数据优化</label>
              <p className="text-[10px] text-warning">以下选项可能改变动画细节，所有预设默认关闭精简并保持高精度。</p>
              
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={optimizationConfig.frames.simplify}
                  onChange={(e) => setOptimizationConfig({
                    frames: { ...optimizationConfig.frames, simplify: e.target.checked }
                  })}
                  className="rounded"
                />
                <label className="text-xs text-text-muted">精简关键帧</label>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={optimizationConfig.frames.removeInvisible}
                  onChange={(e) => setOptimizationConfig({
                    frames: { ...optimizationConfig.frames, removeInvisible: e.target.checked }
                  })}
                  className="rounded"
                />
                <label className="text-xs text-text-muted">移除不可见帧数据</label>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs text-text-muted w-16">精度</label>
                <Select
                  value={String(optimizationConfig.frames.precision)}
                  onChange={(v) => setOptimizationConfig({
                    frames: { ...optimizationConfig.frames, precision: parseInt(v) }
                  })}
                  options={[
                    { value: '6', label: '高 (6位)' },
                    { value: '4', label: '中 (4位)' },
                    { value: '3', label: '低 (3位)' },
                    { value: '2', label: '较低 (2位)' },
                    { value: '1', label: '最低 (1位)' }
                  ]}
                />
              </div>
            </div>

            {/* 压缩优化 */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-text-primary">压缩优化</label>
              
              <div className="flex items-center gap-2">
                <label className="text-xs text-text-muted w-16">级别</label>
                <Select
                  value={String(optimizationConfig.compression.level)}
                  onChange={(v) => setOptimizationConfig({
                    compression: { ...optimizationConfig.compression, level: parseInt(v) }
                  })}
                  options={[
                    { value: '1', label: '1 (最快)' },
                    { value: '3', label: '3' },
                    { value: '6', label: '6 (默认)' },
                    { value: '7', label: '7' },
                    { value: '8', label: '8' },
                    { value: '9', label: '9 (最小)' }
                  ]}
                />
              </div>
            </div>
          </div>
        )}

        {/* 优化统计 */}
        {optimizationStats && (
          <div className={cn('text-xs px-2 py-1.5 rounded space-y-1', optimizationStats.reductionPercent >= 0 ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning')}>
            <div className="flex justify-between">
              <span>当前编辑·未优化:</span>
              <span>{(optimizationStats.originalSize / 1024).toFixed(1)} KiB</span>
            </div>
            <div className="flex justify-between">
              <span>优化后:</span>
              <span>{(optimizationStats.optimizedSize / 1024).toFixed(1)} KiB</span>
            </div>
            <div className="flex justify-between font-medium">
              <span>体积{optimizationStats.reductionPercent >= 0 ? '减少' : '增加'}:</span>
              <span>{Math.abs(optimizationStats.reductionPercent)}%</span>
            </div>
            <div className="text-text-muted border-t border-border pt-1 mt-1">
              <div>图片优化: {optimizationStats.imagesOptimized} 张</div>
              <div>图片跳过: {optimizationStats.imagesSkipped} 张</div>
              {(optimizationStats.imagesFailed ?? 0) > 0 && <div className="text-warning">失败并保留原图: {optimizationStats.imagesFailed} 张</div>}
              <div>图片去重: {optimizationStats.imagesDeduplicated} 张</div>
              <div>帧精简: {optimizationStats.framesSimplified}</div>
              <div>处理耗时: {optimizationStats.processingTime}ms</div>
            </div>
          </div>
        )}

        <div className="border-t border-border pt-3 space-y-2">
          <button
            type="button"
            className="flex w-full items-center justify-between rounded px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
            onClick={() => setShowOtherFormats(!showOtherFormats)}
          >
            <span className="flex items-center gap-1.5">
              <Icon name={showOtherFormats ? 'chevron-down' : 'chevron-right'} size={12} />
              其他格式
            </span>
            <span className="text-text-muted">PNG / 当前帧</span>
          </button>

          {showOtherFormats && (
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                disabled={!canExport || isExporting}
                onClick={() => handleExport('png-sequence')}
              >
                <Icon name="image" size={14} />
                PNG 序列
              </Button>

              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                disabled={!canExport || isExporting}
                onClick={() => handleExport('webp')}
              >
                <Icon name="image" size={14} />
                当前帧
              </Button>
            </div>
          )}

          <button
            type="button"
            className="flex w-full items-center justify-between rounded px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
            onClick={() => setShowMoreExports(!showMoreExports)}
          >
            <span className="flex items-center gap-1.5">
              <Icon name={showMoreExports ? 'chevron-down' : 'chevron-right'} size={12} />
              更多
            </span>
            <span className="text-text-muted">未优化副本</span>
          </button>

          {showMoreExports && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              disabled={!canExport || isExporting}
              onClick={() => handleExport('svga')}
            >
              <Icon name="export" size={14} />
              导出未优化副本
            </Button>
          )}
        </div>
      </div>

      {!canExport && (
        <p className="text-xs text-text-muted mt-2 text-center">
          请先打开 SVGA 文件
        </p>
      )}

      <OperationStatus status={exportStatus} className="mt-2 text-center" />
    </Panel>
    {showPreview && preview && <ExportPreviewDialog result={preview.result} stale={!previewIsCurrent} saving={isExporting} status={exportStatus} onClose={() => setShowPreview(false)} onSave={handleSavePreview} />}
    {showDelivery && <DeliveryPackageDialog isOpen onClose={() => setShowDelivery(false)} />}
    </>
  )
}
