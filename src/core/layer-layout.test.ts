import { describe, expect, it } from 'vitest'
import type { CanvasTransform, FrameData, ImageResource, Layer, VideoItem } from '@/types'
import { createDefaultTracks } from './layer-factory'
import { getLayerGeometry, normalizeCanvasTransform } from './layer-transform'
import { planLayerLayout } from './layer-layout'
import type { LayerLayoutPlan, LayoutOperation, LayoutTarget } from './layer-layout'

const resources = new Map([['shared', { width: 40, height: 30 }]])
const video = {
  movie: { params: { viewBoxWidth: 400, viewBoxHeight: 300 }, sprites: [] }, images: {}
} as unknown as VideoItem

function layer(id: string, x = 0, y = 0, width = 40, height = 30, overrides: Partial<Layer> = {}): Layer {
  const frame: FrameData = {
    alpha: 1, layout: { x: 0, y: 0, width, height },
    transform: { a: 1, b: 0, c: 0, d: 1, tx: x, ty: y }, clipPath: null
  }
  return {
    id, name: `图层 ${id}`, type: 'image', visible: true, locked: false,
    expanded: true, opacity: 1, blendMode: 'normal', imageKey: 'shared',
    clip: { startFrame: 0, duration: 2 }, tracks: createDefaultTracks(),
    sprites: { imageKey: 'shared', matteKey: '', frames: [frame, { ...frame, transform: { ...frame.transform, tx: x + 20 } }] },
    ...overrides
  }
}

function bounds(item: Layer, transform?: CanvasTransform) {
  const geometry = getLayerGeometry(transform ? { ...item, canvasTransform: transform } : item, 0, video, resources)!
  const xs = geometry.quad.map(point => point.x)
  const ys = geometry.quad.map(point => point.y)
  return {
    x: Math.min(...xs), y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys)
  }
}

function plan(layers: readonly Layer[], operation: LayoutOperation, target: LayoutTarget = 'selection') {
  const result = planLayerLayout(layers, 0, video, resources, operation, target)
  if ('error' in result) throw new Error(result.error)
  return result
}

function error(result: LayerLayoutPlan) {
  expect(result).toHaveProperty('error')
  expect(result).not.toHaveProperty('transforms')
  return 'error' in result ? result.error : ''
}

const alignmentCases = [
  ['align-left', 'x', 'width', 0], ['align-center-x', 'x', 'width', 0.5], ['align-right', 'x', 'width', 1],
  ['align-top', 'y', 'height', 0], ['align-center-y', 'y', 'height', 0.5], ['align-bottom', 'y', 'height', 1]
] as const

