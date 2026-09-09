import { describe, expect, it } from 'vitest'
import pako from 'pako'
import { encodeQuantizedPng } from './png-quantize'

function inspect(bytes: Uint8Array) {
  const blocks = new Map<string, Uint8Array>()
  let offset = 8
  while (offset < bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset).getUint32(0)
    const name = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8))
    expect(offset + length + 12).toBeLessThanOrEqual(bytes.length)
    blocks.set(name, bytes.slice(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  expect(offset).toBe(bytes.length)
  expect(blocks.has('IEND')).toBe(true)
  return blocks
}

describe('safe palette PNG writer', () => {
  it.each([1, 2, 4, 32])('emits a complete %ix%i PNG including semi-transparent tiny images', (side) => {
    const rgba = new Uint8Array(side * side * 4)
    for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 255; rgba[i + 3] = 128 }
    const snapshot = rgba.slice()
    const chunks = inspect(new Uint8Array(encodeQuantizedPng(rgba, side, side, 256)))
    expect(new DataView(chunks.get('IHDR')!.buffer).getUint32(0)).toBe(side)
    expect(pako.inflate(chunks.get('IDAT')!).length).toBe((side + 1) * side)
    expect(chunks.get('tRNS')![0]).toBe(128)
    expect(Array.from(new Uint8Array(encodeQuantizedPng(rgba, side, side, 256)).slice(-4))).toEqual([174,66,96,130])
    expect(rgba).toEqual(snapshot)
  })
  it('retains fully transparent pixels and rejects malformed buffers', () => {
    const chunks = inspect(new Uint8Array(encodeQuantizedPng(new Uint8Array(16), 2, 2, 64)))
    expect(chunks.get('tRNS')![0]).toBe(0)
    expect(() => encodeQuantizedPng(new Uint8Array(3), 1, 1, 256)).toThrow()
  })
})
