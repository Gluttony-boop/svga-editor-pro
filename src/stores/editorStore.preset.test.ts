import { beforeEach, describe, expect, it } from 'vitest'
import { useEditorStore } from './editorStore'
import { getPreset } from '@/core/optimizer'

beforeEach(() => useEditorStore.getState().reset())
describe('export preset selection', () => {
  it('applies the named configuration with one undo step', () => {
    const before = useEditorStore.getState().optimizationConfig
    useEditorStore.getState().setSelectedPresetId('aggressive')
    expect(useEditorStore.getState().selectedPresetId).toBe('aggressive')
    expect(useEditorStore.getState().optimizationConfig).toEqual(getPreset('aggressive')!.config)
    expect(useEditorStore.getState().history.past).toHaveLength(1)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().optimizationConfig).toEqual(before)
  })
  it('editing a disabled preset enables a custom configuration', () => {
    useEditorStore.getState().setSelectedPresetId('none')
    expect(useEditorStore.getState().optimizationConfig.enabled).toBe(false)
    useEditorStore.getState().setOptimizationConfig({image: {...useEditorStore.getState().optimizationConfig.image, pngColors: 128}})
    expect(useEditorStore.getState().optimizationConfig.enabled).toBe(true)
    expect(useEditorStore.getState().selectedPresetId).toBe('custom')
  })
})
