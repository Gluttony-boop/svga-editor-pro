import React from 'react'
import { Icon, Button } from '@/components/ui'
import { useEditorStore } from '@/stores'
import { AnimationEngine } from '@/core'
import type { Layer, Keyframe, LayerTracks } from '@/types'
import { cn } from '@/utils/cn'

interface TimelinePanelProps {
  className?: string
}

/**
 * 时间轴编辑器
 * 支持关键帧编辑、图层轨道、播放控制
 */
export const TimelinePanel: React.FC<TimelinePanelProps> = ({ className }) => {
  const params = useEditorStore((s) => s.params)
  const layers = useEditorStore((s) => s.layers)
  const selectedLayerId = useEditorStore((s) => s.selectedLayerId)
  // 细粒度订阅，避免订阅整个 playback 对象
  const isPlaying = useEditorStore((s) => s.playback.isPlaying)
  const currentFrame = useEditorStore((s) => s.playback.currentFrame)
  const loop = useEditorStore((s) => s.playback.loop)
  const speed = useEditorStore((s) => s.playback.speed)
  const setCurrentFrame = useEditorStore((s) => s.setCurrentFrame)
  const setPlaying = useEditorStore((s) => s.setPlaying)
  const toggleLoop = useEditorStore((s) => s.toggleLoop)
  const setSpeed = useEditorStore((s) => s.setSpeed)
  const addLayerKeyframe = useEditorStore((s) => s.addLayerKeyframe)
  const updateLayerKeyframe = useEditorStore((s) => s.updateLayerKeyframe)
  const deleteLayerKeyframe = useEditorStore((s) => s.deleteLayerKeyframe)

  const timelineRef = React.useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = React.useState(1)
  const [scrollOffset, setScrollOffset] = React.useState(0)
  const [selectedKeyframes, setSelectedKeyframes] = React.useState<Set<string>>(new Set())
  const [draggedKeyframe, setDraggedKeyframe] = React.useState<{
    layerId: string
    trackKey: keyof LayerTracks
    keyframeId: string
    startFrame: number
  } | null>(null)

  // 计算帧宽度
  const frameWidth = 10 * zoom
  const totalWidth = (params?.frames || 60) * frameWidth

  // 跳转到指定帧
  const handleSeek = (frame: number) => {
    if (params) {
      setCurrentFrame(Math.max(0, Math.min(params.frames - 1, frame)))
    }
  }

  // 播放/暂停
  const handlePlayPause = () => {
    setPlaying(!isPlaying)
  }

  // 上一帧/下一帧
  const handlePrevFrame = () => {
    handleSeek(currentFrame - 1)
  }

  const handleNextFrame = () => {
    handleSeek(currentFrame + 1)
  }

  // 跳转到开头/结尾
  const handleGoToStart = () => {
    handleSeek(0)
  }

  const handleGoToEnd = () => {
    if (params) {
      handleSeek(params.frames - 1)
    }
  }

  // 时间线点击
  const handleTimelineClick = (e: React.MouseEvent) => {
    const rect = timelineRef.current?.getBoundingClientRect()
    if (!rect) return

    const x = e.clientX - rect.left + scrollOffset
    const frame = Math.round(x / frameWidth)
    handleSeek(frame)
  }

  // 添加关键帧
  const handleAddKeyframe = (
    layerId: string,
    trackKey: keyof LayerTracks,
    frameIndex: number
  ) => {
    const layer = layers.find(l => l.id === layerId)
    if (!layer) return

    const track = layer.tracks[trackKey]
    
    // 检查是否已存在该帧的关键帧
    const existing = track.keyframes.find(kf => kf.frameIndex === frameIndex)
    if (existing) return

    // 获取当前值
    const currentValue = AnimationEngine.interpolateProperty(
      track.keyframes,
      frameIndex,
      track.defaultValue,
      (a, b, t) => {
        if (typeof a === 'number' && typeof b === 'number') {
          return a + (b - a) * t
        }
        if (typeof a === 'object' && typeof b === 'object') {
          const result: any = {}
          for (const key in a) {
            result[key] = (a as any)[key] + ((b as any)[key] - (a as any)[key]) * t
          }
          return result
        }
        return a
      }
    )

    addLayerKeyframe(layerId, trackKey, {
      frameIndex,
      value: currentValue,
      easing: 'linear'
    })
  }

  // 删除关键帧
  const handleDeleteKeyframe = (
    layerId: string,
    trackKey: keyof LayerTracks,
    keyframeId: string
  ) => {
    deleteLayerKeyframe(layerId, trackKey, keyframeId)
    setSelectedKeyframes(prev => {
      const next = new Set(prev)
      next.delete(keyframeId)
      return next
    })
  }

  // 关键帧拖拽开始
  const handleKeyframeDragStart = (
    e: React.MouseEvent,
    layerId: string,
    trackKey: keyof LayerTracks,
    keyframeId: string,
    currentFrame: number
  ) => {
    e.stopPropagation()
    setDraggedKeyframe({
      layerId,
      trackKey,
      keyframeId,
      startFrame: currentFrame
    })

    // 选中关键帧
    setSelectedKeyframes(new Set([keyframeId]))
  }

  // 关键帧拖拽移动
  const handleKeyframeDrag = React.useCallback((e: MouseEvent) => {
    if (!draggedKeyframe) return

    const rect = timelineRef.current?.getBoundingClientRect()
    if (!rect) return

    const x = e.clientX - rect.left + scrollOffset
    const newFrame = Math.round(x / frameWidth)
    const frameDelta = newFrame - draggedKeyframe.startFrame

    if (frameDelta !== 0) {
      const layer = layers.find(l => l.id === draggedKeyframe.layerId)
      if (!layer) return

      const keyframe = layer.tracks[draggedKeyframe.trackKey].keyframes.find(
        kf => kf.id === draggedKeyframe.keyframeId
      )
      if (!keyframe) return

      const newFrameIndex = Math.max(0, keyframe.frameIndex + frameDelta)
      updateLayerKeyframe(
        draggedKeyframe.layerId,
        draggedKeyframe.trackKey,
        draggedKeyframe.keyframeId,
        { frameIndex: newFrameIndex }
      )

      setDraggedKeyframe(prev => prev ? { ...prev, startFrame: newFrame } : null)
    }
  }, [draggedKeyframe, frameWidth, scrollOffset, layers, updateLayerKeyframe])

  // 关键帧拖拽结束
  const handleKeyframeDragEnd = React.useCallback(() => {
    setDraggedKeyframe(null)
  }, [])

  // 注册拖拽事件
  React.useEffect(() => {
    if (draggedKeyframe) {
      window.addEventListener('mousemove', handleKeyframeDrag)
      window.addEventListener('mouseup', handleKeyframeDragEnd)
      return () => {
        window.removeEventListener('mousemove', handleKeyframeDrag)
        window.removeEventListener('mouseup', handleKeyframeDragEnd)
      }
    }
  }, [draggedKeyframe, handleKeyframeDrag, handleKeyframeDragEnd])

  if (!params) {
    return (
      <div className={cn('bg-bg-secondary border-t border-border p-4', className)}>
        <div className="text-center text-text-muted text-sm">
          打开 SVGA 文件以使用时间轴
        </div>
      </div>
    )
  }

  return (
    <div className={cn('bg-bg-secondary border-t border-border flex flex-col', className)}>
      {/* 控制栏 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-bg-primary/50">
        {/* 播放控制 */}
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={handleGoToStart} title="跳到开头">
            <Icon name="skip-back" size={16} />
          </Button>
          <Button variant="ghost" size="sm" onClick={handlePrevFrame} title="上一帧">
            <Icon name="chevron-left" size={16} />
          </Button>
          <Button 
            variant="primary" 
            size="sm" 
            onClick={handlePlayPause}
            className="w-10"
          >
            <Icon name={isPlaying ? 'pause' : 'play'} size={16} />
          </Button>
          <Button variant="ghost" size="sm" onClick={handleNextFrame} title="下一帧">
            <Icon name="chevron-right" size={16} />
          </Button>
          <Button variant="ghost" size="sm" onClick={handleGoToEnd} title="跳到结尾">
            <Icon name="skip-forward" size={16} />
          </Button>
        </div>

        {/* 循环按钮 */}
        <Button 
          variant={loop ? 'primary' : 'ghost'} 
          size="sm" 
          onClick={toggleLoop}
          title="循环播放"
        >
          <Icon name="repeat" size={16} />
        </Button>

        {/* 帧信息 */}
        <div className="flex items-center gap-2 text-sm text-text-secondary ml-4">
          <span className="font-mono">
            {currentFrame} / {params.frames}
          </span>
          <span className="text-text-muted">|</span>
          <span>{params.fps} FPS</span>
        </div>

        {/* 速度控制 */}
        <div className="flex items-center gap-2 ml-4">
          <span className="text-xs text-text-muted">速度:</span>
          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            className="bg-bg-tertiary border border-border rounded px-2 py-1 text-sm"
          >
            <option value={0.25}>0.25x</option>
            <option value={0.5}>0.5x</option>
            <option value={1}>1x</option>
            <option value={1.5}>1.5x</option>
            <option value={2}>2x</option>
          </select>
        </div>

        {/* 缩放控制 */}
        <div className="flex items-center gap-2 ml-auto">
          <Icon name="zoom-out" size={14} className="text-text-muted" />
          <input
            type="range"
            min="0.5"
            max="3"
            step="0.1"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-20"
          />
          <Icon name="zoom-in" size={14} className="text-text-muted" />
        </div>
      </div>

      {/* 时间轴区域 */}
      <div className="flex flex-1 min-h-0">
        {/* 图层列表 */}
        <div className="w-48 border-r border-border flex-shrink-0 overflow-y-auto">
          <div className="h-8 border-b border-border bg-bg-tertiary/50" />
          {layers.map(layer => (
            <LayerTrackLabel
              key={layer.id}
              layer={layer}
              selected={selectedLayerId === layer.id}
              onAddKeyframe={(trackKey) => 
                handleAddKeyframe(layer.id, trackKey, currentFrame)
              }
            />
          ))}
        </div>

        {/* 时间轴网格 */}
        <div 
          ref={timelineRef}
          className="flex-1 overflow-x-auto overflow-y-auto relative"
          onClick={handleTimelineClick}
          onScroll={(e) => setScrollOffset(e.currentTarget.scrollLeft)}
        >
          {/* 帧标尺 */}
          <div 
            className="h-8 border-b border-border bg-bg-tertiary/50 sticky top-0 z-10"
            style={{ width: totalWidth }}
          >
            <FrameRuler 
              frames={params.frames} 
              frameWidth={frameWidth} 
              currentFrame={currentFrame}
            />
          </div>

          {/* 播放头 */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-accent z-20 pointer-events-none"
            style={{ 
              left: currentFrame * frameWidth,
              height: 32 + layers.length * 32 * 4 // 标尺 + 图层轨道
            }}
          >
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 bg-accent rounded-full" />
          </div>

          {/* 图层轨道 */}
          {layers.map(layer => (
            <LayerTrack
              key={layer.id}
              layer={layer}
              frames={params.frames}
              frameWidth={frameWidth}
              selected={selectedLayerId === layer.id}
              selectedKeyframes={selectedKeyframes}
              currentFrame={currentFrame}
              onAddKeyframe={(trackKey, frame) => 
                handleAddKeyframe(layer.id, trackKey, frame)
              }
              onDeleteKeyframe={(trackKey, keyframeId) =>
                handleDeleteKeyframe(layer.id, trackKey, keyframeId)
              }
              onKeyframeDragStart={(trackKey, keyframeId, frame) =>
                handleKeyframeDragStart(
                  {} as React.MouseEvent,
                  layer.id,
                  trackKey,
                  keyframeId,
                  frame
                )
              }
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * 帧标尺组件
 */
const FrameRuler: React.FC<{
  frames: number
  frameWidth: number
  currentFrame: number
}> = ({ frames, frameWidth, currentFrame }) => {
  // 计算刻度间隔
  const getTickInterval = () => {
    if (frameWidth >= 20) return 5
    if (frameWidth >= 10) return 10
    return 20
  }

  const tickInterval = getTickInterval()

  return (
    <div className="relative h-full">
      {Array.from({ length: frames + 1 }, (_, i) => {
        const isMajor = i % tickInterval === 0
        const isCurrent = i === currentFrame

        return (
          <div
            key={i}
            className={cn(
              'absolute top-0 h-full',
              isMajor ? 'border-l border-border' : 'border-l border-border/30'
            )}
            style={{ left: i * frameWidth }}
          >
            {isMajor && (
              <span className={cn(
                'absolute top-1 left-1 text-xs',
                isCurrent ? 'text-accent font-bold' : 'text-text-muted'
              )}>
                {i}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * 图层轨道标签
 */
const LayerTrackLabel: React.FC<{
  layer: Layer
  selected: boolean
  onAddKeyframe: (trackKey: keyof LayerTracks) => void
}> = ({ layer, selected, onAddKeyframe }) => {
  const [expanded, setExpanded] = React.useState(true)

  const trackLabels: Array<{ key: keyof LayerTracks; label: string; icon: string }> = [
    { key: 'position', label: '位置', icon: 'move' },
    { key: 'scale', label: '缩放', icon: 'maximize' },
    { key: 'rotation', label: '旋转', icon: 'rotate-cw' },
    { key: 'alpha', label: '透明度', icon: 'opacity' }
  ]

  return (
    <div className={cn('border-b border-border', selected && 'bg-accent/10')}>
      <div 
        className="flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-bg-tertiary/50"
        onClick={() => setExpanded(!expanded)}
      >
        <Icon 
          name={expanded ? 'chevron-down' : 'chevron-right'} 
          size={12} 
          className="text-text-muted" 
        />
        <span className="text-xs truncate flex-1">{layer.name}</span>
        {layer.isNew && (
          <span className="text-xs text-success">新</span>
        )}
      </div>
      
      {expanded && trackLabels.map(({ key, label, icon }) => (
        <div 
          key={key}
          className="flex items-center gap-2 px-2 py-0.5 hover:bg-bg-tertiary/30 cursor-pointer"
          onClick={() => onAddKeyframe(key)}
        >
          <Icon name={icon} size={10} className="text-text-muted" />
          <span className="text-xs text-text-muted">{label}</span>
          {layer.tracks[key].keyframes.length > 0 && (
            <span className="text-xs text-accent ml-auto">
              {layer.tracks[key].keyframes.length}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * 图层轨道组件
 */
const LayerTrack: React.FC<{
  layer: Layer
  frames: number
  frameWidth: number
  selected: boolean
  selectedKeyframes: Set<string>
  currentFrame: number
  onAddKeyframe: (trackKey: keyof LayerTracks, frame: number) => void
  onDeleteKeyframe: (trackKey: keyof LayerTracks, keyframeId: string) => void
  onKeyframeDragStart: (trackKey: keyof LayerTracks, keyframeId: string, frame: number) => void
}> = ({
  layer,
  frames,
  frameWidth,
  selected,
  selectedKeyframes,
  currentFrame: _currentFrame,
  onAddKeyframe,
  onDeleteKeyframe,
  onKeyframeDragStart
}) => {
  const trackKeys: Array<keyof LayerTracks> = ['position', 'scale', 'rotation', 'alpha']

  return (
    <div 
      className={cn('border-b border-border', selected && 'bg-accent/5')}
      style={{ width: frames * frameWidth }}
    >
      {trackKeys.map(trackKey => (
        <div
          key={trackKey}
          className="h-8 relative border-b border-border/50"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            const x = e.clientX - rect.left
            const frame = Math.round(x / frameWidth)
            onAddKeyframe(trackKey, frame)
          }}
        >
          {/* 关键帧 */}
          {layer.tracks[trackKey].keyframes.map(kf => (
            <KeyframeDiamond
              key={kf.id}
              keyframe={kf}
              frameWidth={frameWidth}
              selected={selectedKeyframes.has(kf.id)}
              onDragStart={(_e) => onKeyframeDragStart(trackKey, kf.id, kf.frameIndex)}
              onDelete={() => onDeleteKeyframe(trackKey, kf.id)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * 关键帧菱形标记
 */
const KeyframeDiamond: React.FC<{
  keyframe: Keyframe
  frameWidth: number
  selected: boolean
  onDragStart: (e: React.MouseEvent) => void
  onDelete: () => void
}> = ({ keyframe, frameWidth, selected, onDragStart, onDelete }) => {
  const [showMenu, setShowMenu] = React.useState(false)

  return (
    <div
      className={cn(
        'absolute top-1/2 -translate-y-1/2 w-3 h-3 cursor-pointer',
        'transform rotate-45 transition-colors',
        selected ? 'bg-accent' : 'bg-primary hover:bg-accent/70'
      )}
      style={{ left: keyframe.frameIndex * frameWidth - 6 }}
      onMouseDown={(e) => {
        e.stopPropagation()
        onDragStart(e)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setShowMenu(true)
      }}
    >
      {showMenu && (
        <div 
          className="absolute top-full left-0 z-30 bg-bg-secondary border border-border rounded shadow-lg p-1 min-w-20"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-xs text-text-muted px-2 py-1">帧 {keyframe.frameIndex}</div>
          <select
            value={keyframe.easing}
            onChange={() => {
              // 这里应该调用 updateLayerKeyframe
              setShowMenu(false)
            }}
            className="w-full text-xs bg-bg-tertiary border border-border rounded px-1 py-0.5"
            onClick={(e) => e.stopPropagation()}
          >
            <option value="linear">线性</option>
            <option value="easeIn">缓入</option>
            <option value="easeOut">缓出</option>
            <option value="easeInOut">缓入缓出</option>
          </select>
          <button
            className="w-full text-xs text-error hover:bg-error/20 rounded px-2 py-1 mt-1"
            onClick={() => {
              onDelete()
              setShowMenu(false)
            }}
          >
            删除关键帧
          </button>
        </div>
      )}
    </div>
  )
}
