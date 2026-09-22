import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { buildManifest, inspectSignature, normalizeVersion, parseArgs, runCli, validateArtifactUrl, validateDate, validateManifest } from './release-manifest.mjs'

const URL = 'https://github.com/example/releases-only/releases/download/v2.1.0/Editor_2.1.0_x64-setup.exe'
const NAME = 'Editor_2.1.0_x64-setup.exe'
const DATE = '2026-09-20T09:30:00+09:00'

// 测试临时生成 Ed25519 密钥，签的是文字样本而非安装包；私钥不落盘，产物不可用于发布。
function signatureFixture(fileName = NAME, overrides = {}, version) {
  const { privateKey } = generateKeyPairSync('ed25519')
  const dataSignature = sign(null, Buffer.from('仅供单元测试，不是应用程序'), privateKey)
  const trusted = `timestamp:1790000000\tfile:${fileName}${version ? `\tversion:${version}` : ''}`
  const body = Buffer.concat([Buffer.from('Ed'), randomBytes(8), dataSignature]).toString('base64')
  const global = sign(null, Buffer.concat([dataSignature, Buffer.from(trusted)]), privateKey).toString('base64')
  const lines = ['untrusted comment: signature from tauri secret key', body, `trusted comment: ${trusted}`, global]
  for (const [index, value] of Object.entries(overrides)) lines[Number(index)] = value
  return Buffer.from(`${lines.join('\n')}\n`).toString('base64')
}

const SIGNATURE = signatureFixture()
const manifest = changes => buildManifest({ version: '2.1.0', platform: 'windows-x86_64', url: URL, signature: SIGNATURE, notes: '改进画布与时间轴', pubDate: DATE, ...changes })
const cliArgs = (dir, extra = []) => ['build', '--version', '2.1.0', '--platform', 'windows-x86_64', '--url', URL, '--signature-file', path.join(dir, `${NAME}.sig`), '--notes', '修复和改进', ...extra]
const quiet = { stdout() {}, stderr() {} }

async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'svga-release-manifest-'))
  t.after(async () => {
    const cleanup = path.resolve(dir)
    assert.equal(path.dirname(cleanup), path.resolve(os.tmpdir()))
    assert.match(path.basename(cleanup), /^svga-release-manifest-[A-Za-z0-9]+$/)
    await rm(cleanup, { recursive: true, force: true })
  })
  await writeFile(path.join(dir, `${NAME}.sig`), SIGNATURE)
  return dir
}

test('默认帮助，不读取凭据、不触发发布', async () => {
  assert.deepEqual(parseArgs([]), { help: true })
  const output = []
  await runCli([], { stdout: text => output.push(text), stderr() { assert.fail('帮助不需要警告') } })
  assert.match(output.join(''), /不写文件、不联网/)
  assert.match(output.join(''), /不需要私钥/)
})

test('版本接受完整 SemVer，并移除单个 v 前缀', () => {
  for (const version of ['0.0.0', '2.1.0', '2.1.0-beta.1', '2.1.0+build.01', '2.1.0-beta.1+build.2']) {
    assert.equal(normalizeVersion(version), version)
    assert.equal(normalizeVersion(`v${version}`), version)
  }
})

test('版本拒绝省略、前导零及假版本占位符', () => {
  for (const version of [null, 2, '', '2.1', '2.1.0.0', '02.1.0', '2.01.0', '2.1.00', '2.1.0-01', '2.1.0-a..b', 'vv2.1.0', ' 2.1.0', 'latest', '${VERSION}', '2.1.0+', '2.1.0-']) {
    assert.throws(() => normalizeVersion(version), /SemVer/)
  }
})

test('RFC3339 支持 UTC、小数和偏移时区，校验真实闰日', () => {
  for (const date of [DATE, '2024-02-29T00:00:00Z', '2026-09-20t23:59:59.123456789z']) assert.equal(validateDate(date), date)
  for (const date of [null, '2026-02-29T00:00:00Z', '2024-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-00-01T00:00:00Z', '2026-01-00T00:00:00Z', '2026-01-01', '2026-01-01T00:00:00', '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+24:00']) assert.throws(() => validateDate(date))
})

