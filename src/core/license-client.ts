import { evaluateLicense, type LeaseClaims, type LicenseEvaluation, type LicenseExpectation } from './license-policy'

export interface StoredLicense {
  schemaVersion: 1
  licenseId: string
  refreshToken: string
  leaseToken: string
  claims: LeaseClaims
  /** 只保存验签 token 的 iat；不会把响应中的未签名时间当作可信时间。 */
  lastTrustedUtc: number
}

export interface LicenseStorage {
  read(): Promise<StoredLicense | null>
  write(value: StoredLicense): Promise<void>
  clear(): Promise<void>
}

export interface LicenseTransport {
  activate(request: { code: string; deviceId: string; nonce: string }): Promise<{ licenseId: string; lease: string; refreshToken: string }>
  refresh(request: { licenseId: string; deviceId: string; refreshToken: string; nonce: string }): Promise<{ licenseId: string; lease: string; refreshToken?: string }>
}

export interface LeaseVerifier {
  /** 在线响应由 nonce 绑定并从签名 iat 建立时间锚；仅离线缓存复验传入本机 UTC。 */
  verify(token: string, expectation: LicenseExpectation, nowUtc?: number): Promise<LeaseClaims>
}

export interface LicenseClientOptions {
  storage: LicenseStorage
  transport: LicenseTransport
  verifier: LeaseVerifier
  deviceId: string
  deviceHash: string
  issuer: string
  audience: string
  knownKids: readonly string[]
  nowUtc?: () => number
  nonce?: () => string
}

export interface StoredLicenseMetadata {
  schemaVersion: 1
  licenseId: string
  claims: LeaseClaims
  lastTrustedUtc: number
}

