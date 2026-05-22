declare module 'pako' {
  export function inflate(data: Uint8Array, options?: { to?: string }): Uint8Array
  export function deflate(data: Uint8Array, options?: { level?: number }): Uint8Array
  export function inflateRaw(data: Uint8Array, options?: { to?: string }): Uint8Array
  export function deflateRaw(data: Uint8Array, options?: { level?: number }): Uint8Array
  export function gzip(data: Uint8Array, options?: { level?: number }): Uint8Array
  export function ungzip(data: Uint8Array, options?: { to?: string }): Uint8Array
}

declare module 'upng-js' {
  export function decode(buffer: ArrayBuffer): { width: number; height: number; data: Uint8Array; tabs: any; frames: any[] }
  export function encode(imgs: ArrayBuffer[], w: number, h: number, cnum?: number): ArrayBuffer
}
