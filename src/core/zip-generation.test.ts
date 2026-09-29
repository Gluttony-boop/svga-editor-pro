import { afterEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { generateZipArchive } from './zip-generation'

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 15))
const bytes = (length: number) => {
  const value = new Uint8Array(length)
  let seed = 0x357931af
  for (let index = 0; index < length; index++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; value[index] = seed & 255 }
  return value
}

function archive(count = 8): JSZip {
  const zip = new JSZip()
  const payload = bytes(256 * 1024)
  for (let index = 0; index < count; index++) zip.file(`entry-${index}.bin`, payload, { date: new Date('2000-01-01T00:00:00Z') })
  return zip
}

async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('ZIP 任务未及时结束')), 1500) })])
  } finally { clearTimeout(timer) }
}

afterEach(() => { vi.restoreAllMocks() })

describe('generateZipArchive', () => {
  // CI 的 Windows runner 在首次压缩大块二进制时可能明显慢于本机，测试超时应覆盖合理冷启动而非偶发抖动。
  it.each(['STORE', 'DEFLATE'] as const)('%s真实生成与generateAsync字节完全一致，CRC可读且本地头不使用data descriptor', async compression => {
    const zip = archive(2)
    const progress: number[] = []
    const create = vi.spyOn(zip, 'generateInternalStream')
    const blob = await generateZipArchive(zip, { compression, compressionLevel: 6, maxBytes: 4 * 1024 * 1024, onProgress: percent => progress.push(percent) })
    expect(blob.type).toBe('application/zip')
    expect(create).toHaveBeenCalledWith({ type: 'uint8array', compression, compressionOptions: { level: 6 }, streamFiles: false, platform: 'DOS' })
    const buffer = await blob.arrayBuffer()
    expect(new Uint8Array(buffer)).toEqual(await zip.generateAsync({ type: 'uint8array', compression, compressionOptions: { level: 6 }, streamFiles: false, platform: 'DOS' }))
    const decoded = await JSZip.loadAsync(buffer, { checkCRC32: true })
    expect(await decoded.file('entry-0.bin')!.async('uint8array')).toEqual(bytes(256 * 1024))
    expect(await decoded.file('entry-1.bin')!.async('uint8array')).toEqual(bytes(256 * 1024))
    expect(new DataView(buffer).getUint16(6, true) & 8).toBe(0)
    expect(progress.length).toBeGreaterThan(2)
    expect(progress.every(percent => percent >= 0 && percent <= 100)).toBe(true)
    expect(progress.at(-1)).toBe(100)
  }, 30_000)

  it.each(['STORE', 'DEFLATE'] as const)('%s真实流数据回调取消立即reject，无未捕获错误、后续用户进度或第二文件读取', async compression => {
    const zip = archive()
    const signal = new AbortController()
    const errors: unknown[] = []
    const collectError = (error: unknown) => errors.push(error)
    process.on('unhandledRejection', collectError)
    process.on('uncaughtException', collectError)
    const progress: number[] = []
    const sourceFiles: Array<string | null> = []
    const makeStream = zip.generateInternalStream.bind(zip)
    vi.spyOn(zip, 'generateInternalStream').mockImplementation(options => {
      const stream = makeStream(options)
      stream.on('data', (_chunk, metadata) => sourceFiles.push(metadata.currentFile))
      return stream
    })
    const removed = vi.spyOn(signal.signal, 'removeEventListener')
    try {
      const pending = generateZipArchive(zip, {
        compression, compressionLevel: 6, maxBytes: 4 * 1024 * 1024, signal: signal.signal,
        onProgress: percent => { progress.push(percent); if (percent > 0 && percent < 100) signal.abort() }
      })
      await expect(deadline(pending)).rejects.toMatchObject({ name: 'AbortError' })
      const progressAtCancellation = progress.length
      expect(progressAtCancellation).toBeGreaterThan(1)
      expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
      await tick()
      expect(progress).toHaveLength(progressAtCancellation)
      expect(errors).toEqual([])
      // streamFiles=false 首条目缓冲的同步刷新不能被抢占，但后续源必须保持暂停。
      expect(new Set(sourceFiles.filter(Boolean))).toEqual(new Set(['entry-0.bin']))
    } finally {
      process.off('unhandledRejection', collectError)
      process.off('uncaughtException', collectError)
    }
  })

  it('预取消不创建流，不启动压缩', async () => {
    const zip = archive()
    const create = vi.spyOn(zip, 'generateInternalStream')
    const controller = new AbortController()
    controller.abort()
    await expect(generateZipArchive(zip, { compression: 'DEFLATE', maxBytes: 100, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(create).not.toHaveBeenCalled()
  })

  it('同一调用栈取消不resume已创建流，所有阶段都清理监听', async () => {
    const zip = archive()
    const makeStream = zip.generateInternalStream.bind(zip)
    const resumes = vi.fn()
    vi.spyOn(zip, 'generateInternalStream').mockImplementation(options => {
      const stream = makeStream(options)
      const resume = stream.resume.bind(stream)
      stream.resume = () => { resumes(); return resume() }
      return stream
    })
    const controller = new AbortController()
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    const progress = vi.fn()
    const pending = generateZipArchive(zip, { compression: 'DEFLATE', maxBytes: 4 * 1024 * 1024, signal: controller.signal, onProgress: progress })
    controller.abort()
    await expect(deadline(pending)).rejects.toMatchObject({ name: 'AbortError' })
    await tick()
    expect(resumes).not.toHaveBeenCalled()
    expect(progress).not.toHaveBeenCalled()
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('等待尚未提供的条目数据时取消，后来输入完成也不发进度', async () => {
    const zip = new JSZip()
    let provide: (value: Uint8Array) => void = () => undefined
    zip.file('waiting.bin', new Promise<Uint8Array>(resolve => { provide = resolve }))
    const controller = new AbortController()
    const progress = vi.fn()
    const pending = generateZipArchive(zip, { compression: 'DEFLATE', maxBytes: 4 * 1024 * 1024, signal: controller.signal, onProgress: progress })
    await tick()
    controller.abort()
    await expect(deadline(pending)).rejects.toMatchObject({ name: 'AbortError' })
    provide(bytes(1024))
    await tick()
    expect(progress).not.toHaveBeenCalled()
  })

  it('压缩进行中、首条目还没有数据事件时取消仍可结束', async () => {
    const zip = archive(16)
    const controller = new AbortController()
    const progress = vi.fn()
    const pending = generateZipArchive(zip, { compression: 'DEFLATE', compressionLevel: 9, maxBytes: 8 * 1024 * 1024, signal: controller.signal, onProgress: progress })
    await new Promise<void>(resolve => setImmediate(resolve))
    controller.abort()
    await expect(deadline(pending)).rejects.toMatchObject({ name: 'AbortError' })
    const count = progress.mock.calls.length
    await tick()
    expect(progress).toHaveBeenCalledTimes(count)
  })

  it('进度回调的业务异常走Promise拒绝，不能逃逸至JSZip事件调用栈', async () => {
    const error = new Error('UI 无法更新进度')
    const progress = vi.fn(() => { throw error })
    const controller = new AbortController()
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    await expect(deadline(generateZipArchive(archive(), { compression: 'STORE', maxBytes: 4 * 1024 * 1024, signal: controller.signal, onProgress: progress }))).rejects.toBe(error)
    await tick()
    expect(progress).toHaveBeenCalledTimes(1)
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('字节上限在流中执行，超限停止进度；恰等于大小可完成', async () => {
    const zip = archive(1)
    const expected = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' })
    const exact = await generateZipArchive(zip, { compression: 'STORE', maxBytes: expected.length })
    expect(exact.size).toBe(expected.length)
    const progress = vi.fn()
    await expect(deadline(generateZipArchive(zip, { compression: 'STORE', maxBytes: expected.length - 1, onProgress: progress }))).rejects.toThrow('大小上限')
    const count = progress.mock.calls.length
    await tick()
    expect(progress).toHaveBeenCalledTimes(count)
  })

  it('JSZip自身数据错误通过error事件拒绝并清理监听', async () => {
    const zip = new JSZip()
    let failInput: (reason: unknown) => void = () => undefined
    zip.file('bad.bin', new Promise<Uint8Array>((_, reject) => { failInput = reject }))
    const controller = new AbortController()
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = generateZipArchive(zip, { compression: 'STORE', maxBytes: 10000, signal: controller.signal })
    const reason = new Error('读取素材失败')
    failInput(reason)
    await expect(deadline(pending)).rejects.toBe(reason)
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('成功完成也移除abort监听，后续取消不影响返回的ZIP', async () => {
    const controller = new AbortController()
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    const blob = await generateZipArchive(new JSZip().file('text.txt', 'done'), { compression: 'STORE', maxBytes: 1000, signal: controller.signal })
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
    expect(await (await JSZip.loadAsync(await blob.arrayBuffer())).file('text.txt')!.async('string')).toBe('done')
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('无效maxBytes=%s在创建流前拒绝', async maxBytes => {
    const zip = new JSZip()
    const create = vi.spyOn(zip, 'generateInternalStream')
    await expect(generateZipArchive(zip, { compression: 'STORE', maxBytes })).rejects.toThrow('大小上限')
    expect(create).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, 10, NaN, Infinity])('拒绝不受支持的压缩级别%s', async compressionLevel => {
    await expect(generateZipArchive(new JSZip(), { compression: 'DEFLATE', maxBytes: 100, compressionLevel })).rejects.toThrow('压缩级别')
  })

  it('保留每条目显式压缩选项，不改动调用方的源ZIP', async () => {
    const zip = new JSZip().file('stored.bin', bytes(1024), { compression: 'STORE' }).file('deflated.txt', '压缩文本'.repeat(100))
    const result = await generateZipArchive(zip, { compression: 'DEFLATE', compressionLevel: 6, maxBytes: 10000 })
    expect(new DataView(await result.arrayBuffer()).getUint16(8, true)).toBe(0)
    expect(zip.file('stored.bin')?.options.compression).toBe('STORE')
    expect(zip.file('deflated.txt')?.options.compression).toBeNull()
  })
})
