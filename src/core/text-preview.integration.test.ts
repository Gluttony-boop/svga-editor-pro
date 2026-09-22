import { afterEach, describe, expect, it, vi } from 'vitest'
import pako from 'pako'
import protobuf from 'protobufjs'
import type { FrameData, Layer, SlotConfig, VideoItem } from '@/types'
import proto from './svga-proto'
import { createDefaultTracks } from './layer-factory'
import { applyLayerFrameEdits } from './layer-transform'
import { CanvasRenderer, type RenderOptions } from './renderer'
import { HighPerformanceRenderer } from './renderer.high-performance'
import { OfficialSvgRenderer } from './renderer.official'
import { ExportEngine } from './exporter'
import { SVGABuilder } from './svga-builder'

const modes = ['high', 'official', 'canvas'] as const
type Mode = typeof modes[number]
const params = { viewBoxWidth: 400, viewBoxHeight: 300, fps: 24, frames: 3 }
const sourceImageBytes = new Uint8Array([1, 2, 3])
const replacementImageBytes = new Uint8Array([9, 8, 7])
const frame = (index = 0): FrameData => ({
  alpha: 0.6 + index * 0.1,
  layout: { x: 0, y: 0, width: 80, height: 30 },
  transform: { a: 0, b: 1.5, c: -0.75, d: 0, tx: 25 + index * 5, ty: 12 },
  clipPath: 'M0 0L80 0L80 30Z'
})
const textSlot = (overrides: Partial<SlotConfig['textConfig']> = {}): SlotConfig => ({
  type: 'text', name: 'title', value: '标题', textConfig: {
    text: '第一行\n第二行', fontSize: 10, color: '#ff8800', fontFamily: 'Arial',
    fontWeight: 'bold', textAlign: 'right', offsetX: -3, offsetY: 2, lineHeight: 1.5, ...overrides
  }
})

type CanvasState = { matrix: number[]; composite: string; alpha: number; clips: string[] }
type DrawRecord = CanvasState & { image: unknown; args: number[] }
type TextRecord = { text: string; x: number; y: number; font: string; color: string; align: string; baseline: string }
type CanvasRecord = { canvas: HTMLCanvasElement; draws: DrawRecord[]; texts: TextRecord[] }

