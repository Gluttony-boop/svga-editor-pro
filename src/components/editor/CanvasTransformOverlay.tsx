import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import Moveable, { type Able } from 'react-moveable'
import Selecto from 'react-selecto'
import type { CanvasTransform } from '@/types'
import { useEditorStore } from '@/stores'
import { getLayerGeometry, normalizeCanvasTransform } from '@/core/layer-transform'
import { canvasPoint, pointInFrame } from '@/core/canvas-selection'
import { requestLayerReveal } from '@/utils/layer-navigation'
import { cn } from '@/utils/cn'
import { getSelectedLayerIds } from '@/utils/layer-selection'
import { captureGroupTransform, applyGroupTransform, type GroupTransformSnapshot } from '@/core/group-transform'

type Tool = 'select' | 'rotate' | 'hand'

// 使用 Moveable 扩展点把旋转命中面放进控制框，复用库的完整旋转手势。
const rotationSurface: Able = {
  name: 'canvasRotationSurface', always: true,
  render(moveable, React) {
    const { pos1, pos2, pos3, pos4 } = moveable.state
    return React.createElement('svg', { key: 'rotation-surface', style: { position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' } },
      React.createElement('polygon', { className: 'moveable-rotation-control', points: [pos1, pos2, pos4, pos3].map(point => point.join(',')).join(' '), style: { fill: 'transparent', pointerEvents: 'all', cursor: 'alias' } }))
  }
}

/** Moveable 负责手柄和手势；这里只映射屏幕像素与 SVGA 坐标、事务及选择。 */
export function CanvasTransformOverlay({ viewportRef, disabled = false }: { viewportRef: RefObject<HTMLDivElement>; disabled?: boolean }) {
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null)
  const setOverlayElement = useCallback((element: HTMLDivElement | null) => { overlayRef.current = element; setOverlay(element) }, [])
  const selectoRef = useRef<Selecto>(null)
  const marqueeRef = useRef<{ video: typeof video; cancelled: boolean } | null>(null)
  const moveableRef = useRef<Moveable>(null)
  const [target, setTarget] = useState<HTMLDivElement | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [shift, setShift] = useState(false)
  const keepRatio = useEditorStore(state => state.canvasKeepRatio)
  const setKeepRatio = useEditorStore(state => state.setCanvasKeepRatio)
  const [snapping, setSnapping] = useState(true)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const panRef = useRef<{ x: number; y: number; offset: { x: number; y: number } } | null>(null)
  const gestureRef = useRef<{ layerId: string; transform: CanvasTransform; group?: GroupTransformSnapshot } | null>(null)
  const [gestureActive, setGestureActive] = useState(false)
  const [groupDelta, setGroupDelta] = useState<CanvasTransform>(() => normalizeCanvasTransform())
  const video = useEditorStore(state => state.videoItem)
  const layers = useEditorStore(state => state.layers)
  const resources = useEditorStore(state => state.imageResources)
  const selectedId = useEditorStore(state => state.selectedLayerId)
  const selectedLayerIds = useEditorStore(state => state.selectedLayerIds)
  const selectedIds = useMemo(() => getSelectedLayerIds({ layers, selectedLayerId: selectedId, selectedLayerIds }), [layers, selectedId, selectedLayerIds])
  const isMulti = selectedIds.length > 1
  const selectionSignature = selectedIds.join('\u0000')
  const zoom = useEditorStore(state => state.zoom)
  const offset = useEditorStore(state => state.canvasOffset)
  const frame = useEditorStore(state => state.playback.currentFrame)
  const playing = useEditorStore(state => state.playback.isPlaying)
  const active = useEditorStore(state => state.isCanvasTransforming)
  const layer = layers.find(item => item.id === selectedId)
  const geometry = layer && video ? getLayerGeometry(layer, frame, video, resources) : null
  const group = useMemo(() => isMulti ? captureGroupTransform(layers.filter(item => selectedIds.includes(item.id)), frame, video, resources) : null, [isMulti, layers, selectedIds, frame, video, resources])
  const groupIsComplete = !!group && group.items.length === selectedIds.length
  const editable = (isMulti ? groupIsComplete : !!layer && layer.visible && !layer.locked && layer.type === 'image' && !!geometry) && !disabled && !playing
  const transform = isMulti ? groupDelta : normalizeCanvasTransform(layer?.canvasTransform)
  const bounds = isMulti ? (gestureRef.current?.group || group)?.bounds : geometry?.baseBounds
  const selectable = useMemo(() => layers.flatMap(item => {
    if (!item.visible || item.locked || item.type !== 'image') return []
    const geometry = getLayerGeometry(item, frame, video, resources)
    if (!geometry) return []
    const xs = geometry.quad.map(point => point.x), ys = geometry.quad.map(point => point.y)
    return [{ id: item.id, geometry, bounds: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } }]
  }), [layers, frame, video, resources])
  const params = video?.movie.params
  const left = params ? size.width / 2 + offset.x - params.viewBoxWidth * zoom / 2 : 0
  const top = params ? size.height / 2 + offset.y - params.viewBoxHeight * zoom / 2 : 0
  const cssTransform = (value: CanvasTransform) => `translate(${value.x * zoom}px, ${value.y * zoom}px) rotate(${value.rotation}rad) scale(${value.scaleX}, ${value.scaleY})`
  const syncMarqueeSelection = useCallback(() => {
    const ids = getSelectedLayerIds(useEditorStore.getState())
    const elements = Array.from(overlayRef.current?.querySelectorAll<HTMLElement>('[data-layer-selectable]') || [])
    selectoRef.current?.setSelectedTargets(elements.filter(element => ids.includes(element.dataset.layerSelectable!)))
  }, [])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const update = () => setSize({ width: viewport.clientWidth, height: viewport.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [viewportRef])

  useLayoutEffect(() => { if (!gestureActive) moveableRef.current?.updateRect() }, [target, selectionSignature, frame, zoom, offset, size, transform.x, transform.y, transform.scaleX, transform.scaleY, transform.rotation, gestureActive, bounds?.x, bounds?.y, bounds?.width, bounds?.height])
  useLayoutEffect(() => {
    syncMarqueeSelection()
  }, [selectionSignature, selectable, overlay, syncMarqueeSelection])

  const end = (commit = true) => {
    gestureRef.current = null
    setGroupDelta(normalizeCanvasTransform())
    setGestureActive(false)
    useEditorStore.getState().endCanvasTransform(commit)
  }
  useLayoutEffect(() => {
    if (!gestureRef.current) return
    end(true)
    moveableRef.current?.stopDrag()
  }, [size.width, size.height, zoom, offset.x, offset.y])
  useEffect(() => {
    if (!active && gestureRef.current) {
      gestureRef.current = null
      setGroupDelta(normalizeCanvasTransform())
      setGestureActive(false)
      moveableRef.current?.stopDrag()
    }
  }, [active])
  useEffect(() => () => { useEditorStore.getState().endCanvasTransform(false) }, [])
  useEffect(() => {
    setTool('select')
    setGestureActive(false)
    gestureRef.current = null
    marqueeRef.current = null
    setGroupDelta(normalizeCanvasTransform())
  }, [video])
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.isComposing || document.querySelector('[role="dialog"]') || (event.target as HTMLElement)?.closest('input,textarea,select,[contenteditable="true"]')) return
      if (event.key === 'Shift') setShift(true)
      if (event.key === 'Escape' && marqueeRef.current) {
        event.preventDefault(); event.stopPropagation()
        marqueeRef.current.cancelled = true
        return
      }
      if (event.key === 'Escape' && gestureRef.current) {
        event.preventDefault(); event.stopPropagation()
        end(false); moveableRef.current?.stopDrag()
        return
      }
      if ((event.ctrlKey || event.metaKey) && ['s', 'o', 'e'].includes(event.key.toLowerCase())) end(true)
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key.toLowerCase() === 'v' || event.key.toLowerCase() === 'h' || event.key.toLowerCase() === 'w') {
        event.preventDefault()
        end(true)
        setTool(event.key.toLowerCase() === 'v' ? 'select' : event.key.toLowerCase() === 'h' ? 'hand' : 'rotate')
      }
    }
    const resetShift = (event: KeyboardEvent) => { if (event.key === 'Shift') setShift(false) }
    const blur = () => { setShift(false); panRef.current = null; if (marqueeRef.current) marqueeRef.current.cancelled = true; end(false); moveableRef.current?.stopDrag() }
    const move = (event: MouseEvent) => {
      const pan = panRef.current
      if (pan) useEditorStore.getState().setCanvasOffset({ x: pan.offset.x + event.clientX - pan.x, y: pan.offset.y + event.clientY - pan.y })
    }
    const up = () => { panRef.current = null }
    window.addEventListener('keydown', keyDown, true)
    window.addEventListener('keyup', resetShift)
    window.addEventListener('blur', blur)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('keydown', keyDown, true); window.removeEventListener('keyup', resetShift)
      window.removeEventListener('blur', blur); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    }
  }, [])

  const begin = (inputEvent?: MouseEvent) => {
    if (inputEvent && (inputEvent.shiftKey || inputEvent.ctrlKey || inputEvent.metaKey || inputEvent.altKey) && inputEvent.target === target) return false
    const state = useEditorStore.getState()
    if (isMulti) {
      const current = captureGroupTransform(state.layers.filter(item => selectedIds.includes(item.id)), state.playback.currentFrame, state.videoItem, state.imageResources)
      if (!current || current.items.length !== selectedIds.length || disabled || !state.beginCanvasTransforms(selectedIds)) return false
      const initial = normalizeCanvasTransform()
      gestureRef.current = { layerId: selectedId!, transform: initial, group: current }
      setGroupDelta(initial)
      setGestureActive(true)
      return true
    }
    if (!layer || disabled || !state.beginCanvasTransform(layer.id)) return false
    gestureRef.current = { layerId: layer.id, transform: normalizeCanvasTransform(state.layers.find(item => item.id === layer.id)?.canvasTransform) }
    setGestureActive(true)
    return true
  }
  const preview = (patch: Partial<CanvasTransform>) => {
    const gesture = gestureRef.current
    if (!gesture) return
    const next = { ...gesture.transform, ...patch }
    if (![next.x, next.y, next.scaleX, next.scaleY, next.rotation].every(Number.isFinite)) return
    gesture.transform = next
    if (target) target.style.transform = cssTransform(next)
    if (gesture.group) {
      setGroupDelta(next)
      useEditorStore.getState().previewCanvasTransforms(applyGroupTransform(gesture.group, { x: next.x, y: next.y, scale: next.scaleX, rotation: next.rotation }))
    } else useEditorStore.getState().previewCanvasTransform(gesture.layerId, next)
  }

  const mouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-stage-tools],.moveable-control-box')) return
    event.stopPropagation()
    overlayRef.current?.focus({ preventScroll: true })
    if (event.button === 1 || (event.button === 0 && tool === 'hand')) {
      event.preventDefault()
      panRef.current = { x: event.clientX, y: event.clientY, offset: { ...offset } }
      return
    }
    if (event.button !== 0 || !video || !params || disabled) return
    if (event.target === target && !event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) return
    const rect = viewportRef.current?.getBoundingClientRect()
    if (!rect) return
    // 暂停会将播放引擎的最后已绘制帧同步回 store，再按同一帧命中。
    useEditorStore.getState().setPlaying(false)
    const state = useEditorStore.getState()
    const point = canvasPoint({ x: event.clientX, y: event.clientY }, rect, { width: params.viewBoxWidth, height: params.viewBoxHeight }, zoom, offset)
    const hits = [...state.layers].reverse().filter(candidate => {
      if (!candidate.visible || candidate.locked || candidate.type !== 'image') return false
      const item = getLayerGeometry(candidate, state.playback.currentFrame, video, state.imageResources)
      return item && (item.frame.alpha ?? 1) * candidate.opacity > 0.001 && pointInFrame(point, item.frame, item.width, item.height)
    })
    const current = hits.findIndex(hit => hit.id === selectedId)
    const hit = hits[event.altKey && current >= 0 ? (current + 1) % hits.length : 0]
    const additive = event.shiftKey || event.ctrlKey || event.metaKey
    if (!hit) {
      // 空白拖动交给 Selecto，点击结束前保留原选区以支持追加框选。
      if (tool !== 'select' && !additive) state.selectLayer(null)
      return
    }
    flushSync(() => { state.selectLayer(hit.id, additive) })
    if (hit) {
      if (!additive) requestLayerReveal(hit.id)
      if (!event.altKey && !additive && tool === 'select') moveableRef.current?.dragStart(event.nativeEvent)
    }
  }

  if (!params) return null
  return <div ref={setOverlayElement} className={cn('absolute inset-0 z-[5] outline-none', tool === 'hand' ? 'cursor-grab' : 'cursor-default')} tabIndex={0} role="region" aria-label="画布直接编辑"
    onMouseDownCapture={event => {
      if (disabled || tool === 'hand' || event.button !== 0 || (event.target as HTMLElement).closest('[data-stage-tools]')) return
      // Selecto 在原生冒泡事件开始时采集几何，必须更早同步暂停实绘帧与选区代理。
      if (useEditorStore.getState().playback.isPlaying) flushSync(() => useEditorStore.getState().setPlaying(false))
    }}
    onMouseDown={mouseDown} onAuxClick={event => event.preventDefault()}
    onKeyDown={event => {
      if (event.target !== overlayRef.current || !editable || !layer || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      const step = event.shiftKey ? 10 : 1
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
      const state = useEditorStore.getState()
      if (isMulti && group && state.beginCanvasTransforms(selectedIds)) {
        state.previewCanvasTransforms(applyGroupTransform(group, { x: dx, y: dy, scale: 1, rotation: 0 }))
        state.endCanvasTransform(true)
      } else if (!isMulti) state.updateCanvasTransform(layer.id, { x: transform.x + dx, y: transform.y + dy })
    }}>
    <div data-stage-tools className="absolute left-3 top-2 right-3 z-10 flex flex-wrap items-center gap-1 rounded border border-border/70 bg-bg-secondary/95 p-1.5 text-xs" onMouseDown={event => event.stopPropagation()}>
      {([['select', '选择 V'], ['rotate', '旋转 W'], ['hand', '抓手 H']] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={tool === id} onClick={() => { end(true); setTool(id) }} className={cn('rounded px-2 py-1', tool === id ? 'bg-accent/20 text-accent' : 'text-text-secondary hover:bg-bg-tertiary')}>{label}</button>)}
      <span className="mx-1 h-4 border-l border-border" />
      <button type="button" aria-pressed={isMulti || keepRatio} disabled={isMulti} title={isMulti ? '多选仅支持整体等比缩放，避免引入额外倾斜' : undefined} onClick={() => setKeepRatio(!keepRatio)} className={cn('rounded px-2 py-1', isMulti || keepRatio ? 'text-accent' : 'text-text-muted')}>{isMulti ? '整体等比' : '等比'}</button>
      <button type="button" aria-pressed={snapping} onClick={() => setSnapping(!snapping)} className={cn('rounded px-2 py-1', snapping ? 'text-accent' : 'text-text-muted')}>吸附</button>
      <span className="ml-auto truncate text-[10px] text-text-muted" title="以当前帧为基准整段调整，不自动创建关键帧或永久编组">{playing ? '播放中 · 点击画面暂停编辑' : isMulti ? `已选 ${selectedIds.length} 层${groupIsComplete ? ' · 整体变换' : ' · 包含当前不可编辑图层'}` : layer ? `${layer.name}${layer.locked ? ' · 已锁定' : !layer.visible ? ' · 已隐藏' : ' · 整段变换'}` : '空白框选 · Shift 追加 · Alt 穿透'}</span>
    </div>
    {selectable.map(item => <div key={item.id} data-layer-selectable={item.id} className="pointer-events-none absolute" style={{ left: left + item.bounds.x * zoom, top: top + item.bounds.y * zoom, width: Math.max(0.01, item.bounds.width * zoom), height: Math.max(0.01, item.bounds.height * zoom) }} />)}
    {isMulti && !playing && <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
      {selectable.filter(item => selectedIds.includes(item.id)).map(item => <polygon key={item.id} points={item.geometry.quad.map(point => `${left + point.x * zoom},${top + point.y * zoom}`).join(' ')} fill="none" stroke="#ef83a1" strokeWidth={1} strokeDasharray="4 3" />)}
    </svg>}
    {bounds && editable && tool !== 'hand' && <div ref={setTarget} data-canvas-transform-target={isMulti ? 'selection' : layer!.id} aria-label={isMulti ? `整体变换 ${selectedIds.length} 个图层` : `变换图层 ${layer!.name}`} className="absolute cursor-move touch-none" style={{
      left: left + bounds.x * zoom, top: top + bounds.y * zoom,
      width: Math.max(0.01, bounds.width * zoom), height: Math.max(0.01, bounds.height * zoom),
      transform: cssTransform(transform), transformOrigin: '50% 50%'
    }} />}
    <Moveable ref={moveableRef} target={editable && tool !== 'hand' ? target : null} draggable={tool === 'select'} scalable={tool === 'select'} rotatable={true}
      ables={tool === 'rotate' ? [rotationSurface] : []} origin={true} keepRatio={isMulti || keepRatio || shift} throttleRotate={shift ? 15 : 0}
      snappable={snapping} snapDirections={{ left: true, top: true, right: true, bottom: true, center: true, middle: true }} snapThreshold={6}
      verticalGuidelines={[left, left + params.viewBoxWidth * zoom / 2, left + params.viewBoxWidth * zoom]}
      horizontalGuidelines={[top, top + params.viewBoxHeight * zoom / 2, top + params.viewBoxHeight * zoom]}
      renderDirections={['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']} useResizeObserver={true} flushSync={flushSync}
      onDragStart={event => { if (!begin(event.inputEvent)) { event.stopDrag(); return } event.set([transform.x * zoom, transform.y * zoom]) }}
      onDrag={event => preview({ x: event.beforeTranslate[0] / zoom, y: event.beforeTranslate[1] / zoom })} onDragEnd={() => end()}
      onScaleStart={event => {
        if (!begin(event.inputEvent)) { event.stopDrag(); return }
        event.set([transform.scaleX, transform.scaleY]); event.dragStart && event.dragStart.set([transform.x * zoom, transform.y * zoom])
        if (target) { event.setMinScaleSize([target.offsetWidth * 0.01, target.offsetHeight * 0.01]); event.setMaxScaleSize([target.offsetWidth * 10, target.offsetHeight * 10]) }
      }}
      onScale={event => preview({ scaleX: event.scale[0], scaleY: event.scale[1], x: event.drag.beforeTranslate[0] / zoom, y: event.drag.beforeTranslate[1] / zoom })} onScaleEnd={() => end()}
      onRotateStart={event => { if (!begin(event.inputEvent)) { event.stopDrag(); return } event.set(transform.rotation * 180 / Math.PI); event.dragStart && event.dragStart.set([transform.x * zoom, transform.y * zoom]) }}
      onRotate={event => preview({ rotation: event.beforeRotation * Math.PI / 180, x: event.drag.beforeTranslate[0] / zoom, y: event.drag.beforeTranslate[1] / zoom })} onRotateEnd={() => end()}
    />
    {overlay && <Selecto ref={selectoRef} container={overlay} dragContainer={overlay} selectableTargets={['[data-layer-selectable]']}
      selectByClick={false} selectFromInside={true} hitRate={0} toggleContinueSelect={['shift']} boundContainer={overlay}
      getElementRect={element => {
        const item = selectable.find(candidate => candidate.id === (element as HTMLElement).dataset.layerSelectable)
        const rect = overlay.getBoundingClientRect()
        const points = item?.geometry.quad.map(point => [rect.left + left + point.x * zoom, rect.top + top + point.y * zoom]) || [[0, 0], [0, 0], [0, 0], [0, 0]]
        return { pos1: points[0], pos2: points[1], pos3: points[3], pos4: points[2] }
      }}
      onDragStart={event => {
        const mouse = event.inputEvent as MouseEvent
        const eventTarget = mouse.target as HTMLElement
        if (tool !== 'select' || disabled || mouse.button !== 0 || eventTarget.closest('[data-stage-tools],.moveable-control-box,[data-canvas-transform-target]')) { event.stop(); return }
        useEditorStore.getState().setPlaying(false)
        const state = useEditorStore.getState()
        const rect = viewportRef.current?.getBoundingClientRect()
        if (!rect) { event.stop(); return }
        const point = canvasPoint({ x: mouse.clientX, y: mouse.clientY }, rect, { width: params.viewBoxWidth, height: params.viewBoxHeight }, zoom, offset)
        if (state.layers.some(item => {
          if (item.type !== 'image' || item.locked || !item.visible) return false
          const geometry = getLayerGeometry(item, state.playback.currentFrame, video, state.imageResources)
          return geometry && pointInFrame(point, geometry.frame, geometry.width, geometry.height)
        })) { event.stop(); return }
        marqueeRef.current = { video, cancelled: false }
        overlay.focus({ preventScroll: true })
      }}
      onSelectEnd={event => {
        const marquee = marqueeRef.current
        marqueeRef.current = null
        if (!marquee || marquee.cancelled || marquee.video !== useEditorStore.getState().videoItem) { syncMarqueeSelection(); return }
        useEditorStore.getState().selectLayers(event.selected.map(element => (element as HTMLElement).dataset.layerSelectable!).filter(Boolean))
      }} />}
    {gestureActive && <div className="pointer-events-none absolute bottom-2 left-3 rounded bg-bg-secondary/95 px-2 py-1 font-mono text-[10px] text-accent">X {transform.x.toFixed(1)} · Y {transform.y.toFixed(1)} · {Math.round(transform.scaleX * 100)}% × {Math.round(transform.scaleY * 100)}% · {(transform.rotation * 180 / Math.PI).toFixed(1)}° · Esc 取消</div>}
  </div>
}
