import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorStore } from '@/stores'
import { generateDeliveryBundle } from '@/core/delivery'
import { createSaveFileTarget } from '@/core/exporter'
import type { DeliveryBundleResult, DeliverySlot, DeliverySlotSource } from '@/types/delivery'
import { DeliveryPackageDialog, DeliveryPackageSummary, DeliverySettingsSummary } from './DeliveryPackageDialog'
import { createDeliveryForm, deliveryFormKey } from './delivery-package-state'

vi.mock('@/core/delivery', () => ({ generateDeliveryBundle: vi.fn() }))
vi.mock('@/core/exporter', () => ({ createSaveFileTarget: vi.fn() }))
vi.mock('@/stores', async () => {
  const actual = await vi.importActual<typeof import('@/stores')>('@/stores')
  // Zustand 的服务端快照固定为初始值；本组仅注入当前只读状态验证 SSR，不模拟事件或订阅。
  return { ...actual, useEditorStore: Object.assign(() => actual.useEditorStore.getState(), actual.useEditorStore) }
})

const state = () => useEditorStore.getState()
const params = { viewBoxWidth: 200, viewBoxHeight: 100, fps: 20, frames: 20 }
const open = () => {
  state().setVideoItem({ movie: { version: '2.0', params, sprites: [], images: {} }, images: {}, buffers: {} })
  state().setOriginalBuffer(new ArrayBuffer(8))
}

function button(html: string, label: string): string {
  const result = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(item => item.includes(`aria-label="${label}"`))
  expect(result, `应存在按钮：${label}`).toBeDefined()
  return result ?? ''
}

function input(html: string, label: string): string {
  const result = html.match(/<input\b[^>]*\/>/g)?.find(item => item.includes(`aria-label="${label}"`))
  expect(result, `应存在输入框：${label}`).toBeDefined()
  return result ?? ''
}

const source = (textEffect: DeliverySlotSource['textEffect'], spriteIndex = 0): DeliverySlotSource => ({
  spriteIndex, layerId: `layer-${spriteIndex}`, originalSpriteIndex: spriteIndex,
  sourceImageKey: 'source', sourceSlotKey: 'source', baselineImageKey: 'source',
  layerName: '图层', currentImageKey: 'source', textEffect, text: null,
})

const slot = (key: string, sources: DeliverySlotSource[] = []): DeliverySlot => ({
  key, role: 'image', state: 'referenced', resource: null, spriteIndices: [], matteForSpriteIndices: [], sources,
})

function bundle(): DeliveryBundleResult {
  return {
    blob: new Blob([new Uint8Array(8192)], { type: 'application/zip' }),
    fileName: '礼物动画-delivery.zip',
    manifest: {
      format: 'svga-editor-delivery', schemaVersion: 1, createdAt: '2026-09-21T00:00:00.000Z', title: '礼物动画',
      sourceRevision: { schemaVersion: 1, algorithm: 'sha256', value: '0123456789abcdef'.repeat(4) },
      params, target: { platform: 'android', player: 'SVGAPlayer', version: 'test', maxFileBytes: null, maxDecodedImageBytes: null },
      previewFrame: 4, optimization: state().optimizationConfig, independentKeysPreserved: true, includesProject: false,
      files: [{ path: 'animation.svga', bytes: 4096, sha256: 'abcd'.repeat(16), role: 'animation' }],
    },
    report: {
      format: 'svga-editor-delivery-report', schemaVersion: 1, previewFrame: 4, decodedImageBytesEstimate: 1024 * 1024,
      checks: [{ id: 'target', title: '目标播放器', status: 'not-tested', detail: '没有执行 Android 真机验证。' }],
    },
    slots: [slot('avatar'), slot('text', [source('dynamic')]), slot('title', [source('baked')])],
    previews: { actual: new Blob(['actual'], { type: 'image/png' }), design: new Blob(['design'], { type: 'image/png' }) },
  }
}