describe('图层对齐规划', () => {
  it.each(alignmentCases)('%s 以不同尺寸的选区并集为基准且不动另一轴', (operation, axis, size, anchor) => {
    const layers = [layer('a', 20, 30, 40, 50), layer('b', 120, 150, 80, 20)]
    const start = axis === 'x' ? 20 : 30
    const length = axis === 'x' ? 180 : 140
    const result = plan(layers, operation)
    expect(result.changed).toBe(true)
    for (const item of layers) {
      const actual = bounds(item, result.transforms[item.id])
      expect(actual[axis] + actual[size] * anchor).toBeCloseTo(start + length * anchor)
      expect(result.transforms[item.id][axis === 'x' ? 'y' : 'x']).toBe(0)
    }
  })

  it.each(alignmentCases)('%s 单层也可以相对画布对齐', (operation, axis, size, anchor) => {
    const item = layer('a', 20, 30)
    const result = plan([item], operation, 'canvas')
    const actual = bounds(item, result.transforms.a)
    expect(actual[axis] + actual[size] * anchor).toBeCloseTo((axis === 'x' ? 400 : 300) * anchor)
  })

  it('使用已有旋转、镜像、缩放和源矩阵倾斜之后的世界边界', () => {
    const transformed = layer('a', 20, 30, 70, 50, {
      canvasTransform: { x: 16, y: -13, scaleX: -1.2, scaleY: 0.8, rotation: Math.PI / 3 }
    })
    transformed.sprites!.frames[0].transform = { a: 1, b: 0.3, c: -0.4, d: 1, tx: 20, ty: 30 }
    const other = layer('b', 210, 150)
    const expected = Math.max(bounds(transformed).x + bounds(transformed).width, bounds(other).x + bounds(other).width)
    const result = plan([transformed, other], 'align-right')
    for (const item of [transformed, other]) {
      const actual = bounds(item, result.transforms[item.id])
      expect(actual.x + actual.width).toBeCloseTo(expected)
    }
    expect(result.transforms.a).toMatchObject({ y: -13, scaleX: -1.2, scaleY: 0.8, rotation: Math.PI / 3 })
  })

  it('使用指定帧并保留逐帧运动，不把一帧几何覆盖到其余帧', () => {
    const a = layer('a', 20, 30)
    const b = layer('b', 100, 30)
    b.sprites!.frames[1].transform.tx = 180
    const result = planLayerLayout([a, b], 1, video, resources, 'align-left', 'selection')
    if ('error' in result) throw new Error(result.error)
    expect(result.transforms.b.x).toBe(-140)
    expect(b.sprites!.frames[0].transform.tx).toBe(100)
    expect(b.sprites!.frames[1].transform.tx).toBe(180)
  })

  it('没有视频仍可相对选区排版', () => {
    const result = planLayerLayout([layer('a'), layer('b', 100)], 0, null, resources, 'align-left', 'selection')
    expect(result).toMatchObject({ changed: true, transforms: { b: { x: -100 } } })
  })

  it('新增图层使用资源尺寸和动画轨道，源数据保持引用不变', () => {
    const item = layer('a', 0, 0, 40, 30, { isNew: true, sprites: undefined })
    item.tracks.position.defaultValue = { x: 37, y: 48 }
    const track = item.tracks
    const result = plan([item], 'align-right', 'canvas')
    expect(result.transforms.a.x).toBe(323)
    expect(item.tracks).toBe(track)
    expect(item.tracks.position.defaultValue).toEqual({ x: 37, y: 48 })
    expect(item.canvasTransform).toBeUndefined()
  })

  it('真实图片资源的 Key、二进制与来源元数据不参与几何数值校验', () => {
    const image: ImageResource = {
      key: 'shared', width: 40, height: 30, data: new Uint8Array([137, 80, 78, 71]),
      mimeType: 'image/png', blobUrl: 'blob:test-resource', isNew: true,
      source: { type: 'url', value: 'https://example.com/avatar.png' }
    }
    const realResources = new Map([['shared', image]])
    const item = layer('a', 0, 0, 40, 30, { isNew: true, sprites: undefined })
    const result = planLayerLayout([item], 0, video, realResources, 'align-right', 'canvas')
    expect(result).toMatchObject({ changed: true, transforms: { a: { x: 360 } } })
    expect(realResources.get('shared')).toBe(image)
  })

  it('稀疏原始矩阵仍按 layout 位置回退', () => {
    const item = layer('a')
    item.sprites!.frames[0] = {
      alpha: 1, layout: { x: 13, y: 17, width: 40, height: 30 }, transform: {}, clipPath: null
    } as FrameData
    expect(plan([item], 'align-left', 'canvas').transforms.a.x).toBe(-13)
  })
})

