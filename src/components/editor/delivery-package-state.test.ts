import { describe, expect, it } from 'vitest'
import { captureExportInputs } from '@/core/export-preview'
import { useEditorStore } from '@/stores'
import { createDeliveryForm, deliveryFormKey, isDeliverySnapshotCurrent, patchDeliveryForm, readDeliveryOptions, type DeliveryForm } from './delivery-package-state'

const form = (patch: Partial<DeliveryForm> = {}): DeliveryForm => ({ ...createDeliveryForm('礼物.svga'), ...patch })

describe('交付表单预算转换与输入约束', () => {
  it('从URL生成默认标题时丢弃账号、目录、鉴权参数和片段', () => {
    const input = createDeliveryForm('https://private-user:private-pass@example.test/internal/project/gift%20name.svga?token=secret#private')
    expect(input.title).toBe('gift name')
    expect(deliveryFormKey(input)).not.toContain('private')
    expect(deliveryFormKey(input)).not.toContain('secret')
  })

  it.each(['blob:https://example.test/private-id', 'data:application/octet-stream;base64,cHJpdmF0ZQ==', 'https://not a valid url?token=secret'])('临时或无效来源不进入交付标题：%s', value => {
    expect(createDeliveryForm(value).title).toBe('动画交付')
  })

  it('默认标题以Unicode字符截断，不拆开Emoji代理对', () => {
    const input = createDeliveryForm(`${'文'.repeat(119)}😀more.svga`)
    expect(input.title).toBe(`${'文'.repeat(119)}😀`)
    expect(() => readDeliveryOptions(input)).not.toThrow()
  })

  it('默认表单不含源工程、不指定平台或预算，读取选项不改原表单', () => {
    const input = form()
    const before = structuredClone(input)
    expect(readDeliveryOptions(input)).toEqual({
      title: '礼物', includeProject: false,
      target: { platform: 'unspecified', player: '', version: '', maxFileBytes: null, maxDecodedImageBytes: null },
    })
    expect(input).toEqual(before)
  })

  it('按二进制MiB转换，允许小数并四舍五入到整数byte', () => {
    const result = readDeliveryOptions(form({ maxFileMiB: '1.5', maxDecodedImageMiB: '0.1' }))
    expect(result.target.maxFileBytes).toBe(1_572_864)
    expect(result.target.maxDecodedImageBytes).toBe(104_858)
  })

  it('科学记数和前后空格转换为明确数值，不改变原始快照键', () => {
    const input = form({ maxFileMiB: ' 1e1 ', maxDecodedImageMiB: '.5' })
    expect(readDeliveryOptions(input).target.maxFileBytes).toBe(10 * 1024 * 1024)
    expect(readDeliveryOptions(input).target.maxDecodedImageBytes).toBe(524288)
    expect(input.maxFileMiB).toBe(' 1e1 ')
  })

  it('空白预算表示不限制，而不是0字节', () => {
    const result = readDeliveryOptions(form({ maxFileMiB: ' ', maxDecodedImageMiB: '\t' }))
    expect(result.target.maxFileBytes).toBeNull()
    expect(result.target.maxDecodedImageBytes).toBeNull()
  })

  it.each(['0', '-1', 'NaN', 'Infinity', '1e309', '0x10', '0b11', '1,5', '1MiB', '1e-30', '9007199254740991'])('拒绝无效文件预算 %s，不静默改成默认值', value => {
    expect(() => readDeliveryOptions(form({ maxFileMiB: value }))).toThrow('SVGA 文件预算')
  })

  it.each(['0', '-1', 'NaN', 'Infinity', '1e309', '0x10', '1e-30'])('对图片解码预算同样拒绝无效值 %s', value => {
    expect(() => readDeliveryOptions(form({ maxDecodedImageMiB: value }))).toThrow('图片解码内存预算')
  })

  it('1 TiB边界有效，越界拒绝且不会钳制', () => {
    expect(readDeliveryOptions(form({ maxFileMiB: '1048576', maxDecodedImageMiB: '1048576' })).target.maxFileBytes).toBe(1024 ** 4)
    expect(() => readDeliveryOptions(form({ maxFileMiB: '1048577' }))).toThrow('1 TiB')
    expect(() => readDeliveryOptions(form({ maxDecodedImageMiB: '1048577' }))).toThrow('1 TiB')
  })

  it('空标题无法生成，播放器和版本可空', () => {
    expect(() => readDeliveryOptions(form({ title: ' ' }))).toThrow('请填写交付标题')
    expect(readDeliveryOptions(form({ player: ' ', version: ' ' })).target).toMatchObject({ player: '', version: '' })
  })

  it.each(['title', 'player', 'version'] as const)('对%s执行同一120字符与控制字符校验', field => {
    expect(() => readDeliveryOptions(form({ [field]: 'x'.repeat(121) }))).toThrow('120')
    expect(() => readDeliveryOptions(form({ [field]: 'name\nsecond' }))).toThrow('控制字符')
    expect(() => readDeliveryOptions(form({ [field]: 'x'.repeat(120) }))).not.toThrow()
  })

  it('平台选择和是否分享源工程原样写入选项，不推断用户同意', () => {
    for (const platform of ['unspecified', 'web', 'android', 'ios', 'other'] as const) {
      const result = readDeliveryOptions(form({ platform, includeProject: true }))
      expect(result.target.platform).toBe(platform)
      expect(result.includeProject).toBe(true)
    }
  })
})

