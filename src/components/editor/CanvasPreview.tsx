import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react'
import { Icon, Button } from '@/components/ui'
import { useEditorStore } from '@/stores'
import { HighPerformanceRenderer, OfficialSvgRenderer } from '@/core'
import type { SVGAPixiRenderer as SVGAPixiRendererType } from '@/rendering/svga-pixi-renderer'
import { cn } from '@/utils/cn'

interface CanvasPreviewProps {
  className?: string
  enableWorker?: boolean // 是否启用Worker渲染
  usePixiRenderer?: boolean // 是否使用 PixiJS 渲染器
  onOpenFile?: () => void
  onSvgaDrop?: (file: File) => void | Promise<void>
}

export const CanvasPreview: React.FC<CanvasPreviewProps> = ({ 
  className,
  enableWorker = true,
  usePixiRenderer = false,
  onOpenFile,
  onSvgaDrop
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<HighPerformanceRenderer | OfficialSvgRenderer | SVGAPixiRendererType | null>(null)
  const rendererKindRef = useRef<'high-performance' | 'official' | 'pixi' | null>(null)
  
  // 渲染器模式：从 store 读取，支持用户切换
  const rendererMode = useEditorStore((s) => s.rendererMode || 'high-performance')
  const setRendererMode = useEditorStore((s) => s.setRendererMode)
  const useOfficialRenderer = rendererMode === 'official'
  const usePixi = usePixiRenderer || rendererMode === 'pixi'
  
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
  const showGrid = useEditorStore((s) => s.showGrid)
  
  // 播放循环内部直接读取 store，避免每帧触发 React 更新
  // 手动帧索引 - 使用本地状态，不订阅 store，避免动画时重渲染
  const manualFrameRef = useRef(0)
  
  const slotConfigs = useEditorStore((s) => s.slotConfigs)
  const layers = useEditorStore((s) => s.layers)
  // 避免 TS6133 - 这些值在事件处理中通过 store 直接获取
  void slotConfigs
  void layers
  
  // 监听手动帧更新事件（非播放状态下的帧跳转）
  useEffect(() => {
    const handleManualFrameUpdate = (e: CustomEvent<{ frameIndex: number }>) => {
      manualFrameRef.current = e.detail.frameIndex
      if (!useEditorStore.getState().playback.isPlaying && rendererRef.current) {
        const state = useEditorStore.getState()
        rendererRef.current.renderFrame(e.detail.frameIndex, {
          slotConfigs: state.slotConfigs,
          layers: state.layers,
          applySlots: true
        })
      }
    }
    
    window.addEventListener('svga-manual-frame', handleManualFrameUpdate as EventListener)
    
    return () => {
      window.removeEventListener('svga-manual-frame', handleManualFrameUpdate as EventListener)
    }
  }, [])

  // 初始化渲染器 - 使用 ref 回调确保在 DOM 元素创建时立即执行
  const canvasRefCallback = useCallback((canvas: HTMLElement | null) => {
    canvasRef.current = canvas instanceof HTMLCanvasElement ? canvas : null
    
    // 如果 canvas 被卸载，不做任何事
    if (!canvas) return

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
      
      // 如果已经有 videoItem，立即初始化
      const state = useEditorStore.getState()
      if (state.videoItem && state.params && rendererRef.current) {
        setRendererReady(false)
        await rendererRef.current.setVideoItem(state.videoItem, { waitForImages: true })
        if (rendererRef.current) {
          const s = useEditorStore.getState()
          await rendererRef.current.renderFrameAsync(0, {
            slotConfigs: s.slotConfigs,
            layers: s.layers,
            applySlots: true
          })
          setRendererReady(true)
        }
      } else {
        setRendererReady(true)
      }
    }

    void initializeRenderer().catch((err) => {
      setPixiLoading(false)
      console.error('[CanvasPreview] Renderer init failed:', err)
    })
  }, [enableWorker, useOfficialRenderer, usePixi])

  // 当 videoItem 变化时，初始化渲染器
  useEffect(() => {
    if (rendererRef.current && videoItem && params) {
      const initRenderer = async () => {
        setRendererReady(false)
        try {
          await rendererRef.current!.setVideoItem(videoItem, { waitForImages: true })
          const state = useEditorStore.getState()
          await rendererRef.current!.renderFrameAsync(0, {
            slotConfigs: state.slotConfigs,
            layers: state.layers,
            applySlots: true
          })
        } finally {
          setRendererReady(true)
        }
      }
      initRenderer()
    }
  }, [videoItem, params])

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
    if (!params || !rendererReady || !rendererRef.current) return

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
    let clockWorker: Worker | null = null
    let clockWorkerUrl: string | null = null
    let mainClockId: number | null = null
    let rafClockId: number | null = null
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
            applySlots: true,
            useFrameCache: false
          })
          renderedFrames++
        }
        
        currentFrameIndex = frameToRender + 1
        
        if (shouldStopAfterRender) {
          useEditorStore.getState().setPlaying(false)
          useEditorStore.getState().setCurrentFrame(playbackState.totalFrames - 1)
          // 最终帧也通知 UI 更新
          updateTimelineIndicators(playbackState.totalFrames - 1)
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

    if (typeof Worker !== 'undefined') {
      clockWorkerUrl = URL.createObjectURL(new Blob([`
        let timer = null;
        self.onmessage = (event) => {
          if (event.data === 'stop') {
            if (timer !== null) clearInterval(timer);
            timer = null;
            return;
          }
          if (event.data === 'start' && timer === null) {
            timer = setInterval(() => self.postMessage('tick'), 16);
          }
        };
      `], { type: 'text/javascript' }))
      clockWorker = new Worker(clockWorkerUrl)
      clockWorker.onmessage = animate
      clockWorker.postMessage('start')
    }
    const rafClock = () => {
      animate()
      if (!cancelled) {
        rafClockId = window.requestAnimationFrame(rafClock)
      }
    }
    rafClockId = window.requestAnimationFrame(rafClock)
    mainClockId = window.setInterval(animate, 16)
    animate()

    return () => {
      cancelled = true
      if (clockWorker) {
        clockWorker.postMessage('stop')
        clockWorker.terminate()
      }
      if (clockWorkerUrl) {
        URL.revokeObjectURL(clockWorkerUrl)
      }
      if (mainClockId !== null) {
        window.clearInterval(mainClockId)
      }
      if (rafClockId !== null) {
        window.cancelAnimationFrame(rafClockId)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, rendererReady])

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
    const containerWidth = container.clientWidth - 80
    const containerHeight = container.clientHeight - 80

    const scaleX = containerWidth / params.viewBoxWidth
    const scaleY = containerHeight / params.viewBoxHeight
    const scale = Math.min(scaleX, scaleY) * 0.95

    setZoom(scale)
    setCanvasOffset({ x: 0, y: 0 })
  }, [params, setZoom, setCanvasOffset])

  // 初始适应
  useEffect(() => {
    fitToContainer()
  }, [fitToContainer])

  // 计算画布样式
  const canvasContainerStyle = useMemo(() => {
    if (!params) return {}
    
    return {
      position: 'absolute' as const,
      left: '50%',
      top: '50%',
      width: params.viewBoxWidth,
      height: params.viewBoxHeight,
      transform: `translate(-50%, -50%) translate(${canvasOffset.x}px, ${canvasOffset.y}px) scale(${zoom})`,
      transformOrigin: 'center center'
    }
  }, [params, zoom, canvasOffset])
  
  // canvas 元素样式
  const canvasStyle = useMemo(() => {
    if (!params) return {}
    
    return {
      width: params.viewBoxWidth,
      height: params.viewBoxHeight,
      display: 'block'
    }
  }, [params])

  // 鼠标拖动开始
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) {
      setIsDragging(true)
      setDragStart({ x: e.clientX - canvasOffset.x, y: e.clientY - canvasOffset.y })
    }
  }, [canvasOffset])

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
        'relative flex-1 bg-bg-tertiary overflow-hidden',
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
      {showGrid && (
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
          className="relative bg-white rounded shadow-2xl overflow-hidden"
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
        <DropZone onOpenFile={onOpenFile} onSvgaDrop={onSvgaDrop} />
      )}

      {pixiLoading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg-primary/50 text-sm text-text-secondary">
          正在加载 WebGL 渲染器...
        </div>
      )}

      {/* 缩放控制 */}
      <div className="absolute bottom-4 right-4 flex items-center gap-2 bg-bg-secondary/90 backdrop-blur rounded-lg p-2">
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
        <Button 
          variant="ghost" 
          size="sm"
          onClick={fitToContainer}
        >
          <Icon name="fit" size={16} />
        </Button>
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
            usePixi ? '当前：WebGL 极速渲染器（点击切换为官方兼容）' :
            useOfficialRenderer ? '当前：官方兼容渲染器（点击切换为 Canvas 高性能）' :
            '当前：Canvas 高性能渲染器（点击切换为 WebGL 极速）'
          }
          onClick={() => {
            const nextMode = rendererMode === 'pixi'
              ? 'official'
              : rendererMode === 'official'
                ? 'high-performance'
                : 'pixi'
            setRendererMode(nextMode)
          }}
          title={
            usePixi ? '当前：WebGL 极速渲染器（点击切换为 Canvas 高性能）' :
            useOfficialRenderer ? '当前：官方渲染器（点击切换为 WebGL 极速）' :
            '当前：Canvas 高性能渲染器（点击切换为官方）'
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
        'border-2 border-dashed rounded-xl p-12 transition-colors cursor-pointer',
        isDragOver 
          ? 'border-accent bg-accent/10' 
          : 'border-border hover:border-accent/50'
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={onOpenFile}
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
        <p className="text-text-primary mb-2">
          拖拽 SVGA 文件到此处
        </p>
        <p className="text-text-muted text-sm">
          或使用菜单 打开文件 / 打开 URL
        </p>
      </div>
    </div>
  )
}
