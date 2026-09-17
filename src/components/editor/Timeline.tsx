import React, { useRef, useState, useEffect, useCallback, useLayoutEffect } from 'react'
import { Icon, Button } from '@/components/ui'
import { useEditorStore } from '@/stores'
import { cn } from '@/utils/cn'
import { getSelectedLayerIds } from '@/utils/layer-selection'
import { getLayerTimeOffset } from '@/core/layer-time'
import { EDITABLE_TRACKS, TRACK_LABELS, getKeyframeEditError } from '@/core/keyframe-editing'
import type { EasingType, LayerTracks } from '@/types'
import { TIMELINE_GUTTER as GUTTER, clampFrame, frameAtPointer, rulerStep, zoomScroll, fitFrameWidth, timelineRulerFrames } from '@/utils/timeline'
import { buildTimelineRows, findTimelineKey, keyframeAtDrag, keyframeMoveError, timelineInsertionError } from '@/utils/timeline-keyframes'
import type { TimelineKeySelection, TimelineTrackFilter } from '@/utils/timeline-keyframes'
import { TimelineLayerTrack, TimelinePropertyTrack } from './TimelineTrack'
import { TimelineKeyframeInspector } from './TimelineKeyframeInspector'

const RULER = 28, DEFAULT_HEIGHT = 280
interface TimelineProps { className?: string }
interface KeyframeDrag {
  selection: TimelineKeySelection
  pointer: number
  originalX: number
  originalScroll: number
  originalFrame: number
  originalSourceFrame: number
  originalOffset: number
  frame: number
}