describe('交付结果当前性令牌', () => {
  it('空修改和实际值未变化时保留表单引用，不触发结果过期', () => {
    const initial = form()
    expect(patchDeliveryForm(initial, {})).toBe(initial)
    expect(patchDeliveryForm(initial, { title: initial.title, includeProject: false })).toBe(initial)
    const prepared = { inputs: [], optionsKey: deliveryFormKey(initial) }
    expect(isDeliverySnapshotCurrent(prepared, [], patchDeliveryForm(initial, { platform: 'unspecified' }))).toBe(true)
  })

  it('真实值变化返回新表单，原值不被改写且旧结果失效', () => {
    const initial = form()
    const next = patchDeliveryForm(initial, { includeProject: true })
    expect(next).not.toBe(initial)
    expect(initial.includeProject).toBe(false)
    expect(next.includeProject).toBe(true)
    expect(isDeliverySnapshotCurrent({ inputs: [], optionsKey: deliveryFormKey(initial) }, [], next)).toBe(false)
  })

  it('相同输入及未修改表单允许保存', () => {
    const input = form()
    const references = [new ArrayBuffer(1), {}, new Map()]
    expect(isDeliverySnapshotCurrent({ inputs: references, optionsKey: deliveryFormKey(input) }, [...references], { ...input })).toBe(true)
  })

  it.each([
    { title: '另一标题' }, { platform: 'web' }, { player: '另一个播放器' }, { version: '2' },
    { maxFileMiB: '2' }, { maxDecodedImageMiB: '3' }, { includeProject: true },
  ] satisfies Partial<DeliveryForm>[])('任一交付设置变化都会使旧包失效：%j', patch => {
    const input = form()
    const prepared = { inputs: [], optionsKey: deliveryFormKey(input) }
    expect(isDeliverySnapshotCurrent(prepared, [], { ...input, ...patch })).toBe(false)
  })

  it('表单改动后再改回也不会撤销已有过期标记', () => {
    const input = form()
    expect(isDeliverySnapshotCurrent({ inputs: [], optionsKey: deliveryFormKey(input), optionsChanged: true }, [], input)).toBe(false)
  })

  it('数值标准化相同的原始编辑也被识别，不误用旧摘要', () => {
    const initial = form({ maxFileMiB: '1' })
    const next = form({ maxFileMiB: '1.0' })
    expect(readDeliveryOptions(initial)).toEqual(readDeliveryOptions(next))
    expect(isDeliverySnapshotCurrent({ inputs: [], optionsKey: deliveryFormKey(initial) }, [], next)).toBe(false)
  })

  it('快照键不依赖对象字段插入顺序', () => {
    const initial = form()
    const reversed = Object.fromEntries(Object.entries(initial).reverse()) as unknown as DeliveryForm
    expect(deliveryFormKey(initial)).toBe(deliveryFormKey(reversed))
  })

  it('结构相同但资源对象换了引用也失效，长度不同亦不能保存', () => {
    const input = form()
    const key = deliveryFormKey(input)
    const source = { content: 'unchanged' }
    expect(isDeliverySnapshotCurrent({ inputs: [source], optionsKey: key }, [{ ...source }], input)).toBe(false)
    expect(isDeliverySnapshotCurrent({ inputs: [source], optionsKey: key }, [source, null], input)).toBe(false)
  })

  it('播放游标、画布视口和选择只影响操作界面，不使已有产物失效', () => {
    const editor = useEditorStore.getState()
    const inputs = captureExportInputs(editor)
    const next = { ...editor, playback: { ...editor.playback, currentFrame: 12, isPlaying: true }, zoom: 2, selectedLayerId: 'another' }
    const current = captureExportInputs(next)
    const input = form()
    expect(isDeliverySnapshotCurrent({ inputs, optionsKey: deliveryFormKey(input) }, current, input)).toBe(true)
  })

  it('编辑帧参数、文案、图层、资源和优化配置后均不能保存旧包', () => {
    const editor = useEditorStore.getState()
    const input = form()
    const prepared = { inputs: captureExportInputs(editor), optionsKey: deliveryFormKey(input) }
    const changed = [
      { ...editor, customFrames: 120 }, { ...editor, customFps: 60 },
      { ...editor, slotConfigs: { ...editor.slotConfigs } }, { ...editor, layers: [...editor.layers] },
      { ...editor, imageResources: new Map(editor.imageResources) },
      { ...editor, audioResources: new Map(editor.audioResources) },
      { ...editor, optimizationConfig: { ...editor.optimizationConfig } },
    ]
    for (const state of changed) expect(isDeliverySnapshotCurrent(prepared, captureExportInputs(state), input)).toBe(false)
  })
})
