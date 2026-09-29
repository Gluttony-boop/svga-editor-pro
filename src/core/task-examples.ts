import pako from 'pako'
import protobuf from 'protobufjs'
import type { FrameData, Movie, Sprite } from '@/types'
import { encodeQuantizedPng } from './png-quantize'
import proto from './svga-proto'

export type StarterTask = 'profile' | 'compress' | 'batch' | 'delivery'

type Color = readonly [number, number, number]
type Pixel = readonly [number, number, number, number]
interface Theme { title: string; sampleText: string; background: Color; card: Color; accent: Color; highlight: Color; seed: number }

const themes: Record<StarterTask, Theme> = {
  profile: { title: '头像昵称', sampleText: '星河设计师', background: [230, 235, 252], card: [255, 255, 255], accent: [88, 91, 229], highlight: [141, 197, 255], seed: 19 },
  compress: { title: '压缩体积', sampleText: '轻量动画测试', background: [12, 43, 50], card: [23, 67, 73], accent: [38, 203, 166], highlight: [160, 243, 205], seed: 47 },
  batch: { title: '批量生产', sampleText: '小雨同学', background: [255, 232, 217], card: [255, 250, 243], accent: [235, 109, 75], highlight: [255, 201, 121], seed: 73 },
  delivery: { title: '检查交付', sampleText: '设计交付样例', background: [27, 24, 48], card: [48, 43, 75], accent: [169, 141, 247], highlight: [220, 199, 255], seed: 103 }
}

const clamp = (value: number, max = 1) => Math.max(0, Math.min(max, value))
const mix = (a: Color, b: Color, t: number): Color => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const pixel = (color: Color, alpha = 1): Pixel => [color[0], color[1], color[2], clamp(alpha) * 255]
const circle = (x: number, y: number, cx: number, cy: number, radius: number) => clamp(radius + 0.5 - Math.hypot(x - cx, y - cy))
const rounded = (x: number, y: number, width: number, height: number, radius: number) => {
  const dx = Math.abs(x - width / 2) - width / 2 + radius
  const dy = Math.abs(y - height / 2) - height / 2 + radius
  return clamp(radius + 0.5 - Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - Math.min(Math.max(dx, dy), 0))
}

function noise(x: number, y: number, seed: number): number {
  let value = Math.imul(x + 17, 374761393) ^ Math.imul(y + seed, 668265263)
  value = Math.imul(value ^ (value >>> 13), 1274126177)
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff
}

function raster(width: number, height: number, paint: (x: number, y: number) => Pixel): Uint8Array {
  const bytes = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = paint(x + 0.5, y + 0.5)
    const offset = (y * width + x) * 4
    for (let channel = 0; channel < 4; channel++) bytes[offset + channel] = Math.round(clamp(color[channel], 255))
  }
  return new Uint8Array(encodeQuantizedPng(bytes, width, height, 256))
}

