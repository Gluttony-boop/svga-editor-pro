import { importJWK, jwtVerify } from 'jose'

export const ISSUER = 'svga-editor-pro-licensing'
export const AUDIENCE = 'com.svga.editor.pro'
export const MAX_LEASE_SECONDS = 3600
export const MAX_LICENSE_SECONDS = 366 * 86400

const HEADER_FIELDS = new Set(['alg', 'typ', 'kid'])
const CLAIM_FIELDS = new Set(['iss', 'aud', 'sub', 'iat', 'nbf', 'exp', 'licenseExpiresAt', 'deviceHash', 'nonce', 'plan'])

function validLicenseId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

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

function decodePart(encoded, label) {
  if (typeof encoded !== 'string' || !encoded || encoded.length > 8192 || encoded.includes('=') || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error(`无效的${label}`)
  let bytes
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4))
    bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  } catch {
    throw new Error(`无效的${label}`)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`无效的${label}`)
  }
}

function readJsonString(text, start) {
  if (text[start] !== '"') throw new Error('JSON 字符串无效')
  let escaped = false
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index]
    if (escaped) {
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (character === '"') {
      return { value: JSON.parse(text.slice(start, index + 1)), end: index + 1 }
    }
  }
  throw new Error('JSON 字符串无效')
}

function skipJsonValue(text, start) {
  const first = text[start]
  if (first === '"') return readJsonString(text, start).end
  if (first === '{' || first === '[') {
    const stack = [first === '{' ? '}' : ']']
    let escaped = false
    for (let index = start + 1; index < text.length; index += 1) {
      const character = text[index]
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        const string = readJsonString(text, index)
        index = string.end - 1
      } else if (character === '{') {
        stack.push('}')
      } else if (character === '[') {
        stack.push(']')
      } else if (character === stack[stack.length - 1]) {
        stack.pop()
        if (stack.length === 0) return index + 1
      }
    }
    throw new Error('JSON 值无效')
  }
  let index = start
  while (index < text.length && !',}'.includes(text[index])) index += 1
  return index
}

function parseStrictObject(encoded, label, fields) {
  const text = decodePart(encoded, label)
  let value
  try { value = JSON.parse(text) } catch { throw new Error(`无效的${label}`) }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`无效的${label}`)
  const keys = new Set()
  let index = 0
  const whitespace = () => { while (/\s/.test(text[index] ?? '')) index += 1 }
  whitespace()
  if (text[index++] !== '{') throw new Error(`无效的${label}`)
  while (true) {
    whitespace()
    if (text[index] === '}') { index += 1; break }
    const key = readJsonString(text, index)
    index = key.end
    if (keys.has(key.value)) throw new Error(`${label}包含重复字段`)
    keys.add(key.value)
    whitespace()
    if (text[index++] !== ':') throw new Error(`无效的${label}`)
    whitespace()
    index = skipJsonValue(text, index)
    whitespace()
    if (text[index] === ',') { index += 1; continue }
    if (text[index] === '}') { index += 1; break }
    throw new Error(`无效的${label}`)
  }
  whitespace()
  if (index !== text.length || keys.size !== fields.size || [...keys].some(key => !fields.has(key))) throw new Error(`${label}字段不完整或包含未知字段`)
  return value
}

/** 未来原生验证器的测试契约；此 JS 验证器不是桌面收费功能的安全边界。 */
export async function verifyLease(token, publicJwk, { now, deviceHash, nonce, kid }) {
  if (typeof token !== 'string' || token.length > 16 * 1024 || !Number.isSafeInteger(now) || now < 0 || !/^[a-f0-9]{64}$/.test(deviceHash) || !/^[a-f0-9]{32,128}$/.test(nonce) || typeof kid !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(kid)) throw new Error('校验上下文无效')
  if (!publicJwk || typeof publicJwk !== 'object' || Array.isArray(publicJwk) || publicJwk.kty !== 'OKP' || publicJwk.crv !== 'Ed25519' || publicJwk.d || typeof publicJwk.x !== 'string' || Object.keys(publicJwk).some(key => !['kty', 'crv', 'x', 'alg'].includes(key)) || (publicJwk.alg !== undefined && publicJwk.alg !== 'EdDSA')) throw new Error('只接受固定的 Ed25519 公钥')
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('授权凭据格式无效')
  parseStrictObject(parts[0], 'JWT头', HEADER_FIELDS)
  parseStrictObject(parts[1], 'JWT载荷', CLAIM_FIELDS)
  const key = await importJWK(publicJwk, 'EdDSA')
  const { payload, protectedHeader } = await jwtVerify(token, key, {
    issuer: ISSUER, audience: AUDIENCE, algorithms: ['EdDSA'], typ: 'JWT',
    currentDate: new Date(now * 1000), clockTolerance: 0,
    requiredClaims: ['sub', 'iat', 'nbf', 'exp', 'licenseExpiresAt', 'deviceHash', 'nonce', 'plan'],
  })
  if (protectedHeader.kid !== kid || payload.deviceHash !== deviceHash || payload.nonce !== nonce || payload.plan !== 'pro' ||
    !validLicenseId(payload.sub) ||
    ![payload.iat, payload.nbf, payload.exp, payload.licenseExpiresAt].every(Number.isSafeInteger) ||
    payload.iat < 0 || payload.nbf !== payload.iat || payload.iat > now || payload.exp <= payload.iat ||
    payload.licenseExpiresAt <= payload.iat || payload.licenseExpiresAt - payload.iat > MAX_LICENSE_SECONDS ||
    payload.exp > payload.licenseExpiresAt || payload.exp - payload.iat > MAX_LEASE_SECONDS) {
    throw new Error('授权凭据字段不一致')
  }
  return payload
}
