/** Transfer only freshly read canvas pixels, never the editor's source buffers. */
export async function compressPalettePng(rgba: Uint8ClampedArray, width: number, height: number, colors: number): Promise<ArrayBuffer> {
  const input = new Uint8Array(rgba).buffer
  if (typeof Worker === 'undefined') {
    const { encodeQuantizedPng } = await import('./png-quantize')
    return encodeQuantizedPng(new Uint8Array(input), width, height, colors)
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./png-quantize.worker.ts', import.meta.url), { type: 'module' })
    const cleanup = () => { clearTimeout(timer); worker.terminate() }
    const timer = setTimeout(() => { cleanup(); reject(new Error('PNG 量化超时，保留原图片')) }, 25000)
    worker.onmessage = (event: MessageEvent<{ buffer?: ArrayBuffer; error?: string }>) => {
      cleanup()
      if (event.data.buffer) resolve(event.data.buffer)
      else reject(new Error(event.data.error || 'PNG 量化失败'))
    }
    worker.onerror = () => { cleanup(); reject(new Error('PNG 压缩 Worker 无法运行，保留原图片')) }
    worker.postMessage({ rgba: input, width, height, colors }, [input])
  })
}