describe('图层等间距规划', () => {
  it.each(['distribute-x', 'distribute-y'] as const)('%s 按边缘间隙分布不同尺寸图层，而非中心等分', operation => {
    const axis = operation === 'distribute-x' ? 'x' : 'y'
    const size = axis === 'x' ? 'width' : 'height'
    const layers = [layer('a', 10, 10, 20, 20), layer('b', 40, 40, 40, 40), layer('c', 140, 140, 60, 60)]
    const result = plan(layers, operation)
    const actual = layers.map(item => bounds(item, result.transforms[item.id]))
    expect(actual[0][axis]).toBe(10)
    expect(actual[1][axis]).toBe(65)
    expect(actual[2][axis] + actual[2][size]).toBe(200)
    expect(actual[1][axis] - actual[0][axis] - actual[0][size]).toBeCloseTo(35)
    expect(actual[2][axis] - actual[1][axis] - actual[1][size]).toBeCloseTo(35)
    expect(result.transforms.b[axis === 'x' ? 'y' : 'x']).toBe(0)
  })

  it.each(['distribute-x', 'distribute-y'] as const)('%s 相对画布时首尾落在画布边界', operation => {
    const axis = operation === 'distribute-x' ? 'x' : 'y'
    const size = axis === 'x' ? 'width' : 'height'
    const layers = [layer('a', 30, 30, 20, 20), layer('b', 60, 60, 40, 40), layer('c', 180, 180, 60, 60)]
    const result = plan(layers, operation, 'canvas')
    const actual = layers.map(item => bounds(item, result.transforms[item.id]))
    expect(actual[0][axis]).toBeCloseTo(0)
    expect(actual[2][axis] + actual[2][size]).toBeCloseTo(axis === 'x' ? 400 : 300)
    expect(actual[1][axis] - actual[0][axis] - actual[0][size])
      .toBeCloseTo(actual[2][axis] - actual[1][axis] - actual[1][size])
  })

  it('按轴起点排序，起点相同时遵循输入顺序且不排序原数组', () => {
    const layers = [layer('b', 10, 40, 40), layer('a', 10, 70, 20), layer('c', 160, 100, 40)]
    const snapshot = [...layers]
    const result = plan(layers, 'distribute-x')
    expect(result.transforms.b.x).toBe(0)
    expect(result.transforms.a.x).toBe(85)
    expect(layers).toEqual(snapshot)
    const reversed = plan([layers[1], layers[0], layers[2]], 'distribute-x')
    expect(reversed.transforms.a.x).toBe(0)
    expect(reversed.transforms.b.x).toBe(65)
  })

  it('选区范围不足允许负间距，并明确警告边界重叠', () => {
    const layers = [layer('a', 0, 0, 100), layer('b', 20, 40, 100), layer('c', 60, 80, 100)]
    const result = plan(layers, 'distribute-x')
    expect(result.transforms.b.x).toBe(10)
    expect(result.warning).toContain('负间距')
    expect(result.warning).toContain('重叠')
  })

  it('负间距已均匀时仍给出提示，但不制造新变换', () => {
    const layers = [layer('a', 0, 0, 100), layer('b', 30, 40, 100), layer('c', 60, 80, 100)]
    const result = plan(layers, 'distribute-x')
    expect(result.changed).toBe(false)
    expect(result.warning).toContain('重叠')
  })

  it('相对画布分布过宽图片时不会裁切或缩放它们', () => {
    const layers = [layer('a', 0, 0, 200), layer('b', 20, 40, 200), layer('c', 60, 80, 200)]
    const result = plan(layers, 'distribute-x', 'canvas')
    expect(layers.map(item => bounds(item, result.transforms[item.id]).x)).toEqual([0, 100, 200])
    expect(result.warning).toContain('重叠')
    expect(result.transforms.b.scaleX).toBe(1)
  })

  it('已有旋转和镜像的图层按变换后边缘计算间隙', () => {
    const layers = [
      layer('a', 0, 0, 30, 60, { canvasTransform: { x: 0, y: 0, scaleX: -1, scaleY: 1, rotation: Math.PI / 2 } }),
      layer('b', 70, 20, 40, 40), layer('c', 210, 40, 20, 30)
    ]
    const result = plan(layers, 'distribute-x')
    const actual = layers.map(item => bounds(item, result.transforms[item.id]))
    expect(actual[1].x - actual[0].x - actual[0].width).toBeCloseTo(actual[2].x - actual[1].x - actual[1].width)
    expect(result.transforms.a.scaleX).toBe(-1)
    expect(result.transforms.a.rotation).toBe(Math.PI / 2)
  })
})

