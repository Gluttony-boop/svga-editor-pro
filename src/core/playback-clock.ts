/** 可见页面使用 RAF，后台使用同源模块 Worker；不可用时安全回退。 */
export function startPlaybackClock(tick: () => void, enableWorker = true): () => void {
  let stopped = false
  let worker: Worker | null = null
  let fallback: number | null = null
  let raf = 0
  const backgroundTick = () => {
    if (!stopped && document.hidden) tick()
  }
  const startFallback = () => {
    if (!stopped && fallback === null) fallback = window.setInterval(backgroundTick, 16)
  }
  const animationTick = () => {
    if (stopped) return
    tick()
    if (!stopped) raf = window.requestAnimationFrame(animationTick)
  }

  if (enableWorker && typeof Worker !== 'undefined') {
    try {
      worker = new Worker(new URL('./playback-clock.worker.ts', import.meta.url), { type: 'module', name: 'svga-playback-clock' })
      worker.onmessage = backgroundTick
      worker.onerror = (event) => {
        event.preventDefault()
        worker?.terminate()
        worker = null
        startFallback()
      }
      worker.postMessage('start')
    } catch {
      worker?.terminate()
      worker = null
      startFallback()
    }
  } else {
    startFallback()
  }

  raf = window.requestAnimationFrame(animationTick)
  tick()
  return () => {
    if (stopped) return
    stopped = true
    worker?.terminate()
    if (fallback !== null) window.clearInterval(fallback)
    window.cancelAnimationFrame(raf)
  }
}