function canvasHarness() {
  const canvases: CanvasRecord[] = []
  const imageRequests: string[] = []
  const loadedImages = new Map<string, HTMLImageElement>()
  const createCanvas = () => {
    const draws: DrawRecord[] = []
    const texts: TextRecord[] = []
    let matrix = [1, 0, 0, 1, 0, 0]
    let clips: string[] = []
    const stack: CanvasState[] = []
    const ctx = {
      globalAlpha: 1, globalCompositeOperation: 'source-over',
      font: '10px sans-serif', fillStyle: '#000000', textAlign: 'left', textBaseline: 'alphabetic',
      setTransform: (...values: number[]) => { matrix = values }, transform: vi.fn(), clearRect: vi.fn(),
      beginPath: vi.fn(), rect: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
      clip: (path?: { path: string }) => { clips.push(path?.path ?? '文字区域') },
      save: () => { stack.push({ matrix: [...matrix], alpha: ctx.globalAlpha, composite: ctx.globalCompositeOperation, clips: [...clips] }) },
      restore: () => {
        const state = stack.pop()!
        matrix = state.matrix; ctx.globalAlpha = state.alpha; ctx.globalCompositeOperation = state.composite; clips = state.clips
      },
      drawImage: (image: unknown, ...args: number[]) => {
        draws.push({ image, args, matrix: [...matrix], alpha: ctx.globalAlpha, composite: ctx.globalCompositeOperation, clips: [...clips] })
      },
      fillText: (text: string, x: number, y: number) => {
        texts.push({ text, x, y, font: ctx.font, color: ctx.fillStyle, align: ctx.textAlign, baseline: ctx.textBaseline })
      }
    }
    const canvas = {
      width: 400, height: 300, getContext: () => ctx,
      toBlob: (callback: (blob: Blob) => void) => callback(new Blob([replacementImageBytes]))
    } as unknown as HTMLCanvasElement
    canvases.push({ canvas, draws, texts })
    return canvas
  }
  class MockImage {
    complete = false
    width = 600; height = 200; naturalWidth = 600; naturalHeight = 200
    onload: (() => void) | null = null
    srcValue = ''
    set src(url: string) {
      this.srcValue = url
      imageRequests.push(url)
      loadedImages.set(url, this as unknown as HTMLImageElement)
      queueMicrotask(() => { this.complete = true; this.onload?.() })
    }
  }
  vi.stubGlobal('document', { createElement: createCanvas })
  vi.stubGlobal('window', { devicePixelRatio: 1 })
  vi.stubGlobal('Path2D', class { constructor(public path: string) {} })
  vi.stubGlobal('Image', MockImage)
  vi.stubGlobal('createImageBitmap', undefined)
  const image = { width: 80, height: 30, naturalWidth: 80, naturalHeight: 30, complete: true } as HTMLImageElement
  const video: VideoItem = {
    movie: { version: '2.0.0', params: { ...params }, images: { title: sourceImageBytes },
      sprites: [{ imageKey: 'title', matteKey: null, frames: [frame(0), frame(1), frame(2)] }] },
    images: { title: image }, buffers: {}
  }
  const layers: Layer[] = [{
    id: '0', editableIndex: 0, name: 'title', imageKey: 'title', type: 'image', visible: true, locked: false,
    expanded: true, opacity: 0.5, blendMode: 'normal', clip: { startFrame: 0, duration: 3 }, tracks: createDefaultTracks(),
    sprites: video.movie.sprites[0], canvasTransform: { x: 7, y: -4, scaleX: 1.2, scaleY: 0.8, rotation: Math.PI / 6 }
  }]
  const main = createCanvas()
  const renderer = (mode: Mode) => mode === 'high' ? new HighPerformanceRenderer(main)
    : mode === 'official' ? new OfficialSvgRenderer(main) : new CanvasRenderer(main)
  return { canvases, createCanvas, main, image, video, layers, renderer, imageRequests, loadedImages }
}

