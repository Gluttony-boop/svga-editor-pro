import { describe, expect, it, vi } from 'vitest'
import { LicenseClient, type LicenseStorage, type StoredLicense } from './license-client'
import type { LeaseClaims } from './license-policy'

const claims = (nonce: string, patch: Partial<LeaseClaims> = {}): LeaseClaims => ({
  iss: 'issuer', aud: 'audience', sub: '00000000-0000-4000-8000-000000000001', verifiedKid: 'current', verifiedAlg: 'EdDSA', iat: 100, nbf: 100, exp: 1000, licenseExpiresAt: 2000,
  deviceHash: 'a'.repeat(64), nonce, plan: 'pro', ...patch
})
function setup() {
  let stored: StoredLicense | null = null
  const storage: LicenseStorage = { read: vi.fn(async () => stored), write: vi.fn(async value => { stored = structuredClone(value) }), clear: vi.fn(async () => { stored = null }) }
  let nonce = 0
  const licenseId = '00000000-0000-4000-8000-000000000001'
  const transport = { activate: vi.fn(async ({ nonce: requestNonce }: { nonce: string }) => ({ licenseId, lease: `lease-${requestNonce}`, refreshToken: 'refresh' })), refresh: vi.fn(async ({ nonce: requestNonce }: { nonce: string }) => ({ licenseId, lease: `lease-${requestNonce}` })) }
  const verifier = { verify: vi.fn(async (_token: string, expectation: { nonce: string }, now?: number) => {
    const trustedNow = now ?? 100
    return claims(expectation.nonce, { sub: licenseId, iat: trustedNow, nbf: trustedNow, exp: trustedNow + 600, licenseExpiresAt: 2000 })
  }) }
  const client = new LicenseClient({ storage, transport, verifier, deviceId: 'install', deviceHash: 'a'.repeat(64), issuer: 'issuer', audience: 'audience', knownKids: ['current'], nowUtc: () => 300, nonce: () => `${'a'.repeat(31)}${(++nonce).toString(16)}` })
  return { client, storage, transport, verifier, getStored: () => stored, setStored: (value: StoredLicense | null) => { stored = value } }
}

describe('原生授权客户端编排层', () => {
  it('激活码只传给transport，不进入安全存储快照', async () => {
    const h = setup(); const result = await h.client.activate(' SVPABC ')
    expect(result.advancedEnabled).toBe(true)
    expect(h.transport.activate).toHaveBeenCalledWith(expect.objectContaining({ code: 'SVPABC', deviceId: 'install' }))
    expect(JSON.stringify(h.getStored())).not.toContain('SVPABC')
    expect(JSON.stringify(h.client.getSnapshot())).not.toContain('refresh')
    expect(JSON.stringify(h.client.getSnapshot())).not.toContain('lease-')
  })

  it('刷新请求单飞，两个调用共享一次网络请求和一次写入', async () => {
    const h = setup(); await h.client.activate('SVPABC')
    let release!: () => void
    h.transport.refresh.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ licenseId: '00000000-0000-4000-8000-000000000001', lease: 'lease-refresh' }) }))
    const first = h.client.refresh(), second = h.client.refresh()
    await vi.waitFor(() => expect(h.transport.refresh).toHaveBeenCalledOnce()); release()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it('清除期间返回的旧刷新不能复活凭据', async () => {
    const h = setup(); await h.client.activate('SVPABC')
    let release!: () => void
    h.transport.refresh.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ licenseId: '00000000-0000-4000-8000-000000000001', lease: 'lease-old' }) }))
    const task = h.client.refresh(); await vi.waitFor(() => expect(h.transport.refresh).toHaveBeenCalledOnce()); await h.client.clearCredentials(); release()
    await expect(task).rejects.toThrow('取消')
    expect(h.getStored()).toBeNull()
  })

  it('刷新不能延长绝对授权期限或替换其他授权编号', async () => {
    const h = setup(); await h.client.activate('SVPABC')
    h.verifier.verify.mockResolvedValueOnce(claims(`${'a'.repeat(31)}2`, { sub: '00000000-0000-4000-8000-000000000001', licenseExpiresAt: 3000 }))
    await expect(h.client.refresh()).rejects.toThrow('延长')
    h.verifier.verify.mockResolvedValueOnce(claims(`${'a'.repeat(31)}3`, { sub: '00000000-0000-4000-8000-000000000001', licenseExpiresAt: 2000 }))
    h.transport.refresh.mockResolvedValueOnce({ licenseId: 'other', lease: 'lease-other' })
    await expect(h.client.refresh()).rejects.toThrow('授权编号')
  })

  it('安全存储写入失败不会把激活报告为成功，也不留下内存凭据', async () => {
    const h = setup(); h.storage.write = vi.fn(async () => { throw new Error('secure storage unavailable') })
    await expect(h.client.activate('SVPABC')).rejects.toThrow('secure storage')
    expect(h.client.getSnapshot()).toBeNull()
  })

  it('加载缓存时重新验签，拒绝把可篡改claims直接用于权益', async () => {
    const h = setup()
    h.setStored({ schemaVersion: 1, licenseId: '00000000-0000-4000-8000-000000000001', refreshToken: 'secret', leaseToken: 'tampered', claims: claims('b'.repeat(32), { exp: 999999 }), lastTrustedUtc: 100 })
    h.verifier.verify.mockRejectedValueOnce(new Error('bad signature'))
    await expect(h.client.load()).resolves.toMatchObject({ state: 'signature-invalid', advancedEnabled: false })
    expect(h.client.getSnapshot()).toBeNull()
  })

  it('清除发生在不可取消写入期间时会补偿清理迟到凭据', async () => {
    const h = setup()
    let release!: () => void
    h.storage.write = vi.fn(value => new Promise<void>(resolve => {
      release = () => { h.setStored(structuredClone(value)); resolve() }
    }))
    const task = h.client.activate('SVPABC')
    await vi.waitFor(() => expect(h.storage.write).toHaveBeenCalledOnce())
    await h.client.clearCredentials()
    release()
    await expect(task).rejects.toThrow('取消')
    expect(h.getStored()).toBeNull()
  })
})