beforeEach(() => { state().reset(); vi.clearAllMocks() })
afterEach(() => { state().reset(); vi.restoreAllMocks() })

describe('专业交付弹窗的初始语义（SSR，不替代浏览器交互验收）', () => {
  it('关闭时不呈现内容，也不生成文件或弹出保存位置', () => {
    expect(renderToStaticMarkup(<DeliveryPackageDialog isOpen={false} onClose={vi.fn()} />)).toBe('')
    expect(generateDeliveryBundle).not.toHaveBeenCalled()
    expect(createSaveFileTarget).not.toHaveBeenCalled()
  })

  it('使用键盘隔离的模态框，说明实际产物与接入清单的范围', () => {
    const html = renderToStaticMarkup(<DeliveryPackageDialog isOpen onClose={vi.fn()} />)
    expect(html).toContain('role="dialog" aria-modal="true" aria-label="专业交付包"')
    expect(html).toContain('tabindex="-1"')
    for (const text of ['实际 SVGA', '文字接入清单', '资源文件', '检查报告', '摘要指纹']) expect(html).toContain(text)
    expect(html).toContain('强制保留独立 Key、不跨 Key 去重')
    expect(html).toContain('不改变编辑器中的压缩设置')
    expect(html).toContain('导出不会代替 Ctrl+S 保存工程')
  })

  it('默认不分享源工程，也不把目标平台选择当作验证通过', () => {
    const html = renderToStaticMarkup(<DeliveryPackageDialog isOpen onClose={vi.fn()} />)
    expect(input(html, '在交付包附带可编辑工程')).not.toContain('checked=""')
    expect(html).toContain('<option value="unspecified" selected="">未指定</option>')
    expect(html).toContain('默认不包含')
    expect(html).toContain('可能未交付的素材')
    expect(html).toContain('请确认有权对外提供')
    expect(html).toContain('不会将填写平台视为兼容性已验证')
    expect(html).not.toContain('data-status="success"')
    expect(html).toContain('SVGA 本体也可能保留未引用素材，请核对资源清单')
  })

  it('初次打开仍显示完整设置，而不是先要求用户展开', () => {
    const html = renderToStaticMarkup(<DeliveryPackageDialog isOpen onClose={vi.fn()} />)
    expect(html.match(/<fieldset\b[^>]*>/)?.[0]).not.toContain('hidden')
    expect(html).not.toContain('aria-label="交付设置摘要"')
    expect(input(html, '交付标题')).toBeTruthy()
  })

  it('没有工程时禁止生成和保存，保留关闭入口', () => {
    const html = renderToStaticMarkup(<DeliveryPackageDialog isOpen onClose={vi.fn()} />)
    expect(button(html, '生成专业交付包')).toContain('disabled=""')
    expect(button(html, '保存交付 ZIP')).toContain('disabled=""')
    expect(button(html, '关闭专业交付包')).not.toContain('disabled=""')
    expect(html).toContain('请先打开一个有效的 SVGA 或 .svgaproj 工程')
  })

  it('有效工程只允许生成，没有生成结果时不能保存', () => {
    open()
    const html = renderToStaticMarkup(<DeliveryPackageDialog isOpen onClose={vi.fn()} />)
    expect(button(html, '生成专业交付包')).not.toContain('disabled=""')
    expect(button(html, '保存交付 ZIP')).toContain('disabled=""')
    expect(html).not.toContain('aria-label="交付包结果"')
  })

  it('仅打开弹窗不提交输入、不暂停播放、不改dirty或历史', () => {
    open()
    state().setCustomFps(24)
    state().setPlaying(true)
    const before = state()
    const capture = vi.spyOn(before, 'captureProjectDocument')
    renderToStaticMarkup(<DeliveryPackageDialog isOpen onClose={vi.fn()} />)
    expect(capture).not.toHaveBeenCalled()
    expect(state()).toBe(before)
    expect(state().isDirty).toBe(true)
    expect(state().playback.isPlaying).toBe(true)
    expect(generateDeliveryBundle).not.toHaveBeenCalled()
    expect(createSaveFileTarget).not.toHaveBeenCalled()
  })

  it.each([
    ['C:\\客户私有目录\\春节礼物.svga', '春节礼物'],
    ['/private/customer/庆典.svgaproj', '庆典'],
    ['TITLE.SVGA', 'TITLE'],
    [null, '动画交付'],
  ])('从源名称 %s 取得标题，不把磁盘路径分享为标题', (currentSource, expected) => {
    useEditorStore.setState({ currentSource })
    const html = renderToStaticMarkup(<DeliveryPackageDialog isOpen onClose={vi.fn()} />)
    expect(input(html, '交付标题')).toContain(`value="${expected}"`)
    expect(html).not.toContain('客户私有目录')
    expect(html).not.toContain('/private/customer/')
  })

  it('优先使用当前工程名，而不是原始SVGA名', () => {
    useEditorStore.setState({ projectName: '已修改礼物.svgaproj', currentSource: '原始.svga' })
    const html = renderToStaticMarkup(<DeliveryPackageDialog isOpen onClose={vi.fn()} />)
    expect(input(html, '交付标题')).toContain('value="已修改礼物"')
  })

  it('过长默认标题限制到120字符，源名内容按普通文本转义', () => {
    useEditorStore.setState({ currentSource: `${'文'.repeat(140)}.svga` })
    const long = renderToStaticMarkup(<DeliveryPackageDialog isOpen onClose={vi.fn()} />)
    expect(input(long, '交付标题')).toContain(`value="${'文'.repeat(120)}"`)
    useEditorStore.setState({ currentSource: '<img src=x onerror=alert(1)>.svga' })
    const escaped = renderToStaticMarkup(<DeliveryPackageDialog isOpen onClose={vi.fn()} />)
    expect(input(escaped, '交付标题')).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(escaped).not.toContain('<img src=x')
  })

  it('两种预算以MiB展示且默认不限制，SDK与版本默认不填', () => {
    const html = renderToStaticMarkup(<DeliveryPackageDialog isOpen onClose={vi.fn()} />)
    for (const label of ['SVGA 文件大小预算 MiB', '图片解码内存预算 MiB', '交付播放器或 SDK', '交付播放器版本']) expect(input(html, label)).toContain('value=""')
    expect(html).toContain('留空表示不限制')
    expect(html).toContain('不包含播放器与纹理开销')
    expect(html).toContain('仅保留在此弹窗')
  })
})

