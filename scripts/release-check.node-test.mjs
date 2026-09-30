import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  HELP,
  parseArgs,
  prepareReleaseArtifacts,
  validateReleaseContext,
  verifyUpdaterArtifact,
} from './release-check.mjs'

const VERSION = '2.0.0'
const TAG = `v${VERSION}`
const SHA = 'a'.repeat(40)
const NAME = 'SVGA-Editor-2.0.0_x64-setup.exe'

// 测试使用临时 Ed25519 密钥签名 MZ 样本，私钥只存在内存中，不生成可发布密钥。
function signedFixture({ version = VERSION, installer = Buffer.from('MZ-test-installer') } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keyId = randomBytes(8)
  const payloadSignature = sign(null, installer, privateKey)
  const trusted = `timestamp:1790000000\tfile:${NAME}\tversion:${version}`
  const body = Buffer.concat([Buffer.from('Ed'), keyId, payloadSignature]).toString('base64')
  const globalSignature = sign(null, Buffer.concat([payloadSignature, Buffer.from(trusted)]), privateKey).toString('base64')
  const signature = Buffer.from([
    'untrusted comment: signature from test key',
    body,
    `trusted comment: ${trusted}`,
    globalSignature,
  ].join('\n') + '\n').toString('base64')
  const publicBody = Buffer.concat([Buffer.from('Ed'), keyId, Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')]).toString('base64')
  const publicKeyText = Buffer.from(`untrusted comment: test public key\n${publicBody}\n`).toString('base64')
  return { installer, signature, publicKey: publicKeyText }
}

function contextFixture(overrides = {}) {
  const fixture = signedFixture()
  const context = validateReleaseContext({
    packageJson: { version: VERSION },
    packageLock: { version: VERSION, packages: { '': { version: VERSION } } },
    tauriConfig: { version: VERSION, bundle: { active: true, targets: ['nsis'] } },
    cargoToml: `[package]\nname = "svga-editor-pro"\nversion = "${VERSION}"\n`,
    tag: TAG,
    sha: SHA,
    expectedSha: SHA,
    repository: 'owner/releases',
    publicKey: fixture.publicKey,
    endpoint: undefined,
    branch: 'master',
    ...overrides,
  })
  return { context, fixture }
}

async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'svga-release-check-'))
  t.after(async () => {
    assert.match(path.basename(dir), /^svga-release-check-/)
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

test('发布上下文验证三处版本、完整 SHA、默认分支和 NSIS 目标', () => {
  const { context } = contextFixture()
  assert.equal(context.version, VERSION)
  assert.equal(context.commit, SHA)
  assert.equal(context.updateEndpoint, 'https://github.com/owner/releases/releases/latest/download/latest.json')
  for (const [field, value] of [
    ['packageJson', { version: '2.0.1' }],
    ['packageLock', { version: '2.0.1', packages: { '': { version: VERSION } } }],
    ['tauriConfig', { version: '2.0.1', bundle: { active: true, targets: ['nsis'] } }],
    ['cargoToml', '[package]\nversion = "2.0.1"\n'],
  ]) {
    assert.throws(() => contextFixture({ [field]: value }), /版本不一致/)
  }
  assert.throws(() => contextFixture({ expectedSha: 'b'.repeat(40) }), /SHA/)
  assert.throws(() => contextFixture({ branch: 'feature/release' }), /默认分支/)
  assert.throws(() => contextFixture({ localTagSha: SHA }), /Tag 已存在/)
})

test('发布上下文拒绝不安全端点、错误版本 Tag 和无效公钥', () => {
  for (const endpoint of ['http://updates.example.com/latest.json', 'https://updates.example.com/latest.json?token=x']) {
    assert.throws(() => contextFixture({ endpoint }), /更新端点|HTTPS/)
  }
  assert.throws(() => contextFixture({ tag: 'v2.0.0-beta.1' }), /Tag/)
  assert.throws(() => contextFixture({ publicKey: 'not-a-key' }), /公钥/)
  assert.throws(() => contextFixture({ tauriConfig: { version: VERSION, bundle: { active: true, targets: ['dmg'] } } }), /NSIS/)
})

test('实际 MZ 字节、签名文件名、版本和公钥必须全部匹配', () => {
  const fixture = signedFixture()
  const checked = verifyUpdaterArtifact({ installer: fixture.installer, signature: fixture.signature, publicKey: fixture.publicKey, version: VERSION, fileName: NAME })
  assert.match(checked.installerSha256, /^[a-f0-9]{64}$/)
  assert.match(checked.publicKeySha256, /^[a-f0-9]{64}$/)
  assert.throws(() => verifyUpdaterArtifact({ installer: Buffer.from('MZ-tampered'), signature: fixture.signature, publicKey: fixture.publicKey, version: VERSION, fileName: NAME }), /验签失败/)
  assert.throws(() => verifyUpdaterArtifact({ ...fixture, version: '2.0.1', fileName: NAME }), /version/)
  assert.throws(() => verifyUpdaterArtifact({ ...fixture, fileName: 'other.exe' }), /文件名/)
})

test('实际签名产物先验收，再在新目录生成清单、收据和摘要', async t => {
  const root = await temporary(t)
  const bundle = path.join(root, 'nsis')
  const output = path.join(root, 'release-assets')
  await mkdir(bundle, { recursive: true })
  const fixture = signedFixture()
  await writeFile(path.join(bundle, NAME), fixture.installer)
  await writeFile(path.join(bundle, `${NAME}.sig`), `${fixture.signature}\n`)
  const context = contextFixture({ publicKey: fixture.publicKey }).context
  const result = await prepareReleaseArtifacts({ context, publicKey: fixture.publicKey, notes: '签名测试发布', bundleDir: bundle, output, runId: '42', runAttempt: '1', now: '2026-10-01T00:00:00Z' })
  assert.deepEqual((await readdir(output)).sort(), ['SHA256SUMS.txt', `${NAME}.sig`, NAME, 'latest.json', 'release-receipt.json'].sort())
  const manifest = JSON.parse(await readFile(path.join(output, 'latest.json'), 'utf8'))
  assert.equal(manifest.version, VERSION)
  assert.equal(manifest.platforms['windows-x86_64'].signature, fixture.signature.trim())
  const receipt = JSON.parse(await readFile(path.join(output, 'release-receipt.json'), 'utf8'))
  assert.equal(receipt.verification.installerSignature, 'passed')
  assert.equal(receipt.runUrl, 'https://github.com/owner/releases/actions/runs/42')
  assert.equal(result.output, output)
  await assert.rejects(prepareReleaseArtifacts({ context, publicKey: fixture.publicKey, notes: '重复', bundleDir: bundle, output }), /已存在/)
})

test('CLI 只接受预期参数，不允许通过参数传入密钥', () => {
  assert.deepEqual(parseArgs(['preflight', '--tag', TAG, '--expected-sha', SHA]), { command: 'preflight', tag: TAG, expectedSha: SHA })
  assert.deepEqual(parseArgs(['artifacts', '--tag', TAG, '--expected-sha', SHA, '--bundle-dir', 'bundle', '--out', 'out']), { command: 'artifacts', tag: TAG, expectedSha: SHA, bundleDir: 'bundle', output: 'out' })
  for (const args of [
    ['preflight', '--tag', TAG, '--expected-sha', 'short'],
    ['preflight', '--tag', TAG, '--expected-sha', SHA, '--private-key', 'secret'],
    ['artifacts', '--tag', TAG, '--expected-sha', SHA, '--bundle-dir', 'bundle'],
  ]) assert.throws(() => parseArgs(args))
  assert.match(HELP, /不读取私钥/)
})

test('工作流不会让旧 Tag 自动公开无签名 Release，正式上传仅发生在验签之后的 draft 步骤', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const publish = await readFile(path.join(root, '.github/workflows/publish-windows-release.yml'), 'utf8')
  const build = await readFile(path.join(root, '.github/workflows/build.yml'), 'utf8')
  assert.match(publish, /expected_sha:/)
  assert.match(publish, /npm run release:check -- preflight/)
  assert.match(publish, /npm run release:check -- artifacts/)
  assert.match(publish, /draft: true/)
  assert.ok(publish.indexOf('Verify actual signed artifacts before upload') < publish.indexOf('Create draft release after verification'))
  assert.doesNotMatch(build, /tags:\s*\n\s*- ['"]v\*['"]/)
  assert.doesNotMatch(build, /softprops\/action-gh-release/)
})
