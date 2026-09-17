import { describe, expect, it } from 'vitest'
import type { CanvasTransform, FrameData, Layer, VideoItem } from '@/types'
import { createDefaultTracks } from './layer-factory'
import { applyGroupTransform, captureGroupTransform, type GroupTransformSnapshot } from './group-transform'
import { getLayerGeometry } from './layer-transform'

const transform = (overrides: Partial<CanvasTransform> = {}): CanvasTransform => ({
  x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, ...overrides
})

const frame = (x = 0, y = 0): FrameData => ({
  alpha: 1,
  layout: { x: 0, y: 0, width: 100, height: 50 },
  transform: { a: 1, b: 0, c: 0, d: 1, tx: x, ty: y },
  clipPath: null
})

const layer = (id: string, overrides: Partial<Layer> = {}): Layer => ({
  id, name: `图层 ${id}`, type: 'image', visible: true, locked: false,
  expanded: true, opacity: 1, blendMode: 'normal', imageKey: 'shared',
  editableIndex: Number(id), clip: { startFrame: 0, duration: 2 }, tracks: createDefaultTracks(),
  sprites: { imageKey: 'shared', matteKey: null, frames: [frame(), frame(10, 20)] },
  ...overrides
})

const video = (): VideoItem => ({
  movie: { version: '2.0', params: { viewBoxWidth: 500, viewBoxHeight: 500, fps: 30, frames: 2 }, images: {}, sprites: [] },
  images: {}, buffers: {}
})

