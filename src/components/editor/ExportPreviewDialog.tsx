import React from 'react'
import { Button, Icon, Modal } from '@/components/ui'
import { OfficialSvgRenderer } from '@/core/renderer.official'
import { loadExportPreviewVideo, type ExportPreviewResult } from '@/core/export-preview'
import { formatResourceBytes } from '@/utils/resource-catalog'
import { OperationStatus, type OperationStatusValue } from '@/components/ui/OperationStatus'

function PreviewCanvas({ blob, frame, title, background }: { blob: Blob; frame: number; title: string; background: string }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const rendererRef = React.useRef<OfficialSvgRenderer | null>(null)
  const frameRef = React.useRef(frame)
  const totalFramesRef = React.useRef(1)
  const [status, setStatus] = React.useState('正在解码预览…')
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    const canvas = canvasRef.current!
    let active = true
    let release: (() => void) | undefined
    let renderer: OfficialSvgRenderer | undefined
    setStatus('正在解码预览…')
    setError(null)
    void (async () => {
      try {
        const loaded = await loadExportPreviewVideo(blob)
        if (!active) { loaded.dispose(); return }
        release = loaded.dispose
        renderer = new OfficialSvgRenderer(canvas)
        await renderer.setVideoItem(loaded.video)
        if (!active) return
        totalFramesRef.current = loaded.video.movie.params.frames
        rendererRef.current = renderer
        renderer.renderFrame(Math.min(frameRef.current, totalFramesRef.current - 1), { useFrameCache: false })
        setStatus(loaded.warning || '')
      } catch (err) {
        release?.()
        if (active) setError((err as Error).message)
      }
    })()
    return () => {
      active = false
      rendererRef.current = null
      void renderer?.setVideoItem(null)
      renderer?.destroy()
      release?.()
      // Release backing pixels immediately when closing or replacing a preview.
      canvas.width = 0
      canvas.height = 0
    }
  }, [blob])

  React.useEffect(() => {
    frameRef.current = frame
    rendererRef.current?.renderFrame(Math.min(frame, totalFramesRef.current - 1), { useFrameCache: false })
  }, [frame])

  return (
    <figure className="min-w-0 space-y-2">
      <figcaption className="text-sm text-text-secondary">{title} · {formatResourceBytes(blob.size)}</figcaption>
      <div className="flex h-60 items-center justify-center overflow-hidden rounded border border-border" style={background === 'transparent' ? {
        backgroundColor: '#d1d5db',
        backgroundImage: 'conic-gradient(#f3f4f6 25%, transparent 0 50%, #f3f4f6 0 75%, transparent 0)',
        backgroundSize: '20px 20px'
      } : { backgroundColor: background }}>
        <canvas ref={canvasRef} aria-label={title} className="max-h-full max-w-full object-contain" />
      </div>
      {status && !error && <p className="text-xs text-text-muted">{status}</p>}
      {error && <p role="alert" className="text-xs text-warning">{error}</p>}
    </figure>
  )
}

