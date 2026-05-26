import React, { useEffect, useState } from 'react'
import { Icon, Button } from '@/components/ui'
import { useEditorStore } from '@/stores'
import { cn } from '@/utils/cn'

interface PlaybackControlsProps {
  className?: string
}

export const PlaybackControls: React.FC<PlaybackControlsProps> = ({ className }) => {
  // 细粒度订阅，避免订阅整个 playback 对象
  const isPlaying = useEditorStore((s) => s.playback.isPlaying)
  const totalFrames = useEditorStore((s) => s.playback.totalFrames)
  const playbackFps = useEditorStore((s) => s.playback.fps)
  const loop = useEditorStore((s) => s.playback.loop)
  const speed = useEditorStore((s) => s.playback.speed)
  const storeCurrentFrame = useEditorStore((s) => s.playback.currentFrame)
  
  const params = useEditorStore((s) => s.params)
  const setPlaying = useEditorStore((s) => s.setPlaying)
  const setCurrentFrame = useEditorStore((s) => s.setCurrentFrame)
  const toggleLoop = useEditorStore((s) => s.toggleLoop)
  const setSpeed = useEditorStore((s) => s.setSpeed)
  
  // 本地帧状态，用于播放时更新 UI
  const [currentFrame, setCurrentFrameLocal] = useState(storeCurrentFrame)
  
  // 性能监控
  const [fps, setFps] = useState(0)
  
  // 监听动画播放时的帧更新事件
  useEffect(() => {
    const handleFrameUpdate = (e: CustomEvent<{ frameIndex: number }>) => {
      setCurrentFrameLocal(e.detail.frameIndex)
    }
    const handleFpsUpdate = (e: CustomEvent<{ fps: number }>) => {
      setFps(e.detail.fps)
    }
    
    window.addEventListener('svga-frame-update', handleFrameUpdate as EventListener)
    window.addEventListener('svga-fps-update', handleFpsUpdate as EventListener)
    
    return () => {
      window.removeEventListener('svga-frame-update', handleFrameUpdate as EventListener)
      window.removeEventListener('svga-fps-update', handleFpsUpdate as EventListener)
    }
  }, [])

  // 当 params 变化时，重置本地状态
  useEffect(() => {
    if (params) {
      setCurrentFrameLocal(storeCurrentFrame)
    }
  }, [params, storeCurrentFrame])



  const handlePrevFrame = () => {
    const newFrame = currentFrame - 1
    if (newFrame >= 0) {
      setCurrentFrame(newFrame)
      setCurrentFrameLocal(newFrame)
      // 触发手动帧更新事件
      window.dispatchEvent(new CustomEvent('svga-manual-frame', { detail: { frameIndex: newFrame } }))
    }
  }

  const handleNextFrame = () => {
    const newFrame = currentFrame + 1
    if (newFrame < totalFrames) {
      setCurrentFrame(newFrame)
      setCurrentFrameLocal(newFrame)
      // 触发手动帧更新事件
      window.dispatchEvent(new CustomEvent('svga-manual-frame', { detail: { frameIndex: newFrame } }))
    }
  }

  const handleFirstFrame = () => {
    setCurrentFrame(0)
    setCurrentFrameLocal(0)
    // 触发手动帧更新事件
    window.dispatchEvent(new CustomEvent('svga-manual-frame', { detail: { frameIndex: 0 } }))
  }

  const handleLastFrame = () => {
    const lastFrame = totalFrames - 1
    setCurrentFrame(lastFrame)
    setCurrentFrameLocal(lastFrame)
    // 触发手动帧更新事件
    window.dispatchEvent(new CustomEvent('svga-manual-frame', { detail: { frameIndex: lastFrame } }))
  }

  const formatTime = (frame: number, fps: number) => {
    const seconds = Math.floor(frame / fps)
    const frames = frame % fps
    const minutes = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${minutes}:${secs.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`
  }

  const speeds = [0.25, 0.5, 1, 2, 4]

  return (
    <div className={cn(
      'flex items-center gap-4 px-6 py-3 bg-bg-secondary border-t border-border',
      className
    )}>
      {/* 播放控制按钮 */}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleFirstFrame}
          disabled={!params}
          title="第一帧"
        >
          <Icon name="skip-start" size={18} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handlePrevFrame}
          disabled={!params}
          title="上一帧"
        >
          <Icon name="step-back" size={18} />
        </Button>
        <Button
          variant={isPlaying ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setPlaying(!isPlaying)}
          disabled={!params}
          title={isPlaying ? '暂停' : '播放'}
          className="w-10"
        >
          <Icon name={isPlaying ? 'pause' : 'play'} size={18} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleNextFrame}
          disabled={!params}
          title="下一帧"
        >
          <Icon name="step-forward" size={18} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleLastFrame}
          disabled={!params}
          title="最后帧"
        >
          <Icon name="skip-end" size={18} />
        </Button>
      </div>

      {/* 时间显示 */}
      <div className="flex items-center gap-2 text-sm font-mono">
        <span className="text-text-primary">
          {formatTime(currentFrame, playbackFps)}
        </span>
        <span className="text-text-muted">/</span>
        <span className="text-text-secondary">
          {formatTime(totalFrames, playbackFps)}
        </span>
      </div>

      {/* 帧滑块 */}
      <div className="flex-1">
        <input
          type="range"
          min={0}
          max={totalFrames - 1 || 0}
          value={currentFrame}
          onChange={(e) => {
            const newFrame = parseInt(e.target.value)
            setCurrentFrame(newFrame)
            setCurrentFrameLocal(newFrame)
            // 触发手动帧更新事件
            window.dispatchEvent(new CustomEvent('svga-manual-frame', { detail: { frameIndex: newFrame } }))
          }}
          disabled={!params}
          className="w-full h-1 bg-border rounded-lg appearance-none cursor-pointer
                     [&::-webkit-slider-thumb]:appearance-none
                     [&::-webkit-slider-thumb]:w-3
                     [&::-webkit-slider-thumb]:h-3
                     [&::-webkit-slider-thumb]:bg-accent
                     [&::-webkit-slider-thumb]:rounded-full
                     [&::-webkit-slider-thumb]:cursor-pointer"
        />
      </div>

      {/* 帧数显示 */}
      <div className="text-sm text-text-secondary font-mono">
        {currentFrame + 1} / {totalFrames}
      </div>

      <div className="w-px h-6 bg-border" />

      {/* FPS 显示 */}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-text-muted">FPS:</span>
        <span className="text-text-primary font-mono">{playbackFps}</span>
      </div>

      {/* 性能监控 */}
      {isPlaying && (
        <div className="flex items-center gap-2 text-sm">
          <div className={cn(
            'px-2 py-0.5 rounded text-xs font-mono',
            fps >= playbackFps * 0.9 
              ? 'bg-green-500/20 text-green-400'
              : fps >= playbackFps * 0.7
                ? 'bg-yellow-500/20 text-yellow-400'
                : 'bg-red-500/20 text-red-400'
          )}>
            {fps} FPS
          </div>
        </div>
      )}

      {/* 循环按钮 */}
      <Button
        variant={loop ? 'primary' : 'ghost'}
        size="sm"
        onClick={toggleLoop}
        disabled={!params}
        title={loop ? '关闭循环' : '开启循环'}
      >
        <Icon name="loop" size={18} />
      </Button>

      {/* 速度控制 */}
      <div className="flex items-center gap-1">
        {speeds.map((s) => (
          <button
            key={s}
            className={cn(
              'px-2 py-1 text-xs rounded transition-colors',
              speed === s
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary'
            )}
            onClick={() => setSpeed(s)}
          >
            {s}x
          </button>
        ))}
      </div>
    </div>
  )
}
