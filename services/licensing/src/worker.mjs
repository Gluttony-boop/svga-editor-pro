import { importJWK, SignJWT } from 'jose'
import { AUDIENCE, ISSUER, durationSeconds, sha256, MAX_LEASE_SECONDS } from './protocol.mjs'

class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
} })
const epoch = () => Math.floor(Date.now() / 1000)
const randomHex = length => Array.from(crypto.getRandomValues(new Uint8Array(length)), byte => byte.toString(16).padStart(2, '0')).join('')
const reject = (condition, status = 400, code = 'invalid_request') => { if (condition) throw new ApiError(status, code) }

async function equalSecret(left, right) {
  const a = await sha256(left), b = await sha256(right)
  let difference = 0
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return difference === 0
}

async function readBody(request) {
  reject(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'), 415, 'json_required')
  const reader = request.body?.getReader()
  reject(!reader)
  let size = 0
  const chunks = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 8192) { await reader.cancel(); throw new ApiError(413, 'body_too_large') }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    reject(!body || Array.isArray(body) || typeof body !== 'object')
    return body
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'invalid_json') }
}

function normalizeCode(value) {
  reject(typeof value !== 'string')
  const code = value.trim().toUpperCase().replace(/-/g, '')
  reject(!/^SVP[0-9A-F]{40}$/.test(code))
  return code
}

async function keys(env) {
  reject(!env.DB || typeof env.ADMIN_TOKEN !== 'string' || env.ADMIN_TOKEN.length < 32 ||
    typeof env.REFRESH_SECRET !== 'string' || env.REFRESH_SECRET.length < 32 ||
    env.ADMIN_TOKEN === env.REFRESH_SECRET ||
    !/^[a-zA-Z0-9_-]{1,48}$/.test(env.LICENSE_KID || ''), 503, 'not_configured')
  try {
    const jwk = JSON.parse(env.LICENSE_PRIVATE_JWK)
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.d) throw new Error()
    return await importJWK(jwk, 'EdDSA')
  } catch { throw new ApiError(503, 'not_configured') }
}

async function refreshToken(env, license) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.REFRESH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  // 域分离且无歧义编码；同设备重试得到相同 handle，网络重试不会锁掉自己。
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify(['svga-refresh-v1', license.id, license.device_hash])))
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function lease(env, signer, license, nonce, now) {
  const expires = Math.min(now + license.lease_seconds, license.expires_at)
  reject(!Number.isSafeInteger(expires) || expires <= now, 403, 'license_unavailable')
  const token = await new SignJWT({ plan: license.plan, deviceHash: license.device_hash, nonce, licenseExpiresAt: license.expires_at })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: env.LICENSE_KID })
    .setIssuer(ISSUER).setAudience(AUDIENCE).setSubject(license.id)
    .setIssuedAt(now).setNotBefore(now).setExpirationTime(expires).sign(signer)
  return json({ lease: token, licenseId: license.id, refreshToken: await refreshToken(env, license) })
}

