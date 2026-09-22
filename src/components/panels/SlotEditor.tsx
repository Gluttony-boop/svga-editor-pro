import React from 'react'
import { Button } from '@/components/ui'
import { CommitNumberField } from '@/components/ui/CommitNumberField'
import { useEditorStore } from '@/stores'
import type { SlotConfig, SlotTextConfig } from '@/types'
import { buildSlotCatalog, type SlotCatalogEntry } from '@/utils/slot-catalog'
import { requestLayerReveal } from '@/utils/layer-navigation'
import { hasTextPreview, normalizeTextConfig } from '@/core/text-preview'
import { fitImageToDataUrl, type ImageFitMode } from '@/core/image-fit'
import { getSlotImageUrl, mergeSlotImageConfig, mergeSlotTextConfig, withoutSlotImageConfig, withoutSlotTextConfig } from '@/utils/slot-config'
import { cn } from '@/utils/cn'

const fieldClass = 'w-full rounded border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent disabled:opacity-40'
const ownConfig = (configs: Record<string, SlotConfig>, key: string) => Object.prototype.hasOwnProperty.call(configs, key) ? configs[key] : undefined
const fontFamilies = ['Arial', 'Microsoft YaHei', 'SimSun', 'SimHei', 'sans-serif', 'serif', 'monospace']

