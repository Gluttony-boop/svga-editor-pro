import React from 'react'
import { CommitNumberField } from '@/components/ui/CommitNumberField'
import { useEditorStore } from '@/stores'
import { EDITABLE_TRACKS, TRACK_LABELS, getKeyframeEditError, sampleAnimationValues, type AnimationValues } from '@/core/keyframe-editing'
import { getLayerSourceFrame, getLayerTimeOffset } from '@/core/layer-time'
import type { EasingType, Layer, LayerTracks } from '@/types'

const easingOptions: Array<[EasingType, string]> = [
  ['linear', '线性'], ['easeIn', '缓入'], ['easeOut', '缓出'], ['easeInOut', '缓入缓出'], ['hold', '保持']
]

/** 当前帧属性始终采样同一套导出轨道；输入和画布手柄都写入这四种属性。 */
export function AnimationKeyframeInspector({ layer }: { layer: Layer }) {
  const frame = useEditorStore(state => state.playback.currentFrame)
  const totalFrames = useEditorStore(state => state.playback.totalFrames)
  const videoItem = useEditorStore(state => state.videoItem)
  const keepRatio = useEditorStore(state => state.canvasKeepRatio)
  const [error, setError] = React.useState<string | null>(null)
  const values = sampleAnimationValues(layer, frame)
  const sourceFrame = getLayerSourceFrame(layer, frame)
  const offset = getLayerTimeOffset(layer)
  const editError = getKeyframeEditError(layer, frame, totalFrames)
  const context = React.useMemo(() => ({ videoItem, layerId: layer.id, frame }), [videoItem, layer.id, frame])
  React.useEffect(() => setError(null), [context])

  const report = (result: { error?: string }) => setError(result.error || null)
  const recordCurrent = (track?: keyof LayerTracks) => {
    // 播放器节流同步状态；先暂停，再以最后实际显示帧决定插入或删除。
    useEditorStore.getState().setPlaying(false)
    const state = useEditorStore.getState()
    if (state.videoItem !== videoItem || state.selectedLayerId !== layer.id) return
    const currentLayer = state.layers.find(item => item.id === layer.id)
    if (!currentLayer) return
    const currentSource = getLayerSourceFrame(currentLayer, state.playback.currentFrame)
    const key = track ? currentLayer.animationTracks?.[track].keyframes.find(item => item.frameIndex === currentSource) : undefined
    report(track && key
      ? state.deleteAnimationKeyframes(layer.id, track, [key.id])
      : state.insertAnimationKeyframes([layer.id], track ? [track] : [...EDITABLE_TRACKS]))
  }
  const commit = <K extends keyof LayerTracks>(track: K, value: AnimationValues[K]) => {
    const state = useEditorStore.getState()
    if (state.selectedLayerId !== layer.id || state.videoItem !== videoItem || state.playback.currentFrame !== frame) return
    report(state.setAnimationValue(layer.id, track, value, frame))
  }
  const seek = (target: number) => {
    const state = useEditorStore.getState()
    state.setPlaying(false)
    state.setCurrentFrame(target)
  }
  const defaults = {
    disabled: !!editError, context,
    onStart: () => useEditorStore.getState().setPlaying(false)
  }
  const commitScale = (axis: 'scaleX' | 'scaleY', percent: number) => {
    const other = axis === 'scaleX' ? 'scaleY' : 'scaleX'
    const scale = { ...values.scale, [axis]: percent / 100 }
    if (keepRatio) scale[other] = values.scale[axis] === 0 ? percent / 100 : values.scale[other] * percent / 100 / values.scale[axis]
    commit('scale', scale)
  }

  const controls = (track: keyof LayerTracks) => {
    const keys = layer.animationTracks?.[track].keyframes || []
    const key = keys.find(item => item.frameIndex === sourceFrame)
    const ordered = [...keys].sort((a, b) => a.frameIndex - b.frameIndex)
    const previous = ordered.filter(item => item.frameIndex + offset < frame && item.frameIndex + offset >= 0).at(-1)
    const next = ordered.find(item => item.frameIndex + offset > frame && item.frameIndex + offset < totalFrames)
    return <div className="mb-2 flex items-center gap-1.5">
      <span className="mr-auto text-xs text-text-secondary">{TRACK_LABELS[track]} <span className="text-[10px] text-text-muted">{keys.length} ◆</span></span>
      <button type="button" aria-label={`上一个${TRACK_LABELS[track]}关键帧`} disabled={!previous} onClick={() => previous && seek(previous.frameIndex + offset)} className="rounded px-1.5 text-text-muted hover:text-accent disabled:opacity-30">‹</button>
      <button type="button" aria-label={`${key ? '删除' : '插入'}当前帧${TRACK_LABELS[track]}关键帧`} aria-pressed={!!key} disabled={!!editError} title={key ? '删除此属性当前帧的关键帧' : '记录此属性当前帧的数值'}
        onClick={() => recordCurrent(track)}
        className={`rounded px-1.5 disabled:opacity-30 ${key ? 'text-accent' : 'text-text-muted hover:text-accent'}`}>{key ? '◆' : '◇'}</button>
      <button type="button" aria-label={`下一个${TRACK_LABELS[track]}关键帧`} disabled={!next} onClick={() => next && seek(next.frameIndex + offset)} className="rounded px-1.5 text-text-muted hover:text-accent disabled:opacity-30">›</button>
    </div>
  }

  return <section aria-label="当前帧关键帧属性" className="space-y-3 border-y border-border py-3">
    <div className="flex items-center justify-between text-xs">
      <span className="font-medium text-accent">◆ 关键帧编辑</span>
      <span className="font-mono text-text-muted">{frame + 1} / {totalFrames} F</span>
    </div>
    <p className="rounded border border-accent/20 bg-accent/5 px-2 py-1.5 text-[10px] leading-relaxed text-text-secondary">
      修改数值或拖动画布会在当前帧记录关键帧。下列值叠加在原动画与整段调整上，位置为附加偏移，100% 为原比例。
    </p>
    <button type="button" disabled={!!editError} onClick={() => recordCurrent()}
      className="w-full rounded border border-accent/30 bg-accent/10 px-2 py-1.5 text-xs text-accent hover:bg-accent/20 disabled:opacity-40">◆ 记录当前帧全部属性</button>
    <div>
      {controls('position')}
      <div className="grid grid-cols-2 gap-2">
        <CommitNumberField {...defaults} label="位置偏移 X" accessibleLabel="关键帧位置 X" value={values.position.x} unit="px" onCommit={value => commit('position', { ...values.position, x: value })} />
        <CommitNumberField {...defaults} label="位置偏移 Y" accessibleLabel="关键帧位置 Y" value={values.position.y} unit="px" onCommit={value => commit('position', { ...values.position, y: value })} />
      </div>
    </div>
    <div>
      {controls('scale')}
      <label className="mb-2 flex items-center justify-end gap-1 text-[10px] text-text-muted">
        <input type="checkbox" checked={keepRatio} onChange={event => useEditorStore.getState().setCanvasKeepRatio(event.target.checked)} className="accent-accent" />锁定比例
      </label>
      <div className="grid grid-cols-2 gap-2">
        <CommitNumberField {...defaults} label="缩放 X" accessibleLabel="关键帧缩放 X" value={values.scale.scaleX * 100} min={0} max={1000} unit="%" onCommit={value => commitScale('scaleX', value)} />
        <CommitNumberField {...defaults} label="缩放 Y" accessibleLabel="关键帧缩放 Y" value={values.scale.scaleY * 100} min={0} max={1000} unit="%" onCommit={value => commitScale('scaleY', value)} />
      </div>
    </div>
    <div>
      {controls('rotation')}
      <CommitNumberField {...defaults} label="附加旋转" accessibleLabel="关键帧旋转" value={values.rotation} unit="°" onCommit={value => commit('rotation', value)} />
    </div>
    <div>
      {controls('alpha')}
      <CommitNumberField {...defaults} label="不透明度比例" accessibleLabel="关键帧不透明度" value={values.alpha * 100} min={0} max={100} unit="%" onCommit={value => commit('alpha', value / 100)} />
    </div>
    {EDITABLE_TRACKS.some(track => layer.animationTracks?.[track].keyframes.some(key => key.frameIndex === sourceFrame)) && <div className="space-y-1.5 rounded border border-border p-2">
      <p className="text-[10px] text-text-muted">当前关键帧 → 下一个关键帧的缓动</p>
      {EDITABLE_TRACKS.map(track => {
        const key = layer.animationTracks?.[track].keyframes.find(item => item.frameIndex === sourceFrame)
        if (!key) return null
        return <label key={track} className="flex items-center justify-between gap-2 text-[11px] text-text-secondary">
          {TRACK_LABELS[track]}
          <select aria-label={`${TRACK_LABELS[track]}关键帧缓动`} value={key.easing} disabled={!!editError} onChange={event => report(useEditorStore.getState().setAnimationEasing(layer.id, track, [key.id], event.target.value as EasingType))}
            className="rounded border border-border bg-bg-tertiary px-1.5 py-1 text-text-primary">
            {easingOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            {key.easing === 'bezier' && <option value="bezier">已有贝塞尔曲线</option>}
          </select>
        </label>
      })}
    </div>}
    {(error || editError) && <p role="status" className="text-[11px] leading-relaxed text-amber-300">{error || editError}</p>}
    <p className="text-[10px] leading-relaxed text-text-muted">◇ 插入 / ◆ 删除 · ‹ › 跳转关键帧 · 时间轴拖动菱形改时间。仅更改当前选中图层；撤销可还原单次操作。</p>
  </section>
}
