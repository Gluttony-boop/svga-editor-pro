import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoItem } from '@/types'
import { normalizeCanvasTransform } from '@/core/layer-transform'
import { useEditorStore } from './editorStore'

const state = () => useEditorStore.getState()
const video = (): VideoItem => ({
  movie: {
    version: '2.0', params: { viewBoxWidth: 320, viewBoxHeight: 240, fps: 24, frames: 12 }, images: {},
    sprites: [{ imageKey: 'title', matteKey: null, frames: Array.from({ length: 12 }, () => ({
      alpha: 1, layout: { x: 0, y: 0, width: 40, height: 30 },
      transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, clipPath: null
    })) }]
  }, images: {}, buffers: { title: new Uint8Array([1, 2, 3]).buffer }
})

beforeEach(() => {
  state().reset()
  state().setVideoItem(video())
  state().setOriginalBuffer(new Uint8Array([83, 86, 71, 65, 1, 0, 0, 0]).buffer)
  state().setSource('D:\\私有目录\\输入.svga', 'file')
})

describe('工程恢复快照：没有编辑副作用', () => {
  it.each(['videoItem', 'params', 'originalBuffer'] as const)('缺少 %s 时返回 null，不变更当前编辑状态', field => {
    useEditorStore.setState({ [field]: null })
    const before = state()
    expect(state().captureProjectRecovery()).toBeNull()
    expect(state()).toBe(before)
  })

  it('纯捕获不暂停播放，不触发暂停回调或添加历史', () => {
    state().updateLayer('0', { name: '已提交内容' })
    state().setPlaying(true)
    state().setCurrentFrame(7)
    const observed = vi.fn()
    const unsubscribe = useEditorStore.subscribe(observed)
    try {
      const before = state()
      const document = state().captureProjectRecovery()
      expect(document?.currentFrame).toBe(7)
      expect(document?.layers[0].name).toBe('已提交内容')
      expect(state()).toBe(before)
      expect(state().playback.isPlaying).toBe(true)
      expect(state().history.past).toHaveLength(1)
      expect(observed).not.toHaveBeenCalled()
    } finally { unsubscribe() }
  })

  it('干净工程可以读取快照但仍保持干净，是否需要备份由调度器判断', () => {
    const before = state()
    expect(state().captureProjectRecovery()).not.toBeNull()
    expect(state()).toBe(before)
    expect(state().isDirty).toBe(false)
  })

  it.each(['canvas', 'text'] as const)('%s 事务开始但尚未输入时，也不捕获或擅自结束它', kind => {
    if (kind === 'canvas') expect(state().beginCanvasTransform('0')).toBe(true)
    else expect(state().beginSlotConfigEdit('title')).toBe(true)
    const before = state()
    expect(state().captureProjectRecovery()).toBeNull()
    expect(state()).toBe(before)
    expect(kind === 'canvas' ? state().isCanvasTransforming : state().isSlotConfigEditing).toBe(true)
    expect(state().history.past).toHaveLength(0)
  })

  it.each(['canvas', 'text'] as const)('%s 连续预览被跳过，仍可 Esc 完整撤回', kind => {
    if (kind === 'canvas') {
      expect(state().beginCanvasTransform('0')).toBe(true)
      for (let x = 1; x <= 8; x++) state().previewCanvasTransform('0', normalizeCanvasTransform({ x }))
    } else {
      expect(state().beginSlotConfigEdit('title')).toBe(true)
      for (let index = 1; index <= 8; index++) {
        state().previewSlotConfig('title', { type: 'text', name: 'title', value: `草稿${index}` })
      }
    }
    const before = state()
    expect(state().captureProjectRecovery()).toBeNull()
    expect(state()).toBe(before)
    expect(state().history.past).toHaveLength(0)
    if (kind === 'canvas') state().endCanvasTransform(false)
    else state().endSlotConfigEdit(false)
    const document = state().captureProjectRecovery()!
    expect(normalizeCanvasTransform(document.layers[0].canvasTransform).x).toBe(0)
    expect(document.slotConfigs).toEqual({})
    expect(state().isDirty).toBe(false)
    expect(state().history.past).toHaveLength(0)
  })

  it.each(['canvas', 'text'] as const)('%s 用户确认后才捕获最终值，重复捕获不增加历史', kind => {
    if (kind === 'canvas') {
      expect(state().beginCanvasTransform('0')).toBe(true)
      state().previewCanvasTransform('0', normalizeCanvasTransform({ x: 15, rotation: 0.25 }))
      state().endCanvasTransform(true)
    } else {
      expect(state().beginSlotConfigEdit('title')).toBe(true)
      state().previewSlotConfig('title', { type: 'text', name: 'title', value: '确认昵称' })
      state().endSlotConfigEdit(true)
    }
    const document = state().captureProjectRecovery()!
    if (kind === 'canvas') expect(document.layers[0].canvasTransform).toMatchObject({ x: 15, rotation: 0.25 })
    else expect(document.slotConfigs.title.value).toBe('确认昵称')
    const before = state()
    state().captureProjectRecovery()
    expect(state()).toBe(before)
    expect(state().history.past).toHaveLength(1)
    expect(state().isDirty).toBe(true)
  })

  it('捕获画布、帧率、关键帧、图像、音频、文字与选区，省略来源完整路径', () => {
    state().setCanvasSize(640, 480)
    state().setCustomFps(30)
    state().setCustomFrames(24)
    state().setAnimationValue('0', 'position', { x: 20, y: -8 }, 6)
    state().setSlotConfig('title', { type: 'text', name: 'title', value: '团队交付' })
    state().addImageResource({ key: 'title', data: new Uint8Array([7, 8]), width: 40, height: 30, mimeType: 'image/png' })
    state().addAudioResource({ key: 'audio', data: new Uint8Array([9, 10]), startTime: 0, duration: 100 })
    state().selectLayer('0')
    state().setCurrentFrame(9)
    const before = state()
    const document = state().captureProjectRecovery()!
    expect(document).toMatchObject({
      name: '输入.svga', params: { viewBoxWidth: 640, viewBoxHeight: 480 },
      customFps: 30, customFrames: 24, currentFrame: 9, selectedLayerId: '0', selectedLayerIds: ['0']
    })
    expect(document.videoItem.movie.params).toEqual(before.videoItem!.movie.params)
    expect(document.layers[0].animationTracks!.position.keyframes.at(-1)?.value).toEqual({ x: 20, y: -8 })
    expect(document.imageResources.get('title')?.data).toEqual(new Uint8Array([7, 8]))
    expect(document.audioResources.get('audio')?.data).toEqual(new Uint8Array([9, 10]))
    expect(document.slotConfigs.title.value).toBe('团队交付')
    expect(document).not.toHaveProperty('projectFilePath')
    expect(document).not.toHaveProperty('currentSource')
    expect(state()).toBe(before)
  })

  it('异步编码使用隔离的可变数据；修改快照不能污染当前编辑状态', () => {
    state().setAnimationValue('0', 'position', { x: 20, y: -8 }, 6)
    state().setSlotConfig('title', { type: 'text', name: 'title', value: '原始昵称' })
    state().addImageResource({ key: 'title', data: new Uint8Array([7, 8]), width: 40, height: 30, mimeType: 'image/png' })
    state().addAudioResource({ key: 'audio', data: new Uint8Array([9, 10]), startTime: 0, duration: 100 })
    const document = state().captureProjectRecovery()!
    new Uint8Array(document.originalBuffer)[0] = 0
    new Uint8Array(document.videoItem.buffers.title)[0] = 99
    document.videoItem.movie.sprites[0].frames[0].transform.tx = 99
    document.layers[0].sprites!.frames[0].transform.tx = 88
    document.layers[0].animationTracks!.position.keyframes.at(-1)!.value.x = 99
    document.params.viewBoxWidth = 1
    document.imageResources.get('title')!.data[0] = 0
    document.audioResources.get('audio')!.data[0] = 0
    document.slotConfigs.title.value = '快照昵称'
    expect(new Uint8Array(state().originalBuffer!)[0]).toBe(83)
    expect(new Uint8Array(state().videoItem!.buffers.title)[0]).toBe(1)
    expect(state().videoItem!.movie.sprites[0].frames[0].transform.tx).toBe(0)
    expect(state().layers[0].sprites!.frames[0].transform.tx).toBe(0)
    expect(state().layers[0].animationTracks!.position.keyframes.at(-1)!.value.x).toBe(20)
    expect(state().params!.viewBoxWidth).toBe(320)
    expect(state().imageResources.get('title')!.data[0]).toBe(7)
    expect(state().audioResources.get('audio')!.data[0]).toBe(9)
    expect(state().slotConfigs.title.value).toBe('原始昵称')
  })

  it('每次快照独立，后续新编辑不会改变先前压缩任务中的内容', () => {
    state().updateLayer('0', { name: '第一版' })
    const first = state().captureProjectRecovery()!
    state().updateLayer('0', { name: '第二版' })
    state().setCanvasSize(640, 480)
    const second = state().captureProjectRecovery()!
    expect(first.layers[0].name).toBe('第一版')
    expect(first.params.viewBoxWidth).toBe(320)
    expect(second.layers[0].name).toBe('第二版')
    expect(second.params.viewBoxWidth).toBe(640)
    expect(second.originalBuffer).not.toBe(first.originalBuffer)
    expect(second.videoItem).not.toBe(first.videoItem)
    expect(second.layers).not.toBe(first.layers)
  })
})