function defaultNonce(): string {
  const bytes = new Uint8Array(16)
  if (!globalThis.crypto?.getRandomValues) throw new Error('当前环境无法生成授权请求随机数。')
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function assertRequestText(value: string, name: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name}无效。`)
}

function assertNonce(value: string): void {
  if (!/^[a-f0-9]{32,128}$/.test(value)) throw new Error('请求随机数无效。')
}

/**
 * 不持有激活码，不实现密码学；长期状态只经由调用方提供的安全存储读写。
 * transport/verifier 预期由 Tauri Rust 层实现，网页端不要传入真实服务实现。
 */
export class LicenseClient {
  private readonly options: LicenseClientOptions
  private stored: StoredLicense | null = null
  private loaded = false
  private loadError: string | null = null
  private generation = 0
  private refreshInFlight: Promise<LicenseEvaluation> | null = null
  private operationTail: Promise<void> = Promise.resolve()

  constructor(options: LicenseClientOptions) {
    this.options = options
    assertRequestText(options.deviceId, '设备标识')
    assertRequestText(options.deviceHash, '设备摘要')
  }

  async load(): Promise<LicenseEvaluation> {
    if (!this.loaded) {
      const generation = this.generation
      const candidate = await this.options.storage.read()
      if (generation !== this.generation) return this.evaluate(false)
      this.loaded = true
      if (candidate) {
        try {
          const now = this.now()
          const claims = await this.options.verifier.verify(candidate.leaseToken, this.expectation(candidate.claims.nonce), now)
          if (generation !== this.generation || claims.sub !== candidate.licenseId || claims.licenseExpiresAt !== candidate.claims.licenseExpiresAt) throw new Error('授权状态身份不匹配。')
          this.stored = { ...candidate, claims, lastTrustedUtc: claims.iat }
        } catch {
          // 不把未验签的缓存 claims 送入权益计算；只保留粗粒度错误状态。
          if (generation === this.generation) {
            this.loadError = '本机授权凭据验签失败。'
            this.stored = null
          }
        }
      }
    }
    return this.evaluate(false)
  }

  evaluate(networkAvailable: boolean, revoked = false): LicenseEvaluation {
    if (this.loadError) return { state: 'signature-invalid', reason: this.loadError, expiresAt: null, licenseExpiresAt: null, advancedEnabled: false, actions: { openProject: true, saveProject: true, exportExisting: true } }
    const claims = this.stored?.claims
    const expected = claims ? this.expectation(claims.nonce) : undefined
    return evaluateLicense({ nowUtc: this.now(), lastTrustedUtc: this.stored?.lastTrustedUtc, claims, expected, networkAvailable, revoked })
  }

  async activate(code: string): Promise<LicenseEvaluation> {
    assertRequestText(code, '激活码')
    return this.withOperation(() => this.activateInternal(code.trim()))
  }

  async refresh(): Promise<LicenseEvaluation> {
    if (this.refreshInFlight) return this.refreshInFlight
    const task = this.withOperation(() => this.refreshInternal())
    this.refreshInFlight = task
    try {
      return await task
    } finally {
      if (this.refreshInFlight === task) this.refreshInFlight = null
    }
  }

  async clearCredentials(): Promise<void> {
    // 先使已经在网络中的操作失效，再排到同一写入队列之后清空；这样清除不会被迟到的 write 复活。
    this.generation++
    this.stored = null
    this.loaded = true
    this.loadError = null
    await this.options.storage.clear()
  }

  /** 调试/界面只得到脱敏元数据；token 和 refreshToken 不会通过此接口暴露。 */
  getSnapshot(): StoredLicenseMetadata | null {
    if (!this.stored) return null
    const { schemaVersion, licenseId, claims, lastTrustedUtc } = this.stored
    return { schemaVersion, licenseId, claims: structuredClone(claims), lastTrustedUtc }
  }

  private async activateInternal(code: string): Promise<LicenseEvaluation> {
    const generation = this.generation
    const nonce = (this.options.nonce ?? defaultNonce)()
    assertNonce(nonce)
    const response = await this.options.transport.activate({ code, deviceId: this.options.deviceId, nonce })
    if (generation !== this.generation) throw new Error('授权操作已取消。')
    const claims = await this.options.verifier.verify(response.lease, this.expectation(nonce))
    if (generation !== this.generation) throw new Error('授权操作已取消。')
    if (claims.nonce !== nonce || claims.deviceHash !== this.options.deviceHash || claims.sub !== response.licenseId || claims.exp > claims.licenseExpiresAt) throw new Error('授权服务返回的授权身份或期限无效。')
    const next: StoredLicense = { schemaVersion: 1, licenseId: response.licenseId, refreshToken: response.refreshToken, leaseToken: response.lease, claims, lastTrustedUtc: claims.iat }
    await this.persistIfCurrent(next, generation)
    this.loadError = null
    this.stored = next
    this.loaded = true
    return this.evaluate(true)
  }

  private async refreshInternal(): Promise<LicenseEvaluation> {
    if (!this.loaded) await this.load()
    const current = this.stored
    if (!current) throw new Error(this.loadError ?? '尚未激活授权。')
    const generation = this.generation
    const nonce = (this.options.nonce ?? defaultNonce)()
    assertNonce(nonce)
    const response = await this.options.transport.refresh({ licenseId: current.licenseId, deviceId: this.options.deviceId, refreshToken: current.refreshToken, nonce })
    if (generation !== this.generation) throw new Error('授权操作已取消。')
    if (response.licenseId !== current.licenseId) throw new Error('刷新响应的授权编号不匹配。')
    const claims = await this.options.verifier.verify(response.lease, this.expectation(nonce))
    if (generation !== this.generation) throw new Error('授权操作已取消。')
    if (claims.nonce !== nonce || claims.deviceHash !== this.options.deviceHash || claims.sub !== current.licenseId || claims.licenseExpiresAt !== current.claims.licenseExpiresAt || claims.exp > claims.licenseExpiresAt) throw new Error('刷新响应延长或改变了绝对授权期限。')
    const next: StoredLicense = { ...current, leaseToken: response.lease, refreshToken: response.refreshToken ?? current.refreshToken, claims, lastTrustedUtc: claims.iat }
    await this.persistIfCurrent(next, generation)
    this.stored = next
    return this.evaluate(true)
  }

  private expectation(nonce: string): LicenseExpectation {
    return { issuer: this.options.issuer, audience: this.options.audience, deviceHash: this.options.deviceHash, nonce, knownKids: this.options.knownKids }
  }

  private now(): number {
    return (this.options.nowUtc ?? (() => Math.floor(Date.now() / 1000)))()
  }

  private async persistIfCurrent(next: StoredLicense, generation: number): Promise<void> {
    if (generation !== this.generation) throw new Error('授权操作已取消。')
    await this.options.storage.write(next)
    if (generation !== this.generation) {
      // 清除可能在不可取消的底层写入期间发生；补偿清理保证迟到写入不会永久复活凭据。
      await this.options.storage.clear()
      throw new Error('授权操作已取消。')
    }
  }

  private async withOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail
    let release!: () => void
    this.operationTail = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}