function makeImages(task: StarterTask, theme: Theme): Record<string, Uint8Array> {
  // 背景保留二倍画布分辨率和轻微渐变纹理，让缩图/量化的空间与画质取舍可被实际观察。
  const background = raster(1040, 600, (x, y) => {
    const radial = clamp(1 - Math.hypot(x - 120, y - 65) / 1120)
    let amount = radial * 0.18 + (x / 1040) * 0.03
    if (task === 'compress') amount += Math.min(x % 56, y % 56) < 1.5 ? 0.08 : 0
    if (task === 'batch') amount += Math.abs((x + y * 0.5) % 112 - 56) < 1 ? 0.06 : 0
    if (task === 'delivery') amount += circle(x % 76, y % 76, 38, 38, 1.4) * 0.12
    const base = mix(theme.background, theme.highlight, clamp(amount))
    const grain = (noise(Math.floor(x), Math.floor(y), theme.seed) - 0.5) * 2.4
    return [base[0] + grain, base[1] + grain, base[2] + grain, 255]
  })
  const card = raster(944, 440, (x, y) => {
    const edge = rounded(x, y, 944, 440, task === 'delivery' ? 28 : 52)
    const rim = edge - rounded(x - 2, y - 2, 940, 436, task === 'delivery' ? 26 : 50)
    const sheen = clamp(1 - Math.hypot(x - 860, y - 25) / 700) * 0.08
    return pixel(mix(theme.card, theme.highlight, Math.max(rim * 0.4, sheen)), edge)
  })
  const avatar = raster(192, 192, (x, y) => {
    const edge = circle(x, y, 96, 96, 94)
    const head = circle(x, y, 96, 70, 27)
    const shoulders = circle(x, y, 96, 163, 60)
    const ring = edge - circle(x, y, 96, 96, 86)
    const face = clamp(head + shoulders)
    const base = mix(theme.accent, theme.highlight, clamp((x + y) / 440))
    return pixel(mix(base, [255, 255, 255], Math.max(face * 0.88, ring * 0.36)), edge)
  })
  const text = raster(600, 116, (x, y) => {
    const edge = rounded(x, y, 600, 116, 22)
    const inner = rounded(x - 2, y - 2, 596, 112, 20)
    return pixel(theme.accent, (edge - inner) * 0.22 + inner * 0.025)
  })
  const progress = raster(584, 44, (x, y) => {
    if (task === 'batch') {
      const segment = x % 100
      return pixel(mix(theme.accent, theme.highlight, Math.floor(x / 100) / 8), rounded(segment, y - 8, 80, 28, 14))
    }
    if (task === 'delivery') {
      const dash = x % 42 < 23 ? 1 : 0
      return pixel(theme.highlight, dash * rounded(x, y - 18, 584, 6, 3) * 0.7)
    }
    return pixel(mix(theme.accent, theme.highlight, x / 584), rounded(x, y - 14, 584, 16, 8) * (x < 408 ? 0.85 : 0.2))
  })
  const orbit = raster(128, 128, (x, y) => {
    const radius = Math.hypot(x - 64, y - 64)
    const ring = clamp(2.5 - Math.abs(radius - 42))
    const dot = circle(x, y, 64, 22, 8)
    const core = task === 'delivery'
      ? clamp(12 - Math.abs(x - 64) - Math.abs(y - 64))
      : circle(x, y, 64, 64, task === 'batch' ? 7 : 4)
    return pixel(theme.accent, Math.max(ring * 0.48, dot, core * 0.7))
  })
  return { studio_background: background, studio_card: card, avatar, nickname_text: text, progress_line: progress, accent_orbit: orbit }
}

function sprite(imageKey: string, width: number, height: number, centerX: number, centerY: number,
  animation?: (phase: number) => { x?: number; y?: number; scale?: number; rotation?: number; alpha?: number }): Sprite {
  const frames: FrameData[] = Array.from({ length: 48 }, (_, index) => {
    const motion = animation?.(index / 48 * Math.PI * 2) || {}
    const scale = motion.scale ?? 1
    const a = Math.cos(motion.rotation ?? 0) * scale
    const b = Math.sin(motion.rotation ?? 0) * scale
    return { alpha: motion.alpha ?? 1, clipPath: null, layout: { x: 0, y: 0, width, height },
      transform: { a, b, c: -b, d: a, tx: centerX + (motion.x || 0) - (a * width - b * height) / 2, ty: centerY + (motion.y || 0) - (b * width + a * height) / 2 } }
  })
  return { imageKey, matteKey: null, frames }
}

/** 全部图像来自本地数学几何，不载入头像、竞品素材或字体；示例资源授权见 docs/task-example-license.md。 */
export function createTaskExample(task: StarterTask): { buffer: ArrayBuffer; fileName: string; nicknameKey: string; sampleText: string; textColor: string } {
  if (!Object.prototype.hasOwnProperty.call(themes, task)) throw new Error('不支持的示例任务')
  const theme = themes[task]
  const movie: Movie = { version: '2.0.0', params: { viewBoxWidth: 520, viewBoxHeight: 300, fps: 24, frames: 48 },
    images: makeImages(task, theme), sprites: [
      sprite('studio_background', 520, 300, 260, 150),
      sprite('studio_card', 472, 220, 260, 150),
      sprite('accent_orbit', 46, 46, 451, 73, phase => ({ rotation: phase })),
      sprite('avatar', 92, 92, 96, 146, phase => ({ y: Math.sin(phase) * 2.5, scale: 1 + Math.sin(phase) * 0.025 })),
      sprite('nickname_text', 300, 58, 314, 136),
      sprite('progress_line', 292, 22, 310, 188, phase => ({ alpha: 0.82 + Math.cos(phase) * 0.12 })),
      sprite('avatar', 32, 32, 449, 217, phase => ({ y: -Math.sin(phase) * 1.5, alpha: 0.88 }))
    ] }
  const MovieType = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
  const encoded = MovieType.encode(MovieType.fromObject(movie)).finish()
  const compressed = new Uint8Array(pako.deflate(encoded, { level: 6 }))
  return { buffer: compressed.buffer, fileName: `原创示例-${theme.title}.svga`, nicknameKey: 'nickname_text', sampleText: theme.sampleText,
    textColor: task === 'profile' || task === 'batch' ? '#26324a' : '#ffffff' }
}