test('Windows v2 使用 exe，而非旧版 updater ZIP', () => {
  assert.equal(validateArtifactUrl(URL, 'windows-x86_64').fileName, NAME)
  assert.equal(validateArtifactUrl(URL.replace('.exe', '.msi'), 'windows-x86_64').fileName, NAME.replace('.exe', '.msi'))
  assert.throws(() => validateArtifactUrl(URL.replace('.exe', '.nsis.zip'), 'windows-x86_64'), /v1 ZIP/)
})

test('macOS 与 Linux 要求各自可更新产物', () => {
  assert.equal(validateArtifactUrl(URL.replace(NAME, 'Editor.app.tar.gz'), 'darwin-aarch64').fileName, 'Editor.app.tar.gz')
  assert.equal(validateArtifactUrl(URL.replace(NAME, 'Editor.AppImage'), 'linux-x86_64').fileName, 'Editor.AppImage')
  assert.throws(() => validateArtifactUrl(URL.replace(NAME, 'Editor.dmg'), 'darwin-x86_64'))
  assert.throws(() => validateArtifactUrl(URL, 'linux-x86_64'))
  for (const platform of ['windows-amd64', 'windows-x86_64-nsis', 'macos-x86_64', 'android-aarch64', '__proto__', '', null]) assert.throws(() => validateArtifactUrl(URL, platform))
})

test('URL 仅允许 HTTPS 完整固定版本发布地址', () => {
  for (const url of [URL.replace('https:', 'http:'), URL.replace('github.com', 'github.com.evil.org'), URL.replace('github.com', 'user:password@github.com'), `${URL}?token=private`, `${URL}#fragment`, URL.replace('/download/v2.1.0', '/latest/download'), URL.replace('github.com', 'github.com:444'), URL.replace(NAME, ''), URL.replace(NAME, 'bad%2fpath.exe'), URL.replace(NAME, 'bad%00.exe'), URL.replace(NAME, 'bad%XX.exe'), URL.replace(NAME, 'bad name.exe'), URL.replace(NAME, 'bad\\name.exe'), 'file:///tmp/installer.exe']) assert.throws(() => validateArtifactUrl(url, 'windows-x86_64'))
})

test('自定义 CDN 必须显式允许精确主机，不接受通配或局域网', () => {
  const url = 'https://downloads.editorpro.cn/v2.1.0/Editor.exe'
  assert.throws(() => validateArtifactUrl(url, 'windows-x86_64'))
  assert.equal(validateArtifactUrl(url, 'windows-x86_64', ['downloads.editorpro.cn']).url, url)
  assert.throws(() => validateArtifactUrl(url.replace('downloads.', 'other.'), 'windows-x86_64', ['downloads.editorpro.cn']))
  for (const host of ['*.editorpro.cn', 'https://editorpro.cn', 'editorpro.cn:443', '127.0.0.1', 'localhost', 'preview.local', 'preview.internal', 'editor.test', 'user:secret@editorpro.cn']) assert.throws(() => validateArtifactUrl(url, 'windows-x86_64', [host]))
})

test('URL 正确处理安装包名称中的空格和中文编码', () => {
  const fileName = 'SVGA 编辑器_2.1.0_x64-setup.exe'
  const value = manifest({ url: URL.replace(NAME, encodeURIComponent(fileName)), signature: signatureFixture(fileName) })
  assert.equal(value.platforms['windows-x86_64'].url.endsWith(encodeURIComponent(fileName)), true)
})

test('签名读取 Tauri Base64 包装而非摘要、路径或下载地址', () => {
  assert.equal(inspectSignature(`\n${SIGNATURE}\n`).signature, SIGNATURE)
  assert.equal(inspectSignature(SIGNATURE).fileName, NAME)
  for (const signature of [null, '', ' ', 'placeholder', '/tmp/installer.exe.sig', 'https://github.com/app.sig', 'a'.repeat(64), 'A'.repeat(9000), Buffer.from('dummy signature').toString('base64'), SIGNATURE.slice(0, -3), `${SIGNATURE}\n${SIGNATURE}`]) assert.throws(() => inspectSignature(signature))
})

test('兼容 Tauri 新签名的 version 元数据，并拒绝与清单版本不一致', () => {
  const value = signatureFixture(NAME, {}, '2.1.0')
  assert.equal(inspectSignature(value).version, '2.1.0')
  assert.throws(() => validateManifest(manifest({ version: '2.1.1', signature: value })))
})