describe('多图层选区快照', () => {
  it('带关键帧的图层整组旋转缩放以当前动画中心为基准，不改写动画轨道', () => {
    const first = layer('0', { canvasTransform: transform({ x: 9, y: -3, scaleX: 1.2, scaleY: 0.8, rotation: 0.3 }) })
    const second = layer('1', { canvasTransform: transform({ x: 120, y: 80 }) })
    for (const [index, item] of [first, second].entries()) {
      item.animationTracks = createDefaultTracks()
      item.animationTracks.position.keyframes = [{ id: `p${index}`, frameIndex: 0, value: { x: 60 - index * 35, y: 15 + index * 10 }, easing: 'linear' }]
      item.animationTracks.scale.keyframes = [{ id: `s${index}`, frameIndex: 0, value: { scaleX: 1.7, scaleY: 0.6 }, easing: 'linear' }]
      item.animationTracks.rotation.keyframes = [{ id: `r${index}`, frameIndex: 0, value: 20, easing: 'linear' }]
    }
    const snapshot = captureGroupTransform([first, second], 0)!
    const delta = { x: 11, y: -19, scale: 1.4, rotation: 0.7 }
    const result = applyGroupTransform(snapshot, delta)
    const c = Math.cos(delta.rotation) * delta.scale
    const s = Math.sin(delta.rotation) * delta.scale
    for (const item of [first, second]) {
      const before = getLayerGeometry(item, 0)!
      const updated = { ...item, canvasTransform: result[item.id] }
      const after = getLayerGeometry(updated, 0)!
      before.quad.forEach((point, index) => {
        const x = point.x - snapshot.center.x, y = point.y - snapshot.center.y
        expect(after.quad[index].x).toBeCloseTo(snapshot.center.x + c * x - s * y + delta.x)
        expect(after.quad[index].y).toBeCloseTo(snapshot.center.y + s * x + c * y + delta.y)
      })
      expect(updated.animationTracks).toBe(item.animationTracks)
    }
  })

  it('边界使用已旋转缩放后的世界四角，中心保留每层未叠加画布变换的基准', () => {
    const first = layer('0', { canvasTransform: transform({ x: 10, y: 20, scaleX: 2, rotation: Math.PI / 2 }) })
    const second = layer('1', { sprites: { imageKey: 'shared', matteKey: null, frames: [frame(200, 20)] } })
    const snapshot = captureGroupTransform([first, second], 0)!
    expect(snapshot.bounds.x).toBeCloseTo(35)
    expect(snapshot.bounds.y).toBeCloseTo(-55)
    expect(snapshot.bounds.width).toBeCloseTo(265)
    expect(snapshot.bounds.height).toBeCloseTo(200)
    expect(snapshot.center.x).toBeCloseTo(167.5)
    expect(snapshot.center.y).toBeCloseTo(45)
    expect(snapshot.items.map(item => item.baseCenter)).toEqual([{ x: 50, y: 25 }, { x: 250, y: 45 }])
    expect(snapshot.items[0].transform).toEqual(first.canvasTransform)
    expect(snapshot.items[0].transform).not.toBe(first.canvasTransform)
  })

  it('跳过隐藏、锁定、非图片、不可见帧和缺失几何，不把相同图片的独立图层合并', () => {
    const empty = layer('10', { sprites: { imageKey: 'shared', matteKey: null, frames: [] } })
    const transparent = layer('11')
    transparent.sprites!.frames[0].alpha = 0
    const invalidGeometry = layer('12')
    invalidGeometry.sprites!.frames[0].transform.a = Number.MAX_VALUE
    const first = layer('0')
    const second = layer('1')
    const snapshot = captureGroupTransform([
      first, second, first,
      layer('2', { visible: false }), layer('3', { locked: true }),
      layer('4', { type: 'shape' }), layer('5', { type: 'text' }), layer('6', { type: 'audio' }),
      layer('7', { opacity: 0 }), layer('8', { clip: { startFrame: 1, duration: 1 } }),
      layer('9', { isNew: true, sprites: undefined }), empty, transparent, invalidGeometry
    ], 0)!
    expect(snapshot.items.map(item => item.id)).toEqual(['0', '1'])
    expect(snapshot.bounds).toEqual({ x: 0, y: 0, width: 100, height: 50 })
  })

  it('没有可编辑图层返回 null，单个图层仍可捕获', () => {
    expect(captureGroupTransform([], 0)).toBeNull()
    expect(captureGroupTransform([layer('0', { locked: true })], 0)).toBeNull()
    expect(captureGroupTransform([layer('0')], -1)).toBeNull()
    expect(captureGroupTransform([layer('0')], NaN)).toBeNull()
    expect(captureGroupTransform([layer('0')], 2)).toBeNull()
    expect(captureGroupTransform([layer('0')], 0)?.items).toHaveLength(1)
  })

  it('支持视频原始帧回退以及使用共享资源的新增图层', () => {
    const sourceVideo = video()
    sourceVideo.movie.sprites = [layer('0').sprites!]
    const imported = layer('0', { sprites: undefined })
    const added = layer('new', { isNew: true, editableIndex: undefined, sprites: undefined })
    added.tracks.position.defaultValue = { x: 200, y: 100 }
    const resources = new Map([['shared', { width: 40, height: 20 }]])
    const snapshot = captureGroupTransform([imported, added], 0, sourceVideo, resources)!
    expect(snapshot.items.map(item => item.id)).toEqual(['0', 'new'])
    expect(snapshot.items[1].baseCenter).toEqual({ x: 220, y: 110 })
    expect(snapshot.bounds).toEqual({ x: 0, y: 0, width: 240, height: 120 })
  })

  it('图层附加关键帧属于几何基准，画布偏移只捕获一次', () => {
    const tracked = layer('0', { canvasTransform: transform({ x: 8, y: 9 }) })
    tracked.tracks.position.keyframes = [{ id: 'position', frameIndex: 0, value: { x: 20, y: 30 }, easing: 'linear' }]
    const snapshot = captureGroupTransform([tracked], 0)!
    expect(snapshot.items[0].baseCenter).toEqual({ x: 70, y: 55 })
    expect(snapshot.center).toEqual({ x: 78, y: 64 })
    expect(snapshot.items[0].transform.x).toBe(8)
  })
})