describe('生成后的紧凑设置摘要', () => {
  it('收起时显示标题、目标、工程分享和预算，给出明确修改入口', () => {
    const form = { ...createDeliveryForm('庆典.svga'), platform: 'android' as const, player: 'SVGAPlayer', version: '2.6', maxFileMiB: '2', maxDecodedImageMiB: '64' }
    const onToggle = vi.fn()
    const html = renderToStaticMarkup(<DeliverySettingsSummary form={form} expanded={false} disabled={false} settingsId="delivery-settings" onToggle={onToggle} />)
    expect(html).toContain('aria-label="交付设置摘要"')
    expect(html).toContain('庆典')
    expect(html).toContain('Android · SVGAPlayer 2.6 · 不附带源工程')
    expect(html).toContain('SVGA 2 MiB · 图片解码 64 MiB')
    expect(button(html, '修改交付设置')).toContain('aria-expanded="false"')
    expect(button(html, '修改交付设置')).toContain('aria-controls="delivery-settings"')
    expect(html).not.toContain('<input')
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('未填目标不冒称完成接入验证，并保留未引用素材分享边界', () => {
    const html = renderToStaticMarkup(<DeliverySettingsSummary form={createDeliveryForm(null)} expanded={false} disabled={false} settingsId="settings" onToggle={vi.fn()} />)
    expect(html).toContain('未指定平台 · 播放器未指定 · 不附带源工程')
    expect(html).toContain('SVGA 不限 · 图片解码 不限')
    expect(html).toContain('即使不附工程，SVGA 本体也可能保留未引用素材，请核对资源清单')
    expect(html).not.toContain('不含任何未交付素材')
    expect(html).not.toContain('兼容性通过')
  })

  it('展开状态只是界面状态，不修改表单或结果快照键', () => {
    const form = { ...createDeliveryForm('设计'), includeProject: true }
    const before = deliveryFormKey(form)
    const html = renderToStaticMarkup(<DeliverySettingsSummary form={form} expanded disabled={false} settingsId="settings" onToggle={vi.fn()} />)
    expect(button(html, '收起交付设置')).toContain('aria-expanded="true"')
    expect(html).toContain('附带源工程')
    expect(deliveryFormKey(form)).toBe(before)
  })

  it('任务进行中禁用展开按钮，不误触发设置变化', () => {
    const html = renderToStaticMarkup(<DeliverySettingsSummary form={createDeliveryForm(null)} expanded={false} disabled settingsId="settings" onToggle={vi.fn()} />)
    expect(button(html, '修改交付设置')).toContain('disabled=""')
  })
})

describe('专业交付结果的证据呈现', () => {
  it('按包内真实载荷展示ZIP/SVGA大小、Key和解码估算，不用源文件大小代替', () => {
    const html = renderToStaticMarkup(<DeliveryPackageSummary result={bundle()} />)
    expect(html).toContain('8.0 KiB')
    expect(html).toContain('4.0 KiB')
    expect(html).toContain('1.00 MiB')
    expect(html).toContain('实际资源 Key')
    expect(html).toContain('>3</p>')
    expect(html).toContain('0123456789abcdef…')
    expect(html).toContain('SHA-256 abcdabcdabcdabcd…')
    expect(html).not.toContain('验收通过')
  })

  it('所有帧标签使用同一份快照的1起始帧，不宣称播放游标会改变已生成文件', () => {
    const html = renderToStaticMarkup(<DeliveryPackageSummary result={bundle()} />)
    expect(html).toContain('快照第 5 帧 / 20 帧')
    expect(html).toContain('alt="实际 SVGA · 第 5 帧"')
    expect(html).toContain('alt="设计模拟 · 第 5 帧"')
    expect(html).toContain('移动播放游标不会改变此包')
    expect(html).toContain('如需其他帧请重新生成')
    expect(html).toContain('不代表整段动画或目标 SDK / 真机实测')
  })

  it('双预览优先于长篇接入说明和逐项报告，便于首先核对画面', () => {
    const html = renderToStaticMarkup(<DeliveryPackageSummary result={bundle()} />)
    expect(html.indexOf('alt="实际 SVGA')).toBeLessThan(html.indexOf('动态文字 Key：'))
    expect(html.indexOf('alt="设计模拟')).toBeLessThan(html.indexOf('截图固定为生成时'))
    expect(html.indexOf('alt="设计模拟')).toBeLessThan(html.indexOf('aria-label="交付检查结果"'))
  })

  it('明确区分动态文案模拟与SVGA固定字形，不把设计截图当成实际文件', () => {
    const html = renderToStaticMarkup(<DeliveryPackageSummary result={bundle()} />)
    expect(html).toContain('动态文字 Key：1 · 固定字形 Key：1')
    expect(html).toContain('需开发端按清单设置')
    expect(html).toContain('不能由播放器动态改字')
    expect(html).toContain('不叠加仅模拟的动态文案')
    expect(html).toContain('不代表文案已写入 SVGA')
  })

  it('文字数量按实际Key计算，重复sprite来源不重复累计', () => {
    const result = bundle()
    result.slots = [
      slot('a', [source('dynamic'), source('dynamic', 1), source('empty', 2)]),
      slot('b', [source('baked'), source('baked', 1)]),
      slot('mixed', [source('dynamic'), source('baked', 1)]),
      slot('disabled', [source('disabled')]),
    ]
    const html = renderToStaticMarkup(<DeliveryPackageSummary result={result} />)
    expect(html).toContain('动态文字 Key：2 · 固定字形 Key：2')
    expect(html).toContain('同一 Key 可有不同文字来源')
  })

  it('目标平台即便填写也保留未实测状态，不显示全绿兼容', () => {
    const html = renderToStaticMarkup(<DeliveryPackageSummary result={bundle()} />)
    expect(html).toContain('data-check-status="not-tested"')
    expect(html).toContain('>未实测</span>')
    expect(html).toContain('没有执行 Android 真机验证')
    expect(html).toContain('不执行该播放器')
    expect(html).not.toContain('data-check-status="passed"')
    expect(html).not.toContain('兼容性通过')
  })

  it('检查失败仍说明可以保存诊断ZIP，不冒充正式验收通过', () => {
    const result = bundle()
    result.report.checks.push({ id: 'file-budget', title: '文件预算', status: 'failed', detail: '超过 2 KiB 预算。' })
    const html = renderToStaticMarkup(<DeliveryPackageSummary result={result} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('1 项检查未通过')
    expect(html).toContain('不符合当前交付目标')
    expect(html).toContain('仍可保存诊断 ZIP')
    expect(html).toContain('不能将它标为验收通过')
    expect(html).toContain('data-check-status="failed"')
  })

  it('逐项保留四种检查状态及精确Key，不丢失警告', () => {
    const result = bundle()
    result.report.checks = [
      { id: 'structure', title: '结构', status: 'passed', detail: '可解码' },
      { id: 'budget', title: '预算', status: 'failed', detail: '超出' },
      { id: 'webp', title: 'WebP', status: 'warning', detail: '确认SDK支持', key: '<script>&\"' },
      { id: 'device', title: '设备', status: 'not-tested', detail: '未执行' },
    ]
    const html = renderToStaticMarkup(<DeliveryPackageSummary result={result} />)
    for (const check of result.report.checks) {
      expect(html).toContain(`data-check-status="${check.status}"`)
      expect(html).toContain(check.title)
      expect(html).toContain(check.detail)
    }
    expect(html).toContain('Key：&lt;script&gt;&amp;&quot;')
    expect(html).not.toContain('<script>')
  })

  it('明确内存只是图片解码估算，不用它保证播放器峰值内存', () => {
    const html = renderToStaticMarkup(<DeliveryPackageSummary result={bundle()} />)
    expect(html).toContain('内存仅估算图片解码')
    expect(html).toContain('不包括纹理、缓存、画布及运行时开销')
  })

  it('载荷缺少动画摘要时显示未记录，不能用ZIP大小补假数值', () => {
    const result = bundle()
    result.manifest.files = []
    const html = renderToStaticMarkup(<DeliveryPackageSummary result={result} />)
    expect(html).toContain('未记录')
    expect(html).toContain('0 个载荷文件')
  })

  it('仅实际包附带工程时显示源数据分享警告', () => {
    const result = bundle()
    expect(renderToStaticMarkup(<DeliveryPackageSummary result={result} />)).not.toContain('此包附带可编辑')
    result.manifest.includesProject = true
    const html = renderToStaticMarkup(<DeliveryPackageSummary result={result} />)
    expect(html).toContain('此包附带可编辑 .svgaproj 工程')
    expect(html).toContain('可能未交付的素材')
    expect(html).toContain('分享前请确认')
  })

  it('文件名、检查和摘要列表均转义为文本，不执行外来HTML', () => {
    const result = bundle()
    result.fileName = '<svg onload=alert(1)>.zip'
    result.manifest.files[0].path = '<script>alert(1)</script>'
    result.report.checks[0].detail = '<img src=x onerror=alert(1)>'
    const html = renderToStaticMarkup(<DeliveryPackageSummary result={result} />)
    expect(html).toContain('&lt;svg onload=alert(1)&gt;.zip')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img src=x')
  })
})
