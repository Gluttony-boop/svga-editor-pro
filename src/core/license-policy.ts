/**
 * 桌面授权的纯策略层：这里只计算已由原生层验签的 claims，绝不在浏览器伪造安全边界。
 * 到期或断网不影响打开、保存和迁出已有工程；未来高级能力只能读取 advancedEnabled。
 */
export type LicenseState = 'unlicensed' | 'active' | 'offline' | 'near-expiry' | 'expired' | 'revoked' | 'clock-suspect' | 'signature-invalid' | 'network-error'

/** 与 Worker JWT payload 对齐；算法和 kid 位于受保护 header，不是 payload claim。 */
export interface LeaseClaims {
  iss: string
  aud: string
  sub: string
  iat: number
  nbf: number
  exp: number
  licenseExpiresAt: number
  deviceHash: string
  nonce: string
  plan: string
  /** 原生 verifier 从受保护 header 写入的校验结果，不是 JWT payload 字段。 */
  verifiedAlg: 'EdDSA'
  verifiedKid: string
}

export interface LicenseExpectation {
  issuer: string
  audience: string
  deviceHash: string
  nonce: string
  knownKids: readonly string[]
  skewSeconds?: number
}

export interface LicenseEvaluationInput {
  nowUtc: number
  lastTrustedUtc?: number
  claims?: LeaseClaims | null
  expected?: LicenseExpectation
  networkAvailable: boolean
  revoked?: boolean
}

export interface LicenseEvaluation {
  state: LicenseState
  reason: string
  expiresAt: number | null
  licenseExpiresAt: number | null
  advancedEnabled: boolean
  actions: { openProject: true; saveProject: true; exportExisting: true }
}

export function durationSeconds(value: number, unit: 'hours' | 'days'): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > (unit === 'hours' ? 8784 : 366)) throw new Error('授权时长必须是正整数且不超过 366 天。')
  return value * (unit === 'hours' ? 3600 : 86_400)
}

function isText(value: unknown, maximum = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function isUuidLike(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function isLowerHex(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum && /^[a-f0-9]+$/.test(value)
}

export function validateLeaseClaims(claims: LeaseClaims, expected: LicenseExpectation, nowUtc: number): string | null {
  if (!Number.isSafeInteger(nowUtc) || nowUtc < 0) return '本机时间不可用。'
  if (!claims || typeof claims !== 'object') return '授权字段缺失。'
  if (!isUuidLike(claims.sub) || claims.plan !== 'pro') return '授权身份或计划不匹配。'
  if (!isText(claims.iss) || !isText(claims.aud) || !isLowerHex(claims.deviceHash, 64, 64) || !isLowerHex(claims.nonce, 32, 128)) return '授权文本字段无效。'
  if (claims.verifiedAlg !== 'EdDSA') return '授权算法不受支持。'
  if (!isText(claims.verifiedKid, 48) || !expected.knownKids.includes(claims.verifiedKid)) return '授权签名版本不受信任。'
  if (claims.iss !== expected.issuer || claims.aud !== expected.audience) return '授权来源或受众不匹配。'
  if (claims.deviceHash !== expected.deviceHash || claims.nonce !== expected.nonce) return '授权设备或请求随机数不匹配。'
  const integers = [claims.iat, claims.nbf, claims.exp, claims.licenseExpiresAt]
  if (integers.some(value => !Number.isSafeInteger(value) || value < 0)) return '授权时间字段必须是非负整数秒。'
  if (claims.nbf !== claims.iat || claims.exp <= claims.iat || claims.exp > claims.licenseExpiresAt || claims.exp - claims.iat > 3_600) return '授权时间范围无效。'
  const skew = expected.skewSeconds ?? 60
  if (!Number.isSafeInteger(skew) || skew < 0 || skew > 300) return '授权时间容差无效。'
  if (claims.iat > nowUtc + skew) return '授权尚未生效。'
  return null
}

export function evaluateLicense(input: LicenseEvaluationInput): LicenseEvaluation {
  const actions = { openProject: true as const, saveProject: true as const, exportExisting: true as const }
  const none = (state: LicenseState, reason: string, claims?: LeaseClaims): LicenseEvaluation => ({
    state,
    reason,
    expiresAt: claims?.exp ?? null,
    licenseExpiresAt: claims?.licenseExpiresAt ?? null,
    advancedEnabled: false,
    actions
  })
  if (!Number.isSafeInteger(input.nowUtc) || input.nowUtc < 0) return none('clock-suspect', '本机时间不可用，暂不启用高级能力。')
  if (input.lastTrustedUtc !== undefined && (!Number.isSafeInteger(input.lastTrustedUtc) || input.nowUtc < input.lastTrustedUtc - 300)) return none('clock-suspect', '本机时间早于上次可信时间，需要联网校时。', input.claims ?? undefined)
  if (!input.claims) return none('unlicensed', '尚未激活桌面授权。')
  if (input.revoked) return none('revoked', '授权已被服务端吊销。', input.claims)
  if (!input.expected) return none('signature-invalid', '缺少原生验签上下文。', input.claims)
  const error = validateLeaseClaims(input.claims, input.expected, input.nowUtc)
  if (error) return none('signature-invalid', error, input.claims)
  const { exp, licenseExpiresAt } = input.claims
  if (input.nowUtc >= licenseExpiresAt) return none('expired', '授权已到绝对截止时间。', input.claims)
  if (input.nowUtc >= exp) return none('expired', '短期授权凭据已到期，请联网刷新。', input.claims)
  const remaining = exp - input.nowUtc
  const state: LicenseState = remaining <= 300 ? 'near-expiry' : input.networkAvailable ? 'active' : 'offline'
  return { state, reason: state === 'offline' ? '当前使用已验签的离线短期凭据，不能延长绝对期限。' : '授权有效。', expiresAt: exp, licenseExpiresAt, advancedEnabled: true, actions }
}
