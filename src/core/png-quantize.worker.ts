import { encodeQuantizedPng } from './png-quantize'

self.onmessage = (event: MessageEvent<{ rgba: ArrayBuffer; width: number; height: number; colors: number }>) => {
  try {
    const { rgba, width, height, colors } = event.data
    const buffer = encodeQuantizedPng(new Uint8Array(rgba), width, height, colors)
    self.postMessage({ buffer }, { transfer: [buffer] })
  } catch (error) {
    self.postMessage({ error: (error as Error).message })
  }
}
