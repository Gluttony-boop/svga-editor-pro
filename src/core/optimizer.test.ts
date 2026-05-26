import { describe, expect, it } from 'vitest'
import { getPreset, OPTIMIZATION_PRESETS } from './optimizer'

describe('optimization presets', () => {
  it('exposes the default balanced preset', () => {
    const preset = getPreset('balanced')

    expect(preset?.name).toBe('均衡优化')
    expect(preset?.config.enabled).toBe(true)
    expect(preset?.config.image.format).toBe('webp')
  })

  it('keeps preset ids unique', () => {
    const ids = OPTIMIZATION_PRESETS.map((preset) => preset.id)

    expect(new Set(ids).size).toBe(ids.length)
  })
})