export const Timeline: React.FC<TimelineProps> = ({ className }) => {
  const viewportRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelInputRef = useRef(false)
  const rulerHeadRef = useRef<HTMLDivElement>(null)
  const trackHeadRef = useRef<HTMLDivElement>(null)
  const currentColumnRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef(0)
  const dragRef = useRef<{ pointer: number; x: number } | null>(null)
  const keyDragRef = useRef<KeyframeDrag | null>(null)
  const pendingZoomRef = useRef<number | null>(null)
  const resizeRef = useRef<{ y:number; height:number } | null>(null)
  const [manualFrameWidth, setManualFrameWidth] = useState<number | null>(null)
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  const [expanded, setExpanded] = useState(false)
  const [compact, setCompact] = useState(false)
  const [windowHeight, setWindowHeight] = useState(() => typeof window === 'undefined' ? 900 : window.innerHeight)
  const [viewport, setViewport] = useState({ width: 600, height: 140, left: 0, top: 0 })
  const [follow, setFollow] = useState(true)
  const [scrubbing, setScrubbing] = useState(false)
  const [frameLabel, setFrameLabel] = useState('1')
  const [trackFilter, setTrackFilter] = useState<TimelineTrackFilter>('all')
  const [onlySelected, setOnlySelected] = useState(false)
  const [expansion, setExpansion] = useState<Record<string, boolean>>({})
  const [keySelection, setKeySelection] = useState<TimelineKeySelection | null>(null)
  const [keyPreview, setKeyPreview] = useState<{ selection: TimelineKeySelection; frame: number; error: string | null } | null>(null)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const videoItem = useEditorStore(s => s.videoItem)
  const totalFrames = useEditorStore(s => s.playback.totalFrames)
  const fps = useEditorStore(s => s.playback.fps)
  const storeFrame = useEditorStore(s => s.playback.currentFrame)
  const layers = useEditorStore(s => s.layers)
  const selectedLayerId = useEditorStore(s => s.selectedLayerId)
  const selectedLayerIds = useEditorStore(s => s.selectedLayerIds)
  const selectedIds = React.useMemo(() => getSelectedLayerIds({ layers, selectedLayerId, selectedLayerIds }), [layers, selectedLayerId, selectedLayerIds])
  const selectLayer = useEditorStore(s => s.selectLayer)
  const rows = React.useMemo(() => buildTimelineRows(layers, selectedLayerId, expansion, trackFilter, onlySelected, selectedIds), [layers, selectedLayerId, expansion, trackFilter, onlySelected, selectedIds])
  const selectedKey = findTimelineKey(layers, keySelection)
  const available = !!videoItem && totalFrames > 0
  const rowHeight = compact ? 24 : 28
  const automaticWidth = fitFrameWidth(viewport.width, totalFrames)
  const frameWidth = manualFrameWidth ?? automaticWidth
  const maxFrameWidth = Math.max(160, automaticWidth * 8)
  const maxHeight = Math.max(160, Math.min(640, Math.floor(windowHeight * 0.65)))
  const displayedHeight = Math.min(expanded ? 600 : height, maxHeight)

  const cancelKeyDrag = useCallback(() => {
    const drag = keyDragRef.current
    keyDragRef.current = null
    setKeyPreview(null)
    const el = viewportRef.current
    if (drag && el?.hasPointerCapture(drag.pointer)) el.releasePointerCapture(drag.pointer)
  }, [])

  useEffect(() => {
    const onResize = () => setWindowHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const readScroll = useCallback(() => {
    const el = viewportRef.current
    if (el) setViewport({ width: el.clientWidth, height: el.clientHeight, left: el.scrollLeft, top: el.scrollTop })
  }, [])
  const revealFrame = useCallback((frame: number, centered = false) => {
    const el = viewportRef.current
    if (!el || el.clientWidth <= GUTTER) return
    const width = el.clientWidth - GUTTER, x = frame * frameWidth
    if (centered || x < el.scrollLeft || x > el.scrollLeft + width - 24) {
      el.scrollLeft = zoomScroll(frame, centered ? width / 2 : 24, frameWidth, width, totalFrames)
      readScroll()
    }
  }, [frameWidth, totalFrames, readScroll])
  const paintFrame = useCallback((index: number) => {
    const frame = clampFrame(index, totalFrames)
    frameRef.current = frame
    const left = `${GUTTER + frame * frameWidth}px`
    if (rulerHeadRef.current) rulerHeadRef.current.style.left = left
    if (trackHeadRef.current) trackHeadRef.current.style.left = left
    if (currentColumnRef.current) currentColumnRef.current.style.left = left
    if (document.activeElement !== inputRef.current) setFrameLabel(String(frame + 1))
  }, [totalFrames, frameWidth])

  useEffect(() => {
    const receive = (event: Event) => {
      const frame = (event as CustomEvent<{frameIndex:number}>).detail.frameIndex
      paintFrame(frame)
      if (follow && !dragRef.current && !keyDragRef.current && useEditorStore.getState().playback.isPlaying) revealFrame(frame)
    }
    window.addEventListener('svga-frame-update', receive)
    window.addEventListener('svga-manual-frame', receive)
    return () => { window.removeEventListener('svga-frame-update', receive); window.removeEventListener('svga-manual-frame', receive) }
  }, [paintFrame, follow, revealFrame])
  useEffect(() => { paintFrame(storeFrame) }, [storeFrame, paintFrame])
  useEffect(() => {
    dragRef.current = null
    cancelKeyDrag()
    setScrubbing(false)
    setKeySelection(null)
    setExpansion({})
    setNotice(null)
    pendingZoomRef.current = null
    const el = viewportRef.current
    if (el) { el.scrollLeft = 0; el.scrollTop = 0 }
    setManualFrameWidth(null)
    readScroll()
  }, [videoItem, readScroll, cancelKeyDrag])
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    readScroll()
    const observer = new ResizeObserver(readScroll)
    observer.observe(el)
    return () => observer.disconnect()
  }, [readScroll])
  useLayoutEffect(() => {
    if (pendingZoomRef.current !== null && viewportRef.current) {
      viewportRef.current.scrollLeft = pendingZoomRef.current
      pendingZoomRef.current = null
    }
    paintFrame(frameRef.current)
    readScroll()
  }, [frameWidth, totalFrames, rows.length, paintFrame, readScroll])
  useEffect(() => {
    const index = rows.findIndex(row => row.layer.id === selectedLayerId), el = viewportRef.current
    if (index < 0 || !el) return
    const top = index * rowHeight
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + rowHeight > el.scrollTop + el.clientHeight - RULER) el.scrollTop = top + rowHeight - el.clientHeight + RULER
    readScroll()
  }, [selectedLayerId, rows, rowHeight, viewport.height, readScroll])

  useEffect(() => {
    if (keySelection && (selectedLayerId !== keySelection.layerId || !findTimelineKey(layers, keySelection))) {
      setKeySelection(null)
      cancelKeyDrag()
    }
  }, [selectedLayerId, layers, keySelection, cancelKeyDrag])

  useEffect(() => {
    const stop = () => { dragRef.current = null; resizeRef.current = null; setScrubbing(false); cancelKeyDrag() }
    window.addEventListener('blur', stop)
    return () => window.removeEventListener('blur', stop)
  }, [cancelKeyDrag])

  const seek = useCallback((index: number) => {
    if (!available) return
    const frame = clampFrame(index, totalFrames), state = useEditorStore.getState()
    state.setPlaying(false)
    state.setCurrentFrame(frame)
    paintFrame(frame)
    window.dispatchEvent(new CustomEvent('svga-manual-frame', {detail:{frameIndex:frame}}))
    window.dispatchEvent(new CustomEvent('svga-frame-update', {detail:{frameIndex:frame}}))
  }, [available, totalFrames, paintFrame])
  const seekPointer = useCallback((clientX: number) => {
    const el = viewportRef.current
    if (el) seek(frameAtPointer(clientX, el.getBoundingClientRect().left, el.scrollLeft, frameWidth, totalFrames))
  }, [frameWidth, totalFrames, seek])

  const selectTimelineKey = useCallback((selection: TimelineKeySelection) => {
    const state = useEditorStore.getState()
    const found = findTimelineKey(state.layers, selection)
    if (!found) return
    state.selectLayer(selection.layerId)
    state.setTransformEditMode('keyframe')
    setKeySelection(selection)
    setNotice(null)
    seek(found.outputFrame)
    revealFrame(found.outputFrame)
  }, [seek, revealFrame])

  const insertKeys = (layerIds: string[], tracks: (keyof LayerTracks)[], preserveSelection = false) => {
    // 播放器在暂停回调中同步实际画面帧，不能沿用暂停前的播放头缓存。
    useEditorStore.getState().setPlaying(false)
    const state = useEditorStore.getState()
    const frame = state.playback.currentFrame
    const ids = [...new Set(layerIds)]
    const error = timelineInsertionError(state.layers, ids, frame, state.playback.totalFrames)
    if (error) { setNotice({ text: error, error: true }); return }
    const result = state.insertAnimationKeyframes(ids, tracks, frame)
    if (result.error) { setNotice({ text: result.error, error: true }); return }
    const updated = useEditorStore.getState()
    updated.setTransformEditMode('keyframe')
    const track = tracks[0]
    if (preserveSelection && ids.length > 1) {
      // 批量插入仍维持图层多选，不将某个关键帧提升为唯一选中图层。
      setKeySelection(null)
      seek(frame)
    } else {
      const layer = updated.layers.find(item => item.id === ids[0])
      const key = layer?.animationTracks?.[track].keyframes.find(item => item.frameIndex + getLayerTimeOffset(layer) === frame)
      if (key) selectTimelineKey({ layerId: ids[0], track, keyId: key.id })
    }
    setExpansion(value => ({ ...value, ...Object.fromEntries(ids.map(id => [id, true])) }))
    if (trackFilter === 'animated' || (trackFilter !== 'all' && !tracks.includes(trackFilter))) setTrackFilter('all')
    setNotice({ text: result.changed ? `已为 ${ids.length} 个图层在第 ${frame + 1} 帧插入${tracks.length === 1 ? TRACK_LABELS[track] : '全部属性'}关键帧` : '当前帧已有关键帧，已保留原值。', error: false })
  }

  const moveKey = (selection: TimelineKeySelection, outputFrame: number) => {
    const state = useEditorStore.getState()
    const found = findTimelineKey(state.layers, selection)
    if (!found) { setNotice({ text: '关键帧已不存在，请重新选择。', error: true }); return }
    const error = keyframeMoveError(found.layer, selection.track, selection.keyId, outputFrame, state.playback.totalFrames)
    if (error) { setNotice({ text: error, error: true }); return }
    if (found.outputFrame === outputFrame) return
    const result = state.moveAnimationKeyframe(selection.layerId, selection.track, selection.keyId, outputFrame)
    setNotice({ text: result.error ?? (result.changed ? `关键帧已移到第 ${outputFrame + 1} 帧` : '关键帧位置未改变'), error: !!result.error })
    if (!result.error) { seek(outputFrame); revealFrame(outputFrame) }
  }

  const deleteSelectedKey = () => {
    if (!keySelection) { setNotice({ text: '请先选择一个关键帧；此处不会删除图层。', error: false }); return }
    const result = useEditorStore.getState().deleteAnimationKeyframes(keySelection.layerId, keySelection.track, [keySelection.keyId])
    setNotice({ text: result.error ?? '已删除关键帧，可撤销', error: !!result.error })
    if (!result.error) setKeySelection(null)
  }

  const setSelectedEasing = (easing: EasingType) => {
    if (!keySelection) { setNotice({ text: '请先选择关键帧，再设置缓动。', error: false }); return }
    const result = useEditorStore.getState().setAnimationEasing(keySelection.layerId, keySelection.track, [keySelection.keyId], easing)
    setNotice({ text: result.error ?? '已更新关键帧的出段缓动', error: !!result.error })
  }

  const beginKeyDrag = (event: React.PointerEvent<HTMLButtonElement>, selection: TimelineKeySelection) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    cancelKeyDrag()
    selectTimelineKey(selection)
    const el = viewportRef.current
    el?.focus({ preventScroll: true })
    const state = useEditorStore.getState()
    const found = findTimelineKey(state.layers, selection)
    if (!el || !found) return
    const error = getKeyframeEditError(found.layer, found.outputFrame, state.playback.totalFrames)
    if (error) { setNotice({ text: error, error: true }); return }
    keyDragRef.current = {
      selection, pointer: event.pointerId, originalX: event.clientX, originalScroll: el.scrollLeft,
      originalFrame: found.outputFrame, originalSourceFrame: found.keyframe.frameIndex,
      originalOffset: getLayerTimeOffset(found.layer), frame: found.outputFrame
    }
    el.setPointerCapture(event.pointerId)
  }

  const previewKeyDrag = (clientX: number) => {
    const drag = keyDragRef.current
    const el = viewportRef.current
    if (!drag || !el) return
    const frame = keyframeAtDrag(drag.originalFrame, clientX - drag.originalX, el.scrollLeft - drag.originalScroll, frameWidth)
    drag.frame = frame
    const state = useEditorStore.getState()
    const found = findTimelineKey(state.layers, drag.selection)
    const error = found ? keyframeMoveError(found.layer, drag.selection.track, drag.selection.keyId, frame, state.playback.totalFrames) : '关键帧已不存在，请重新选择。'
    setKeyPreview({ selection: drag.selection, frame, error })
  }

  const finishKeyDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = keyDragRef.current
    if (!drag || drag.pointer !== event.pointerId) return
    previewKeyDrag(event.clientX)
    const found = findTimelineKey(useEditorStore.getState().layers, drag.selection)
    cancelKeyDrag()
    if (!found || found.keyframe.frameIndex !== drag.originalSourceFrame || getLayerTimeOffset(found.layer) !== drag.originalOffset) {
      setNotice({ text: '拖动期间图层时间或关键帧已改变，请重新拖动。', error: true })
      return
    }
    moveKey(drag.selection, drag.frame)
  }

  const handleTimelineKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === 'F9') {
      event.preventDefault(); event.stopPropagation(); cancelKeyDrag(); setSelectedEasing('easeInOut'); return
    }
    if ((event.target as HTMLElement).closest('input,select,textarea,[contenteditable="true"]')) {
      if (event.key === 'Delete' || event.key === 'Backspace') event.stopPropagation()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      if (keyDragRef.current) { cancelKeyDrag(); setNotice({ text: '已取消关键帧移动', error: false }) }
      else setKeySelection(null)
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault(); event.stopPropagation(); cancelKeyDrag(); deleteSelectedKey(); return
    }
    const shortcuts: Record<string, TimelineTrackFilter> = { p: 'position', s: 'scale', r: 'rotation', t: 'alpha', u: 'animated' }
    const filter = shortcuts[event.key.toLowerCase()]
    if (filter) {
      event.preventDefault(); event.stopPropagation()
      setTrackFilter(value => value === filter ? 'all' : filter)
      if (selectedLayerId) setExpansion(value => ({ ...value, [selectedLayerId]: true }))
      return
    }
    const frame = event.key === 'ArrowLeft' ? frameRef.current - (event.shiftKey ? 10 : 1)
      : event.key === 'ArrowRight' ? frameRef.current + (event.shiftKey ? 10 : 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? totalFrames - 1 : null
    if (frame === null) return
    event.preventDefault(); event.stopPropagation(); seek(frame); revealFrame(clampFrame(frame, totalFrames))
  }
  useEffect(() => {
    if (!scrubbing) return
    let id = 0
    const tick = () => {
      const drag = dragRef.current, el = viewportRef.current
      if (drag && el) {
        const rect = el.getBoundingClientRect()
        const delta = drag.x < rect.left + GUTTER + 20 ? -12 : drag.x > rect.right - 20 ? 12 : 0
        if (delta) {
          const previous = el.scrollLeft
          el.scrollLeft += delta
          if (el.scrollLeft !== previous) { readScroll(); seekPointer(drag.x) }
        }
      }
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [scrubbing, readScroll, seekPointer])
  const zoom = useCallback((next: number, anchorX?: number) => {
    const el = viewportRef.current
    if (!available || !el) return
    const width = Math.max(1, el.clientWidth - GUTTER), currentX = frameRef.current * frameWidth - el.scrollLeft
    const x = anchorX ?? (currentX >= 0 && currentX <= width ? currentX : width / 2)
    const nextWidth = Math.max(0.000001, Math.min(maxFrameWidth, next))
    pendingZoomRef.current = zoomScroll((el.scrollLeft + x) / frameWidth, x, nextWidth, width, totalFrames)
    setManualFrameWidth(nextWidth)
  }, [available, frameWidth, totalFrames, maxFrameWidth])
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const wheel = (event: WheelEvent) => {
      if (!available) return
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        zoom(frameWidth * (event.deltaY < 0 ? 1.25 : 0.8), Math.max(0, event.clientX - el.getBoundingClientRect().left - GUTTER))
      } else if (event.shiftKey) { event.preventDefault(); el.scrollLeft += event.deltaY || event.deltaX; readScroll() }
    }
    el.addEventListener('wheel', wheel, {passive:false})
    return () => el.removeEventListener('wheel', wheel)
  }, [available, frameWidth, zoom, readScroll])
  const commitFrame = () => {
    if (cancelInputRef.current) { cancelInputRef.current=false; return }
    const text = frameLabel.trim(), value = Number(text)
    if (text && Number.isFinite(value)) { const frame = clampFrame(value - 1, totalFrames); seek(frame); revealFrame(frame, true); setFrameLabel(String(frame + 1)) }
    else setFrameLabel(String(frameRef.current + 1))
  }
  const start = clampFrame(Math.floor(viewport.left / frameWidth) - 1, totalFrames)
  const end = clampFrame(Math.ceil((viewport.left + Math.max(0, viewport.width - GUTTER)) / frameWidth) + 1, totalFrames)
  const step = rulerStep(frameWidth, totalFrames)
  const ticks = timelineRulerFrames(start, end, totalFrames, frameWidth)
  const firstRow = Math.max(0, Math.floor(viewport.top / rowHeight) - 2)
  const lastRow = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / rowHeight) + 2)
  const width = Math.max(viewport.width, GUTTER + totalFrames * frameWidth + 12)
  const contentHeight = RULER + Math.max(viewport.height - RULER, rows.length * rowHeight)
  const previewRow = keyPreview ? rows.findIndex(row => row.layer.id === keyPreview.selection.layerId && row.track === keyPreview.selection.track) : -1
  const insertionError = timelineInsertionError(layers, selectedIds, frameRef.current, totalFrames)
  const onLayerSelect = (id: string, additive?: boolean) => { cancelKeyDrag(); setKeySelection(null); selectLayer(id, additive) }

  return (
    <section aria-label="时间轴" onKeyDown={handleTimelineKeyDown} className={cn('flex flex-col flex-shrink-0 min-h-[160px] bg-bg-secondary border-t border-border', className)} style={{height:displayedHeight}}>
      <div role="separator" aria-label="调整时间轴高度" aria-orientation="horizontal" aria-valuemin={160} aria-valuemax={maxHeight} aria-valuenow={displayedHeight} tabIndex={0}
        className="h-2 flex-shrink-0 cursor-row-resize flex items-center justify-center hover:bg-accent/10 touch-none"
        onPointerDown={e => { if (e.button !== 0) return; resizeRef.current={y:e.clientY,height:displayedHeight}; e.currentTarget.setPointerCapture(e.pointerId) }}
        onPointerMove={e => { if (resizeRef.current) { setExpanded(false); setHeight(Math.max(160, Math.min(maxHeight, resizeRef.current.height + resizeRef.current.y - e.clientY))) } }}
        onPointerUp={() => { resizeRef.current=null }} onLostPointerCapture={() => { resizeRef.current=null }}
        onDoubleClick={() => {setExpanded(false);setHeight(DEFAULT_HEIGHT)}} onKeyDown={e => { if(e.key==='ArrowUp'||e.key==='ArrowDown') {e.preventDefault();e.stopPropagation();setExpanded(false);setHeight(Math.max(160,Math.min(maxHeight,displayedHeight+(e.key==='ArrowUp'?20:-20))))} }}><span className="h-0.5 w-10 rounded bg-border-light" /></div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2 border-b border-border">
        <span className="flex items-center gap-1.5 text-sm font-medium"><Icon name="timeline" size={15}/>时间轴</span>
        <button type="button" aria-label={expanded ? '收起时间轴' : '展开时间轴'} aria-expanded={expanded} aria-controls="timeline-tracks" onClick={() => setExpanded(value => !value)} title="展开可查看更多图层，再次点击恢复高度" className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-text-muted hover:bg-bg-tertiary hover:text-text-primary"><Icon name={expanded ? 'minimize' : 'maximize'} size={14}/>{expanded ? '收起' : '展开'}</button>
        <label className="flex items-center gap-1 text-xs text-text-muted ml-auto">帧
          <input ref={inputRef} aria-label="跳转到帧" type="text" inputMode="numeric" value={available ? frameLabel : '0'} disabled={!available}
            onChange={e=>setFrameLabel(e.target.value)} onBlur={commitFrame}
            onKeyDown={e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();commitFrame()}if(e.key==='Escape'){cancelInputRef.current=true;setFrameLabel(String(frameRef.current+1));e.currentTarget.blur()}}}
            className="w-14 rounded border border-border bg-bg-primary px-1.5 py-1 text-center font-mono text-text-primary" /> / {Math.max(0,totalFrames)}
        </label>
        <Button size="sm" variant="ghost" disabled={!available} title="定位播放头" onClick={()=>revealFrame(frameRef.current,true)}>定位</Button>
        <Button size="sm" variant={manualFrameWidth === null ? 'secondary' : 'ghost'} aria-pressed={manualFrameWidth === null} disabled={!available} title="适应全部帧" onClick={()=>{pendingZoomRef.current=0;setManualFrameWidth(null);if(viewportRef.current)viewportRef.current.scrollLeft=0;readScroll()}}>自适应</Button>
        <Button size="sm" variant="ghost" disabled={!available || frameWidth<=0.000001} title="缩小时间轴" onClick={()=>zoom(frameWidth/1.5)}><Icon name="minus" size={13}/></Button>
        <Button size="sm" variant="ghost" disabled={!available || frameWidth>=maxFrameWidth} title="放大时间轴" onClick={()=>zoom(frameWidth*1.5)}><Icon name="plus" size={13}/></Button>
        <button type="button" aria-label="紧凑轨道" aria-pressed={compact} onClick={()=>setCompact(value=>!value)} title="减小行高，在同一高度内显示更多图层" className={cn('rounded px-2 py-1 text-xs',compact?'bg-accent/10 text-accent':'text-text-muted')}>紧凑</button>
        <button type="button" aria-pressed={follow} onClick={()=>setFollow(!follow)} title="播放时自动滚动到播放头" className={cn('rounded px-2 py-1 text-xs',follow?'bg-accent/10 text-accent':'text-text-muted')}>跟随</button>
      </div>
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1 text-[11px]">
        <label className="flex items-center gap-1 text-text-muted">属性
          <select aria-label="时间轴属性筛选" value={trackFilter} onChange={event => setTrackFilter(event.target.value as TimelineTrackFilter)} className="rounded border border-border bg-bg-primary px-1 py-0.5 text-text-primary">
            <option value="all">全部属性</option><option value="position">位置（P）</option><option value="scale">缩放（S）</option><option value="rotation">旋转（R）</option><option value="alpha">透明度（T）</option><option value="animated">已有动画（U）</option>
          </select>
        </label>
        <button type="button" aria-pressed={onlySelected} onClick={() => setOnlySelected(value => !value)} title="仅查看当前选中的图层" className={cn('rounded px-1.5 py-0.5', onlySelected ? 'bg-accent/10 text-accent' : 'text-text-muted')}>仅选中图层</button>
        <button type="button" disabled={!available || !!insertionError} aria-describedby="timeline-insertion-hint" onClick={() => insertKeys(getSelectedLayerIds(useEditorStore.getState()), trackFilter === 'all' || trackFilter === 'animated' ? [...EDITABLE_TRACKS] : [trackFilter], true)}
          title={insertionError ?? `为选中的 ${selectedIds.length} 个图层在当前帧插入调整关键帧，保留已有值；任一图层不可编辑则整组不变`} className="rounded border border-accent/30 px-1.5 py-0.5 text-accent hover:bg-accent/10 disabled:opacity-30">◆ 插入关键帧</button>
        <span id="timeline-insertion-hint" className={cn('ml-auto truncate', insertionError && selectedIds.length ? 'text-error' : 'text-text-muted')} title={insertionError ?? '调整轨道叠加在原始逐帧动画上；拖动播放头不会自动创建关键帧'}>{selectedIds.length && insertionError ? insertionError : '调整轨道 · 保留原始动画'}</span>
      </div>
      {selectedKey && keySelection && <TimelineKeyframeInspector key={`${keySelection.layerId}:${keySelection.track}:${keySelection.keyId}`} layer={selectedKey.layer} track={keySelection.track} keyframe={selectedKey.keyframe} outputFrame={selectedKey.outputFrame} totalFrames={totalFrames}
        disabled={selectedKey.layer.locked || !selectedKey.layer.visible} onMove={frame => moveKey(keySelection, frame)} onEasing={setSelectedEasing} onDelete={deleteSelectedKey} />}
      <div ref={viewportRef} id="timeline-tracks" data-testid="timeline-scroll" className="relative flex-1 min-h-0 overflow-auto outline-none" tabIndex={0} aria-label="时间轴轨道，左右方向键逐帧，Shift 加速十帧，Home 和 End 跳首尾"
        onScroll={readScroll}
        onPointerDown={e=>{
          if(e.button!==0 || !available || (e.target as HTMLElement).closest('[data-layer-label],button,input,select'))return
          const el=e.currentTarget, rect=el.getBoundingClientRect()
          if(e.clientX<rect.left+GUTTER || e.clientX>=rect.left+el.clientWidth || e.clientY>=rect.top+el.clientHeight)return
          cancelKeyDrag();setKeySelection(null)
          e.preventDefault();el.focus({preventScroll:true});el.setPointerCapture(e.pointerId)
          dragRef.current={pointer:e.pointerId,x:e.clientX};setScrubbing(true);seekPointer(e.clientX)
          const layerId=(e.target as HTMLElement).closest<HTMLElement>('[data-track-layer]')?.dataset.trackLayer
          if(layerId)selectLayer(layerId)
        }}
        onPointerMove={e=>{
          if(keyDragRef.current?.pointer===e.pointerId){previewKeyDrag(e.clientX);return}
          if(dragRef.current?.pointer===e.pointerId){dragRef.current.x=e.clientX;seekPointer(e.clientX)}
        }}
        onPointerUp={e=>{
          if(keyDragRef.current?.pointer===e.pointerId){finishKeyDrag(e);return}
          if(dragRef.current?.pointer===e.pointerId){seekPointer(e.clientX);dragRef.current=null;setScrubbing(false);if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId)}
        }}
        onPointerCancel={()=>{dragRef.current=null;setScrubbing(false);cancelKeyDrag()}} onLostPointerCapture={()=>{dragRef.current=null;setScrubbing(false);cancelKeyDrag()}} style={{touchAction:'none'}}>
        {!available ? <div className="flex h-full items-center justify-center text-xs text-text-muted">打开 SVGA 文件后，拖动刻度即可逐帧查看</div> : <div className="relative" style={{width,height:contentHeight}}>
          <div className="sticky top-0 z-30 h-7 border-b border-border bg-bg-tertiary cursor-col-resize" data-testid="timeline-ruler">
            <div data-layer-label className="sticky left-0 z-40 flex h-full items-center border-r border-border bg-bg-tertiary px-3 text-[10px] text-text-muted" style={{width:GUTTER}}>图层 / 属性 · {onlySelected ? selectedIds.length : layers.length}</div>
            {ticks.map(frame=><div key={frame} data-timeline-tick={frame+1} className="absolute top-0 h-full border-l border-border-light text-[11px] text-text-secondary pointer-events-none" style={{left:GUTTER+frame*frameWidth}}><span className="absolute top-1 whitespace-nowrap" style={frame===totalFrames-1 && frameWidth<Math.max(24,String(totalFrames).length*7+12) ? {right:4} : {left:4}}>{frame+1}</span></div>)}
            <div ref={rulerHeadRef} className="absolute top-0 h-full w-px bg-accent pointer-events-none" style={{left:GUTTER+frameRef.current*frameWidth}}><span className="absolute -left-1 top-0 h-2 w-2 rotate-45 bg-accent" /></div>
          </div>
          <div className="absolute bottom-0 pointer-events-none" style={{left:GUTTER,top:RULER,width:totalFrames*frameWidth,backgroundImage:'linear-gradient(to right, #4a586b50 1px, transparent 1px)',backgroundSize:`${frameWidth >= 16 ? frameWidth : step*frameWidth}px 100%`}} />
          <div ref={currentColumnRef} data-testid="timeline-current-column" className="absolute bottom-0 pointer-events-none bg-accent/10" style={{top:RULER,left:GUTTER+frameRef.current*frameWidth,width:frameWidth}} />
          <div className="absolute bottom-0 border-l border-border-light pointer-events-none" style={{top:RULER,left:GUTTER+totalFrames*frameWidth}} />
          {rows.slice(firstRow,lastRow).map((row,offset) => row.track
            ? <TimelinePropertyTrack key={row.key} layer={row.layer} track={row.track} top={RULER+(firstRow+offset)*rowHeight} rowHeight={rowHeight} frameWidth={frameWidth} totalFrames={totalFrames} selected={selectedIds.includes(row.layer.id)} start={start} end={end}
                currentFrame={frameRef.current} selection={keySelection} onInsert={(id,track) => insertKeys([id],[track])} onKeySelect={selectTimelineKey} onKeyPointerDown={beginKeyDrag} />
            : <TimelineLayerTrack key={row.key} layer={row.layer} top={RULER+(firstRow+offset)*rowHeight} rowHeight={rowHeight} frameWidth={frameWidth} totalFrames={totalFrames} selected={selectedIds.includes(row.layer.id)} start={start} end={end}
                expanded={row.expanded} onExpand={(id,value) => setExpansion(previous => ({ ...previous, [id]:value }))} onSelect={onLayerSelect} />
          )}
          {keyPreview && previewRow >= 0 && <div className={cn('absolute z-[12] pointer-events-none border-l', keyPreview.error ? 'border-error text-error' : 'border-accent text-accent')}
            style={{ top: RULER+previewRow*rowHeight, left: GUTTER+Math.max(0,Math.min(totalFrames-1,keyPreview.frame))*frameWidth, height: rowHeight }}>
            <span className="absolute left-2 top-0.5 whitespace-nowrap rounded bg-bg-primary px-1 text-[10px] shadow">预览第 {keyPreview.frame+1} 帧{keyPreview.error ? ' · 不可放置' : ' · 松开应用'}</span>
            <span className="absolute -left-1 top-2 h-2 w-2 rotate-45 border border-current bg-bg-primary" />
          </div>}
          {!layers.length && <p className="sticky left-0 w-fit p-3 text-xs text-text-muted">暂无图层，可在上方刻度定位帧</p>}
          {layers.length > 0 && !rows.length && <p className="sticky left-0 w-fit p-3 text-xs text-text-muted">当前没有选中图层，可关闭“仅选中图层”筛选</p>}
          <div ref={trackHeadRef} className="absolute bottom-0 w-px bg-accent pointer-events-none z-10" style={{top:RULER,left:GUTTER+frameRef.current*frameWidth}} />
        </div>}
      </div>
      <div className="flex flex-shrink-0 justify-between gap-2 border-t border-border px-3 py-1 text-[10px] text-text-muted">
        <span role="status" aria-live="polite" className={cn('truncate', (keyPreview?.error || notice?.error) && 'text-error')} title={keyPreview?.error ?? notice?.text ?? 'P/S/R/T 筛选属性 · U 已有动画 · F9 缓动 · Delete 删除关键帧'}>{keyPreview?.error ?? notice?.text ?? '拖动定位 · Shift+滚轮横移 · Ctrl+滚轮缩放 · P/S/R/T/U 属性'}</span>
        <span className="whitespace-nowrap">{fps} FPS · {fps>0?(totalFrames/fps).toFixed(2):'—'} s</span>
      </div>
    </section>
  )
}
