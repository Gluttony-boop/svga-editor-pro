import { importJWK, jwtVerify } from 'jose'

export const ISSUER = 'svga-editor-pro-licensing'
export const AUDIENCE = 'com.svga.editor.pro'
export const MAX_LEASE_SECONDS = 3600

export function durationSeconds(duration) {
  const factor = duration?.unit === 'hours' ? 3600 : duration?.unit === 'days' ? 86400 : 0
  const seconds = duration?.value * factor
  if (!factor || !Number.isSafeInteger(duration?.value) || duration.value < 1 || seconds > 366 * 86400) {
    throw new Error('时长必须为正整数小时或天，最多 366 天')
  }
  return seconds
}

export async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** 未来原生验证器的测试契约；此 JS 验证器不是桌面收费功能的安全边界。 */
export async function verifyLease(token, publicJwk, { now, deviceHash, nonce, kid }) {
  if (!Number.isSafeInteger(now) || now < 0 || !/^[a-f0-9]{64}$/.test(deviceHash) || !/^[a-f0-9]{32,128}$/.test(nonce)) throw new Error('校验上下文无效')
  if (publicJwk.kty !== 'OKP' || publicJwk.crv !== 'Ed25519' || publicJwk.d) throw new Error('只接受固定的 Ed25519 公钥')
  const key = await importJWK(publicJwk, 'EdDSA')
  const { payload, protectedHeader } = await jwtVerify(token, key, {
    issuer: ISSUER, audience: AUDIENCE, algorithms: ['EdDSA'], typ: 'JWT',
    currentDate: new Date(now * 1000), clockTolerance: 0,
    requiredClaims: ['sub', 'iat', 'nbf', 'exp', 'licenseExpiresAt', 'deviceHash', 'nonce', 'plan'],
  })
  if (protectedHeader.kid !== kid || payload.deviceHash !== deviceHash || payload.nonce !== nonce || payload.plan !== 'pro' ||
    typeof payload.sub !== 'string' || !payload.sub ||
    ![payload.iat, payload.nbf, payload.exp, payload.licenseExpiresAt].every(Number.isSafeInteger) ||
    payload.nbf !== payload.iat || payload.iat > now || payload.exp <= payload.iat ||
    payload.exp > payload.licenseExpiresAt || payload.exp - payload.iat > MAX_LEASE_SECONDS) {
    throw new Error('授权凭据字段不一致')
  }
  return payload
}