/** 控制面原型：只校验授权，不接收或上传设计文件，不在未配置时伪造激活成功。 */
export function createLicenseWorker(now = epoch) {
  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url)
        if (request.method === 'GET' && url.pathname === '/health') return json({ service: 'svga-licensing', stage: 'prototype' })
        reject(request.method !== 'POST', 405, 'post_required')
        const admin = url.pathname.startsWith('/v1/admin/')
        const signer = await keys(env)
        if (admin) {
          const bearer = request.headers.get('authorization') || ''
          reject(bearer.length > 4096 || !await equalSecret(bearer, `Bearer ${env.ADMIN_TOKEN}`), 401, 'unauthorized')
        } else {
          reject(!['/v1/activate', '/v1/refresh'].includes(url.pathname), 404, 'not_found')
          // 未绑定限流器不开放公开激活端点，防止部署疏漏耗尽免费额度。
          reject(!env.ACTIVATION_RATE_LIMITER, 503, 'rate_limit_not_configured')
          const rateKey = await sha256(JSON.stringify(['license-rate', env.REFRESH_SECRET, request.headers.get('cf-connecting-ip') || 'local']))
          const { success } = await env.ACTIVATION_RATE_LIMITER.limit({ key: rateKey })
          reject(!success, 429, 'rate_limited')
        }
        const body = await readBody(request)
        const instant = now()
        reject(!Number.isSafeInteger(instant) || instant < 0, 503, 'clock_unavailable')

        if (url.pathname === '/v1/admin/licenses') {
          let seconds
          try { seconds = durationSeconds(body.duration) } catch { throw new ApiError(400, 'invalid_duration') }
          const leaseSeconds = body.leaseSeconds ?? 900
          reject(!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > MAX_LEASE_SECONDS || (body.plan !== undefined && body.plan !== 'pro'))
          const code = `SVP${randomHex(20).toUpperCase()}`
          const id = crypto.randomUUID()
          await env.DB.prepare('INSERT INTO licenses (id,code_hash,plan,duration_seconds,lease_seconds,created_at) VALUES (?,?,?,?,?,?)')
            .bind(id, await sha256(code), 'pro', seconds, leaseSeconds, instant).run()
          return json({ licenseId: id, activationCode: `SVP-${code.slice(3).match(/.{1,8}/g).join('-')}`, durationSeconds: seconds, startsAt: 'first_activation', seats: 1 }, 201)
        }
        const revoke = /^\/v1\/admin\/licenses\/([0-9a-f-]{36})\/revoke$/.exec(url.pathname)
        if (revoke) {
          const row = await env.DB.prepare('UPDATE licenses SET revoked_at=COALESCE(revoked_at,?) WHERE id=? RETURNING id').bind(instant, revoke[1]).first()
          reject(!row, 404, 'not_found')
          return json({ revoked: true, licenseId: row.id })
        }
        reject(admin, 404, 'not_found')
        reject(typeof body.deviceId !== 'string' || typeof body.nonce !== 'string' ||
          !/^[a-zA-Z0-9_-]{32,128}$/.test(body.deviceId) || !/^[a-f0-9]{32,128}$/.test(body.nonce))
        const deviceHash = await sha256(body.deviceId)
        if (url.pathname === '/v1/activate') {
          const codeHash = await sha256(normalizeCode(body.code))
          // 单语句比较并写入，两个不同设备同时激活时也只有一个能绑定。
          const license = await env.DB.prepare(`UPDATE licenses SET
            device_hash=COALESCE(device_hash,?1), activated_at=COALESCE(activated_at,?2),
            expires_at=COALESCE(expires_at,?2+duration_seconds)
            WHERE code_hash=?3 AND revoked_at IS NULL
            AND (device_hash IS NULL OR device_hash=?1) AND (expires_at IS NULL OR expires_at>?2)
            RETURNING *`).bind(deviceHash, instant, codeHash).first()
          reject(!license, 403, 'license_unavailable')
          return await lease(env, signer, license, body.nonce, instant)
        }
        reject(typeof body.licenseId !== 'string' || typeof body.refreshToken !== 'string' ||
          !/^[0-9a-f-]{36}$/.test(body.licenseId) || !/^[a-f0-9]{64}$/.test(body.refreshToken))
        const license = await env.DB.prepare('SELECT * FROM licenses WHERE id=? AND device_hash=? AND revoked_at IS NULL AND expires_at>?')
          .bind(body.licenseId, deviceHash, instant).first()
        reject(!license || !await equalSecret(body.refreshToken, await refreshToken(env, license)), 403, 'license_unavailable')
        return await lease(env, signer, license, body.nonce, instant)
      } catch (error) {
        // 服务端异常也不回显 SQL、凭据或私钥，客户端只收到可操作的错误类别。
        return json({ error: error instanceof ApiError ? error.code : 'service_unavailable' }, error instanceof ApiError ? error.status : 503)
      }
    }
  }
}

export default createLicenseWorker()
