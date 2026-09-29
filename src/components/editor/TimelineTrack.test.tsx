import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Layer } from '@/types'
import { createAnimationTracks } from '@/core/keyframe-editing'
import { createDefaultTracks } from '@/core/layer-factory'
import { TimelinePropertyTrack } from './TimelineTrack'

describe('时间轴关键帧多选呈现', () => {
  it('同轨多选均显示 aria-pressed，其他层/属性的同名 Key 不混选', () => {
    const animationTracks = createAnimationTracks()
    animationTracks.rotation.keyframes = [
      { id: 'one', frameIndex: 1, value: 20, easing: 'hold' },
      { id: 'two', frameIndex: 10, value: 40, easing: 'linear' },
      { id: 'three', frameIndex: 20, value: 80, easing: 'linear' }
    ]
    const layer: Layer = { id: 'a', name: '头像', type: 'image', visible: true, locked: false, expanded: false, opacity: 1,
      blendMode: 'normal', clip: { startFrame: 0, duration: 30 }, tracks: createDefaultTracks(), animationTracks }
    const html = renderToStaticMarkup(<TimelinePropertyTrack layer={layer} track="rotation" top={28} rowHeight={28} frameWidth={10}
      totalFrames={30} selected start={0} end={29} currentFrame={0} selection={[
        { layerId: 'a', track: 'rotation', keyId: 'one' }, { layerId: 'a', track: 'rotation', keyId: 'two' },
        { layerId: 'a', track: 'position', keyId: 'three' }, { layerId: 'b', track: 'rotation', keyId: 'three' }
      ]} onInsert={vi.fn()} onKeySelect={vi.fn()} onKeyPointerDown={vi.fn()} />)
    expect(html.match(/data-timeline-key="one"[^>]*aria-pressed="true"/)).not.toBeNull()
    expect(html.match(/data-timeline-key="two"[^>]*aria-pressed="true"/)).not.toBeNull()
    expect(html.match(/data-timeline-key="three"[^>]*aria-pressed="false"/)).not.toBeNull()
    expect(html).toContain('Ctrl/Cmd 点选多选')
    expect(html).toContain('Shift 同轨区间')
  })
})