export function ExportPreviewDialog({ result, stale, saving, status, onClose, onSave }: {
  result: ExportPreviewResult
  stale: boolean
  saving: boolean
  status: OperationStatusValue | null
  onClose: () => void
  onSave: (kind: 'optimized' | 'baseline') => void
}) {
  const [frame, setFrame] = React.useState(0)
  const frameRef = React.useRef(0)
  const [playing, setPlaying] = React.useState(false)
  const [background, setBackground] = React.useState('transparent')
  const controlsRef = React.useRef<HTMLDivElement>(null)
  const totalFrames = Math.max(1, Math.floor(result.params.frames))
  const fps = result.params.fps > 0 ? result.params.fps : 24

  React.useEffect(() => { frameRef.current = frame }, [frame])
  React.useEffect(() => {
    if (!playing) return
    const startTime = performance.now()
    const startFrame = frameRef.current
    let id = 0
    const tick = (now: number) => {
      setFrame((startFrame + Math.floor((now - startTime) * fps / 1000)) % totalFrames)
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [playing, fps, totalFrames])

  // Keep editor shortcuts from operating behind this comparison dialog.
  React.useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    controlsRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = controlsRef.current?.closest('[role="dialog"]')
      const dialogs = document.querySelectorAll('[role="dialog"]')
      if (dialogs[dialogs.length - 1] !== dialog) return
      if (event.key === 'Escape') return // The shared modal handles closing.
      if ((event.ctrlKey || event.metaKey) && ['s', 'o', 'e', 'z', 'y'].includes(event.key.toLowerCase())) event.preventDefault()
      if (event.key === ' ' && !(event.target as HTMLElement)?.matches('button, input, select, textarea')) {
        event.preventDefault()
        if (!event.repeat) setPlaying(value => !value)
      }
      if (event.key === 'Tab') {
        const elements = controlsRef.current?.closest('[role="dialog"]')?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')
        if (elements?.length) {
          const first = elements[0]
          const last = elements[elements.length - 1]
          if (event.shiftKey && (document.activeElement === first || document.activeElement === controlsRef.current)) { event.preventDefault(); last.focus() }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
      }
      event.stopPropagation()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown); previousFocus?.focus() }
  }, [])

  const seek = (next: number) => { setPlaying(false); setFrame(Math.max(0, Math.min(totalFrames - 1, next))) }
  return (
    <Modal isOpen onClose={onClose} title="导出预览与体积对比" className="!max-w-4xl" footer={<>
      <Button variant="ghost" onClick={onClose}>关闭</Button>
      <Button disabled={stale || saving} onClick={() => onSave('baseline')}>保存未优化副本</Button>
      <Button variant="primary" disabled={stale || saving} onClick={() => onSave('optimized')}>保存此优化结果</Button>
    </>}>
      <div ref={controlsRef} tabIndex={-1} className="space-y-4 outline-none">
        <div className="grid grid-cols-3 gap-2 text-xs">
          {[
            ['源文件', result.sourceBytes],
            ['当前编辑·未优化', result.baseline.size],
            ['优化后', result.optimized.size]
          ].map(([label, bytes]) => <div key={label} className="rounded bg-bg-tertiary p-2"><div className="text-text-muted">{label}</div><div className="mt-1 font-mono text-text-primary">{formatResourceBytes(Number(bytes))}</div></div>)}
        </div>
        <p className="text-xs text-text-muted">相对当前编辑的未优化副本，体积{result.stats.reductionPercent >= 0 ? '减少' : '增加'} {Math.abs(result.stats.reductionPercent)}%。下方预览重新解码真实导出文件；仅对比画面，不播放音频。</p>
        {stale && <p role="alert" className="rounded bg-warning/10 p-2 text-sm text-warning">编辑内容或导出配置已变化，此结果已失效。请关闭并重新生成预览。</p>}
        {result.warnings.map(warning => <p key={warning} className="text-xs text-warning">{warning}</p>)}
        <OperationStatus status={stale && status?.kind === 'stale' ? null : status} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <PreviewCanvas blob={result.baseline} frame={frame} title="当前编辑·未优化" background={background} />
          <PreviewCanvas blob={result.optimized} frame={frame} title="优化结果" background={background} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setPlaying(!playing)} aria-label={playing ? '暂停对比' : '播放对比'}><Icon name={playing ? 'pause' : 'play'} size={16} /></Button>
          <Button size="sm" onClick={() => seek(frame - 1)} disabled={frame === 0}>上一帧</Button>
          <Button size="sm" onClick={() => seek(frame + 1)} disabled={frame === totalFrames - 1}>下一帧</Button>
          <span className="text-xs font-mono text-text-secondary">{frame + 1} / {totalFrames} · {fps} FPS</span>
          <select aria-label="对比背景" value={background} onChange={e => setBackground(e.target.value)} className="ml-auto rounded border border-border bg-bg-tertiary p-1 text-xs">
            <option value="transparent">透明棋盘</option><option value="#000000">黑色</option><option value="#ffffff">白色</option>
          </select>
          <input aria-label="对比帧" type="range" min={0} max={totalFrames - 1} value={frame} onChange={e => seek(Number(e.target.value))} className="w-full accent-accent" />
        </div>
      </div>
    </Modal>
  )
}
