import type JSZip from 'jszip'

export interface ZipGenerationOptions {
  compression: 'STORE' | 'DEFLATE'
  compressionLevel?: number
  maxBytes: number
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}

const cancelled = () => new DOMException('已取消 ZIP 生成', 'AbortError')

/**
 * 使用公开流接口控制取消；绝不向 JSZip 的 data 回调抛错。
 * 不启用 streamFiles，以保持工程已有的本地头、CRC 和条目大小布局。
 * pause 不能抢占已经进入的同步压缩/刷新片段，因此终止后还需忽略迟到的数据。
 */
export async function generateZipArchive(zip: JSZip, options: ZipGenerationOptions): Promise<Blob> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) throw new Error('ZIP 大小上限必须是正安全整数（字节）')
  if (options.compression !== 'STORE' && options.compression !== 'DEFLATE') throw new Error('ZIP 压缩模式无效')
  if (options.compressionLevel !== undefined && (!Number.isInteger(options.compressionLevel) || options.compressionLevel < 1 || options.compressionLevel > 9)) throw new Error('ZIP 压缩级别必须是 1–9 的整数')
  if (options.signal?.aborted) throw cancelled()

  const stream = zip.generateInternalStream({
    type: 'uint8array', compression: options.compression,
    ...(options.compressionLevel === undefined ? {} : { compressionOptions: { level: options.compressionLevel } }),
    streamFiles: false, platform: 'DOS'
  })
  return new Promise<Blob>((resolve, reject) => {
    let chunks: ArrayBuffer[] = []
    let totalBytes = 0
    let settled = false
    const pause = () => {
      // 即使库已结束/出错，也不能让清理错误从事件回调逃逸并悬挂调用方。
      try { stream.pause() } catch { /* 保留任务原始错误；公开流接口没有强制销毁方法。 */ }
    }
    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort)
      chunks = []
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      pause()
      cleanup()
      reject(error)
    }
    const onAbort = () => fail(cancelled())

    stream.on('data', (chunk, metadata) => {
      // resume 内部可能已排队；若终止后才开始送数据，再 pause 一次并丢弃。
      if (settled) { pause(); return }
      try {
        if (options.signal?.aborted) { onAbort(); return }
        if (chunk.byteLength > options.maxBytes - totalBytes) { fail(new Error(`ZIP 文件超过 ${options.maxBytes} 字节大小上限`)); return }
        totalBytes += chunk.byteLength
        // 不持有库可复用的切片，也不在结束时额外拼接一个同等大小的 Uint8Array。
        chunks.push(new Uint8Array(chunk).buffer)
        options.onProgress?.(metadata.percent)
        if (options.signal?.aborted) onAbort()
      } catch (error) { fail(error) }
    })
    stream.on('error', error => fail(error))
    stream.on('end', () => {
      if (settled) return
      try {
        if (options.signal?.aborted) { onAbort(); return }
        const result = new Blob(chunks, { type: 'application/zip' })
        settled = true
        cleanup()
        resolve(result)
      } catch (error) { fail(error) }
    })
    options.signal?.addEventListener('abort', onAbort, { once: true })
    // 同一调用栈内关闭对话框时，不启动此前尚未 resume 的工作。
    queueMicrotask(() => {
      if (settled) return
      if (options.signal?.aborted) { onAbort(); return }
      try { stream.resume() } catch (error) { fail(error) }
    })
  })
}