const matrixValues = (value: FrameData['transform']) => [value.a, value.b, value.c, value.d, value.tx, value.ty]
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe.each(modes)('%s 动态文字真实绘制路径', mode => {
  it('扩宽文字框不把文字压回原宽度，也不改变底图、字号和图层变换中心', async () => {
    const h = canvasHarness()
    const renderer = h.renderer(mode)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    const slot = textSlot({ boxWidth: 240, boxHeight: 60, referenceWidth: 80, referenceHeight: 30 })
    await renderer.renderFrameAsync(1, { layers: h.layers, slotConfigs: { title: slot }, useFrameCache: false })
    const composed = h.canvases.find(item => item.texts.length > 0)!
    expect([composed.canvas.width, composed.canvas.height]).toEqual([240, 60])
    expect(composed.draws[0].args).toEqual([0, 0, 80, 30])
    expect(composed.texts[0]).toMatchObject({ x: 237, font: 'bold 10px Arial' })
    const output = h.canvases[0].draws.at(-1)!
    expect(output.args).toEqual([0, 0, 240, 60])
    expect(output.matrix).toEqual(matrixValues(applyLayerFrameEdits(frame(1), h.layers[0], 1).transform))
    expect(output.clips).toEqual([frame().clipPath])
    renderer.destroy()
  })

  it('同一文字区域随逐帧layout同比例变化并复用固定纹理', async () => {
    const h = canvasHarness()
    h.video.movie.sprites[0].frames[2].layout = { x: 0, y: 0, width: 160, height: 60 }
    const renderer = h.renderer(mode)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    const slot = textSlot({ boxWidth: 240, boxHeight: 60, referenceWidth: 80, referenceHeight: 30 })
    await renderer.renderFrameAsync(0, { layers: h.layers, slotConfigs: { title: slot }, useFrameCache: false })
    await renderer.renderFrameAsync(2, { layers: h.layers, slotConfigs: { title: slot }, useFrameCache: false })
    expect(h.canvases.filter(item => item.texts.length > 0)).toHaveLength(1)
    const output = h.canvases[0].draws.at(-1)!
    expect(output.args).toEqual([0, 0, 480, 120])
    expect(output.matrix).toEqual(matrixValues(applyLayerFrameEdits(h.video.movie.sprites[0].frames[2], h.layers[0], 2).transform))
    renderer.destroy()
  })

  it('禁用文字保留框的透明扩展，底图仍按原尺寸绘制', async () => {
    const h = canvasHarness()
    const renderer = h.renderer(mode)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    const slot = textSlot({ enabled: false, replaceImage: true, boxWidth: 240, boxHeight: 60, referenceWidth: 80, referenceHeight: 30 })
    await renderer.renderFrameAsync(0, { layers: h.layers, slotConfigs: { title: slot }, useFrameCache: false })
    const output = h.canvases[0].draws.at(-1)!
    expect(output.args).toEqual([0, 0, 240, 60])
    const composed = h.canvases.find(item => item.canvas === output.image)!
    expect(composed.draws[0].args).toEqual([0, 0, 80, 30])
    expect(composed.texts).toHaveLength(0)
    renderer.destroy()
  })

  it('缺底图且后帧没有layout时回退文字参考尺寸，并用它计算原运动中心', async () => {
    const h = canvasHarness()
    h.video.images = {}
    h.video.movie.images = {}
    h.video.movie.sprites[0].frames[1].layout = null
    const renderer = h.renderer(mode)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    const slot = textSlot({ boxWidth: 240, boxHeight: 60, referenceWidth: 80, referenceHeight: 30 })
    await renderer.renderFrameAsync(1, { layers: h.layers, slotConfigs: { title: slot }, useFrameCache: false })
    const output = h.canvases[0].draws.at(-1)!
    expect(output.args).toEqual([0, 0, 240, 60])
    expect(output.matrix).toEqual(matrixValues(applyLayerFrameEdits(h.video.movie.sprites[0].frames[1], h.layers[0], 1, { width: 80, height: 30 }).transform))
    renderer.destroy()
  })

  it('缺layout但原位图与参考尺寸不同，仍按原位图回退；不用扩容纹理的尺寸', async () => {
    const h = canvasHarness()
    h.video.images.title = { ...h.image, width: 600, height: 200, naturalWidth: 600, naturalHeight: 200 } as HTMLImageElement
    h.video.movie.sprites[0].frames[1].layout = null
    const renderer = h.renderer(mode)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    const slot = textSlot({ boxWidth: 240, boxHeight: 60, referenceWidth: 80, referenceHeight: 30 })
    await renderer.renderFrameAsync(1, { layers: h.layers, slotConfigs: { title: slot }, useFrameCache: false })
    const output = h.canvases[0].draws.at(-1)!
    expect(output.args).toEqual([0, 0, 1800, 400])
    expect(output.matrix).toEqual(matrixValues(applyLayerFrameEdits(h.video.movie.sprites[0].frames[1], h.layers[0], 1, { width: 600, height: 200 }).transform))
    renderer.destroy()
  })

  it('删除所有使用某遮罩的内容层后，留下的普通Key不再被错误隐藏', async () => {
    const h = canvasHarness()
    const content = { imageKey: 'content', matteKey: 'title', frames: [frame(0), frame(1), frame(2)] }
    h.video.movie.sprites.push(content)
    h.video.images.content = h.image
    h.video.movie.images.content = sourceImageBytes
    const contentLayer = { ...h.layers[0], id: '1', editableIndex: 1, imageKey: 'content', sprites: content }
    const renderer = h.renderer(mode)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    const slot = textSlot({ boxWidth: 240, boxHeight: 60, referenceWidth: 80, referenceHeight: 30 })
    await renderer.renderFrameAsync(0, { layers: [...h.layers, contentLayer], slotConfigs: { title: slot }, useFrameCache: false })
    expect(h.canvases.some(item => item.texts.length)).toBe(false)
    await renderer.renderFrameAsync(0, { layers: h.layers, slotConfigs: { title: slot }, useFrameCache: false })
    const output = h.canvases[0].draws.at(-1)!
    expect(output.args).toEqual([0, 0, 240, 60])
    expect(h.canvases.find(item => item.canvas === output.image)!.texts).toHaveLength(2)
    renderer.destroy()
  })

  it('多行文字样式与原图合成后共同接受缩放、旋转、透明度和裁剪', async () => {
    const h = canvasHarness()
    const renderer = h.renderer(mode)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    await renderer.renderFrameAsync(1, { layers: h.layers, slotConfigs: { title: textSlot() }, useFrameCache: false })
    const composed = h.canvases.find(item => item.texts.length > 0)!
    expect(composed.canvas.width).toBe(80)
    expect(composed.canvas.height).toBe(30)
    expect(composed.draws[0]).toMatchObject({ image: h.image, args: [0, 0, 80, 30] })
    expect(composed.texts).toEqual([
      { text: '第一行', x: 77, y: 9.5, font: 'bold 10px Arial', color: '#ff8800', align: 'right', baseline: 'middle' },
      { text: '第二行', x: 77, y: 24.5, font: 'bold 10px Arial', color: '#ff8800', align: 'right', baseline: 'middle' }
    ])
    const output = h.canvases[0].draws.at(-1)!
    const expected = applyLayerFrameEdits(h.video.movie.sprites[0].frames[1], h.layers[0], 1)
    expect(output.image).toBe(composed.canvas)
    expect(output.matrix).toEqual(matrixValues(expected.transform))
    expect(output.alpha).toBeCloseTo(0.35)
    expect(output.clips).toEqual([frame().clipPath])
    renderer.destroy()
  })

  it('同key重复图层共享文字位图但保持各自原始运动', async () => {
    const h = canvasHarness()
    const duplicate = { ...h.video.movie.sprites[0], frames: [frame(2), frame(1), frame(0)] }
    h.video.movie.sprites.push(duplicate)
    h.layers.push({ ...h.layers[0], id: '1', editableIndex: 1, sprites: duplicate, canvasTransform: undefined })
    const renderer = h.renderer(mode)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    await renderer.renderFrameAsync(0, { layers: h.layers, slotConfigs: { title: textSlot() }, useFrameCache: false })
    const composites = h.canvases.filter(item => item.texts.length > 0)
    expect(composites).toHaveLength(1)
    expect(h.canvases[0].draws).toHaveLength(2)
    expect(h.canvases[0].draws.every(item => item.image === composites[0].canvas)).toBe(true)
    expect(h.canvases[0].draws[0].matrix).not.toEqual(h.canvases[0].draws[1].matrix)
    renderer.destroy()
  })

  it('仅文字模式不绘占位图，禁用、删除、清空和关闭插槽后恢复源图', async () => {
    const h = canvasHarness()
    const renderer = h.renderer(mode)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    const slot = textSlot({ replaceImage: true })
    await renderer.renderFrameAsync(0, { layers: h.layers, slotConfigs: { title: slot }, useFrameCache: false })
    const composed = h.canvases.find(item => item.texts.length > 0)!
    expect(composed.draws).toHaveLength(0)
    const resetOptions: RenderOptions[] = [
      { slotConfigs: { title: textSlot({ enabled: false }) } },
      { slotConfigs: {} },
      { slotConfigs: { title: textSlot({ text: ' \n ' }) } },
      { slotConfigs: { title: slot }, applySlots: false }
    ]
    for (const options of resetOptions) {
      await renderer.renderFrameAsync(0, { ...options, layers: h.layers, useFrameCache: false })
      expect(h.canvases[0].draws.at(-1)!.image).toBe(h.image)
    }
    renderer.destroy()
  })

  it.each(['image', 'legacy-text'] as const)('%s 同key的替换图片与文字共存，局部尺寸不随替换图改变', async variant => {
    const h = canvasHarness()
    const renderer = h.renderer(mode)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    const slot: SlotConfig = variant === 'image'
      ? { ...textSlot(), type: 'image', value: 'blob:replacement', imageConfig: { url: 'blob:replacement', scaleMode: 'stretch' } }
      : { type: 'text', name: 'title', value: '旧配置标题', imageConfig: { url: 'blob:replacement', scaleMode: 'stretch' } }
    await renderer.renderFrameAsync(0, { layers: h.layers, slotConfigs: { title: slot }, useFrameCache: false })
    const composed = h.canvases.find(item => item.texts.length > 0)!
    expect(h.imageRequests).toContain('blob:replacement')
    expect(composed.canvas.width).toBe(80)
    expect(composed.canvas.height).toBe(30)
    expect(composed.draws[0].image).toBe(h.loadedImages.get('blob:replacement'))
    expect(composed.draws[0].args).toEqual([0, 0, 80, 30])
    if (variant === 'legacy-text') expect(composed.texts[0].text).toBe('旧配置标题')
    renderer.destroy()
  })

  it('原帧无layout时仍以原始图片尺寸定位文字，不借用替换图尺寸', async () => {
    const h = canvasHarness()
    h.video.movie.sprites[0].frames.forEach(value => { value.layout = null })
    const renderer = h.renderer(mode)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    const slot: SlotConfig = { ...textSlot(), type: 'image', value: 'blob:replacement' }
    await renderer.renderFrameAsync(0, { layers: h.layers, slotConfigs: { title: slot }, useFrameCache: false })
    const composed = h.canvases.find(item => item.texts.length > 0)!
    expect([composed.canvas.width, composed.canvas.height]).toEqual([80, 30])
    expect(composed.draws[0].image).toBe(h.loadedImages.get('blob:replacement'))
    renderer.destroy()
  })

  it('关闭文字不会撤销同key图片替换，替换地址变化后不会沿用旧合成图', async () => {
    const h = canvasHarness()
    const renderer = h.renderer(mode)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    const slot: SlotConfig = { ...textSlot(), type: 'image', value: 'blob:first' }
    const options = { layers: h.layers, slotConfigs: { title: slot }, useFrameCache: true }
    await renderer.renderFrameAsync(0, options)
    const first = h.canvases.find(item => item.texts.length > 0)!
    expect(first.draws[0].image).toBe(h.loadedImages.get('blob:first'))
    slot.value = 'blob:second'
    await renderer.renderFrameAsync(0, options)
    const second = h.canvases.filter(item => item.texts.length > 0).at(-1)!
    expect(second.canvas).not.toBe(first.canvas)
    expect(second.draws[0].image).toBe(h.loadedImages.get('blob:second'))
    expect(h.canvases[0].draws.at(-1)!.image).toBe(second.canvas)
    slot.textConfig!.enabled = false
    await renderer.renderFrameAsync(0, options)
    expect(h.canvases[0].draws.at(-1)!.image).toBe(h.loadedImages.get('blob:second'))
    renderer.destroy()
  })

  it('旧格式value文字修改不会被同key的imageConfig地址遮蔽帧缓存', async () => {
    const h = canvasHarness()
    const renderer = h.renderer(mode)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    const slot: SlotConfig = { type: 'text', name: 'title', value: '旧标题', imageConfig: { url: 'blob:replacement', scaleMode: 'stretch' } }
    const options = { layers: h.layers, slotConfigs: { title: slot }, useFrameCache: true }
    await renderer.renderFrameAsync(0, options)
    slot.value = '新标题'
    await renderer.renderFrameAsync(0, options)
    const latest = h.canvases.filter(item => item.texts.length > 0).at(-1)!
    expect(latest.texts[0].text).toBe('新标题')
    expect(h.canvases[0].draws.at(-1)!.image).toBe(latest.canvas)
    renderer.destroy()
  })

  it('缺少图片但有layout的文字key使用局部透明画布', async () => {
    const h = canvasHarness()
    h.video.images = {}
    h.video.movie.images = {}
    const renderer = h.renderer(mode)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    await renderer.renderFrameAsync(0, { layers: h.layers, slotConfigs: { title: textSlot() }, useFrameCache: false })
    const composed = h.canvases.find(item => item.texts.length > 0)!
    expect([composed.canvas.width, composed.canvas.height]).toEqual([80, 30])
    expect(composed.draws).toHaveLength(0)
    expect(h.canvases[0].draws.at(-1)!.image).toBe(composed.canvas)
    renderer.destroy()
  })

  it('排程偏移与源裁切只在有效输出帧绘制文字', async () => {
    const h = canvasHarness()
    h.layers[0].timeOffsetFrames = 1
    h.layers[0].clip = { startFrame: 1, duration: 1 }
    const renderer = h.renderer(mode)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    const options = { layers: h.layers, slotConfigs: { title: textSlot() }, useFrameCache: false }
    for (const index of [0, 1, 3, 4]) await renderer.renderFrameAsync(index, options)
    expect(h.canvases[0].draws).toHaveLength(0)
    await renderer.renderFrameAsync(2, options)
    const expected = applyLayerFrameEdits(frame(1), h.layers[0], 2)
    expect(h.canvases[0].draws.at(-1)!.matrix).toEqual(matrixValues(expected.transform))
    expect(h.canvases[0].draws.at(-1)!.alpha).toBeCloseTo(0.35)
    renderer.destroy()
  })

  it('内容文字先随图层变换与裁剪，再由独立matte进行遮罩', async () => {
    const h = canvasHarness()
    const maskImage = { ...h.image }
    const maskFrame = { ...frame(2), alpha: 0.25 }
    h.video.movie.sprites[0].matteKey = 'mask'
    const maskSprite = { imageKey: 'mask', matteKey: null, frames: [maskFrame, maskFrame, maskFrame] }
    h.video.movie.sprites.push(maskSprite)
    h.video.images.mask = maskImage
    h.layers.push({ ...h.layers[0], id: '1', editableIndex: 1, imageKey: 'mask', name: 'mask', opacity: 1, sprites: maskSprite, canvasTransform: undefined })
    const renderer = h.renderer(mode)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    await renderer.renderFrameAsync(0, { layers: h.layers, slotConfigs: { title: textSlot() }, useFrameCache: false })
    const composed = h.canvases.find(item => item.texts.length > 0)!
    const offscreen = h.canvases.find(item => item.draws.some(draw => draw.image === maskImage))!
    expect(offscreen.draws[0].image).toBe(composed.canvas)
    expect(offscreen.draws[0].clips).toEqual([frame().clipPath])
    expect(offscreen.draws[0].alpha).toBeCloseTo(0.3)
    expect(offscreen.draws[1]).toMatchObject({ image: maskImage, composite: 'destination-in', alpha: 0.25, matrix: matrixValues(maskFrame.transform) })
    expect(h.canvases[0].draws.at(-1)!.image).toBe(offscreen.canvas)
    renderer.destroy()
  })

  it('同帧仅修改字体或颜色时文字合成缓存和帧缓存都失效', async () => {
    const h = canvasHarness()
    const renderer = h.renderer(mode)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    const slot = textSlot()
    const options = { layers: h.layers, slotConfigs: { title: slot }, useFrameCache: true }
    await renderer.renderFrameAsync(0, options)
    const first = h.canvases.find(item => item.texts.length > 0)!
    await renderer.renderFrameAsync(0, options)
    expect(h.canvases.filter(item => item.texts.length > 0)).toHaveLength(1)
    slot.textConfig!.color = '#123456'
    await renderer.renderFrameAsync(0, options)
    const second = h.canvases.filter(item => item.texts.length > 0).at(-1)!
    expect(second.canvas).not.toBe(first.canvas)
    expect(second.texts[0].color).toBe('#123456')
    expect(h.canvases[0].draws.at(-1)!.image).toBe(second.canvas)
    slot.textConfig!.fontFamily = 'Georgia'
    await renderer.renderFrameAsync(0, options)
    const third = h.canvases.filter(item => item.texts.length > 0).at(-1)!
    expect(third.canvas).not.toBe(second.canvas)
    expect(third.texts[0].font).toContain('Georgia')
    expect(h.canvases[0].draws.at(-1)!.image).toBe(third.canvas)
    renderer.destroy()
  })

  it('无文字保持原始绘制路径，不创建额外局部canvas', async () => {
    const h = canvasHarness()
    const renderer = h.renderer(mode)
    await renderer.setVideoItem(h.video, { waitForImages: true })
    await renderer.renderFrameAsync(0, { layers: h.layers, useFrameCache: false })
    expect(h.canvases).toHaveLength(1)
    expect(h.canvases[0].draws.at(-1)!.image).toBe(h.image)
    renderer.destroy()
  })
})