describe('多图层整体变换', () => {
  it('无操作保持每个数值精确一致，不产生浮点漂移或共享可变对象', () => {
    const selected = layer('0', { canvasTransform: transform({ x: -0, y: 1 / 3, scaleX: -1.2, scaleY: 2.3, rotation: Math.PI / 7 }) })
    const snapshot = captureGroupTransform([selected], 0)!
    const result = applyGroupTransform(snapshot, { x: 0, y: 0, scale: 1, rotation: 0 })
    expect(result['0']).toEqual(selected.canvasTransform)
    expect(Object.is(result['0'].x, -0)).toBe(true)
    expect(result['0']).not.toBe(snapshot.items[0].transform)
    result['0'].x = 100
    expect(snapshot.items[0].transform.x).toBe(-0)
  })

  it('纯平移直接叠加偏移，不因世界坐标过大丢掉微小偏移', () => {
    const snapshot: GroupTransformSnapshot = {
      bounds: { x: 1e12, y: -1e12, width: 100, height: 100 },
      center: { x: 1e12 + 50, y: -1e12 + 50 },
      items: [{ id: '0', baseCenter: { x: 1e12, y: -1e12 }, transform: transform({ x: 1e-7, y: -1e-7 }) }]
    }
    const result = applyGroupTransform(snapshot, { x: 1e-7, y: 1e-8, scale: 1, rotation: 0 })['0']
    expect(result.x).toBe(1e-7 + 1e-7)
    expect(result.y).toBe(-1e-7 + 1e-8)
    expect(result.scaleX).toBe(1)
    expect(result.rotation).toBe(0)
  })

  it('整体等比缩放、旋转、位移等价于世界矩阵合成，保留源倾斜和原有负缩放', () => {
    const first = layer('0', { canvasTransform: transform({ x: 12, y: -8, scaleX: -2, scaleY: 0.5, rotation: Math.PI / 5 }) })
    first.sprites!.frames[0].transform = { a: 1.2, b: 0.4, c: 0.3, d: -0.8, tx: 40, ty: 60 }
    const second = layer('1', { canvasTransform: transform({ x: -5, y: 15, scaleX: 0.8, scaleY: -1.3, rotation: -Math.PI / 6 }) })
    second.sprites!.frames[0].transform.tx = 200
    const layers = [first, second]
    const before = JSON.stringify(layers)
    const snapshot = captureGroupTransform(layers, 0)!
    const captured = JSON.stringify(snapshot)
    const delta = { x: 17, y: -23, scale: 1.7, rotation: Math.PI / 2 }
    const result = applyGroupTransform(snapshot, delta)

    for (const selected of layers) {
      const source = getLayerGeometry(selected, 0)!
      const updated = getLayerGeometry({ ...selected, canvasTransform: result[selected.id] }, 0)!
      source.quad.forEach((point, index) => {
        const x = point.x - snapshot.center.x
        const y = point.y - snapshot.center.y
        expect(updated.quad[index].x).toBeCloseTo(snapshot.center.x - delta.scale * y + delta.x)
        expect(updated.quad[index].y).toBeCloseTo(snapshot.center.y + delta.scale * x + delta.y)
      })
      expect(result[selected.id].scaleX).toBe(selected.canvasTransform!.scaleX * delta.scale)
      expect(result[selected.id].scaleY).toBe(selected.canvasTransform!.scaleY * delta.scale)
      expect(result[selected.id].rotation).toBe(selected.canvasTransform!.rotation + delta.rotation)
    }
    expect(JSON.stringify(layers)).toBe(before)
    expect(JSON.stringify(snapshot)).toBe(captured)
  })

  it('新增图层和同图片导入层围绕同一选区中心旋转，变换按图层身份独立返回', () => {
    const imported = layer('0')
    const added = layer('new', { isNew: true, editableIndex: undefined, sprites: undefined })
    added.tracks.position.defaultValue = { x: 200, y: 100 }
    const resources = new Map([['shared', { width: 100, height: 50 }]])
    const snapshot = captureGroupTransform([imported, added], 0, null, resources)!
    const result = applyGroupTransform(snapshot, { x: 0, y: 0, scale: 1, rotation: Math.PI })
    expect(Object.keys(result)).toEqual(['0', 'new'])
    expect(result['0'].x).toBeCloseTo(200)
    expect(result['0'].y).toBeCloseTo(100)
    expect(result.new.x).toBeCloseTo(-200)
    expect(result.new.y).toBeCloseTo(-100)
    expect(result['0']).not.toBe(result.new)
  })

  it('每次计算以手势起始快照为基准，不累积预览变换', () => {
    const snapshot = captureGroupTransform([layer('0', { canvasTransform: transform({ x: 5, y: 6 }) }), layer('1')], 0)!
    applyGroupTransform(snapshot, { x: 10, y: 20, scale: 2, rotation: Math.PI / 2 })
    expect(applyGroupTransform(snapshot, { x: 3, y: 4, scale: 1, rotation: 0 })['0']).toEqual(transform({ x: 8, y: 10 }))
  })

  it('非法输入回退到安全默认值，空快照不会创建虚构图层', () => {
    const selected = layer('0', { canvasTransform: transform({ x: NaN, y: Infinity, scaleX: -1.5 }) })
    const snapshot = captureGroupTransform([selected], 0)!
    expect(applyGroupTransform(snapshot, { x: NaN, y: Infinity, scale: NaN, rotation: -Infinity })['0'])
      .toEqual(transform({ scaleX: -1.5 }))
    expect(applyGroupTransform({ bounds: { x: 0, y: 0, width: 0, height: 0 }, center: { x: 0, y: 0 }, items: [] },
      { x: 1, y: 1, scale: 2, rotation: 1 })).toEqual({})
  })
})
