import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeCanvasTransform } from '@/core/layer-transform'
import { mergeSlotImageConfig, mergeSlotTextConfig } from '@/utils/slot-config'
import type { SlotConfig, SlotTextConfig, VideoItem } from '@/types'
import { useEditorStore } from './editorStore'

const state = () => useEditorStore.getState()
const createVideo = (key = 'title$'): VideoItem => ({
  movie: {
    version: '2.0', params: { viewBoxWidth: 400, viewBoxHeight: 300, fps: 24, frames: 24 },
    images: {}, sprites: [{ imageKey: key, matteKey: null, frames: [{
      alpha: 1, layout: { x: 0, y: 0, width: 80, height: 60 },
      transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, clipPath: null
    }] }]
  }, images: {}, buffers: {}
})
const style: SlotTextConfig = {
  text: '样例文字', fontSize: 28, color: '#123456', fontFamily: 'Arial',
  fontWeight: 'bold', textAlign: 'left', offsetX: 3, offsetY: 4,
  lineHeight: 1.5, enabled: true, replaceImage: true
}
const config = (text = '实时名称', key = 'title$'): SlotConfig =>
  mergeSlotTextConfig(state().slotConfigs[key], key, { ...style, text })
const preview = (text = '实时名称', key = 'title$') => state().previewSlotConfig(key, config(text, key))
const startPreview = (text = '实时名称', key = 'title$') => {
  expect(state().beginSlotConfigEdit(key)).toBe(true)
  preview(text, key)
}

beforeEach(() => {
  state().reset()
  state().setVideoItem(createVideo())
  state().setOriginalBuffer(new ArrayBuffer(16))
  state().initializeHistory()
})

afterEach(() => {
  state().reset()
  vi.restoreAllMocks()
})

