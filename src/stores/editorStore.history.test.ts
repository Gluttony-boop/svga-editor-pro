import { beforeEach, describe, expect, it } from 'vitest'
import { useEditorStore } from './editorStore'
import type { Layer, VideoItem } from '@/types'

const createLayer = (id: string, name = id): Layer => ({
  id,
  name,
  type: 'image',
  visible: true,
  locked: false,
  expanded: true,
  opacity: 1,
  blendMode: 'normal',
  imageKey: `${id}.png`,
  clip: {
    startFrame: 0,
    duration: 24
  },
  tracks: {
    position: {
      keyframes: [],
      currentValue: { x: 0, y: 0 },
      defaultValue: { x: 0, y: 0 }
    },
    scale: {
      keyframes: [],
      currentValue: { scaleX: 1, scaleY: 1 },
      defaultValue: { scaleX: 1, scaleY: 1 }
    },
    rotation: {
      keyframes: [],
      currentValue: 0,
      defaultValue: 0
    },
    alpha: {
      keyframes: [],
      currentValue: 1,
      defaultValue: 1
    }
  }
})

const createVideoItem = (): VideoItem => ({
  movie: {
    version: '2.0',
    params: {
      viewBoxWidth: 100,
      viewBoxHeight: 100,
      fps: 24,
      frames: 24
    },
    images: {},
    sprites: []
  },
  images: {},
  buffers: {}
})

describe('editorStore history', () => {
  beforeEach(() => {
    useEditorStore.getState().reset()
    useEditorStore.setState({
      params: {
        viewBoxWidth: 100,
        viewBoxHeight: 100,
        fps: 24,
        frames: 24
      },
      layers: [createLayer('layer-1')],
      selectedLayerId: 'layer-1',
      isDirty: false
    })
    useEditorStore.getState().clearHistory()
  })

  it('undoes and redoes a layer update', () => {
    const store = useEditorStore.getState()

    store.updateLayer('layer-1', { opacity: 0.4 })

    expect(useEditorStore.getState().layers[0].opacity).toBe(0.4)
    expect(useEditorStore.getState().canUndo).toBe(true)

    useEditorStore.getState().undo()

    expect(useEditorStore.getState().layers[0].opacity).toBe(1)
    expect(useEditorStore.getState().canRedo).toBe(true)

    useEditorStore.getState().redo()

    expect(useEditorStore.getState().layers[0].opacity).toBe(0.4)
  })

  it('restores deleted layers and selection on undo', () => {
    const secondLayer = createLayer('layer-2')
    useEditorStore.setState({
      layers: [createLayer('layer-1'), secondLayer],
      selectedLayerId: 'layer-2'
    })
    useEditorStore.getState().clearHistory()

    useEditorStore.getState().deleteLayer('layer-2')

    expect(useEditorStore.getState().layers.map((layer) => layer.id)).toEqual(['layer-1'])
    expect(useEditorStore.getState().selectedLayerId).toBeNull()

    useEditorStore.getState().undo()

    expect(useEditorStore.getState().layers.map((layer) => layer.id)).toEqual(['layer-1', 'layer-2'])
    expect(useEditorStore.getState().selectedLayerId).toBe('layer-2')
  })

  it('clears redo history after a new edit', () => {
    useEditorStore.getState().updateLayer('layer-1', { opacity: 0.5 })
    useEditorStore.getState().undo()

    expect(useEditorStore.getState().canRedo).toBe(true)

    useEditorStore.getState().updateLayer('layer-1', { opacity: 0.25 })

    expect(useEditorStore.getState().canRedo).toBe(false)
  })

  it('clears history when a new video item is loaded', () => {
    useEditorStore.getState().updateLayer('layer-1', { opacity: 0.5 })

    expect(useEditorStore.getState().canUndo).toBe(true)

    useEditorStore.getState().setVideoItem(createVideoItem())

    expect(useEditorStore.getState().canUndo).toBe(false)
    expect(useEditorStore.getState().canRedo).toBe(false)
  })
})
