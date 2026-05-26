import React from 'react'
import { Panel, Button, Icon, Slider, Select } from '@/components/ui'
import { useEditorStore, useCanExport, useCurrentParams } from '@/stores'
import { ExportEngine, saveGeneratedFile, svgaBuilder, svgaOptimizer, OPTIMIZATION_PRESETS, getPreset } from '@/core'
import { cn } from '@/utils/cn'

interface ExportPanelProps {
  className?: string
  collapsible?: boolean
  defaultCollapsed?: boolean
}

export const ExportPanel: React.FC<ExportPanelProps> = ({ className, collapsible = true, defaultCollapsed = false }) => {
  const canExport = useCanExport()
  const videoItem = useEditorStore((s) => s.videoItem)
  const originalBuffer = useEditorStore((s) => s.originalBuffer)
  const compressionConfig = useEditorStore((s) => s.compressionConfig)
  const slotConfigs = useEditorStore((s) => s.slotConfigs)
  const layers = useEditorStore((s) => s.layers)
  const imageResources = useEditorStore((s) => s.imageResources)
  const currentFrame = useEditorStore((s) => s.playback.currentFrame)
  const params = useCurrentParams()
  
  // 优化相关状态
  const optimizationConfig = useEditorStore((s) => s.optimizationConfig)
  const selectedPresetId = useEditorStore((s) => s.selectedPresetId)
  const optimizationStats = useEditorStore((s) => s.optimizationStats)
  const setOptimizationConfig = useEditorStore((s) => s.setOptimizationConfig)
  const setSelectedPresetId = useEditorStore((s) => s.setSelectedPresetId)
  const setOptimizationStats = useEditorStore((s) => s.setOptimizationStats)

  const [isExporting, setIsExporting] = React.useState(false)
  const [exportStatus, setExportStatus] = React.useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = React.useState(false)

  // 检查是否存在需要重建合并的编辑内容
  const hasNewContent = React.useMemo(() => {
    const originalLayerCount = videoItem?.movie.sprites?.length ?? 0
    const activeOriginalLayerCount = layers.filter(
      (layer) => !layer.isNew && layer.editableIndex !== undefined
    ).length
    const hasDeletedOriginalLayers = activeOriginalLayerCount < originalLayerCount
    const hasNewLayers = layers.some(l => l.isNew)
    const hasNewImages = Array.from(imageResources.values()).some(r => r.isNew)
    const hasAnimations = layers.some(l => 
      Object.values(l.tracks).some(track => track.keyframes.length > 0)
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
    const preset = getPreset(presetId)
    if (preset) {
      setOptimizationConfig(preset.config)
    }
  }

  // 一键优化导出
  const handleQuickOptimizeExport = async () => {
    if (!videoItem || !params) return
    if (!originalBuffer) {
      setExportStatus('导出失败: 没有原始 SVGA 数据')
      return
    }

    setIsExporting(true)
    setExportStatus('正在导出...')
    setOptimizationStats(null)

    try {

      const baseBlob = await buildSvgaBlob({ ...compressionConfig, enabled: false })
      const optimizedBlob = await svgaOptimizer.quickOptimize(await baseBlob.arrayBuffer())
      const stats = svgaOptimizer.getStats()

      const saved = await saveGeneratedFile(optimizedBlob, 'export.svga')
      if (!saved) {
        setExportStatus('已取消导出')
        return
      }

      setOptimizationStats(stats)
      setExportStatus(`导出完成!`)
    } catch (error) {
      console.error('导出失败:', error)
      setExportStatus(`导出失败: ${(error as Error).message}`)
    } finally {
      setIsExporting(false)
    }
  }

  // 带优化配置的导出
  const handleOptimizedExport = async () => {
    if (!videoItem || !params) return
    if (!originalBuffer) {
      setExportStatus('导出失败: 没有原始 SVGA 数据')
      return
    }

    setIsExporting(true)
    setExportStatus('正在导出...')
    setOptimizationStats(null)

    try {
      const baseBlob = await buildSvgaBlob({ ...compressionConfig, enabled: false })
      const blob = await svgaOptimizer.optimize(await baseBlob.arrayBuffer(), optimizationConfig)
      const stats = svgaOptimizer.getStats()
      
      const saved = await saveGeneratedFile(blob, 'export.svga')
      if (!saved) {
        setExportStatus('已取消导出')
        return
      }

      setOptimizationStats(stats)
      setExportStatus(`导出完成!`)
    } catch (error) {
      console.error('导出失败:', error)
      setExportStatus(`导出失败: ${(error as Error).message}`)
    } finally {
      setIsExporting(false)
    }
  }

  const handleExport = async (format: 'svga' | 'png-sequence' | 'webp') => {
    if (!videoItem || !params) return
    if (format === 'svga' && !originalBuffer) {
      setExportStatus('导出失败: 没有原始数据')
      return
    }

    const defaultName = format === 'png-sequence'
      ? 'frames.zip'
      : format === 'webp'
        ? 'frame.webp'
        : 'export.svga'

    setIsExporting(true)
    setExportStatus(null)
    
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

          blob = await buildSvgaBlob(compressionConfig)
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

      const saved = await saveGeneratedFile(blob, defaultName)
      if (!saved) {
        setExportStatus('已取消导出')
        return
      }

      setExportStatus('导出成功')
    } catch (error) {
      console.error('导出失败:', error)
      setExportStatus(`导出失败: ${(error as Error).message}`)
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <Panel
      title="导出"
      icon={<Icon name="export" size={16} />}
      className={className}
      collapsible={collapsible}
      defaultCollapsed={defaultCollapsed}
    >
      <div className="space-y-3">
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
              {layers.filter(l => Object.values(l.tracks).some(t => t.keyframes.length > 0)).length > 0 && (
                <li>{layers.filter(l => Object.values(l.tracks).some(t => t.keyframes.length > 0)).length} 个图层有动画</li>
              )}
              {layers.filter(l => l.imageKey && l.name.trim() && l.name.trim() !== l.imageKey).length > 0 && (
                <li>{layers.filter(l => l.imageKey && l.name.trim() && l.name.trim() !== l.imageKey).length} 个图层已改名</li>
              )}
            </ul>
          </div>
        )}

        {/* 一键导出按钮 */}
        <Button
          variant="primary"
          className="w-full"
          disabled={!canExport || isExporting}
          onClick={handleQuickOptimizeExport}
        >
          <Icon name="export" size={16} />
          {isExporting ? '导出中...' : '导出 SVGA'}
        </Button>

        {/* 优化预设选择 */}
        <div className="space-y-2">
          <label className="text-xs text-text-muted">优化预设</label>
          <Select
            value={selectedPresetId}
            onChange={handlePresetChange}
            options={OPTIMIZATION_PRESETS.map(p => ({
              value: p.id,
              label: p.name
            }))}
          />
          {selectedPresetId !== 'none' && selectedPresetId !== 'custom' && (
            <p className="text-xs text-text-muted">
              {OPTIMIZATION_PRESETS.find(p => p.id === selectedPresetId)?.description}
            </p>
          )}
        </div>

        {/* 高级配置切换 */}
        <button
          className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary w-full"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} size={12} />
          高级配置
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

              <div className="flex items-center gap-2">
                <label className="text-xs text-text-muted w-16">质量</label>
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
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={optimizationConfig.image.resizeEnabled}
                  onChange={(e) => setOptimizationConfig({
                    image: { ...optimizationConfig.image, resizeEnabled: e.target.checked }
                  })}
                  className="rounded"
                />
                <label className="text-xs text-text-muted">启用缩放</label>
                {optimizationConfig.image.resizeEnabled && (
                  <div className="flex items-center gap-1 ml-2">
                    <input
                      type="number"
                      value={optimizationConfig.image.resizePercent}
                      onChange={(e) => setOptimizationConfig({
                        image: { ...optimizationConfig.image, resizePercent: parseInt(e.target.value) || 100 }
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
                <label className="text-xs text-text-muted">去重相同图片</label>
              </div>
            </div>

            {/* 帧数据优化 */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-text-primary">帧数据优化</label>
              
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

        {/* 带配置导出按钮 */}
        <Button
          variant="secondary"
          className="w-full"
          disabled={!canExport || isExporting}
          onClick={handleOptimizedExport}
        >
          <Icon name="export" size={16} />
          按配置导出
        </Button>

        {/* 优化统计 */}
        {optimizationStats && (
          <div className="text-xs bg-success/10 text-success px-2 py-1.5 rounded space-y-1">
            <div className="flex justify-between">
              <span>原始大小:</span>
              <span>{(optimizationStats.originalSize / 1024).toFixed(1)} KB</span>
            </div>
            <div className="flex justify-between">
              <span>优化后:</span>
              <span>{(optimizationStats.optimizedSize / 1024).toFixed(1)} KB</span>
            </div>
            <div className="flex justify-between font-medium">
              <span>体积减少:</span>
              <span>{optimizationStats.reductionPercent}%</span>
            </div>
            <div className="text-text-muted border-t border-border pt-1 mt-1">
              <div>图片优化: {optimizationStats.imagesOptimized} 张</div>
              <div>图片跳过: {optimizationStats.imagesSkipped} 张</div>
              <div>图片去重: {optimizationStats.imagesDeduplicated} 张</div>
              <div>帧精简: {optimizationStats.framesSimplified}</div>
              <div>处理耗时: {optimizationStats.processingTime}ms</div>
            </div>
          </div>
        )}

        <div className="border-t border-border pt-3 space-y-2">
          <p className="text-xs text-text-muted">其他格式</p>
          
          <Button
            variant="secondary"
            className="w-full"
            disabled={!canExport || isExporting}
            onClick={() => handleExport('svga')}
          >
            <Icon name="export" size={16} />
            导出原始 SVGA
          </Button>

          <Button
            variant="secondary"
            className="w-full"
            disabled={!canExport || isExporting}
            onClick={() => handleExport('png-sequence')}
          >
            <Icon name="image" size={16} />
            导出 PNG 序列
          </Button>

          <Button
            variant="secondary"
            className="w-full"
            disabled={!canExport || isExporting}
            onClick={() => handleExport('webp')}
          >
            <Icon name="image" size={16} />
            导出当前帧
          </Button>
        </div>
      </div>

      {!canExport && (
        <p className="text-xs text-text-muted mt-2 text-center">
          请先打开 SVGA 文件
        </p>
      )}

      {exportStatus && (
        <p className={cn("text-xs mt-2 text-center", exportStatus.includes('失败') ? 'text-error' : 'text-success')}>
          {exportStatus}
        </p>
      )}
    </Panel>
  )
}