describe('文字预览历史事务', () => {
  it('文字框加宽与固定参考尺寸作为一次配置提交，可整体撤销和重做', () => {
    const video = state().videoItem
    const layers = state().layers
    const resources = state().imageResources
    const next = mergeSlotTextConfig(undefined, 'title$', {
      ...style, text: '2222222222222', boxWidth: 300, boxHeight: 60,
      referenceWidth: 80, referenceHeight: 60, exportMode: 'bake'
    })
    state().setSlotConfig('title$', next)
    expect(state().history.past).toHaveLength(1)
    expect(state().slotConfigs['title$']).toEqual(next)
    expect(state().videoItem).toBe(video)
    expect(state().layers).toBe(layers)
    expect(state().imageResources).toBe(resources)
    state().undo()
    expect(state().slotConfigs).toEqual({})
    state().redo()
    expect(state().slotConfigs['title$']).toEqual(next)
  })

  it('文字框配置后的连续文字预览只提交一次，保留尺寸、参考和写入模式', () => {
    const expanded: SlotTextConfig = {
      ...style, boxWidth: 300, boxHeight: 60,
      referenceWidth: 80, referenceHeight: 60, exportMode: 'bake'
    }
    state().setSlotConfig('title$', mergeSlotTextConfig(undefined, 'title$', expanded))
    state().initializeHistory()
    state().beginSlotConfigEdit('title$')
    for (let length = 1; length <= 13; length++) {
      state().previewSlotConfig('title$', mergeSlotTextConfig(state().slotConfigs['title$'], 'title$', { ...expanded, text: '2'.repeat(length) }))
    }
    expect(state().history.past).toHaveLength(0)
    state().endSlotConfigEdit(true)
    expect(state().history.past).toHaveLength(1)
    expect(state().slotConfigs['title$'].textConfig).toEqual({ ...expanded, text: '2222222222222' })
    state().undo()
    expect(state().slotConfigs['title$'].textConfig).toEqual(expanded)
  })

  it('Esc 使用的取消事务恢复扩展文字框、原文字和导出模式，不保留草稿或新增历史', () => {
    const expanded: SlotTextConfig = {
      ...style, boxWidth: 300, boxHeight: 60,
      referenceWidth: 80, referenceHeight: 60, exportMode: 'bake'
    }
    state().setSlotConfig('title$', mergeSlotTextConfig(undefined, 'title$', expanded))
    state().initializeHistory()
    const before = state()
    state().beginSlotConfigEdit('title$')
    state().previewSlotConfig('title$', mergeSlotTextConfig(state().slotConfigs['title$'], 'title$', {
      ...expanded, text: '未完成文案', boxWidth: 500, exportMode: 'preview'
    }))
    state().endSlotConfigEdit(false)
    expect(state().slotConfigs).toBe(before.slotConfigs)
    expect(state().slotConfigs['title$'].textConfig).toEqual(expanded)
    expect(state().history).toBe(before.history)
    expect(state().isDirty).toBe(false)
  })

  it('加宽后的图片替换与文字范围独立，撤销换图不会清掉范围', () => {
    const expanded: SlotTextConfig = {
      ...style, boxWidth: 300, boxHeight: 60,
      referenceWidth: 80, referenceHeight: 60, exportMode: 'preview'
    }
    state().setSlotConfig('title$', mergeSlotTextConfig(undefined, 'title$', expanded))
    state().initializeHistory()
    state().setSlotConfig('title$', mergeSlotImageConfig(state().slotConfigs['title$'], 'title$', 'data:image/png;base64,new', 'stretch'))
    expect(state().slotConfigs['title$'].textConfig).toEqual(expanded)
    state().undo()
    expect(state().slotConfigs['title$'].imageConfig).toBeUndefined()
    expect(state().slotConfigs['title$'].textConfig).toEqual(expanded)
  })

  it('已存在的空白 Key 仍按原字符串绑定，不做 trim', () => {
    state().setVideoItem(createVideo('   '))
    expect(state().beginSlotConfigEdit('   ')).toBe(true)
    state().previewSlotConfig('   ', { type: 'text', name: '   ', value: '姓名', textConfig: { ...style, text: '姓名' } })
    state().endSlotConfigEdit(true)
    expect(state().slotConfigs['   '].textConfig!.text).toBe('姓名')
    expect(state().slotConfigs['']).toBeUndefined()
  })

  it('原生解析器未提供 movie.images 时仍可在布局占位 Key 上预览', () => {
    const video = createVideo('placeholder')
    delete (video.movie as Partial<VideoItem['movie']>).images
    state().setVideoItem(video)
    expect(state().beginSlotConfigEdit('placeholder')).toBe(true)
    state().previewSlotConfig('placeholder', { type: 'text', name: 'placeholder', value: '示例文字' })
    state().endSlotConfigEdit(true)
    expect(state().slotConfigs.placeholder.value).toBe('示例文字')
  })
  it('连续输入二十次实时改变配置，仅结束输入时写入一次历史', () => {
    const video = state().videoItem
    const layers = state().layers
    const resources = state().imageResources
    state().beginSlotConfigEdit('title$')
    for (let index = 1; index <= 20; index++) {
      preview(`文字 ${index}`)
      expect(state().slotConfigs['title$'].textConfig!.text).toBe(`文字 ${index}`)
      expect(state().history.past).toHaveLength(0)
    }
    expect(state().isSlotConfigEditing).toBe(true)
    state().endSlotConfigEdit(true)
    expect(state().history.past).toHaveLength(1)
    expect(state().history.past[0].label).toBe('模拟文字：title$')
    expect(state().isSlotConfigEditing).toBe(false)
    expect(state().isDirty).toBe(true)
    expect(state().videoItem).toBe(video)
    expect(state().layers).toBe(layers)
    expect(state().imageResources).toBe(resources)
    state().undo()
    expect(state().slotConfigs).toEqual({})
    state().redo()
    expect(state().slotConfigs['title$']).toEqual(config('文字 20'))
  })

  it.each([false, true])('取消恢复精确配置引用、dirty 和历史，原 dirty=%s', dirty => {
    useEditorStore.setState({ isDirty: dirty })
    const before = state()
    startPreview()
    state().endSlotConfigEdit(false)
    expect(state().slotConfigs).toBe(before.slotConfigs)
    expect(state().history).toBe(before.history)
    expect(state().isDirty).toBe(dirty)
    expect(state().isSlotConfigEditing).toBe(false)
  })

  it('没有输入时提交不产生 dirty 和历史', () => {
    const before = state()
    state().beginSlotConfigEdit('title$')
    state().endSlotConfigEdit(true)
    expect(state().slotConfigs).toBe(before.slotConfigs)
    expect(state().history).toBe(before.history)
    expect(state().isDirty).toBe(false)
  })

  it('输入后改回原值精确恢复配置引用，不因字段顺序差异产生历史', () => {
    state().setSlotConfig('title$', config('原文字'))
    state().initializeHistory()
    const before = state()
    startPreview('新文字')
    state().previewSlotConfig('title$', {
      textConfig: { ...Object.fromEntries(Object.entries(style).reverse()), text: '原文字' } as SlotTextConfig,
      value: '原文字', name: 'title$', type: 'text'
    })
    state().endSlotConfigEdit(true)
    expect(state().slotConfigs).toBe(before.slotConfigs)
    expect(state().history).toBe(before.history)
    expect(state().isDirty).toBe(false)
  })

  it('同一 key 重复 begin 不拆分一次输入事务', () => {
    startPreview('一')
    expect(state().beginSlotConfigEdit('title$')).toBe(true)
    preview('二')
    state().endSlotConfigEdit(true)
    expect(state().history.past).toHaveLength(1)
    state().undo()
    expect(state().slotConfigs).toEqual({})
  })

  it('切换不同 key 自动提交前一个事务', () => {
    useEditorStore.setState({ detectedSlots: ['other$'] })
    startPreview('第一项')
    startPreview('第二项', 'other$')
    expect(state().history.past).toHaveLength(1)
    state().endSlotConfigEdit(false)
    expect(state().slotConfigs['title$'].value).toBe('第一项')
    expect(state().slotConfigs['other$']).toBeUndefined()
  })

  it('withHistory 操作先提交文字草稿，两次撤销分别撤销图层与文字', () => {
    startPreview()
    state().updateLayer('0', { opacity: 0.5 })
    expect(state().history.past.map(entry => entry.label)).toEqual(['模拟文字：title$', '修改图层属性：title$'])
    expect(state().isSlotConfigEditing).toBe(false)
    state().undo()
    expect(state().layers[0].opacity).toBe(1)
    expect(state().slotConfigs['title$'].value).toBe('实时名称')
    state().undo()
    expect(state().slotConfigs).toEqual({})
  })

  it('画布开始拖动先提交文字；文字开始输入先提交画布', () => {
    startPreview()
    expect(state().beginCanvasTransform('0')).toBe(true)
    expect(state().isSlotConfigEditing).toBe(false)
    expect(state().history.past).toHaveLength(1)
    state().previewCanvasTransform('0', normalizeCanvasTransform({ x: 12 }))
    startPreview('继续文字')
    expect(state().isCanvasTransforming).toBe(false)
    expect(state().history.past).toHaveLength(2)
    state().endSlotConfigEdit(false)
    expect(state().layers[0].canvasTransform!.x).toBe(12)
    expect(state().slotConfigs['title$'].value).toBe('实时名称')
  })

  it('保存导出的 endCanvasTransform(true) 提交文字，之后失焦取消不能撤回已保存内容', () => {
    startPreview()
    state().endCanvasTransform(true)
    const saved = state()
    state().endSlotConfigEdit(false)
    expect(state().slotConfigs).toBe(saved.slotConfigs)
    expect(state().history.past).toHaveLength(1)
    expect(state().isSlotConfigEditing).toBe(false)
  })

  it('画布取消、播放、切帧、选图层、视口缩放不拆分文字输入', () => {
    startPreview()
    state().endCanvasTransform(false)
    state().setPlaying(true)
    state().setCurrentFrame(12)
    state().selectLayer('0')
    state().setZoom(2)
    expect(state().isSlotConfigEditing).toBe(true)
    expect(state().history.past).toHaveLength(0)
    state().endSlotConfigEdit(false)
    expect(state().slotConfigs).toEqual({})
    expect(state().playback.currentFrame).toBe(12)
    expect(state().selectedLayerId).toBe('0')
  })

  it('输入时撤销只取消本次草稿，不顺带撤销上一条已提交操作', () => {
    state().updateLayer('0', { opacity: 0.7 })
    const before = state()
    startPreview()
    state().undo()
    expect(state().slotConfigs).toBe(before.slotConfigs)
    expect(state().history).toBe(before.history)
    expect(state().layers[0].opacity).toBe(0.7)
    preview('过期事件')
    state().endSlotConfigEdit(true)
    expect(state().history).toBe(before.history)
    state().undo()
    expect(state().layers[0].opacity).toBe(1)
  })

  it('输入时重做仅取消草稿并保留重做分支', () => {
    state().updateLayer('0', { opacity: 0.7 })
    state().undo()
    const before = state()
    startPreview()
    state().redo()
    expect(state().slotConfigs).toBe(before.slotConfigs)
    expect(state().history).toBe(before.history)
    expect(state().canRedo).toBe(true)
    state().redo()
    expect(state().layers[0].opacity).toBe(0.7)
  })

  it('历史跳转会取消草稿并跳转，旧事件不能覆盖目标历史', () => {
    state().updateLayer('0', { opacity: 0.7 })
    state().setCustomFps(30)
    startPreview()
    state().jumpToHistory(0)
    const target = state()
    preview('过期事件')
    state().endSlotConfigEdit(true)
    expect(state().layers[0].opacity).toBe(1)
    expect(state().customFps).toBeNull()
    expect(state().slotConfigs).toEqual({})
    expect(state().history).toBe(target.history)
  })

  it('创建快照先提交文字；恢复快照取消草稿而不把草稿存入时间线', () => {
    const opened = state().history.snapshots![0].id
    startPreview('正式名称')
    const bookmark = state().createHistorySnapshot('文字完成')
    expect(state().history.past).toHaveLength(1)
    startPreview('未完成草稿')
    state().restoreHistorySnapshot(opened)
    expect(state().slotConfigs).toEqual({})
    preview('旧事件')
    state().endSlotConfigEdit(true)
    state().restoreHistorySnapshot(bookmark)
    expect(state().slotConfigs['title$'].value).toBe('正式名称')
  })

  it('initializeHistory 取消草稿，clearHistory 保留已提交的草稿内容', () => {
    startPreview()
    state().initializeHistory()
    expect(state().slotConfigs).toEqual({})
    expect(state().isDirty).toBe(false)
    startPreview('保留文字')
    state().clearHistory()
    expect(state().slotConfigs['title$'].value).toBe('保留文字')
    expect(state().history.past).toHaveLength(0)
    expect(state().isSlotConfigEditing).toBe(false)
  })

  it('commitHistory 提交文字时不生成多余的第二条历史', () => {
    startPreview()
    state().commitHistory('外部提交')
    expect(state().history.past).toHaveLength(1)
    expect(state().history.past[0].label).toBe('模拟文字：title$')
  })

  it('同一 key 的图片与文字配置可一同撤销重做，保留全部样式', () => {
    state().setSlotConfig('title$', mergeSlotImageConfig(undefined, 'title$', 'data:image/png;base64,original'))
    state().initializeHistory()
    startPreview()
    state().endSlotConfigEdit(true)
    expect(state().slotConfigs['title$'].type).toBe('image')
    expect(state().slotConfigs['title$'].value).toBe('data:image/png;base64,original')
    state().undo()
    expect(state().slotConfigs['title$'].textConfig).toBeUndefined()
    state().redo()
    expect(state().slotConfigs['title$'].textConfig).toEqual({ ...style, text: '实时名称' })
    expect(state().slotConfigs['title$'].imageConfig!.url).toBe('data:image/png;base64,original')
  })
})

