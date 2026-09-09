import UPNG from 'upng-js'
import pako from 'pako'

function chunk(name: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(data.length + 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, data.length)
  bytes.set(new TextEncoder().encode(name), 4)
  bytes.set(data, 8)
  let crc = 0xffffffff
  for (let i = 4; i < bytes.length - 4; i++) {
    crc ^= bytes[i]
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0)
  return bytes
}

/** Use UPNG only for quantization. Its published encoder truncates tiny PNGs. */
export function encodeQuantizedPng(rgba: Uint8Array, width: number, height: number, colors: number): ArrayBuffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 4_194_304 || rgba.length !== width * height * 4) throw new Error('PNG 量化尺寸无效或超过 419 万像素')
  if (![64, 128, 256].includes(colors)) throw new Error('PNG 色数必须是 64、128 或 256')
  const input = new Uint8Array(rgba).buffer
  const quantized = new Uint8Array(UPNG.quantize([input], colors, false).bufs[0])
  const palette = new Map<number, number>()
  const rgb: number[] = [], alpha: number[] = []
  const rows = new Uint8Array((width + 1) * height)
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4
    // Fully transparent pixels need no hidden RGB variation.
    const a = quantized[offset + 3]
    const r = a ? quantized[offset] : 0, g = a ? quantized[offset + 1] : 0, b = a ? quantized[offset + 2] : 0
    const value = (r | g << 8 | b << 16 | a << 24) >>> 0
    let index = palette.get(value)
    if (index === undefined) {
      index = palette.size
      if (index >= 256) throw new Error('PNG 调色板超过 256 色')
      palette.set(value, index)
      rgb.push(r, g, b)
      alpha.push(a)
    }
    rows[Math.floor(i / width) * (width + 1) + 1 + i % width] = index
  }
  const header = new Uint8Array(13), view = new DataView(header.buffer)
  view.setUint32(0, width); view.setUint32(4, height)
  header[8] = 8; header[9] = 3 // indexed RGBA via PLTE + tRNS
  const chunks = [new Uint8Array([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('PLTE', new Uint8Array(rgb)), chunk('tRNS', new Uint8Array(alpha)), chunk('IDAT', pako.deflate(rows, { level: 9 })), chunk('IEND', new Uint8Array())]
  const result = new Uint8Array(chunks.reduce((size, bytes) => size + bytes.length, 0))
  let offset = 0
  for (const bytes of chunks) { result.set(bytes, offset); offset += bytes.length }
  return result.buffer
}
