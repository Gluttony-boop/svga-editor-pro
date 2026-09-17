import React, { useRef, useState, useEffect, useCallback, useLayoutEffect } from 'react'
import { Icon, Button } from '@/components/ui'
import { useEditorStore } from '@/stores'
import { cn } from '@/utils/cn'
import { getSelectedLayerIds } from '@/utils/layer-selection'
import { getLayerTimeOffset, getLayerOutputRange } from '@/core/layer-time'
import type { Layer, Keyframe } from '@/types'
import { TIMELINE_GUTTER as GUTTER, clampFrame, frameAtPointer, rulerStep, zoomScroll, fitFrameWidth, clipRange, timelineRulerFrames } from '@/utils/timeline'

const RULER = 28, DEFAULT_HEIGHT = 280
interface TimelineProps { className?: string }

export const Timeline: React.FC<TimelineProps> = ({ className }) => {
  const viewportRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelInputRef = useRef(false)
  const rulerHeadRef = useRef<HTMLDivElement>(null)
  const trackHeadRef = useRef<HTMLDivElement>(null)
  const currentColumnRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef(0)
  const dragRef = useRef<{ pointer: number; x: number } | null>(null)
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
  const videoItem = useEditorStore(s => s.videoItem)
  const totalFrames = useEditorStore(s => s.playback.totalFrames)
  const fps = useEditorStore(s => s.playback.fps)
  const storeFrame = useEditorStore(s => s.playback.currentFrame)
  const layers = useEditorStore(s => s.layers)
  const selectedLayerId = useEditorStore(s => s.selectedLayerId)
  const selectedLayerIds = useEditorStore(s => s.selectedLayerIds)
  const selectedIds = React.useMemo(() => getSelectedLayerIds({ layers, selectedLayerId, selectedLayerIds }), [layers, selectedLayerId, selectedLayerIds])
  const selectLayer = useEditorStore(s => s.selectLayer)
  const available = !!videoItem && totalFrames > 0
  const rowHeight = compact ? 24 : 28
  const automaticWidth = fitFrameWidth(viewport.width, totalFrames)
  const frameWidth = manualFrameWidth ?? automaticWidth
  const maxFrameWidth = Math.max(160, automaticWidth * 8)
  const maxHeight = Math.max(160, Math.min(640, Math.floor(windowHeight * 0.65)))
  const displayedHeight = Math.min(expanded ? 600 : height, maxHeight)

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
      if (follow && !dragRef.current && useEditorStore.getState().playback.isPlaying) revealFrame(frame)
    }
    window.addEventListener('svga-frame-update', receive)
    window.addEventListener('svga-manual-frame', receive)
    return () => { window.removeEventListener('svga-frame-update', receive); window.removeEventListener('svga-manual-frame', receive) }
  }, [paintFrame, follow, revealFrame])
  useEffect(() => { paintFrame(storeFrame) }, [storeFrame, paintFrame])
  useEffect(() => {
    dragRef.current = null
    setScrubbing(false)
    pendingZoomRef.current = null
    const el = viewportRef.current
    if (el) { el.scrollLeft = 0; el.scrollTop = 0 }
    setManualFrameWidth(null)
    readScroll()
  }, [videoItem, readScroll])
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
  }, [frameWidth, totalFrames, layers.length, paintFrame, readScroll])
  useEffect(() => {
    const index = layers.findIndex(layer => layer.id === selectedLayerId), el = viewportRef.current
    if (index < 0 || !el) return
    const top = index * rowHeight
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + rowHeight > el.scrollTop + el.clientHeight - RULER) el.scrollTop = top + rowHeight - el.clientHeight + RULER
    readScroll()
  }, [selectedLayerId, layers, rowHeight, viewport.height, readScroll])

  useEffect(() => {
    const stop = () => { dragRef.current = null; resizeRef.current = null; setScrubbing(false) }
    window.addEventListener('blur', stop)
    return () => window.removeEventListener('blur', stop)
  }, [])

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
  const lastRow = Math.min(layers.length, Math.ceil((viewport.top + viewport.height) / rowHeight) + 2)
  const width = Math.max(viewport.width, GUTTER + totalFrames * frameWidth + 12)
  const contentHeight = RULER + Math.max(viewport.height - RULER, layers.length * rowHeight)

  return (
    <section aria-label="时间轴" className={cn('flex flex-col flex-shrink-0 min-h-[160px] bg-bg-secondary border-t border-border', className)} style={{height:displayedHeight}}>
      <div role="separator" aria-label="调整时间轴高度" aria-orientation="horizontal" aria-valuemin={160} aria-valuemax={maxHeight} aria-valuenow={displayedHeight} tabIndex={0}
        className="h-2 flex-shrink-0 cursor-row-resize flex items-center justify-center hover:bg-accent/10 touch-none"
        onPointerDown={e => { if (e.button !== 0) return; resizeRef.current={y:e.clientY,height:displayedHeight}; e.currentTarget.setPointerCapture(e.pointerId) }}
        onPointerMove={e => { if (resizeRef.current) { setExpanded(false); setHeight(Math.max(160, Math.min(maxHeight, resizeRef.current.height + resizeRef.current.y - e.clientY))) } }}
        onPointerUp={() => { resizeRef.current=null }} onLostPointerCapture={() => { resizeRef.current=null }}
        onDoubleClick={() => {setExpanded(false);setHeight(DEFAULT_HEIGHT)}} onKeyDown={e => { if(e.key==='ArrowUp'||e.key==='ArrowDown') {e.preventDefault();setExpanded(false);setHeight(Math.max(160,Math.min(maxHeight,displayedHeight+(e.key==='ArrowUp'?20:-20))))} }}><span className="h-0.5 w-10 rounded bg-border-light" /></div>
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
      <div ref={viewportRef} id="timeline-tracks" data-testid="timeline-scroll" className="relative flex-1 min-h-0 overflow-auto outline-none" tabIndex={0} aria-label="时间轴轨道，左右方向键逐帧，Shift 加速十帧，Home 和 End 跳首尾"
        onScroll={readScroll}
        onKeyDown={e=>{
          if((e.target as HTMLElement).closest('input,select,button'))return
          const frame=e.key==='ArrowLeft'?frameRef.current-(e.shiftKey?10:1):e.key==='ArrowRight'?frameRef.current+(e.shiftKey?10:1):e.key==='Home'?0:e.key==='End'?totalFrames-1:null
          if(frame===null || e.ctrlKey || e.metaKey || e.altKey)return
          e.preventDefault();e.stopPropagation();seek(frame);revealFrame(clampFrame(frame,totalFrames))
        }}
        onPointerDown={e=>{
          if(e.button!==0 || !available || (e.target as HTMLElement).closest('[data-layer-label]'))return
          const el=e.currentTarget, rect=el.getBoundingClientRect()
          if(e.clientX<rect.left+GUTTER || e.clientX>=rect.left+el.clientWidth || e.clientY>=rect.top+el.clientHeight)return
          e.preventDefault();el.focus({preventScroll:true});el.setPointerCapture(e.pointerId)
          dragRef.current={pointer:e.pointerId,x:e.clientX};setScrubbing(true);seekPointer(e.clientX)
          const layerId=(e.target as HTMLElement).closest<HTMLElement>('[data-track-layer]')?.dataset.trackLayer
          if(layerId)selectLayer(layerId)
        }}
        onPointerMove={e=>{if(dragRef.current?.pointer===e.pointerId){dragRef.current.x=e.clientX;seekPointer(e.clientX)}}}
        onPointerUp={e=>{if(dragRef.current?.pointer===e.pointerId){seekPointer(e.clientX);dragRef.current=null;setScrubbing(false);if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId)}}}
        onPointerCancel={()=>{dragRef.current=null;setScrubbing(false)}} onLostPointerCapture={()=>{dragRef.current=null;setScrubbing(false)}} style={{touchAction:'none'}}>
        {!available ? <div className="flex h-full items-center justify-center text-xs text-text-muted">打开 SVGA 文件后，拖动刻度即可逐帧查看</div> : <div className="relative" style={{width,height:contentHeight}}>
          <div className="sticky top-0 z-30 h-7 border-b border-border bg-bg-tertiary cursor-col-resize" data-testid="timeline-ruler">
            <div data-layer-label className="sticky left-0 z-40 flex h-full items-center border-r border-border bg-bg-tertiary px-3 text-[10px] text-text-muted" style={{width:GUTTER}}>图层 · {layers.length}</div>
            {ticks.map(frame=><div key={frame} data-timeline-tick={frame+1} className="absolute top-0 h-full border-l border-border-light text-[11px] text-text-secondary pointer-events-none" style={{left:GUTTER+frame*frameWidth}}><span className="absolute top-1 whitespace-nowrap" style={frame===totalFrames-1 && frameWidth<Math.max(24,String(totalFrames).length*7+12) ? {right:4} : {left:4}}>{frame+1}</span></div>)}
            <div ref={rulerHeadRef} className="absolute top-0 h-full w-px bg-accent pointer-events-none" style={{left:GUTTER+frameRef.current*frameWidth}}><span className="absolute -left-1 top-0 h-2 w-2 rotate-45 bg-accent" /></div>
          </div>
          <div className="absolute bottom-0 pointer-events-none" style={{left:GUTTER,top:RULER,width:totalFrames*frameWidth,backgroundImage:'linear-gradient(to right, #4a586b50 1px, transparent 1px)',backgroundSize:`${frameWidth >= 16 ? frameWidth : step*frameWidth}px 100%`}} />
          <div ref={currentColumnRef} data-testid="timeline-current-column" className="absolute bottom-0 pointer-events-none bg-accent/10" style={{top:RULER,left:GUTTER+frameRef.current*frameWidth,width:frameWidth}} />
          <div className="absolute bottom-0 border-l border-border-light pointer-events-none" style={{top:RULER,left:GUTTER+totalFrames*frameWidth}} />
          {layers.slice(firstRow,lastRow).map((layer,offset)=><LayerTrack key={layer.id} layer={layer} index={firstRow+offset} rowHeight={rowHeight} frameWidth={frameWidth} totalFrames={totalFrames} selected={selectedIds.includes(layer.id)} start={start} end={end} onSelect={selectLayer} />)}
          {!layers.length && <p className="sticky left-0 w-fit p-3 text-xs text-text-muted">暂无图层，可在上方刻度定位帧</p>}
          <div ref={trackHeadRef} className="absolute bottom-0 w-px bg-accent pointer-events-none z-10" style={{top:RULER,left:GUTTER+frameRef.current*frameWidth}} />
        </div>}
      </div>
      <div className="flex justify-between gap-2 border-t border-border px-3 py-1 text-[10px] text-text-muted"><span className="truncate">拖动定位 · Shift+滚轮横移 · Ctrl+滚轮缩放</span><span className="whitespace-nowrap">{fps} FPS · {fps>0?(totalFrames/fps).toFixed(2):'—'} s · ◆ 编辑关键帧</span></div>
    </section>
  )
}

