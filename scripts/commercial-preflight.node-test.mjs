import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { collectChecks, formatText, parseArgs, summarize } from './commercial-preflight.mjs'

async function fixture({ updater, license, dirty = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svga-preflight-'))
  await mkdir(path.join(root, 'src-tauri'), { recursive: true })
  await mkdir(path.join(root, '.github/workflows'), { recursive: true })
  await mkdir(path.join(root, 'scripts'), { recursive: true })
  await mkdir(path.join(root, 'docs/commercial'), { recursive: true })
  const packageJson = {
    version: '2.0.0',
    scripts: { 'package:github': 'node scripts/package-github.mjs', 'release:manifest': 'node scripts/release-manifest.mjs', 'test:licensing': 'npm test', 'test:release-manifest': 'node --test', 'prepare:updater-config': 'node scripts/prepare-updater-config.mjs', 'test:updater-config': 'node --test' },
  }
  const tauri = { version: '2.0.0', bundle: { targets: ['nsis'] }, plugins: {} }
  if (updater !== undefined) tauri.plugins.updater = updater
  if (license !== undefined) tauri.plugins.license = license
  await writeFile(path.join(root, 'package.json'), JSON.stringify(packageJson))
  await writeFile(path.join(root, 'src-tauri/tauri.conf.json'), JSON.stringify(tauri))
  await writeFile(path.join(root, 'src-tauri/Cargo.toml'), '[package]\nversion = "2.0.0"\n')
  for (const file of ['.github/workflows/package-windows.yml', '.github/workflows/publish-windows-release.yml', '.github/workflows/commercial-foundations.yml', 'scripts/package-github.mjs', 'scripts/release-manifest.mjs', 'scripts/prepare-updater-config.mjs', 'docs/commercial/STATUS.md']) await writeFile(path.join(root, file), 'placeholder')
  await writeFile(path.join(root, 'src-tauri/resources/README.md'), '不得放入授权私钥或更新私钥。').catch(async () => {
    await mkdir(path.join(root, 'src-tauri/resources'), { recursive: true })
    await writeFile(path.join(root, 'src-tauri/resources/README.md'), '不得放入授权私钥或更新私钥。')
  })
  return { root, dirty }
}

test('parseArgs supports strict and JSON output without accepting unknown flags', () => {
  assert.deepEqual(parseArgs(['--strict', '--json']), { strict: true, json: true, root: parseArgs([]).root, help: false })
  assert.throws(() => parseArgs(['--token', 'secret']), /未知选项/)
})

test('preflight reports development configuration as warnings, not false readiness', async () => {
  const { root } = await fixture()
  try {
    const checks = await collectChecks(root, { git: false })
    assert.equal(summarize(checks).block, 0)
    assert.equal(checks.find(check => check.id === 'updater').level, 'warn')
    assert.equal(checks.find(check => check.id === 'license').level, 'warn')
    assert.match(formatText(checks), /尚不能|外部账户/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('preflight rejects insecure updater and invalid license configuration', async () => {
  const { root } = await fixture({
    updater: { pubkey: 'public', endpoints: ['http://updates.example.com/latest.json'], requireSignedVersion: false },
    license: { endpoint: 'https://license.example.com', publicKey: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', d: 'private', x: 'x' }), issuer: 'issuer', audience: 'audience', kid: 'key' },
  })
  try {
    const checks = await collectChecks(root, { git: false })
    const summary = summarize(checks)
    assert.equal(summary.block, 0)
    assert.equal(checks.find(check => check.id === 'updater').level, 'warn')
    assert.equal(checks.find(check => check.id === 'license').level, 'warn')
    assert.match(checks.find(check => check.id === 'updater').detail, /HTTPS/)
    assert.match(checks.find(check => check.id === 'license').detail, /不含私钥/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('strict mode turns pending configuration into a failing conclusion', async () => {
  const { root } = await fixture()
  try {
    const checks = await collectChecks(root, { git: false })
    const text = formatText(checks, { strict: true })
    assert.match(text, /strict 模式/)
    assert.ok(summarize(checks).warn > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
