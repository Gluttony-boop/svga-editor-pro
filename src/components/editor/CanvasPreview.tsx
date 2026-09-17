import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react'
import { Icon, Button } from '@/components/ui'
import { useEditorStore } from '@/stores'
import { HighPerformanceRenderer, OfficialSvgRenderer } from '@/core'
import type { SVGAPixiRenderer as SVGAPixiRendererType } from '@/rendering/svga-pixi-renderer'
import { cn } from '@/utils/cn'
import { calculatePreviewZoom, previewFileName } from '@/utils/preview-view'
import { formatResourceBytes } from '@/utils/resource-catalog'
import { CanvasTransformOverlay } from './CanvasTransformOverlay'
import { PreviewRenderQueue } from '@/core/preview-render-queue'
import { startPlaybackClock } from '@/core/playback-clock'

type PreviewRenderer = HighPerformanceRenderer | OfficialSvgRenderer | SVGAPixiRendererType
type PreviewState = ReturnType<typeof useEditorStore.getState>

interface CanvasPreviewProps {
  className?: string
  enableWorker?: boolean // 是否启用Worker渲染
  usePixiRenderer?: boolean // 是否使用 PixiJS 渲染器
  onOpenFile?: () => void
  onSvgaDrop?: (file: File) => void | Promise<void>
  immersive?: boolean
  onToggleImmersive?: () => void
}

const paintPreviewBackground = (canvas: HTMLCanvasElement | null, backgroundColor: string) => {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'destination-over'

  if (backgroundColor === 'transparent') {
    const size = 20
    for (let y = 0; y < canvas.height; y += size) {
      for (let x = 0; x < canvas.width; x += size) {
        ctx.fillStyle = ((x / size + y / size) % 2 === 0) ? '#ffffff' : '#d1d5db'
        ctx.fillRect(x, y, size, size)
      }
    }
  } else {
    ctx.fillStyle = backgroundColor
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }

  ctx.restore()
}

