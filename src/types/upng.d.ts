declare module 'upng-js' {
  const UPNG: { quantize(images: ArrayBuffer[], colors: number, roundAlpha: boolean): { bufs: ArrayBuffer[] } }
  export default UPNG
}