test('拒绝假签名封装和显式不可发布占位符', () => {
  for (const signature of [signatureFixture(NAME, { 0: 'untrusted comment: DO NOT PUBLISH dummy' }), signatureFixture(NAME, { 1: Buffer.alloc(74).toString('base64') }), signatureFixture(NAME, { 3: Buffer.alloc(64).toString('base64') }), signatureFixture(NAME, { 3: randomBytes(63).toString('base64') }), signatureFixture(NAME, { 2: 'trusted comment: missing metadata' }), signatureFixture('../file.exe'), signatureFixture('file\t.exe')]) assert.throws(() => inspectSignature(signature))
})

test('明确只做结构校验：不将篡改后的合法长度签名字节当作密码学验签', () => {
  const lines = Buffer.from(SIGNATURE, 'base64').toString('utf8').trimEnd().split('\n')
  const bytes = Buffer.from(lines[1], 'base64')
  bytes[20] ^= 1
  lines[1] = bytes.toString('base64')
  assert.equal(inspectSignature(Buffer.from(`${lines.join('\n')}\n`).toString('base64')).fileName, NAME)
})

test('生成完整清单并规范化版本，不带私钥或额外自定义字段', () => {
  assert.deepEqual(manifest({ version: 'v2.1.0' }), {
    version: '2.1.0', notes: '改进画布与时间轴', pub_date: DATE,
    platforms: { 'windows-x86_64': { url: URL, signature: SIGNATURE } },
  })
  const value = manifest({ pubDate: undefined })
  assert.match(value.pub_date, /^\d{4}-\d{2}-\d{2}T/)
})

test('生成清单要求说明，校验允许官方可选字段缺省', () => {
  for (const notes of [undefined, null, '', ' ', '\0', '汉'.repeat(30_000)]) assert.throws(() => manifest({ notes }))
  const value = manifest()
  delete value.notes
  delete value.pub_date
  assert.equal(validateManifest(value).version, '2.1.0')
})

test('清单拒绝全部空平台、缺签名/地址和未知字段', () => {
  for (const value of [null, [], {}, { ...manifest(), platforms: {} }, { ...manifest(), platforms: [] }, { ...manifest(), extra: true }, { ...manifest(), platforms: { 'windows-x86_64': { url: URL } } }, { ...manifest(), platforms: { 'windows-x86_64': { signature: SIGNATURE } } }, { ...manifest(), platforms: { 'windows-x86_64': { url: URL, signature: SIGNATURE, pubkey: 'not allowed' } } }]) assert.throws(() => validateManifest(value))
})

test('校验所有平台，不因 Windows 正确而跳过其他平台的错误', () => {
  const value = manifest()
  value.platforms['darwin-aarch64'] = { url: URL.replace(NAME, 'Editor.app.tar.gz'), signature: signatureFixture('Editor.app.tar.gz') }
  assert.equal(Object.keys(validateManifest(value).platforms).length, 2)
  value.platforms['darwin-aarch64'].signature = ''
  assert.throws(() => validateManifest(value))
})

test('拒绝 URL 与签名里文件名不匹配的产物', () => {
  assert.throws(() => manifest({ url: URL.replace(NAME, 'Another.exe') }), /文件名/)
})

test('参数默认预览，可显式写入或只读校验', () => {
  assert.equal(parseArgs(cliArgs('example')).write, false)
  assert.equal(parseArgs(cliArgs('example', ['--out', 'release/latest.json', '--write'])).write, true)
  assert.deepEqual(parseArgs(['validate', '--file', 'latest.json']), { command: 'validate', allowedHosts: [], write: false, file: 'latest.json' })
  assert.equal(parseArgs(cliArgs('example', ['--allow-host', 'cdn.editorpro.cn', '--allow-host', 'releases.editorpro.cn'])).allowedHosts.length, 2)
})

test('参数拒绝私钥/凭据、重复、缺值及矛盾写入选项', () => {
  for (const args of [['--private-key', 'secret'], ['build'], cliArgs('example', ['--token', 'secret']), cliArgs('example', ['--version', '2.2.0']), cliArgs('example', ['--notes-file', 'notes.md']), cliArgs('example', ['--write']), cliArgs('example', ['--write', '--dry-run']), cliArgs('example', ['--out', 'installer.exe']), cliArgs('example', ['--file', 'latest.json']), cliArgs('example', ['--out']), ['validate', '--file', 'latest.json', '--write'], ['validate', '--file', 'latest.json', '--notes', 'wrong']]) assert.throws(() => parseArgs(args))
})