describe('文字事务隔离与 key 安全', () => {
  it.each(['', '   ', 'missing', 'title', 'constructor', '__proto__'])('拒绝未识别或不完整的 key：%s', key => {
    expect(state().beginSlotConfigEdit(key)).toBe(false)
    state().previewSlotConfig(key, config('不应写入', key))
    state().endSlotConfigEdit(true)
    expect(state().slotConfigs).toEqual({})
    expect(state().history.past).toHaveLength(0)
  })

  it('无文件时即使有旧配置也不能启动事务', () => {
    state().reset()
    useEditorStore.setState({ slotConfigs: { title: config('旧配置', 'title') } })
    expect(state().beginSlotConfigEdit('title')).toBe(false)
  })

  it('已存在的无绑定旧 key 仍可编辑，且不剥离尾部美元符号', () => {
    state().setSlotConfig('unbound$', config('旧配置', 'unbound$'))
    state().initializeHistory()
    startPreview('新配置', 'unbound$')
    state().endSlotConfigEdit(true)
    expect(state().slotConfigs['unbound$'].value).toBe('新配置')
    expect(state().slotConfigs.unbound).toBeUndefined()
  })

  it('真正存在的 __proto__ 资源 key 作为普通自有字段存储、撤销与重做', () => {
    state().setVideoItem(createVideo('__proto__'))
    state().initializeHistory()
    state().beginSlotConfigEdit('__proto__')
    state().previewSlotConfig('__proto__', mergeSlotTextConfig(undefined, '__proto__', style))
    state().endSlotConfigEdit(true)
    expect(Object.prototype.hasOwnProperty.call(state().slotConfigs, '__proto__')).toBe(true)
    expect(state().slotConfigs['__proto__'].textConfig).toEqual(style)
    expect(Object.getPrototypeOf(state().slotConfigs)).toBe(Object.prototype)
    state().undo()
    expect(Object.prototype.hasOwnProperty.call(state().slotConfigs, '__proto__')).toBe(false)
    state().redo()
    expect(state().slotConfigs['__proto__'].textConfig).toEqual(style)
  })

  it('不匹配的 key 或配置名称不能修改或取消另一个输入事务', () => {
    startPreview('正确内容')
    const before = state().slotConfigs
    state().previewSlotConfig('other', config('旧回调', 'other'))
    state().previewSlotConfig('title$', config('错误名称', 'other'))
    expect(state().slotConfigs).toBe(before)
    expect(state().isSlotConfigEditing).toBe(true)
    state().endSlotConfigEdit(true)
    expect(state().slotConfigs['title$'].value).toBe('正确内容')
  })

  it.each(['replace', 'close', 'reset'] as const)('文件发生 %s 后旧草稿与回调不能回写', action => {
    startPreview()
    if (action === 'replace') state().setVideoItem(createVideo('next$'))
    if (action === 'close') state().setVideoItem(null)
    if (action === 'reset') state().reset()
    const next = state()
    preview('旧文件事件')
    state().endSlotConfigEdit(true)
    state().endSlotConfigEdit(false)
    expect(state().slotConfigs).toBe(next.slotConfigs)
    expect(state().slotConfigs).toEqual({})
    expect(state().videoItem).toBe(next.videoItem)
    expect(state().history).toBe(next.history)
    expect(state().isDirty).toBe(false)
    expect(state().isSlotConfigEditing).toBe(false)
  })

  it.each(['video', 'buffer', 'configs'] as const)('底层 %s 引用替换后拒绝过期预览，不恢复旧配置', changed => {
    startPreview()
    if (changed === 'video') useEditorStore.setState({ videoItem: createVideo() })
    if (changed === 'buffer') state().setOriginalBuffer(new ArrayBuffer(32))
    if (changed === 'configs') useEditorStore.setState({ slotConfigs: { external: config('外部编辑', 'external') } })
    const next = state()
    preview('过期事件')
    state().endSlotConfigEdit(false)
    expect(state().slotConfigs).toBe(next.slotConfigs)
    expect(state().history).toBe(next.history)
    expect(state().isSlotConfigEditing).toBe(false)
  })

  it('外部持有的配置对象在 preview 之后被修改也不污染 store', () => {
    state().beginSlotConfigEdit('title$')
    const incoming = config()
    state().previewSlotConfig('title$', incoming)
    incoming.textConfig!.text = '外部篡改'
    expect(state().slotConfigs['title$'].textConfig!.text).toBe('实时名称')
    state().endSlotConfigEdit(true)
  })

  it('文字编辑、取消和历史操作不回收仍被图片配置引用的 URL', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    state().setSlotConfig('title$', mergeSlotImageConfig(undefined, 'title$', 'blob:still-needed'))
    state().initializeHistory()
    startPreview()
    state().endSlotConfigEdit(false)
    startPreview()
    state().endSlotConfigEdit(true)
    state().undo()
    state().redo()
    expect(state().slotConfigs['title$'].value).toBe('blob:still-needed')
    expect(revoke).not.toHaveBeenCalled()
  })
})