const LayerTrack = React.memo(({layer,index,rowHeight,frameWidth,totalFrames,selected,start,end,onSelect}: {layer:Layer;index:number;rowHeight:number;frameWidth:number;totalFrames:number;selected:boolean;start:number;end:number;onSelect:(id:string,additive?:boolean)=>void}) => {
  const range=clipRange(getLayerOutputRange(layer).startFrame,layer.clip.duration,totalFrames)
  const timeOffset = getLayerTimeOffset(layer)
  const frames=React.useMemo(()=>Array.from(new Set(Object.values(layer.tracks).flatMap(track=>track.keyframes.map((key: Keyframe)=>key.frameIndex+timeOffset)))).sort((a,b)=>a-b),[layer.tracks,timeOffset])
  const markers:number[]=[]
  let lastX=-Infinity
  for(const frame of frames){if(frame<start||frame>end||frame<0||frame>=totalFrames)continue;const x=frame*frameWidth;if(x-lastX>=8){markers.push(frame);lastX=x}}
  return <div data-track-layer={layer.id} className={cn('absolute left-0 right-0 border-b border-border/50',selected&&'bg-accent/5')} style={{top:RULER+index*rowHeight,height:rowHeight}}>
    {range.end>range.start && <div title={`第 ${range.start+1}–${range.end} 帧`} className={cn('absolute h-3.5 rounded border',selected?'border-accent/60 bg-accent/25':'border-border-light bg-slate-500/20',!layer.visible&&'opacity-40')} style={{top:(rowHeight-14)/2,left:GUTTER+range.start*frameWidth,width:Math.max(1,(range.end-range.start)*frameWidth)}} />}
    {markers.map(frame=><span key={frame} title={`第 ${frame+1} 帧 · 编辑关键帧`} className="absolute h-2 w-2 rotate-45 bg-accent pointer-events-none" style={{top:(rowHeight-8)/2,left:GUTTER+frame*frameWidth-4}} />)}
    <button type="button" data-layer-label aria-label={`选择时间轴图层：${layer.name}`} aria-pressed={selected} title={layer.name} onClick={event=>onSelect(layer.id,event.shiftKey||event.ctrlKey||event.metaKey)} className={cn('sticky left-0 z-20 flex h-full items-center gap-1.5 border-r border-border px-2 text-left text-xs',selected?'bg-bg-tertiary text-accent':'bg-bg-secondary text-text-secondary hover:bg-bg-tertiary')} style={{width:GUTTER}}>
      <Icon name={layer.locked?'lock':!layer.visible?'eye-closed':'layer'} size={12}/><span className="truncate">{layer.name}</span>
    </button>
  </div>
})
LayerTrack.displayName='LayerTrack'