describe('图层排版保护与无变化判定', () => {
  it('先去重图层身份，重复同一层不能满足数量要求', () => {
    const a = layer('a')
    expect(error(planLayerLayout([a, a], 0, video, resources, 'align-left', 'selection'))).toContain('2')
    expect(error(planLayerLayout([a, a, layer('b', 100)], 0, video, resources, 'distribute-x', 'selection'))).toContain('3')
    expect(Object.keys(plan([a, a, layer('b', 100)], 'align-left').transforms)).toEqual(['a', 'b'])
  })

  it('空选区和单层相对选区操作有明确提示', () => {
    error(planLayerLayout([], 0, video, resources, 'align-left', 'canvas'))
    expect(error(planLayerLayout([layer('a')], 0, video, resources, 'align-left', 'selection'))).toContain('2')
  })

  it.each([
    { locked: true }, { visible: false }, { type: 'shape' }, { type: 'audio' },
    { opacity: 0 }, { clip: { startFrame: 1, duration: 2 } }, { sprites: { imageKey: 'shared', frames: [] } }
  ] as Array<Partial<Layer>>)('任何一个成员不可编辑或本帧无边界时整次拒绝：%j', overrides => {
    const layers = [layer('a', 0), layer('b', 80, 40, 40, 30, overrides)]
    const snapshot = JSON.stringify(layers)
    error(planLayerLayout(layers, 0, video, resources, 'align-left', 'selection'))
    expect(JSON.stringify(layers)).toBe(snapshot)
  })

  it.each([NaN, Infinity, -Infinity, -1])('拒绝非法帧 %s', frameIndex => {
    error(planLayerLayout([layer('a')], frameIndex, video, resources, 'align-left', 'canvas'))
  })

  it.each([0, -1, Infinity, NaN])('拒绝无效画布尺寸 %s', width => {
    const invalidVideo = { ...video, movie: { ...video.movie, params: { ...video.movie.params, viewBoxWidth: width } } }
    error(planLayerLayout([layer('a')], 0, invalidVideo, resources, 'align-left', 'canvas'))
  })

  it('相对画布必须提供视频尺寸', () => {
    error(planLayerLayout([layer('a')], 0, null, resources, 'align-left', 'canvas'))
  })

  it.each(['x', 'y', 'scaleX', 'scaleY', 'rotation'] as const)('拒绝画布变换的非有限 %s，不采用容错默认值', key => {
    const item = layer('a', 0, 0, 40, 30, { canvasTransform: { ...normalizeCanvasTransform(), [key]: NaN } })
    expect(error(planLayerLayout([item], 0, video, resources, 'align-left', 'canvas'))).toContain('无效数值')
  })

  it('拒绝原始帧非有限矩阵、尺寸和透明度', () => {
    for (const part of ['transform', 'layout', 'alpha']) {
      const item = layer('a')
      if (part === 'transform') item.sprites!.frames[0].transform.tx = Infinity
      else if (part === 'layout') item.sprites!.frames[0].layout!.width = NaN
      else item.sprites!.frames[0].alpha = NaN
      error(planLayerLayout([item], 0, video, resources, 'align-left', 'canvas'))
    }
  })

  it('拒绝资源与活动轨道非有限参数', () => {
    error(planLayerLayout([layer('a')], 0, video, new Map([['shared', { width: Infinity, height: 30 }]]), 'align-left', 'canvas'))
    const item = layer('a', 0, 0, 40, 30, { isNew: true, sprites: undefined })
    item.tracks.position.defaultValue.x = Infinity
    error(planLayerLayout([item], 0, video, resources, 'align-left', 'canvas'))
  })

  it('拒绝零边界和计算溢出，不向外提供部分结果', () => {
    const collapsed = layer('b', 20, 20, 40, 30, { canvasTransform: { ...normalizeCanvasTransform(), scaleX: 0 } })
    error(planLayerLayout([layer('a'), collapsed], 0, video, resources, 'align-left', 'selection'))
    const overflow = layer('b', 20)
    overflow.sprites!.frames[0].transform.a = Number.MAX_VALUE
    error(planLayerLayout([layer('a'), overflow], 0, video, resources, 'align-left', 'selection'))
  })

  it('对齐误差不超过阈值时复用原值，避免无效历史和细微漂移', () => {
    const transform = { x: 0.00000001, y: 12, scaleX: 1, scaleY: 1, rotation: 0 }
    const item = layer('a', 0, 0, 40, 30, { canvasTransform: transform })
    const result = plan([item], 'align-left', 'canvas')
    expect(result.changed).toBe(false)
    expect(result.transforms.a).toBe(transform)
    expect(result.transforms.a.x).toBe(0.00000001)
  })

  it('真正的位移超过阈值时更新且输入完全不变', () => {
    const item = layer('a', 0.000001, 0)
    const snapshot = JSON.stringify(item)
    const result = plan([item], 'align-left', 'canvas')
    expect(result.changed).toBe(true)
    expect(result.transforms.a.x).toBe(-0.000001)
    expect(JSON.stringify(item)).toBe(snapshot)
  })

  it('缺省变换对齐完成返回单位变换且无变化', () => {
    const result = plan([layer('a', 0, 0)], 'align-left', 'canvas')
    expect(result.changed).toBe(false)
    expect(result.transforms.a).toEqual(normalizeCanvasTransform())
  })

  it('不将特殊图层 ID 当作对象原型', () => {
    const result = plan([layer('__proto__', 20)], 'align-left', 'canvas')
    expect(Object.prototype.hasOwnProperty.call(result.transforms, '__proto__')).toBe(true)
    expect(result.transforms['__proto__'].x).toBe(-20)
    expect(Object.getPrototypeOf(result.transforms)).toBe(Object.prototype)
  })

  it('未知操作或参照不会触发不受支持的排版', () => {
    error(planLayerLayout([layer('a')], 0, video, resources, 'toString' as LayoutOperation, 'canvas'))
    error(planLayerLayout([layer('a')], 0, video, resources, 'align-left', 'invalid' as LayoutTarget))
  })
})