test('dry-run 即使有 --out 也不创建文件，并明确不能代替验签', async t => {
  const dir = await temporary(t)
  const output = path.join(dir, 'not-created', 'latest.json')
  const logs = []
  const value = await runCli(cliArgs(dir, ['--out', output]), { stdout() {}, stderr: text => logs.push(text) })
  assert.equal(value.version, '2.1.0')
  await assert.rejects(stat(path.dirname(output)), { code: 'ENOENT' })
  assert.match(logs.join('\n'), /DRY RUN/)
  assert.match(logs.join('\n'), /未验证安装包数字签名/)
})

test('显式写入可创建新目录，但绝不覆盖已有文件', async t => {
  const dir = await temporary(t)
  const output = path.join(dir, 'new', 'latest.json')
  await runCli(cliArgs(dir, ['--out', output, '--write']), quiet)
  const first = await readFile(output, 'utf8')
  assert.equal(JSON.parse(first).version, '2.1.0')
  await assert.rejects(runCli(cliArgs(dir, ['--out', output, '--write']), quiet), /拒绝覆盖/)
  assert.equal(await readFile(output, 'utf8'), first)
})

test('只读校验已有 JSON 输出有限信息', async t => {
  const dir = await temporary(t)
  const file = path.join(dir, 'latest.json')
  await writeFile(file, JSON.stringify(manifest()))
  const logs = []
  await runCli(['validate', '--file', file], { stdout: text => logs.push(text), stderr: text => logs.push(text) })
  assert.match(logs.join('\n'), /清单格式通过/)
  assert.match(logs.join('\n'), /未发布/)
})

test('无法解析的清单和签名错误不回显原始内容', async t => {
  const dir = await temporary(t)
  const file = path.join(dir, 'latest.json')
  await writeFile(file, 'unexpected sensitive content')
  await assert.rejects(runCli(['validate', '--file', file], quiet), error => /有效 JSON/.test(error.message) && !error.message.includes('sensitive'))
  await writeFile(path.join(dir, `${NAME}.sig`), 'private content mistaken for a signature')
  await assert.rejects(runCli(cliArgs(dir), quiet), error => !error.message.includes('private content'))
})

test('拒绝改名后的签名文件及误传密钥路径', async t => {
  const dir = await temporary(t)
  const args = cliArgs(dir)
  const signatureIndex = args.indexOf('--signature-file') + 1
  args[signatureIndex] = path.join(dir, 'renamed.exe.sig')
  await writeFile(args[signatureIndex], SIGNATURE)
  await assert.rejects(runCli(args, quiet), /文件名/)
  args[signatureIndex] = path.join(dir, 'private.key')
  await assert.rejects(runCli(args, quiet), /密钥文件/)
})

test('说明可来自文件，但不隐式读取环境变量或密钥', async t => {
  const dir = await temporary(t)
  const notesFile = path.join(dir, 'notes.md')
  await writeFile(notesFile, '## 改进\n\n- 支持更新提示。\n')
  const args = cliArgs(dir)
  args.splice(args.indexOf('--notes'), 2, '--notes-file', notesFile)
  const value = await runCli(args, quiet)
  assert.equal(value.notes, '## 改进\n\n- 支持更新提示。\n')
})

test('拒绝过大文件及非法 UTF-8，不创建输出', async t => {
  const dir = await temporary(t)
  const sig = path.join(dir, `${NAME}.sig`)
  await writeFile(sig, 'a'.repeat(8193))
  await assert.rejects(runCli(cliArgs(dir), quiet), /大小限制/)
  await writeFile(sig, Buffer.from([0xff, 0xfe, 0xff]))
  await assert.rejects(runCli(cliArgs(dir), quiet), /UTF-8/)
})

test('真实 CLI 帮助正常退出，输入错误以非零状态退出', () => {
  const script = fileURLToPath(new globalThis.URL('./release-manifest.mjs', import.meta.url))
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', windowsHide: true })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /Tauri 2/)
  const failed = spawnSync(process.execPath, [script, 'build'], { encoding: 'utf8', windowsHide: true })
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /更新清单失败/)
})