export function SlotEditor({ entry, config }: { entry: SlotCatalogEntry; config?: SlotConfig }) {
  const video = useEditorStore(state => state.videoItem)
  const layers = useEditorStore(state => state.layers)
  const currentFrame = useEditorStore(state => state.playback.currentFrame)
  const [mode, setMode] = React.useState<'text' | 'image'>('text')
  const [notice, setNotice] = React.useState('')
  const [textError, setTextError] = React.useState('')
  const [boxEditRevision, setBoxEditRevision] = React.useState(0)
  const [imageBusy, setImageBusy] = React.useState(false)
  const [fitMode, setFitMode] = React.useState<ImageFitMode>('fit')
  const inputRef = React.useRef<HTMLInputElement>(null)
  const draftActive = React.useRef(false)
  const uploadAbort = React.useRef<AbortController | null>(null)
  const text = normalizeTextConfig(config?.textConfig, config?.type === 'text' ? config.value : null)
  const editable = entry.canSimulateText && !imageBusy
  const key = entry.key
  const context = React.useMemo(() => ({ video, key }), [video, key])
  const boxContext = React.useMemo(() => ({ context, boxEditRevision }), [context, boxEditRevision])

  React.useEffect(() => {
    setImageBusy(false)
    setTextError('')
    return () => {
      uploadAbort.current?.abort()
      if (draftActive.current) { useEditorStore.getState().endSlotConfigEdit(false); draftActive.current = false }
    }
  }, [context])

  const latestConfig = () => ownConfig(useEditorStore.getState().slotConfigs, key)
  const beginDraft = () => {
    if (editable && useEditorStore.getState().videoItem === video) draftActive.current = useEditorStore.getState().beginSlotConfigEdit(key)
  }
  const endDraft = (commit: boolean) => {
    if (draftActive.current) useEditorStore.getState().endSlotConfigEdit(commit)
    draftActive.current = false
  }
  const updateText = (patch: Partial<SlotTextConfig>, preview = false) => {
    const state = useEditorStore.getState()
    if (!editable || state.videoItem !== video) return
    try {
      const previous = latestConfig()
      const nextText = normalizeTextConfig({ ...normalizeTextConfig(previous?.textConfig, previous?.type === 'text' ? previous.value : null), ...patch })
      const next = mergeSlotTextConfig(previous, key, nextText)
      if (preview) {
        if (!draftActive.current || !state.isSlotConfigEditing) beginDraft()
        if (draftActive.current) useEditorStore.getState().previewSlotConfig(key, next)
      } else { endDraft(true); state.setSlotConfig(key, next) }
      setTextError('')
    } catch (error) {
      setTextError('文字配置未应用：' + (error instanceof Error ? error.message : String(error)))
    }
  }
  const currentText = () => {
    const current = latestConfig()
    return normalizeTextConfig(current?.textConfig, current?.type === 'text' ? current.value : null)
  }
  const updateTextBox = (patch: Partial<SlotTextConfig>) => {
    const current = currentText()
    // 参考尺寸只在首次建立时记录，后续加宽不会累积放大底图或改变换图适配尺寸。
    updateText({
      boxWidth: current.boxWidth ?? Math.ceil(entry.width),
      boxHeight: current.boxHeight ?? Math.ceil(entry.height),
      referenceWidth: current.referenceWidth ?? Math.ceil(entry.width),
      referenceHeight: current.referenceHeight ?? Math.ceil(entry.height),
      ...patch
    })
    // 校验拒绝或整数化后也刷新输入草稿，避免数字框仍显示未实际应用的尺寸。
    setBoxEditRevision(revision => revision + 1)
  }
  const resetTextBox = () => {
    const current = currentText()
    if (current.exportMode === 'bake') {
      updateTextBox({ boxWidth: current.referenceWidth, boxHeight: current.referenceHeight })
    } else {
      updateText({ boxWidth: undefined, boxHeight: undefined, referenceWidth: undefined, referenceHeight: undefined })
      setBoxEditRevision(revision => revision + 1)
    }
  }
  const removePart = (part: 'text' | 'image') => {
    endDraft(true)
    const next = part === 'text' ? withoutSlotTextConfig(latestConfig()) : withoutSlotImageConfig(latestConfig())
    if (next) useEditorStore.getState().setSlotConfig(key, next)
    else useEditorStore.getState().removeSlotConfig(key)
  }
  const draftKeys = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    event.stopPropagation()
    if (event.key === 'Escape' || (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); endDraft(false); event.currentTarget.blur()
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); endDraft(true); event.currentTarget.blur() }
  }

  const uploadImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > 32 * 1024 * 1024) { setNotice('图片不能超过 32 MiB。'); return }
    endDraft(true)
    const state = useEditorStore.getState()
    const previous = latestConfig()
    const buffer = state.originalBuffer
    const controller = new AbortController()
    uploadAbort.current?.abort()
    uploadAbort.current = controller
    const url = URL.createObjectURL(file)
    setImageBusy(true)
    setNotice('正在生成目标尺寸图片…')
    try {
      const dataUrl = await fitImageToDataUrl(url, Math.ceil(entry.width), Math.ceil(entry.height), fitMode, controller.signal)
      const current = useEditorStore.getState()
      if (controller.signal.aborted) return
      if (current.videoItem !== video || current.originalBuffer !== buffer || ownConfig(current.slotConfigs, key) !== previous) throw new Error('目标内容已经变化，请重新选择图片')
      const target = buildSlotCatalog(current.videoItem, current.layers, current.imageResources, current.slotConfigs).find(item => item.key === key)
      if (!target?.canSimulateText || target.width !== entry.width || target.height !== entry.height ||
        JSON.stringify(target.referenceLayerIds) !== JSON.stringify(entry.referenceLayerIds)) throw new Error('引用图层或尺寸已经变化，请重新选择图片')
      current.setSlotConfig(key, mergeSlotImageConfig(previous, key, dataUrl, 'stretch'))
      setNotice('图片已替换，保留此 Key 的文字模拟；可撤销。')
    } catch (error) { if (!controller.signal.aborted) setNotice('图片未替换：' + (error instanceof Error ? error.message : String(error))) }
    finally { URL.revokeObjectURL(url); if (!controller.signal.aborted) setImageBusy(false) }
  }

  const imageUrl = getSlotImageUrl(config)
  const linked = entry.referenceLayerIds.map(id => layers.find(layer => layer.id === id)).filter(Boolean)
  const visibleNow = linked.some(layer => {
    if (!layer || !layer.visible || layer.opacity === 0) return false
    const source = currentFrame - (layer.timeOffsetFrames || 0)
    if (source < layer.clip.startFrame || source >= layer.clip.startFrame + layer.clip.duration) return false
    return !layer.sprites || !!layer.sprites.frames[source] && (layer.sprites.frames[source].alpha ?? 1) > 0
  })
  const numbers = { disabled: !editable, context, onStart: () => { endDraft(true); setTextError('') } }

  return <section aria-label="当前 Key 配置" className="space-y-3 rounded border border-border bg-bg-tertiary/40 p-2.5">
    <div className="flex items-start gap-1">
      <input aria-label="完整插槽 Key" readOnly value={key} className={cn(fieldClass, 'min-w-0 font-mono')} onFocus={event => event.target.select()} />
      <button type="button" aria-label="复制完整 Key" className="shrink-0 whitespace-nowrap rounded px-1.5 py-1 text-xs text-accent" onClick={async () => {
        try { await navigator.clipboard.writeText(key); setNotice('完整 Key 已复制') }
        catch { setNotice('无法使用剪贴板，请选择 Key 文本复制') }
      }}>复制</button>
    </div>
    <p className="text-[10px] leading-relaxed text-text-muted">{entry.reason} · {entry.width > 0 ? `${entry.width} × ${entry.height} px` : '尺寸未知'}{entry.warning ? ` · ${entry.warning}` : ''}</p>
    {linked.length > 0 && <div className="flex flex-wrap gap-1" aria-label="插槽引用图层">
      {linked.map(layer => layer && <button type="button" key={layer.id} onClick={() => requestLayerReveal(layer.id)} title="只定位图层，不改变画面" className="max-w-full truncate rounded border border-border px-1.5 py-1 text-[10px] text-text-secondary hover:text-accent">定位 {layer.name}{!layer.visible ? ' · 隐藏' : ''}{layer.locked ? ' · 锁定' : ''}</button>)}
    </div>}
    <div role="group" aria-label="Key 配置模式" className="grid grid-cols-2 gap-1">
      {(['text', 'image'] as const).map(value => <button type="button" key={value} aria-pressed={mode === value} onClick={() => { endDraft(true); setMode(value) }} className={cn('rounded px-2 py-1.5 text-xs', mode === value ? 'bg-accent/15 text-accent' : 'bg-bg-primary text-text-muted')}>{value === 'text' ? '模拟文字' : '替换图片'}</button>)}
    </div>
    {mode === 'text' ? <div className="space-y-3">
      <p className="rounded border border-accent/20 bg-accent/5 p-2 text-[10px] leading-relaxed text-text-secondary">文字跟随此 Key 的全部图层动画。可扩大显示范围，并选择仅模拟或将当前字形写入 SVGA；PNG 序列和 WebP 始终包含当前可见效果。</p>
      <div className="flex items-center justify-between gap-1">
        <label className="flex items-center gap-1 text-[11px] text-text-secondary"><input type="checkbox" aria-label="显示模拟文字" checked={text.enabled !== false} disabled={!editable} onChange={event => updateText({ enabled: event.target.checked })} className="accent-accent" />显示文字</label>
        <button type="button" disabled={!editable} onClick={() => updateText({ text: '设计师昵称', fontSize: Math.max(24, Math.min(96, Math.round(entry.height / 5))), enabled: true })} className="text-[11px] text-accent disabled:opacity-40">插入示例文字</button>
      </div>
      <label className="block text-[11px] text-text-secondary">文字内容
        <textarea aria-label="模拟文字内容" rows={3} maxLength={500} disabled={!editable} value={text.text} placeholder="输入昵称、祝福语，可换行…" onFocus={beginDraft} onChange={event => updateText({ text: event.target.value }, true)} onBlur={() => endDraft(true)} onKeyDown={draftKeys} className={cn(fieldClass, 'mt-1 resize-y')} />
      </label>
      <p className="text-[10px] text-text-muted">输入即预览 · 失焦提交一次撤销 · Esc 放弃 · {Array.from(text.text).length}/500</p>
      <fieldset className="space-y-2 rounded border border-border p-2">
        <legend className="px-1 text-[11px] text-text-secondary">文字显示范围</legend>
        <div className="grid grid-cols-2 gap-2">
          <CommitNumberField {...numbers} context={boxContext} label="文字框宽度" accessibleLabel="文字框宽度" value={text.boxWidth ?? Math.ceil(entry.width)} unit="px" step={1} onCommit={value => updateTextBox({ boxWidth: Math.round(value) })} />
          <CommitNumberField {...numbers} context={boxContext} label="文字框高度" accessibleLabel="文字框高度" value={text.boxHeight ?? Math.ceil(entry.height)} unit="px" step={1} onCommit={value => updateTextBox({ boxHeight: Math.round(value) })} />
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          <button type="button" disabled={!editable} onClick={() => updateTextBox({ boxWidth: (currentText().boxWidth ?? Math.ceil(entry.width)) + 100 })} className="text-accent disabled:opacity-40">加宽 100 px</button>
          <button type="button" disabled={!editable || text.boxWidth === undefined} onClick={resetTextBox} className="text-text-muted hover:text-accent disabled:opacity-40">恢复原尺寸</button>
        </div>
        <p className="text-[10px] leading-relaxed text-text-muted">加宽可容纳更多文字，不拉伸底图；范围会写入导出的 SVGA。单边 1–8192 px，合成区域最多 4,194,304 像素。</p>
        {text.referenceWidth !== undefined && <p aria-label="文字参考尺寸" className="text-[10px] text-text-muted">源参考：{text.referenceWidth} × {text.referenceHeight} px · 保留逐帧动画比例</p>}
        {textError && <p role="alert" className="text-[11px] leading-relaxed text-error">{textError}</p>}
      </fieldset>
      <label className="block text-[11px] text-text-secondary">SVGA 文字导出
        <select aria-label="SVGA文字导出模式" disabled={!editable} value={text.exportMode ?? 'preview'} onChange={event => {
          if (event.target.value === 'bake') updateTextBox({ exportMode: 'bake' })
          else updateText({ exportMode: 'preview' })
        }} className={cn(fieldClass, 'mt-1')}>
          <option value="preview">仅模拟文字（范围仍生效）</option>
          <option value="bake">写入 SVGA（固定字形）</option>
        </select>
      </label>
      <p className="text-[10px] leading-relaxed text-text-muted">{text.exportMode === 'bake'
        ? '导出的文字会成为图片字形，不能再作为动态文本修改；保存 .svgaproj 工程后仍可继续改字。接入端请勿再次叠加相同文字。'
        : '导出的 SVGA 不包含模拟文字，仅保留扩展后的透明显示范围；需要文字也显示在导出文件中，请选择“写入 SVGA”。'}</p>
      <div className="grid grid-cols-2 gap-2">
        <CommitNumberField {...numbers} label="字号" accessibleLabel="模拟文字字号" value={text.fontSize} unit="px" min={1} max={512} onCommit={value => updateText({ fontSize: value })} />
        <label className="text-[11px] text-text-secondary">颜色<input aria-label="模拟文字颜色" type="color" value={/^#[0-9a-f]{6}$/i.test(text.color) ? text.color : '#ffffff'} disabled={!editable} onFocus={beginDraft} onChange={event => updateText({ color: event.target.value }, true)} onBlur={() => endDraft(true)} className="mt-1 h-8 w-full rounded border border-border bg-bg-primary" /></label>
      </div>
      <label className="block text-[11px] text-text-secondary">本机字体
        <select aria-label="模拟文字字体" value={text.fontFamily} disabled={!editable} onChange={event => updateText({ fontFamily: event.target.value })} className={cn(fieldClass, 'mt-1')}>
          {[...fontFamilies, ...(!fontFamilies.includes(text.fontFamily) ? [text.fontFamily] : [])].map(family => <option key={family} value={family}>{family}</option>)}
        </select>
      </label>
      <div className="flex items-center gap-2 text-[11px] text-text-secondary">
        <label className="flex items-center gap-1"><input type="checkbox" aria-label="模拟文字粗体" disabled={!editable} checked={text.fontWeight === 'bold'} onChange={event => updateText({ fontWeight: event.target.checked ? 'bold' : 'normal' })} className="accent-accent" />粗体</label>
        <select aria-label="模拟文字对齐" disabled={!editable} value={text.textAlign} onChange={event => updateText({ textAlign: event.target.value as SlotTextConfig['textAlign'] })} className={cn(fieldClass, 'ml-auto !w-auto')}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <CommitNumberField {...numbers} label="水平偏移" accessibleLabel="模拟文字水平偏移" value={text.offsetX || 0} unit="px" min={-8192} max={8192} onCommit={value => updateText({ offsetX: value })} />
        <CommitNumberField {...numbers} label="垂直偏移" accessibleLabel="模拟文字垂直偏移" value={text.offsetY || 0} unit="px" min={-8192} max={8192} onCommit={value => updateText({ offsetY: value })} />
      </div>
      <CommitNumberField {...numbers} label="多行行距" accessibleLabel="模拟文字行距" value={text.lineHeight || 1.2} unit="倍" min={0.5} max={4} onCommit={value => updateText({ lineHeight: value })} />
      <label className="flex items-center gap-1 text-[11px] text-text-secondary"><input type="checkbox" aria-label="仅显示文字" disabled={!editable} checked={!!text.replaceImage} onChange={event => updateText({ replaceImage: event.target.checked })} className="accent-accent" />仅显示文字，隐藏此 Key 的底图</label>
      {!visibleNow && hasTextPreview(config) && <p className="text-[11px] text-warning">当前帧没有可见的引用图层，请播放或切换到显示该图层的帧。</p>}
      <p className="text-[10px] text-text-muted">超出文字框的文字会裁切；原遮罩、裁切路径和画布边界仍会限制显示。字体未安装时使用系统后备字体。</p>
      <button type="button" disabled={!entry.textConfigured || imageBusy} onClick={() => removePart('text')} className="text-[11px] text-text-muted hover:text-accent disabled:opacity-40">清除文字模拟（保留图片替换）</button>
    </div> : <div className="space-y-2">
      <p className="text-[11px] text-text-muted">作用于此 Key 的全部引用图层，不清除文字模拟。先按目标尺寸拟合为静态 PNG，上传后立即应用；可撤销。</p>
      <select aria-label="插槽图片适配模式" value={fitMode} disabled={imageBusy} onChange={event => setFitMode(event.target.value as ImageFitMode)} className={fieldClass}><option value="fit">等比适应</option><option value="fill">居中裁切</option><option value="stretch">拉伸</option></select>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={event => void uploadImage(event)} />
      {imageUrl && <img src={imageUrl} alt="当前插槽替换图" className="h-24 w-full rounded bg-bg-primary object-contain" />}
      <Button size="sm" disabled={!entry.canSimulateText || imageBusy} onClick={() => inputRef.current?.click()}>{imageBusy ? '正在处理…' : imageUrl ? '更换插槽图片…' : '选择插槽图片…'}</Button>
      {imageUrl && <button type="button" disabled={imageBusy} onClick={() => removePart('image')} className="block text-[11px] text-text-muted hover:text-accent">恢复原图（保留文字模拟）</button>}
    </div>}
    {notice && <p role="status" className="text-[11px] leading-relaxed text-text-secondary">{notice}</p>}
  </section>
}
