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

const MAX_LEASE_SECONDS = 3_600
const MAX_LICENSE_SECONDS = 366 * 86_400
const CANCELLATION_ERROR = '授权操作已取消。'
const VERIFIED_CLAIM_FIELDS = ['iss', 'aud', 'sub', 'iat', 'nbf', 'exp', 'licenseExpiresAt', 'deviceHash', 'nonce', 'plan', 'verifiedAlg', 'verifiedKid'].sort()

function defaultNonce(): string {
  const bytes = new Uint8Array(16)
  if (!globalThis.crypto?.getRandomValues) throw new Error('当前环境无法生成授权请求随机数。')
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function assertRequestText(value: string, name: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name}无效。`)
}

function isUuidLike(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function assertNonce(value: string): void {
  if (!/^[a-f0-9]{32,128}$/.test(value)) throw new Error('请求随机数无效。')
}

function assertLicenseId(value: unknown): asserts value is string {
  if (!isUuidLike(value)) throw new Error('授权服务返回的许可编号无效。')
}

function assertLeaseToken(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16 * 1024 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('授权服务返回的凭据格式无效。')
}

function assertRefreshToken(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('授权服务返回的刷新凭据格式无效。')
}

function assertVerifiedClaims(claims: LeaseClaims, expectation: LicenseExpectation): void {
  if (!claims || typeof claims !== 'object') throw new Error('授权验签结果字段无效。')
  const actualKeys = Object.keys(claims).sort()
  if (actualKeys.length !== VERIFIED_CLAIM_FIELDS.length || actualKeys.some((key, index) => key !== VERIFIED_CLAIM_FIELDS[index])) throw new Error('授权验签结果字段无效。')
  if (claims.iss !== expectation.issuer || claims.aud !== expectation.audience || claims.deviceHash !== expectation.deviceHash || claims.nonce !== expectation.nonce || claims.plan !== 'pro') throw new Error('授权验签结果身份无效。')
  if (!isUuidLike(claims.sub) || claims.verifiedAlg !== 'EdDSA' || !expectation.knownKids.includes(claims.verifiedKid)) throw new Error('授权验签结果身份无效。')
  if (![claims.iat, claims.nbf, claims.exp, claims.licenseExpiresAt].every(value => Number.isSafeInteger(value) && value >= 0) || claims.nbf !== claims.iat || claims.exp <= claims.iat || claims.exp > claims.licenseExpiresAt || claims.exp - claims.iat > MAX_LEASE_SECONDS || claims.licenseExpiresAt - claims.iat > MAX_LICENSE_SECONDS) throw new Error('授权验签结果期限无效。')
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
  /** 所有安全存储 mutation 共用一个尾指针，保证 clear 不会与迟到 write 竞态。 */
  private storageTail: Promise<void> = Promise.resolve()

  constructor(options: LicenseClientOptions) {
    this.options = options
    assertRequestText(options.deviceId, '设备标识')
    assertRequestText(options.deviceHash, '设备摘要')
  }

  async load(): Promise<LicenseEvaluation> {
    // 加载也是状态变更：慢速缓存复验必须排在激活/刷新之前，不能反向覆盖新凭据。
    return this.withOperation(() => this.loadInternal())
  }

  private async loadInternal(): Promise<LicenseEvaluation> {
    if (!this.loaded) {
      const generation = this.generation
      const candidate = await this.options.storage.read()
      if (generation !== this.generation) return this.evaluate(false)
      this.loaded = true
      if (candidate) {
        try {
          const now = this.now()
          const expectation = this.expectation(candidate.claims.nonce)
          const claims = await this.options.verifier.verify(candidate.leaseToken, expectation, now)
          assertVerifiedClaims(claims, expectation)
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
    // 立即取消运行中和已排队的旧意图；清除不等待慢速网络，但新意图必须等清除落盘。
    this.generation++
    this.stored = null
    this.loaded = true
    this.loadError = null
    this.refreshInFlight = null
    // 让清除后的新意图无需等待已经取消、但可能卡在网络中的旧操作；代际检查会阻止旧操作写回。
    this.operationTail = Promise.resolve()
    // 清除本身也进入存储队列；若旧网络请求已经开始写入，clear 必须排在该写入之后完成。
    await this.enqueueStorage(() => this.options.storage.clear())
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
    if (generation !== this.generation) throw new Error(CANCELLATION_ERROR)
    assertLicenseId(response.licenseId)
    assertLeaseToken(response.lease)
    assertRefreshToken(response.refreshToken)
    const claims = await this.options.verifier.verify(response.lease, this.expectation(nonce))
    if (generation !== this.generation) throw new Error(CANCELLATION_ERROR)
    const expectation = this.expectation(nonce)
    assertVerifiedClaims(claims, expectation)
    if (claims.sub !== response.licenseId) throw new Error('授权服务返回的授权身份或期限无效。')
    const next: StoredLicense = { schemaVersion: 1, licenseId: response.licenseId, refreshToken: response.refreshToken, leaseToken: response.lease, claims, lastTrustedUtc: claims.iat }
    await this.persistIfCurrent(next, generation)
    this.loadError = null
    this.stored = next
    this.loaded = true
    return this.evaluate(true)
  }

  private async refreshInternal(): Promise<LicenseEvaluation> {
    if (!this.loaded) await this.loadInternal()
    const current = this.stored
    if (!current) throw new Error(this.loadError ?? '尚未激活授权。')
    const generation = this.generation
    const nonce = (this.options.nonce ?? defaultNonce)()
    assertNonce(nonce)
    const response = await this.options.transport.refresh({ licenseId: current.licenseId, deviceId: this.options.deviceId, refreshToken: current.refreshToken, nonce })
    if (generation !== this.generation) throw new Error(CANCELLATION_ERROR)
    assertLicenseId(response.licenseId)
    assertLeaseToken(response.lease)
    if (response.refreshToken !== undefined) assertRefreshToken(response.refreshToken)
    if (response.licenseId !== current.licenseId) throw new Error('刷新响应的授权编号不匹配。')
    const claims = await this.options.verifier.verify(response.lease, this.expectation(nonce))
    if (generation !== this.generation) throw new Error(CANCELLATION_ERROR)
    assertVerifiedClaims(claims, this.expectation(nonce))
    if (claims.sub !== current.licenseId || claims.licenseExpiresAt !== current.claims.licenseExpiresAt) throw new Error('刷新响应延长或改变了绝对授权期限。')
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
    if (generation !== this.generation) throw new Error(CANCELLATION_ERROR)
    // clearCredentials 会在同一队列中排到这次 write 后面；因此写完后发现代际过期时无需再启动一个无序补偿 clear。
    await this.enqueueStorage(() => this.options.storage.write(next))
    if (generation !== this.generation) throw new Error(CANCELLATION_ERROR)
  }

  private enqueueStorage<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.storageTail
    const task = previous.catch(() => {}).then(operation)
    this.storageTail = task.then(() => undefined, () => undefined)
    return task
  }

  private async withOperation<T>(operation: () => Promise<T>): Promise<T> {
    // generation 代表调用时的用户意图，不能在排队结束后重新捕获，否则退出前的激活会复活。
    const generation = this.generation
    const previous = this.operationTail
    let release!: () => void
    this.operationTail = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      if (generation !== this.generation) throw new Error('授权操作已取消。')
      return await operation()
    } finally {
      release()
    }
  }
}
