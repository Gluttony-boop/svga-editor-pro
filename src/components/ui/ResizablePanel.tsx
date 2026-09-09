import React, { useState, useRef, useCallback, useEffect } from 'react'
import { cn } from '@/utils/cn'

export interface ResizablePanelProps {
  children: React.ReactNode
  className?: string
  /** 初始宽度/高度 (像素) */
  defaultSize?: number
  /** 最小宽度/高度 (像素) */
  minSize?: number
  /** 最大宽度/高度 (像素) */
  maxSize?: number
  /** 调整方向 */
  direction?: 'horizontal' | 'vertical'
  /** 调整大小的边 ('start' = 左/上, 'end' = 右/下) */
  resizeSide?: 'start' | 'end' | 'both'
  /** 尺寸变化回调 */
  onResize?: (size: number) => void
  /** 是否显示调整手柄 */
  showHandle?: boolean
}

/**
 * 可拖拽调整大小的面板组件
 */
export const ResizablePanel: React.FC<ResizablePanelProps> = ({
  children,
  className,
  defaultSize = 280,
  minSize = 150,
  maxSize = 500,
  direction = 'horizontal',
  resizeSide = 'end',
  onResize,
  showHandle = true
}) => {
  const [size, setSize] = useState(defaultSize)
  const [isResizing, setIsResizing] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const startPosRef = useRef(0)
  const startSizeRef = useRef(0)

  const handleMouseDown = useCallback((e: React.MouseEvent, _side: 'start' | 'end') => {
    e.preventDefault()
    setIsResizing(true)
    startPosRef.current = direction === 'horizontal' ? e.clientX : e.clientY
    startSizeRef.current = size
  }, [direction, size])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const currentPos = direction === 'horizontal' ? e.clientX : e.clientY
      const delta = currentPos - startPosRef.current
      
      let newSize: number
      if (resizeSide === 'start') {
        newSize = startSizeRef.current - delta
      } else {
        newSize = startSizeRef.current + delta
      }
      
      // 限制范围
      newSize = Math.max(minSize, Math.min(maxSize, newSize))
      
      setSize(newSize)
      onResize?.(newSize)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, direction, resizeSide, minSize, maxSize, onResize])

  const style: React.CSSProperties = direction === 'horizontal' 
    ? { width: size } 
    : { height: size }

  const resizeHandleClass = cn(
    'absolute flex items-center justify-center transition-colors z-10',
    direction === 'horizontal' 
      ? 'top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/30'
      : 'left-0 right-0 h-1 cursor-row-resize hover:bg-accent/30',
    isResizing && 'bg-accent/50'
  )

  return (
    <div
      ref={panelRef}
      className={cn('relative', className)}
      style={style}
    >
      {/* 左侧/上侧调整手柄 */}
      {showHandle && (resizeSide === 'start' || resizeSide === 'both') && (
        <div
          className={cn(resizeHandleClass, 'left-0')}
          onMouseDown={(e) => handleMouseDown(e, 'start')}
        >
          <div className={cn(
            'w-0.5 h-8 rounded-full bg-border',
            isResizing && 'bg-accent'
          )} />
        </div>
      )}
      
      {/* 内容区域 */}
      <div className="absolute inset-0 overflow-hidden">
        {children}
      </div>
      
      {/* 右侧/下侧调整手柄 */}
      {showHandle && (resizeSide === 'end' || resizeSide === 'both') && (
        <div
          className={cn(resizeHandleClass, 'right-0')}
          onMouseDown={(e) => handleMouseDown(e, 'end')}
        >
          <div className={cn(
            'w-0.5 h-8 rounded-full bg-border',
            isResizing && 'bg-accent'
          )} />
        </div>
      )}
    </div>
  )
}

/**
 * 可垂直调整大小的面板（用于上下分布的面板）
 */
export interface ResizableVerticalPanelProps {
  children: React.ReactNode
  className?: string
  defaultHeight?: number
  minHeight?: number
  maxHeight?: number
  onResize?: (height: number) => void
}

export const ResizableVerticalPanel: React.FC<ResizableVerticalPanelProps> = ({
  children,
  className,
  defaultHeight = 200,
  minHeight = 100,
  maxHeight = 500,
  onResize
}) => {
  return (
    <ResizablePanel
      className={className}
      direction="vertical"
      resizeSide="end"
      defaultSize={defaultHeight}
      minSize={minHeight}
      maxSize={maxHeight}
      onResize={onResize}
    >
      {children}
    </ResizablePanel>
  )
}

/**
 * 面板分割器 - 用于分割两个面板
 */
export interface PanelSplitterProps {
  className?: string
  direction?: 'horizontal' | 'vertical'
  onDrag: (delta: number) => void
}

export const PanelSplitter: React.FC<PanelSplitterProps> = ({
  direction = 'horizontal',
  onDrag,
  className
}) => {
  const [isDragging, setIsDragging] = useState(false)
  const startPosRef = useRef(0)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    startPosRef.current = direction === 'horizontal' ? e.clientX : e.clientY
  }, [direction])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const currentPos = direction === 'horizontal' ? e.clientX : e.clientY
      const delta = currentPos - startPosRef.current
      startPosRef.current = currentPos
      onDrag(delta)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, direction, onDrag])

  return (
    <div
      className={cn(
        'flex-shrink-0 transition-colors',
        direction === 'horizontal' 
          ? 'w-1 cursor-col-resize hover:bg-accent/30'
          : 'h-1 cursor-row-resize hover:bg-accent/30',
        isDragging && 'bg-accent/50',
        className
      )}
      onMouseDown={handleMouseDown}
    >
      <div className={cn(
        direction === 'horizontal' ? 'w-full h-full' : 'w-full h-full',
        'bg-border',
        isDragging && 'bg-accent'
      )} />
    </div>
  )
}