export const CanvasPreview: React.FC<CanvasPreviewProps> = ({ 
  className,
  enableWorker = true,
  usePixiRenderer = false,
  onOpenFile,
  onSvgaDrop,
  immersive = false,
  onToggleImmersive
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const previewToolsRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<PreviewRenderer | null>(null)
  const rendererKindRef = useRef<'high-performance' | 'official' | 'pixi' | null>(null)
  
  // 渲染器模式：从 store 读取，支持用户切换
  const rendererMode = useEditorStore((s) => s.rendererMode || 'high-performance')
  const setRendererMode = useEditorStore((s) => s.setRendererMode)
  const effectiveRendererMode = rendererMode === 'pixi' ? 'official' : rendererMode
  const useOfficialRenderer = effectiveRendererMode === 'official'
  const usePixi = usePixiRenderer

  useEffect(() => {
    if (rendererMode === 'pixi') {
      setRendererMode('official')
    }
  }, [rendererMode, setRendererMode])
  
  // 拖动状态
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  
  // 渲染器是否已初始化
  const [rendererReady, setRendererReady] = useState(false)
  const [pixiLoading, setPixiLoading] = useState(false)
  
  // 性能指标显示
  const [showMetrics, setShowMetrics] = useState(false)
  const [performanceMetrics, setPerformanceMetrics] = useState({
    fps: 0,
    lastRenderTime: 0,
    cacheSize: 0,
    workerEnabled: false,
    cacheHits: 0,
    cacheMisses: 0,
    spriteCount: 0
  })
  
  // 最大缓存帧数
  const maxCacheSize = 100

  // 使用选择器获取状态，避免不必要的重渲染
  const videoItem = useEditorStore((s) => s.videoItem)
  const params = useEditorStore((s) => s.params)
  const zoom = useEditorStore((s) => s.zoom)
  const setZoom = useEditorStore((s) => s.setZoom)
  const canvasOffset = useEditorStore((s) => s.canvasOffset)
  const setCanvasOffset = useEditorStore((s) => s.setCanvasOffset)
  const previewBackgroundColor = useEditorStore((s) => s.previewBackgroundColor)
  const setPreviewBackgroundColor = useEditorStore((s) => s.setPreviewBackgroundColor)
  const showGrid = useEditorStore((s) => s.showGrid)
  const source = useEditorStore((s) => s.currentSource)
  const originalBytes = useEditorStore((s) => s.originalBuffer?.byteLength ?? 0)
  const fps = useEditorStore((s) => s.playback.fps)
  const totalFrames = useEditorStore((s) => s.playback.totalFrames)
  const isPlaying = useEditorStore((s) => s.playback.isPlaying)
  const savedViewportRef = useRef<{ video: typeof videoItem; zoom: number; offset: { x: number; y: number } } | null>(null)
  const previewBackgroundColorRef = useRef(previewBackgroundColor)

  const lastRenderedFrameRef = useRef<{ video: PreviewState['videoItem']; frame: number } | null>(null)
  const loadedRendererRef = useRef<{ renderer: PreviewRenderer; video: PreviewState['videoItem']; params: PreviewState['params'] } | null>(null)
  const mountRevisionRef = useRef(0)
  const renderQueueRef = useRef<PreviewRenderQueue<{ renderer: PreviewRenderer; state: PreviewState }> | null>(null)

  if (!renderQueueRef.current) {
    renderQueueRef.current = new PreviewRenderQueue(async ({ renderer, state }, isCurrent) => {
      if (renderer !== rendererRef.current || !state.videoItem || !state.params) return
      const loaded = loadedRendererRef.current
      if (loaded?.renderer !== renderer || loaded.video !== state.videoItem || loaded.params !== state.params) {
        await renderer.setVideoItem(state.videoItem, { waitForImages: true })
        if (renderer !== rendererRef.current) return
        loadedRendererRef.current = { renderer, video: state.videoItem, params: state.params }
      }
      const shouldRender = () => isCurrent() && renderer === rendererRef.current
        && useEditorStore.getState().videoItem === state.videoItem
        && !useEditorStore.getState().playback.isPlaying
      if (!isCurrent() || renderer !== rendererRef.current) return
      if (shouldRender()) {
        await renderer.renderFrameAsync(state.playback.currentFrame, {
          slotConfigs: state.slotConfigs,
          layers: state.layers,
          imageResources: state.imageResources,
          applySlots: true,
          useFrameCache: false,
          shouldRender
        })
        if (!shouldRender()) return
        lastRenderedFrameRef.current = { video: state.videoItem, frame: state.playback.currentFrame }
        paintPreviewBackground(canvasRef.current, previewBackgroundColorRef.current)
        window.dispatchEvent(new CustomEvent('svga-preview-frame', { detail: { frameIndex: state.playback.currentFrame } }))
      }
      setRendererReady(true)
    }, (error) => console.error('[CanvasPreview] 预览渲染失败:', error))
  }

  const requestPreviewFrame = useCallback((frameIndex?: number) => {
    const renderer = rendererRef.current
    const state = useEditorStore.getState()
    if (!renderer || !state.videoItem || !state.params) return
    renderQueueRef.current?.request({
      renderer,
      state: frameIndex === undefined ? state : { ...state, playback: { ...state.playback, currentFrame: frameIndex } }
    })
  }, [])

  useEffect(() => {
    const unsubscribe = useEditorStore.subscribe((state, previous) => {
      previewBackgroundColorRef.current = state.previewBackgroundColor
      const documentChanged = state.videoItem !== previous.videoItem || state.params !== previous.params
      if (documentChanged) {
        lastRenderedFrameRef.current = null
        renderQueueRef.current?.invalidate()
        setRendererReady(false)
        requestPreviewFrame()
        return
      }
      if (state.playback.isPlaying && !previous.playback.isPlaying) {
        renderQueueRef.current?.invalidate()
        requestPreviewFrame()
        return
      }
      if (!state.playback.isPlaying && previous.playback.isPlaying) {
        // Store 的播放进度经过节流，暂停时先同步实绘帧，保证随后的命中与拖动不跳帧。
        const rendered = lastRenderedFrameRef.current
        if (rendered?.video === state.videoItem && state.playback.currentFrame === previous.playback.currentFrame
          && rendered.frame !== state.playback.currentFrame) {
          state.setCurrentFrame(rendered.frame)
          return
        }
      }
      if (!state.playback.isPlaying && (state.layers !== previous.layers || state.slotConfigs !== previous.slotConfigs
        || state.imageResources !== previous.imageResources || state.previewBackgroundColor !== previous.previewBackgroundColor
        || state.playback.currentFrame !== previous.playback.currentFrame || state.playback.isPlaying !== previous.playback.isPlaying)) {
        requestPreviewFrame()
      }
    })
    const handleManualFrameUpdate = (event: Event) => {
      if (!useEditorStore.getState().playback.isPlaying) requestPreviewFrame((event as CustomEvent<{ frameIndex: number }>).detail.frameIndex)
    }
    window.addEventListener('svga-manual-frame', handleManualFrameUpdate)
    return () => {
      unsubscribe()
      renderQueueRef.current?.invalidate()
      window.removeEventListener('svga-manual-frame', handleManualFrameUpdate)
    }
  }, [requestPreviewFrame])

  // 初始化渲染器 - 使用 ref 回调确保在 DOM 元素创建时立即执行
  const canvasRefCallback = useCallback((canvas: HTMLElement | null) => {
    canvasRef.current = canvas instanceof HTMLCanvasElement ? canvas : null
    const mountRevision = ++mountRevisionRef.current
    renderQueueRef.current?.invalidate()
    if (!canvas) {
      rendererRef.current?.destroy()
      rendererRef.current = null
      rendererKindRef.current = null
      loadedRendererRef.current = null
      return
    }

    const initializeRenderer = async () => {
      const nextKind = usePixi ? 'pixi' : useOfficialRenderer ? 'official' : 'high-performance'
    
      // 如果渲染器模式变了，需要重建
      if (rendererRef.current) {
        if (rendererKindRef.current === nextKind) return
        rendererRef.current.destroy()
        rendererRef.current = null
        rendererKindRef.current = null
      }
      
      // 创建新渲染器
      if (usePixi) {
        const container = canvas
        if (container) {
          setPixiLoading(true)
          const { SVGAPixiRenderer } = await import('@/rendering/svga-pixi-renderer')
          if (mountRevision !== mountRevisionRef.current) return
          rendererRef.current = new SVGAPixiRenderer(container)
          setPixiLoading(false)
        }
      } else if (useOfficialRenderer && canvas instanceof HTMLCanvasElement) {
        rendererRef.current = new OfficialSvgRenderer(canvas)
      } else if (canvas instanceof HTMLCanvasElement) {
        rendererRef.current = new HighPerformanceRenderer(canvas, enableWorker)
      }
      if (!rendererRef.current) return
      rendererKindRef.current = nextKind
      ;(canvas as any).__renderer = rendererRef.current
      ;(window as any).__SVGA_RENDERER__ = rendererRef.current
      
      setRendererReady(false)
      requestPreviewFrame()
    }

    void initializeRenderer().catch((err) => {
      setPixiLoading(false)
      console.error('[CanvasPreview] Renderer init failed:', err)
    })
  }, [enableWorker, useOfficialRenderer, usePixi, requestPreviewFrame])

  // StrictMode 重订阅以及已有画布切换文件时，都交给同一队列初始化。
  useEffect(() => {
    requestPreviewFrame()
  }, [videoItem, params, requestPreviewFrame])

  // 更新性能指标（使用 requestIdleCallback 避免阻塞渲染）
  const updatePerformanceMetrics = useCallback(() => {
    if (rendererRef.current) {
      const metrics = rendererRef.current.getPerformanceMetrics()
      setPerformanceMetrics({
        fps: metrics.fps,
        lastRenderTime: metrics.lastRenderTime,
        cacheSize: metrics.cacheSize,
        workerEnabled: metrics.workerEnabled,
        cacheHits: metrics.cacheHits,
        cacheMisses: metrics.cacheMisses,
        spriteCount: metrics.spriteCount
      })
    }
  }, [])
  
  // 直接更新时间轴指示器位置（不触发 React 重渲染）
  const updateTimelineIndicators = useCallback((frameIndex: number) => {
    // 使用 CSS 自定义属性或直接操作 DOM
    document.documentElement.style.setProperty('--current-frame', String(frameIndex))
    
    // 触发自定义事件，让其他组件可以监听
    window.dispatchEvent(new CustomEvent('svga-frame-update', { 
      detail: { frameIndex } 
    }))
  }, [])


  // 播放动画 - 完全独立于 React 状态
  useEffect(() => {
    if (!params || !rendererReady || !rendererRef.current || !isPlaying) return

    const getPlaybackState = () => {
      const state = useEditorStore.getState()
      return {
        isPlaying: state.playback.isPlaying,
        fps: Math.max(1, state.playback.fps || 24),
        totalFrames: state.playback.totalFrames,
        loop: state.playback.loop,
        speed: state.playback.speed,
        startFrame: state.playback.currentFrame
      }
    }
    
    const initialState = getPlaybackState()
    if (initialState.totalFrames <= 0) return

    let lastTime = performance.now()
    let currentFrameIndex = initialState.startFrame
    let cancelled = false
    let wasPlaying = false
    let lastUiUpdate = 0
    let renderedFrames = 0
    let lastFpsTime = performance.now()
    let tickBusy = false

    const animate = () => {
      if (cancelled || tickBusy) return
      tickBusy = true

      const currentTime = performance.now()
      const playbackState = getPlaybackState()
      if (!playbackState.isPlaying) {
        wasPlaying = false
        currentFrameIndex = playbackState.startFrame
        lastTime = currentTime
        renderedFrames = 0
        lastFpsTime = currentTime
        tickBusy = false
        return
      }

      if (!wasPlaying) {
        wasPlaying = true
        currentFrameIndex = playbackState.startFrame
        lastTime = currentTime
        lastUiUpdate = currentTime
        renderedFrames = 0
        lastFpsTime = currentTime
      }

      const adjustedInterval = (1000 / playbackState.fps) / Math.max(0.01, playbackState.speed || 1)
      const deltaTime = currentTime - lastTime

      if (deltaTime >= adjustedInterval) {
        const frameStep = Math.max(1, Math.floor(deltaTime / adjustedInterval))
        lastTime = currentTime - (deltaTime % adjustedInterval)

        let frameToRender = currentFrameIndex + frameStep - 1
        let shouldStopAfterRender = false

        if (playbackState.loop) {
          frameToRender %= playbackState.totalFrames
        } else if (frameToRender >= playbackState.totalFrames - 1) {
          frameToRender = playbackState.totalFrames - 1
          shouldStopAfterRender = true
        }

        if (rendererRef.current) {
          const state = useEditorStore.getState()
          rendererRef.current.renderFrame(frameToRender, {
            slotConfigs: state.slotConfigs,
            layers: state.layers,
            imageResources: state.imageResources,
            applySlots: true,
            useFrameCache: false
          })
          paintPreviewBackground(canvasRef.current, previewBackgroundColorRef.current)
          lastRenderedFrameRef.current = { video: state.videoItem, frame: frameToRender }
          window.dispatchEvent(new CustomEvent('svga-preview-frame', { detail: { frameIndex: frameToRender } }))
          renderedFrames++
        }
        
        currentFrameIndex = frameToRender + 1
        
        if (shouldStopAfterRender) {
          useEditorStore.getState().setPlaying(false)
          useEditorStore.getState().setCurrentFrame(playbackState.totalFrames - 1)
          // 最终帧也通知 UI 更新
          updateTimelineIndicators(playbackState.totalFrames - 1)
          tickBusy = false
          return
        }

        if (currentFrameIndex >= playbackState.totalFrames) {
          if (playbackState.loop) {
            currentFrameIndex = 0
          }
        }
        
        // 定期更新 UI（时间轴、进度条、FPS 指示）
        if (currentTime - lastUiUpdate >= 250) {
          useEditorStore.getState().setCurrentFrame(frameToRender)
          updateTimelineIndicators(frameToRender)
          lastUiUpdate = currentTime
          
          // 每秒计算一次实际渲染 FPS
          if (currentTime - lastFpsTime >= 1000) {
            const actualFps = Math.round(renderedFrames * 1000 / (currentTime - lastFpsTime))
            window.dispatchEvent(new CustomEvent('svga-fps-update', { detail: { fps: actualFps } }))
            renderedFrames = 0
            lastFpsTime = currentTime
          }
        }
      }
      tickBusy = false
    }

    const stopClock = startPlaybackClock(animate, enableWorker)

    return () => {
      cancelled = true
      stopClock()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, rendererReady, isPlaying, enableWorker])

  // 手动帧更新已改用事件监听（见 svga-manual-frame 事件）

  // 定期更新性能指标
  useEffect(() => {
    if (!showMetrics) return
    
    const interval = setInterval(() => {
      updatePerformanceMetrics()
    }, 500)
    
    return () => clearInterval(interval)
  }, [showMetrics, updatePerformanceMetrics])

  // 适应容器
  const fitToContainer = useCallback(() => {
    if (!containerRef.current || !params) return

    const container = containerRef.current
    const toolsHeight = previewToolsRef.current?.offsetHeight ?? 48
    const topInset = immersive ? 0 : 72
    setZoom(calculatePreviewZoom(container.clientWidth, Math.max(1, container.clientHeight - toolsHeight - topInset), params.viewBoxWidth, params.viewBoxHeight))
    setCanvasOffset({ x: 0, y: (topInset - toolsHeight) / 2 })
  }, [params, setZoom, setCanvasOffset, immersive])

  // 初始适应
  useEffect(() => {
    fitToContainer()
  }, [fitToContainer])

  useEffect(() => {
    if (immersive && videoItem) {
      if (!savedViewportRef.current || savedViewportRef.current.video !== videoItem) {
        const state = useEditorStore.getState()
        savedViewportRef.current = { video: videoItem, zoom: state.zoom, offset: { ...state.canvasOffset } }
      }
      fitToContainer()
      // Refit when the window size changes, without resetting the playhead or renderer.
      const observer = new ResizeObserver(fitToContainer)
      if (containerRef.current) observer.observe(containerRef.current)
      return () => observer.disconnect()
    }
    const saved = savedViewportRef.current
    if (saved?.video === videoItem) {
      setZoom(saved.zoom)
      setCanvasOffset(saved.offset)
    }
    savedViewportRef.current = null
  }, [immersive, videoItem, fitToContainer, setZoom, setCanvasOffset])

  // 计算画布样式
  const colorInputValue = previewBackgroundColor === 'transparent' ? '#000000' : previewBackgroundColor

  const previewBackgroundStyle = useMemo(() => {
    const transparentPreview = previewBackgroundColor === 'transparent'

    return {
      backgroundColor: transparentPreview ? '#ffffff' : previewBackgroundColor,
      backgroundImage: transparentPreview
        ? `
          linear-gradient(45deg, #d1d5db 25%, transparent 25%),
          linear-gradient(-45deg, #d1d5db 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, #d1d5db 75%),
          linear-gradient(-45deg, transparent 75%, #d1d5db 75%)
        `
        : undefined,
      backgroundSize: transparentPreview ? '20px 20px' : undefined,
      backgroundPosition: transparentPreview ? '0 0, 0 10px, 10px -10px, -10px 0px' : undefined
    }
  }, [previewBackgroundColor])

  const canvasContainerStyle = useMemo(() => {
    if (!params) return {}
    
    return {
      position: 'absolute' as const,
      left: '50%',
      top: '50%',
      width: params.viewBoxWidth,
      height: params.viewBoxHeight,
      ...previewBackgroundStyle,
      transform: `translate(-50%, -50%) translate(${canvasOffset.x}px, ${canvasOffset.y}px) scale(${zoom})`,
      transformOrigin: 'center center'
    }
  }, [params, zoom, canvasOffset, previewBackgroundStyle])
  
  // canvas 元素样式
  const canvasStyle = useMemo(() => {
    if (!params) return {}
    
    return {
      width: params.viewBoxWidth,
      height: params.viewBoxHeight,
      display: 'block',
      ...previewBackgroundStyle
    }
  }, [params, previewBackgroundStyle])

  // 鼠标拖动开始
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (videoItem && !immersive && !usePixi) return
    if (e.button === 0) {
      setIsDragging(true)
      setDragStart({ x: e.clientX - canvasOffset.x, y: e.clientY - canvasOffset.y })
    }
  }, [canvasOffset, videoItem, immersive, usePixi])

  // 鼠标拖动中
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return
    setCanvasOffset({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y
    })
  }, [isDragging, dragStart, setCanvasOffset])

  // 鼠标拖动结束
  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  // 鼠标滚轮缩放
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      setZoom(zoom * delta)
    }
  }, [zoom, setZoom])

  return (
    <div 
      ref={containerRef}
      className={cn(
        'relative flex-1 bg-bg-primary overflow-hidden',
        isDragging && 'cursor-grabbing',
        className
      )}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
    >
      {/* 网格背景 */}
      {showGrid && !immersive && (
        <div
          className="absolute inset-0 opacity-10 pointer-events-none"
          style={{
            backgroundImage: `
              linear-gradient(to right, #ffffff 1px, transparent 1px),
              linear-gradient(to bottom, #ffffff 1px, transparent 1px)
            `,
            backgroundSize: '20px 20px'
          }}
        />
      )}

      {/* 画布容器 */}
      {videoItem && params ? (
        <div 
          className="relative rounded shadow-2xl overflow-hidden"
          style={canvasContainerStyle}
        >
          {usePixi ? (
            <div ref={canvasRefCallback} style={canvasStyle} />
          ) : (
            <canvas
              ref={canvasRefCallback}
              style={canvasStyle}
            />
          )}
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center p-6"><DropZone onOpenFile={onOpenFile} onSvgaDrop={onSvgaDrop} /></div>
      )}

      {pixiLoading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg-primary/50 text-sm text-text-secondary">
          正在加载 WebGL 渲染器...
        </div>
      )}

      {immersive && params && (
        <div className="absolute left-4 right-4 top-4 z-10 flex items-start justify-between gap-4" onMouseDown={e => e.stopPropagation()}>
          <div className="min-w-0 rounded-lg bg-bg-secondary/90 px-3 py-2 text-xs backdrop-blur">
            <p className="truncate text-sm text-text-primary" title={previewFileName(source)}>{previewFileName(source)}</p>
            <p className="mt-1 text-text-muted">{params.viewBoxWidth} × {params.viewBoxHeight} · {fps} FPS · {totalFrames} 帧 · {fps > 0 ? (totalFrames / fps).toFixed(2) : '—'} 秒 · 源文件 {formatResourceBytes(originalBytes)}</p>
          </div>
          <Button className="flex-shrink-0" onClick={onToggleImmersive} title="退出沉浸预览（Esc / F9）">退出沉浸预览</Button>
        </div>
      )}
      {!immersive && !usePixi && videoItem && params && <CanvasTransformOverlay viewportRef={containerRef} disabled={!rendererReady || pixiLoading} />}

      {/* 缩放控制 */}
      <div ref={previewToolsRef} aria-label="画布工具" className="absolute bottom-4 right-4 z-10 flex max-w-[calc(100%-2rem)] flex-wrap items-center justify-end gap-2 bg-bg-secondary/90 backdrop-blur rounded-lg border border-border/60 p-2" onMouseDown={e => e.stopPropagation()}>
        <Button 
          variant="ghost" 
          size="sm"
          onClick={() => setZoom(zoom / 1.2)}
        >
          <Icon name="minus" size={16} />
        </Button>
        <span className="text-xs text-text-secondary w-12 text-center">
          {Math.round(zoom * 100)}%
        </span>
        <Button 
          variant="ghost" 
          size="sm"
          onClick={() => setZoom(zoom * 1.2)}
        >
          <Icon name="plus" size={16} />
        </Button>
        <div className="w-px h-4 bg-border mx-1" />
        <label
          className="relative grid h-8 w-8 cursor-pointer place-items-center rounded hover:bg-white/10"
          title="预览背景色"
        >
          <span
            className={cn(
              'h-4 w-4 rounded border border-white/40 shadow-inner',
              previewBackgroundColor === 'transparent' &&
                'bg-[linear-gradient(45deg,#9ca3af_25%,transparent_25%),linear-gradient(-45deg,#9ca3af_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#9ca3af_75%),linear-gradient(-45deg,transparent_75%,#9ca3af_75%)] bg-[length:8px_8px] bg-[position:0_0,0_4px,4px_-4px,-4px_0px]'
            )}
            style={{ backgroundColor: previewBackgroundColor === 'transparent' ? '#ffffff' : previewBackgroundColor }}
          />
          <input
            type="color"
            value={colorInputValue}
            onChange={(e) => setPreviewBackgroundColor(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label="预览背景色"
          />
        </label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={cn(
              'h-4 w-4 rounded-full border border-white/50 bg-[linear-gradient(45deg,#9ca3af_25%,transparent_25%),linear-gradient(-45deg,#9ca3af_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#9ca3af_75%),linear-gradient(-45deg,transparent_75%,#9ca3af_75%)] bg-white bg-[length:8px_8px] bg-[position:0_0,0_4px,4px_-4px,-4px_0px] transition-transform hover:scale-110',
              previewBackgroundColor === 'transparent' && 'ring-1 ring-accent ring-offset-1 ring-offset-bg-secondary'
            )}
            onClick={() => setPreviewBackgroundColor('transparent')}
            title="背景透明"
            aria-label="背景透明"
          />
          {['#000000', '#ffffff', '#cfe8ff', '#1e293b'].map((color) => (
            <button
              key={color}
              type="button"
              className={cn(
                'h-4 w-4 rounded-full border transition-transform hover:scale-110',
                previewBackgroundColor.toLowerCase() === color && 'ring-1 ring-accent ring-offset-1 ring-offset-bg-secondary'
              )}
              style={{ backgroundColor: color, borderColor: color === '#ffffff' ? '#94a3b8' : color }}
              onClick={() => setPreviewBackgroundColor(color)}
              title={`背景色 ${color}`}
              aria-label={`背景色 ${color}`}
            />
          ))}
        </div>
        <div className="w-px h-4 bg-border mx-1" />
        <Button 
          variant="ghost" 
          size="sm"
          onClick={fitToContainer}
          title="适应画布"
        >
          <Icon name="fit" size={16} />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => { setZoom(1); setCanvasOffset({ x: 0, y: 0 }) }} title="原始尺寸（100%）" disabled={!videoItem}>1:1</Button>
        {!immersive && onToggleImmersive && <Button variant="ghost" size="sm" onClick={onToggleImmersive} disabled={!videoItem} title="沉浸预览（F9）" aria-label="沉浸预览"><Icon name="fullscreen" size={16} /></Button>}
        <div className="w-px h-4 bg-border mx-1" />
        <Button 
          variant="ghost" 
          size="sm"
          onClick={() => setShowMetrics(!showMetrics)}
          title="性能指标"
        >
          <Icon name="activity" size={16} />
        </Button>
        <div className="w-px h-4 bg-border mx-1" />
        <Button 
          variant="ghost" 
          size="sm"
          aria-label={
            useOfficialRenderer ? '当前：官方兼容渲染器（点击切换为 Canvas 高性能）' :
            '当前：Canvas 高性能渲染器（点击切换为官方兼容）'
          }
          onClick={() => {
            const nextMode = effectiveRendererMode === 'official' ? 'high-performance' : 'official'
            setRendererMode(nextMode)
          }}
          title={
            useOfficialRenderer ? '当前：官方兼容渲染器（点击切换为 Canvas 高性能）' :
            '当前：Canvas 高性能渲染器（点击切换为官方兼容）'
          }
        >
          <Icon name={useOfficialRenderer ? 'layers' : 'zap'} size={16} />
        </Button>
      </div>

      {/* 性能指标面板 */}
      {showMetrics && (
        <div className="absolute top-4 left-4 bg-bg-secondary/90 backdrop-blur rounded-lg p-3 text-xs space-y-1 min-w-[140px]">
          <div className="flex items-center justify-between gap-4">
            <span className="text-text-muted">渲染 FPS:</span>
            <span className={performanceMetrics.fps >= 30 ? 'text-green-400' : performanceMetrics.fps >= 15 ? 'text-yellow-400' : 'text-red-400'}>
              {performanceMetrics.fps}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-text-muted">目标 FPS:</span>
            <span className="text-text-secondary">
              {useEditorStore.getState().playback.fps || 24}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-text-muted">渲染耗时:</span>
            <span className={performanceMetrics.lastRenderTime < 16 ? 'text-green-400' : performanceMetrics.lastRenderTime < 33 ? 'text-yellow-400' : 'text-red-400'}>
              {performanceMetrics.lastRenderTime.toFixed(2)}ms
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-text-muted">精灵数:</span>
            <span className="text-text-secondary">
              {performanceMetrics.spriteCount}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-text-muted">帧缓存:</span>
            <span className="text-text-secondary">
              {performanceMetrics.cacheSize} / {maxCacheSize}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-text-muted">缓存命中:</span>
            <span className={performanceMetrics.cacheHits > 0 ? 'text-green-400' : 'text-text-secondary'}>
              {performanceMetrics.cacheHits} / {performanceMetrics.cacheHits + performanceMetrics.cacheMisses}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

// 拖放区域组件
const DropZone: React.FC<{
  onOpenFile?: () => void
  onSvgaDrop?: (file: File) => void | Promise<void>
}> = ({ onOpenFile, onSvgaDrop }) => {
  const [isDragOver, setIsDragOver] = React.useState(false)

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }

  const handleDragLeave = () => {
    setIsDragOver(false)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const file = e.dataTransfer.files[0]
    if (file) {
      await onSvgaDrop?.(file)
    }
  }

  return (
    <div
      className={cn(
        'w-full max-w-sm border border-dashed rounded-2xl px-6 py-10 transition-colors cursor-pointer bg-bg-secondary/40',
        isDragOver 
          ? 'border-accent bg-accent/10' 
          : 'border-border hover:border-accent/50'
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={onOpenFile}
      role="button"
      tabIndex={0}
      aria-label="选择 SVGA 文件"
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpenFile?.() } }}
    >
      <div className="text-center">
        <Icon 
          name="upload" 
          size={48} 
          className={cn(
            'mx-auto mb-4 transition-colors',
            isDragOver ? 'text-accent' : 'text-text-muted'
          )} 
        />
        <p className="text-lg font-medium text-text-primary mb-2">
          开始编辑你的动画
        </p>
        <p className="text-text-muted text-sm">
          拖入 SVGA 文件，或点击选择
        </p>
        <div className="mt-6 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-[#21131a]"><Icon name="folder-open" size={16} />选择 SVGA 文件</div>
        <p className="mt-5 text-xs text-text-muted">图层编辑 · 素材替换 · 压缩导出</p>
        <p className="mt-2 text-xs text-text-muted">也可以按 <kbd className="rounded border border-border px-1 py-0.5 font-mono">Ctrl+O</kbd> 打开文件</p>
      </div>
    </div>
  )
}
