import assert from 'node:assert/strict'
import { before, after, beforeEach, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { Miniflare } from 'miniflare'
import { createLicenseWorker } from '../src/worker.mjs'
import { durationSeconds, verifyLease, sha256, ISSUER, AUDIENCE } from '../src/protocol.mjs'

let runtime, db, env, publicJwk, privateKey
let now = 1_790_000_000
const nonce = 'a'.repeat(32)
const deviceId = 'device-one-'.padEnd(40, 'x')
const worker = createLicenseWorker(() => now)
const request = (path, body = {}, { admin = false, overrides = {}, headers = {} } = {}) => worker.fetch(new Request(`https://licensing.test${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(admin ? { authorization: `Bearer ${env.ADMIN_TOKEN}` } : {}), ...headers }, body: JSON.stringify(body),
}), { ...env, ...overrides })
const issue = async (duration = { value: 1, unit: 'hours' }) => {
  const response = await request('/v1/admin/licenses', { duration }, { admin: true })
  assert.equal(response.status, 201)
  return response.json()
}
const activate = (code, device = deviceId, requestNonce = nonce) => request('/v1/activate', { code, deviceId: device, nonce: requestNonce })
const checked = async (response, device = deviceId, requestNonce = nonce) => {
  assert.equal(response.status, 200)
  const result = await response.json()
  const payload = await verifyLease(result.lease, publicJwk, { now, deviceHash: await sha256(device), nonce: requestNonce, kid: 'test-key-1' })
  return { ...result, payload }
}

before(async () => {
  runtime = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("test") } }', compatibilityDate: '2026-07-30', d1Databases: { DB: 'test-licenses' } })
  db = await runtime.getD1Database('DB')
  const schema = await readFile(new URL('../migrations/0001_licenses.sql', import.meta.url), 'utf8')
  await db.prepare(schema).run()
  const pair = await generateKeyPair('EdDSA', { extractable: true })
  privateKey = pair.privateKey
  publicJwk = await exportJWK(pair.publicKey)
  env = {
    DB: db, ADMIN_TOKEN: 'test-admin-only-'.padEnd(48, 'a'), REFRESH_SECRET: 'test-refresh-only-'.padEnd(48, 'b'),
    LICENSE_KID: 'test-key-1', LICENSE_PRIVATE_JWK: JSON.stringify(await exportJWK(pair.privateKey)),
    ACTIVATION_RATE_LIMITER: { limit: async () => ({ success: true }) },
  }
})
after(async () => { await runtime?.dispose() })
beforeEach(async () => { now = 1_790_000_000; await db.prepare('DELETE FROM licenses').run() })

test('小时和天使用固定秒数，不接受负值、小数、未知单位或超一年时长', () => {
  assert.equal(durationSeconds({ value: 1, unit: 'hours' }), 3600)
  assert.equal(durationSeconds({ value: 6, unit: 'hours' }), 21600)
  assert.equal(durationSeconds({ value: 7, unit: 'days' }), 604800)
  for (const value of [-1, 0, 0.5, 367, NaN, Infinity, '1']) assert.throws(() => durationSeconds({ value, unit: 'days' }))
  assert.throws(() => durationSeconds({ value: 1, unit: 'weeks' }))
})

test('管理员发码仅存SHA256，创建时不开始消耗使用时间', async () => {
  const created = await issue()
  const row = await db.prepare('SELECT * FROM licenses WHERE id=?').bind(created.licenseId).first()
  assert.equal(row.duration_seconds, 3600)
  assert.equal(row.activated_at, null)
  assert.equal(row.expires_at, null)
  assert.equal(row.device_hash, null)
  assert.equal(row.code_hash, await sha256(created.activationCode.replace(/-/g, '')))
  assert.ok(!JSON.stringify(row).includes(created.activationCode))
})

test('首次激活按服务端时间起算，签名、nonce、设备与绝对到期字段可验证', async () => {
  const code = await issue()
  now += 86400 * 2
  const result = await checked(await activate(code.activationCode))
  assert.equal(result.payload.iat, now)
  assert.equal(result.payload.exp, now + 900)
  assert.equal(result.payload.licenseExpiresAt, now + 3600)
  assert.equal(result.payload.sub, code.licenseId)
  assert.equal(result.refreshToken.length, 64)
})

test('同设备反复激活和刷新不重置起点，最后一分钟lease被绝对期限截断', async () => {
  const code = await issue()
  const first = await checked(await activate(code.activationCode))
  const deadline = first.payload.licenseExpiresAt
  now += 600
  const second = await checked(await activate(code.activationCode.toLowerCase()))
  assert.equal(second.payload.licenseExpiresAt, deadline)
  assert.equal(second.refreshToken, first.refreshToken)
  now = deadline - 30
  const response = await request('/v1/refresh', { licenseId: first.licenseId, refreshToken: first.refreshToken, deviceId, nonce })
  const fresh = await checked(response)
  assert.equal(fresh.payload.exp, deadline)
  assert.equal(fresh.payload.licenseExpiresAt, deadline)
  now = deadline
  assert.equal((await activate(code.activationCode)).status, 403)
  assert.equal((await request('/v1/refresh', { licenseId: first.licenseId, refreshToken: first.refreshToken, deviceId, nonce })).status, 403)
  await assert.rejects(verifyLease(fresh.lease, publicJwk, { now, deviceHash: await sha256(deviceId), nonce, kid: 'test-key-1' }))
})

test('真实D1并发首次激活只允许一个不同设备获胜', async () => {
  const code = await issue({ value: 3, unit: 'days' })
  const otherDevice = 'device-two-'.padEnd(40, 'y')
  const attempts = await Promise.all([activate(code.activationCode), activate(code.activationCode, otherDevice)])
  assert.deepEqual(attempts.map(result => result.status).sort(), [200, 403])
  const winner = attempts[0].status === 200 ? deviceId : otherDevice
  const row = await db.prepare('SELECT * FROM licenses WHERE id=?').bind(code.licenseId).first()
  assert.equal(row.device_hash, await sha256(winner))
  assert.equal(row.expires_at, now + 3 * 86400)
})

test('客户端时间参数不能改变服务端首次激活和到期时间', async () => {
  const code = await issue()
  const result = await checked(await request('/v1/activate', { code: code.activationCode, deviceId, nonce, issuedAt: 0, now: 0, expiresAt: now + 99999999 }))
  assert.equal(result.payload.licenseExpiresAt, now + 3600)
})

test('吊销阻止刷新和再激活，已签lease仅能使用到之前exp', async () => {
  const code = await issue()
  const first = await checked(await activate(code.activationCode))
  assert.equal((await request(`/v1/admin/licenses/${code.licenseId}/revoke`, {}, { admin: true })).status, 200)
  assert.equal((await activate(code.activationCode)).status, 403)
  assert.equal((await request('/v1/refresh', { licenseId: code.licenseId, deviceId, nonce, refreshToken: first.refreshToken })).status, 403)
  // 离线凭据无法获知远端吊销，测试明确这条信任边界，不能宣称即时离线撤销。
  await verifyLease(first.lease, publicJwk, { now, deviceHash: await sha256(deviceId), nonce, kid: 'test-key-1' })
  now = first.payload.exp
  await assert.rejects(verifyLease(first.lease, publicJwk, { now, deviceHash: await sha256(deviceId), nonce, kid: 'test-key-1' }))
})

test('签名篡改、错误公钥、错误kid、设备或nonce与到期均被拒绝', async () => {
  const first = await checked(await activate((await issue()).activationCode))
  const context = { now, deviceHash: await sha256(deviceId), nonce, kid: 'test-key-1' }
  const [header, payload, signature] = first.lease.split('.')
  const tampered = Buffer.from(JSON.stringify({ ...first.payload, exp: now + 99999999 })).toString('base64url')
  await assert.rejects(verifyLease(`${header}.${tampered}.${signature}`, publicJwk, context))
  const otherPair = await generateKeyPair('EdDSA', { extractable: true })
  await assert.rejects(verifyLease(first.lease, await exportJWK(otherPair.publicKey), context))
  for (const patch of [{ kid: 'wrong' }, { deviceHash: '0'.repeat(64) }, { nonce: 'b'.repeat(32) }, { now: now - 1 }, { now: first.payload.exp }]) {
    await assert.rejects(verifyLease(first.lease, publicJwk, { ...context, ...patch }))
  }
})

test('即使合法签名也拒绝越过绝对期限、超长lease及非整数时间', async () => {
  const context = { now, deviceHash: await sha256(deviceId), nonce, kid: 'test-key-1' }
  for (const patch of [{ exp: now + 3601 }, { licenseExpiresAt: now + 100 }, { iat: now - 0.5 }, { nbf: now - 1 }, { plan: 'unknown' }]) {
    const token = await new SignJWT({ sub: crypto.randomUUID(), iat: now, nbf: now, exp: now + 900, licenseExpiresAt: now + 7200, plan: 'pro', deviceHash: context.deviceHash, nonce, ...patch })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: context.kid }).setIssuer(ISSUER).setAudience(AUDIENCE).sign(privateKey)
    await assert.rejects(verifyLease(token, publicJwk, context))
  }
})

test('未配置、错误管理员凭据、限流都失败关闭且不泄露信息', async () => {
  for (const [overrides, expected] of [[{ LICENSE_PRIVATE_JWK: 'private-key-secret' }, 503], [{ ADMIN_TOKEN: '' }, 503], [{ ACTIVATION_RATE_LIMITER: undefined }, 503], [{ ACTIVATION_RATE_LIMITER: { limit: async () => ({ success: false }) } }, 429]]) {
    const response = await request('/v1/activate', {}, { overrides })
    assert.equal(response.status, expected)
    assert.ok(!await response.text().then(text => text.includes('private-key-secret')))
  }
  assert.equal((await request('/v1/admin/licenses', { duration: { value: 1, unit: 'hours' } })).status, 401)
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM licenses').first()).total, 0)
})

test('错误刷新密钥、不支持方法、无效JSON与超大正文不会修改授权', async () => {
  const first = await checked(await activate((await issue()).activationCode))
  assert.equal((await request('/v1/refresh', { licenseId: first.licenseId, deviceId, nonce, refreshToken: '0'.repeat(64) })).status, 403)
  assert.equal((await worker.fetch(new Request('https://licensing.test/v1/activate'), env)).status, 405)
  assert.equal((await worker.fetch(new Request('https://licensing.test/v1/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' }), env)).status, 400)
  assert.equal((await request('/v1/activate', { long: 'x'.repeat(10000) })).status, 413)
  assert.equal((await request('/v1/activate', {}, { headers: { 'content-type': 'text/plain' } })).status, 415)
})

test('不接受数组隐式转字符串作为设备/nonce/刷新凭据', async () => {
  const code = await issue()
  assert.equal((await request('/v1/activate', { code: code.activationCode, deviceId: [deviceId], nonce })).status, 400)
  assert.equal((await request('/v1/activate', { code: code.activationCode, deviceId, nonce: [nonce] })).status, 400)
  const first = await checked(await activate(code.activationCode))
  assert.equal((await request('/v1/refresh', { licenseId: [first.licenseId], deviceId, nonce, refreshToken: first.refreshToken })).status, 400)
})

test('不同环境私钥/管理员/刷新凭据必须分离，错误配置不改变数据库', async () => {
  const response = await request('/v1/admin/licenses', { duration: { value: 1, unit: 'hours' } }, { admin: true, overrides: { REFRESH_SECRET: env.ADMIN_TOKEN } })
  assert.equal(response.status, 503)
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM licenses').first()).total, 0)
})

test('固定jose凭据与原生Rust验签器共享同一协议样本', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/jose-lease.json', import.meta.url), 'utf8'))
  const payload = await verifyLease(fixture.token, fixture.publicJwk, fixture.expectation)
  assert.equal(payload.sub, '00000000-0000-4000-8000-000000000007')
  assert.equal(payload.exp, 1_790_000_900)
})
