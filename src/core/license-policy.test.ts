import { describe, expect, it } from 'vitest'
import { durationSeconds, evaluateLicense, validateLeaseClaims, type LeaseClaims, type LicenseExpectation } from './license-policy'

const expectation: LicenseExpectation = { issuer: 'issuer', audience: 'audience', deviceHash: 'a'.repeat(64), nonce: 'b'.repeat(32), knownKids: ['current', 'previous'] }
const claims = (patch: Partial<LeaseClaims> = {}): LeaseClaims => ({
  iss: 'issuer', aud: 'audience', sub: '00000000-0000-4000-8000-000000000001', verifiedKid: 'current', verifiedAlg: 'EdDSA', iat: 100, nbf: 100, exp: 1000, licenseExpiresAt: 2000,
  deviceHash: 'a'.repeat(64), nonce: 'b'.repeat(32), plan: 'pro', ...patch
})

describe('授权时间与权益策略', () => {
  it('小时与天使用固定连续秒数，不把自然日混入', () => {
    expect(durationSeconds(1, 'hours')).toBe(3600)
    expect(durationSeconds(7, 'days')).toBe(604800)
    expect(() => durationSeconds(0, 'hours')).toThrow()
    expect(() => durationSeconds(367, 'days')).toThrow()
  })

  it('短期凭据不能越过绝对截止时间，exp边界恰到即失效', () => {
    expect(evaluateLicense({ nowUtc: 999, claims: claims(), expected: expectation, networkAvailable: true }).advancedEnabled).toBe(true)
    expect(evaluateLicense({ nowUtc: 1000, claims: claims(), expected: expectation, networkAvailable: true })).toMatchObject({ state: 'expired', actions: { saveProject: true } })
    expect(validateLeaseClaims(claims({ exp: 3000, licenseExpiresAt: 2000 }), expectation, 100)).toContain('时间范围')
  })

  it('断网只保留仍有效的旧凭据，绝不送出隐藏宽限', () => {
    expect(evaluateLicense({ nowUtc: 500, claims: claims(), expected: expectation, networkAvailable: false })).toMatchObject({ state: 'offline', advancedEnabled: true })
    expect(evaluateLicense({ nowUtc: 2000, claims: claims(), expected: expectation, networkAvailable: false })).toMatchObject({ state: 'expired', actions: { openProject: true, exportExisting: true } })
  })

  it('回拨、吊销、错误设备和错误kid不开放高级能力但保留工程操作', () => {
    expect(evaluateLicense({ nowUtc: 500, lastTrustedUtc: 900, claims: claims(), expected: expectation, networkAvailable: true }).state).toBe('clock-suspect')
    expect(evaluateLicense({ nowUtc: 500, claims: claims(), expected: expectation, networkAvailable: true, revoked: true }).state).toBe('revoked')
    expect(evaluateLicense({ nowUtc: 500, claims: claims({ deviceHash: 'c'.repeat(64) }), expected: expectation, networkAvailable: true })).toMatchObject({ state: 'signature-invalid', actions: { openProject: true } })
    expect(evaluateLicense({ nowUtc: 500, claims: claims({ verifiedKid: 'unknown' }), expected: expectation, networkAvailable: true }).advancedEnabled).toBe(false)
  })

  it('近到期状态可提示刷新，仍不关闭编辑器或删除文件', () => {
    expect(evaluateLicense({ nowUtc: 800, claims: claims(), expected: expectation, networkAvailable: true })).toMatchObject({ state: 'near-expiry', actions: { openProject: true, saveProject: true, exportExisting: true } })
  })

  it('没有原生验签上下文或严格时间关系时不开放高级能力', () => {
    expect(evaluateLicense({ nowUtc: 500, claims: claims(), networkAvailable: true }).state).toBe('signature-invalid')
    expect(evaluateLicense({ nowUtc: 500, claims: claims({ nbf: 101 }), expected: expectation, networkAvailable: true }).advancedEnabled).toBe(false)
    expect(evaluateLicense({ nowUtc: 500, claims: claims({ exp: 4700 }), expected: expectation, networkAvailable: true }).advancedEnabled).toBe(false)
  })
})