const Movie = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
const encode = (value: object) => new Uint8Array(pako.deflate(Movie.encode(Movie.fromObject(value)).finish())).buffer
const decode = (value: ArrayBuffer) => Movie.toObject(Movie.decode(pako.inflate(new Uint8Array(value))), { bytes: Uint8Array, defaults: false })

describe('SVGA导出不会烘焙模拟文字', () => {
  it.each(['exportSVGA', 'exportSVGALite', 'builder'] as const)('%s 纯文字配置保留原图片，图片文字共存配置只导出替换图', async method => {
    for (const variant of ['text-only', 'image-with-text', 'legacy-text-with-image'] as const) {
      const h = canvasHarness()
      h.layers[0].canvasTransform = undefined
      h.layers[0].opacity = 1
      const source = encode(h.video.movie)
      const slot: SlotConfig = variant === 'text-only' ? textSlot({ replaceImage: true })
        : variant === 'image-with-text' ? { ...textSlot(), type: 'image', value: 'blob:replacement' }
          : { type: 'text', name: 'title', value: '旧格式标题', imageConfig: { url: 'blob:replacement', scaleMode: 'stretch' } }
      const slots = { title: slot }
      const before = JSON.stringify(slots)
      let blob: Blob
      if (method === 'builder') {
        blob = await new SVGABuilder().mergeWithOriginal(source, { params, layers: h.layers, imageResources: new Map(), slotConfigs: slots })
      } else {
        const engine = new ExportEngine(h.main)
        engine.setVideoItem(h.video)
        blob = await engine[method](source, { fps: params.fps, frames: params.frames, layers: h.layers, slotConfigs: slots })
      }
      const output = decode(await blob.arrayBuffer())
      expect(output.images.title, variant).toEqual(variant === 'text-only' ? sourceImageBytes : replacementImageBytes)
      expect(output.sprites[0].frames).toEqual(decode(source).sprites[0].frames)
      expect(h.canvases.flatMap(item => item.texts)).toHaveLength(0)
      expect(h.imageRequests).not.toContain('旧格式标题')
      expect(JSON.stringify(slots)).toBe(before)
      expect(decode(source).images.title).toEqual(sourceImageBytes)
    }
  })
})
