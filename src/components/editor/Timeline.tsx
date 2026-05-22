import React, { useRef, useState, useEffect } from 'react'
import { Icon, Button } from '@/components/ui'
import { useEditorStore } from '@/stores'
import { cn } from '@/utils/cn'

interface TimelineProps {
  className?: string
}

export const Timeline: React.FC<TimelineProps> = ({ className }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const rulerPlayheadRef = useRef<HTMLDivElement>(null)
  const trackPlayheadRef = useRef<HTMLDivElement>(null)
  const currentFrameRef = useRef(0)
  const [scale, setScale] = useState(1)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [trackViewportHeight, setTrackViewportHeight] = useState(120)

  const videoItem = useEditorStore((s) => s.videoItem)
  const params = useEditorStore((s) => s.params)
  const setCurrentFrameGlobal = useEditorStore((s) => s.setCurrentFrame)
  const frameWidth = 10 * scale
  const setPlayheadFrame = React.useCallback((frameIndex: number) => {
    currentFrameRef.current = frameIndex
    const left = `${frameIndex * frameWidth}px`
    if (rulerPlayheadRef.current) rulerPlayheadRef.current.style.left = left
    if (trackPlayheadRef.current) trackPlayheadRef.current.style.left = left
  }, [frameWidth])
  
  // 监听动画播放时的帧更新事件
  useEffect(() => {
    const handleFrameUpdate = (e: CustomEvent<{ frameIndex: number }>) => {
      setPlayheadFrame(e.detail.frameIndex)
    }
    
    window.addEventListener('svga-frame-update', handleFrameUpdate as EventListener)
    
    return () => {
      window.removeEventListener('svga-frame-update', handleFrameUpdate as EventListener)
    }
  }, [setPlayheadFrame])  // 移除 playback.currentFrame 依赖，避免每次帧变化都重新订阅

  // 当 videoItem 变化时，重置本地状态
  useEffect(() => {
    if (videoItem && params) {
      setPlayheadFrame(0)
    }
  }, [videoItem, params, setPlayheadFrame])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const updateHeight = () => setTrackViewportHeight(el.clientHeight || 120)
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(el)
    return () => observer.disconnect()
  }, [videoItem])

  if (!videoItem || !params) {
    return (
      <div className={cn('h-32 bg-bg-secondary border-t border-border flex items-center justify-center', className)}>
        <p className="text-text-muted text-sm">打开 SVGA 文件以查看时间轴</p>
      </div>
    )
  }

  const totalFrames = params.frames
  const totalWidth = totalFrames * frameWidth
  const trackHeight = 32
  const sprites = videoItem.movie.sprites || []
  const totalTrackHeight = Math.max(trackViewportHeight, sprites.length * trackHeight)
  const visibleStart = Math.max(0, Math.floor(scrollTop / trackHeight) - 2)
  const visibleEnd = Math.min(
    sprites.length,
    Math.ceil((scrollTop + trackViewportHeight) / trackHeight) + 2
  )
  const visibleSprites = sprites.slice(visibleStart, visibleEnd)

  const handleTimelineClick = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left + scrollLeft
    const frame = Math.floor(x / frameWidth)
    const newFrame = Math.max(0, Math.min(frame, totalFrames - 1))
    setCurrentFrameGlobal(newFrame)
    setPlayheadFrame(newFrame)
    // 触发手动帧更新事件，让预览画布同步渲染
    window.dispatchEvent(new CustomEvent('svga-manual-frame', { detail: { frameIndex: newFrame } }))
  }

  const handleZoomIn = () => setScale(Math.min(scale + 0.5, 5))
  const handleZoomOut = () => setScale(Math.max(scale - 0.5, 0.5))

  return (
    <div className={cn('h-32 bg-bg-secondary border-t border-border flex flex-col', className)}>
      {/* 时间轴头部 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Icon name="timeline" size={16} className="text-text-secondary" />
          <span className="text-sm text-text-primary">时间轴</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={handleZoomOut}>
            <Icon name="minus" size={14} />
          </Button>
          <span className="text-xs text-text-secondary w-12 text-center">
            {Math.round(scale * 100)}%
          </span>
          <Button variant="ghost" size="sm" onClick={handleZoomIn}>
            <Icon name="plus" size={14} />
          </Button>
        </div>
      </div>

      {/* 时间轴主体 */}
      <div className="flex-1 relative overflow-hidden">
        {/* 帧标尺 */}
        <div 
          className="absolute top-0 left-0 right-0 h-6 border-b border-border overflow-hidden"
          onScroll={(e) => setScrollLeft((e.target as HTMLDivElement).scrollLeft)}
        >
          <div 
            className="h-full relative bg-bg-tertiary cursor-pointer"
            style={{ width: `${totalWidth}px` }}
            onClick={handleTimelineClick}
          >
            {/* 帧刻度 */}
            {Array.from({ length: Math.ceil(totalFrames / 5) }).map((_, i) => {
              const frame = i * 5
              return (
                <div
                  key={frame}
                  className="absolute top-0 h-full flex flex-col items-center"
                  style={{ left: `${frame * frameWidth}px` }}
                >
                  <span className="text-xs text-text-muted">{frame}</span>
                  <div className="flex-1 w-px bg-border" />
                </div>
              )
            })}

            {/* 当前帧指示器 */}
            <div
              ref={rulerPlayheadRef}
              className="absolute top-0 h-full w-0.5 bg-accent z-10"
              style={{ left: `${currentFrameRef.current * frameWidth}px` }}
            >
              <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-accent" />
            </div>
          </div>
        </div>

        {/* 图层轨道 */}
        <div 
          ref={containerRef}
          className="absolute top-6 left-0 right-0 bottom-0 overflow-auto"
          onScroll={(e) => {
            const target = e.target as HTMLDivElement
            setScrollLeft(target.scrollLeft)
            setScrollTop(target.scrollTop)
          }}
        >
          <div 
            className="relative"
            style={{ width: `${totalWidth}px`, height: `${totalTrackHeight}px` }}
            onClick={handleTimelineClick}
          >
            {/* 背景网格 */}
            <div className="absolute inset-0">
              {Array.from({ length: totalFrames }).map((_, i) => (
                <div
                  key={i}
                  className="absolute top-0 h-full border-r border-border/30"
                  style={{ left: `${i * frameWidth}px`, width: `${frameWidth}px` }}
                />
              ))}
            </div>

            {/* 图层轨道 */}
            {visibleSprites.map((sprite, offset) => {
              const layerIndex = visibleStart + offset
              return (
              <LayerTrack
                key={layerIndex}
                sprite={sprite}
                index={layerIndex}
                frameWidth={frameWidth}
                totalFrames={totalFrames}
              />
              )
            })}

            {/* 播放头 */}
            <div
              ref={trackPlayheadRef}
              className="absolute top-0 h-full w-0.5 bg-accent pointer-events-none z-20"
              style={{ left: `${currentFrameRef.current * frameWidth}px` }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

interface LayerTrackProps {
  sprite: any
  index: number
  frameWidth: number
  totalFrames: number
}

const LayerTrack: React.FC<LayerTrackProps> = React.memo(({ sprite, index, frameWidth, totalFrames }) => {
  const frames = sprite.frames || []
  const maxMarkers = 80
  const markerStep = Math.max(1, Math.ceil(frames.length / maxMarkers))
  const denseTrack = frames.length > maxMarkers

  return (
    <div 
      className="absolute left-0 right-0 h-8 border-b border-border"
      style={{ top: `${index * 32}px` }}
    >
      {/* 图层名称 */}
      <div className="absolute left-2 top-1/2 -translate-y-1/2 z-10 bg-bg-secondary pr-2">
        <span className="text-xs text-text-secondary truncate max-w-[100px] block">
          {sprite.imageKey || `Layer ${index + 1}`}
        </span>
      </div>

      {/* 关键帧标记 */}
      <div className="absolute inset-0">
        {denseTrack && (
          <div
            className="absolute top-1/2 -translate-y-1/2 h-1 bg-accent/40 rounded-full"
            style={{
              left: `${frameWidth / 2}px`,
              width: `${Math.max(frameWidth, (totalFrames - 1) * frameWidth)}px`
            }}
          />
        )}
        {frames.map((frame: any, i: number) => {
          if (denseTrack && i % markerStep !== 0 && i !== frames.length - 1) return null
          // 只在有变化的帧显示标记
          if (i === 0 || frame.transform || frame.alpha !== undefined) {
            return (
              <div
                key={i}
                className="absolute top-1/2 -translate-y-1/2 w-2 h-2 bg-accent rounded-full cursor-pointer hover:scale-150 transition-transform"
                style={{ left: `${i * frameWidth + frameWidth / 2 - 4}px` }}
                title={`Frame ${i}`}
              />
            )
          }
          return null
        })}
      </div>
    </div>
  )
})

LayerTrack.displayName = 'LayerTrack'
