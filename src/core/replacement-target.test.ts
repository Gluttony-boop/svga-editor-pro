import { describe, expect, it } from 'vitest'
import { useEditorStore } from '@/stores'
import { captureReplacementTarget, isReplacementTargetCurrent } from './replacement-target'

describe('replacement target identity', () => {
  const resource = { key: 'badge', data: new Uint8Array([1]), width: 100, height: 100, mimeType: 'image/png' as const }
  const state = { ...useEditorStore.getState(), imageResources: new Map([['badge', resource]]) }
  const target = captureReplacementTarget(state, 'badge')
  it('allows unrelated resource changes', () => {
    expect(isReplacementTargetCurrent(target, { ...state, imageResources: new Map([...state.imageResources, ['other', { ...resource, key: 'other' }]]) })).toBe(true)
  })
  it('rejects deleting or replacing the original resource and switching documents', () => {
    expect(isReplacementTargetCurrent(target, { ...state, imageResources: new Map() })).toBe(false)
    expect(isReplacementTargetCurrent(target, { ...state, imageResources: new Map([['badge', { ...resource }]]) })).toBe(false)
    expect(isReplacementTargetCurrent(target, { ...state, originalBuffer: new ArrayBuffer(1) })).toBe(false)
  })
  it('rejects an intervening change to the same slot', () => {
    expect(isReplacementTargetCurrent(target, { ...state, slotConfigs: { badge: { type: 'image', name: 'badge', value: 'data:image/png;base64,new' } } })).toBe(false)
  })
  it('does not validate a key with no resource', () => {
    expect(isReplacementTargetCurrent(captureReplacementTarget(state, 'missing'), state)).toBe(false)
  })
})
