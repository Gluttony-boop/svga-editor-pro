import { spawnSync } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildManifest, inspectSignature, normalizeVersion } from './release-manifest.mjs'
import { createUpdaterOverlay } from './prepare-updater-config.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAX_INSTALLER_BYTES = 256 * 1024 * 1024
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export const HELP = `签名 Windows 发布门禁（不读取私钥、不联网、不创建远程 Release）

  node scripts/release-check.mjs preflight --tag v2.1.0 --expected-sha <完整提交SHA>
  node scripts/release-check.mjs artifacts --tag v2.1.0 --expected-sha <完整提交SHA> --bundle-dir <nsis目录> --out <不存在的新目录>

环境变量：TAURI_UPDATER_PUBLIC_KEY、GITHUB_REPOSITORY；可选 TAURI_UPDATER_ENDPOINT。
artifacts 还要求 RELEASE_NOTES；可选 GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT 供追溯。
preflight 检查干净工作区、四处版本、Tag、SHA、公钥及更新端点。
artifacts 对实际 .exe 和 .sig 使用公钥验签，校验签名版本后才写入 latest.json、校验值与构建记录。
不会覆盖已有文件，不会自动发布或运行安装程序。CLI 仅支持本仓库的 Windows x86_64 NSIS 通道。`

function decodeBase64(value, label) {
  if (typeof value !== 'string' || !value || value.length > 8192 || !BASE64.test(value)) throw new Error(`${label}必须是规范 Base64，不能是路径或占位符。`)
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error(`${label}不是规范 Base64。`)
  return bytes
}

/** 只解析公钥封装；私钥永远不进入此发布检查工具。 */
export function inspectUpdaterPublicKey(value) {
  if (typeof value !== 'string' || value !== value.trim() || /[\r\n]/.test(value)) throw new Error('更新公钥必须为单行 Base64。')
  const envelope = decodeBase64(value, '更新公钥')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(envelope) } catch { throw new Error('更新公钥封装不是 UTF-8。') }
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  if (lines.length !== 2 || !/^untrusted comment: [^\r\n]+$/.test(lines[0])) throw new Error('更新公钥不是 Tauri/Minisign 公钥封装。')
  const data = decodeBase64(lines[1], 'Minisign 公钥')
  if (data.length !== 42 || data.subarray(0, 2).toString('ascii') !== 'Ed' || data.subarray(2, 10).every(byte => byte === 0) || data.subarray(10).every(byte => byte === 0)) {
    throw new Error('更新公钥算法、长度或内容无效。')
  }
  return {
    keyId: data.subarray(2, 10),
    key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: data.subarray(10).toString('base64url') }, format: 'jwk' }),
    fingerprint: sha256(data),
  }
}

/** 使用 Node 的 Ed25519 验证实现，同时绑定实际字节及 Minisign trusted comment。 */
export function verifyUpdaterArtifact({ installer, signature, publicKey, version, fileName }) {
  const signed = inspectSignature(signature)
  if (signed.fileName !== fileName) throw new Error('安装包文件名与签名不一致。')
  if (signed.version !== normalizeVersion(version)) throw new Error('签名必须包含与发布版本一致的 version；旧版无版本签名不允许发布。')
  if (!Buffer.isBuffer(installer) || installer.length < 2 || installer.length > MAX_INSTALLER_BYTES || installer.subarray(0, 2).toString('ascii') !== 'MZ') throw new Error('实际安装包必须是大小限制内的 Windows EXE。')
  const key = inspectUpdaterPublicKey(publicKey)
  const lines = Buffer.from(signed.signature, 'base64').toString('utf8').replace(/\r\n/g, '\n').trimEnd().split('\n')
  const body = Buffer.from(lines[1], 'base64')
  if (!key.keyId.equals(body.subarray(2, 10))) throw new Error('安装包签名 Key ID 与配置公钥不一致。')
  // ED 是 Minisign 的 BLAKE2b-512 预哈希模式，Ed 是兼容的原始消息模式。
  const message = body[1] === 0x44 ? createHash('blake2b512').update(installer).digest() : installer
  const payloadSignature = body.subarray(10)
  const trustedComment = Buffer.from(lines[2].slice('trusted comment: '.length), 'utf8')
  if (!verify(null, message, key.key, payloadSignature) || !verify(null, Buffer.concat([payloadSignature, trustedComment]), key.key, Buffer.from(lines[3], 'base64'))) {
    throw new Error('安装包或签名元数据验签失败，拒绝生成发布清单。')
  }
  return { publicKeySha256: key.fingerprint, installerSha256: sha256(installer), signatureSha256: sha256(Buffer.from(signed.signature)) }
}

export function validateReleaseContext({ packageJson, packageLock, tauriConfig, cargoToml, tag, sha, expectedSha, repository, publicKey, endpoint, status = '', localTagSha, branch, defaultBranch = 'master' }) {
  if (typeof tag !== 'string' || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) throw new Error('正式发布 Tag 必须是 vX.Y.Z；测试版应使用独立通道。')
  const version = normalizeVersion(tag)
  // 使用“输入末尾”判断，避免带 m 的 $ 在每一行都提前截断 Cargo package 段。
  const packageSection = /^\[package\]\s*\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(cargoToml || '')?.[1]
  const cargoVersion = /^version\s*=\s*"([^"]+)"\s*$/m.exec(packageSection || '')?.[1]
  if ([packageJson?.version, packageLock?.version, packageLock?.packages?.['']?.version, tauriConfig?.version, cargoVersion].some(value => value !== version)) throw new Error('发布 Tag 与 package.json、package-lock.json、Tauri、Cargo 版本不一致；请先更新并提交版本。')
  if (!/^[a-f0-9]{40}$/.test(expectedSha || '') || sha !== expectedSha) throw new Error('预期完整 SHA 与当前提交不一致，拒绝打包错误版本。')
  if (localTagSha) throw new Error('同名 Tag 已存在；签名发布必须使用全新的 Tag，不能重用或移动已有 Tag。')
  if (branch !== undefined && branch !== defaultBranch) throw new Error(`发布必须从默认分支 ${defaultBranch} 执行，当前分支为 ${branch || '未知'}。`)
  if (status) throw new Error('签名发布要求工作区干净；请先审核、提交并推送，不能用 --allow-dirty 绕过。')
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some(part => /^\.+$/.test(part))) throw new Error('GITHUB_REPOSITORY 必须是明确的 GitHub owner/repo。')
  if (!tauriConfig?.bundle?.active || !tauriConfig?.bundle?.targets?.includes('nsis')) throw new Error('正式 Windows 发布必须启用 NSIS 安装目标。')
  const publicKeyInfo = inspectUpdaterPublicKey(publicKey)
  const overlay = createUpdaterOverlay({ publicKey, repositoryName: repository, updateEndpoint: endpoint })
  return { version, tag, commit: sha, repository, publicKeySha256: publicKeyInfo.fingerprint, updateEndpoint: overlay.plugins.updater.endpoints[0] }
}

function git(root, args, allowMissing = false) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
  if (result.status !== 0) {
    if (allowMissing && result.status === 1) return undefined
    throw new Error('无法检查 Git 发布来源，未输出可能含凭据的原始错误。')
  }
  return result.stdout.trim()
}

export async function inspectRelease({ root = ROOT, tag, expectedSha, env = process.env, checkClean = true }) {
  const [packageJson, packageLock, tauriConfig, cargoToml] = await Promise.all([
    readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'package-lock.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'src-tauri/Cargo.toml'), 'utf8'),
  ])
  // Tag 先经过格式限制，避免输入被 Git 解释为选项或 revision expression。
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag || '')) throw new Error('正式发布 Tag 必须是 vX.Y.Z。')
  const localTagSha = git(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], true)
  const ref = env.GITHUB_REF?.startsWith('refs/heads/') ? env.GITHUB_REF.slice('refs/heads/'.length) : undefined
  return validateReleaseContext({ packageJson, packageLock, tauriConfig, cargoToml, tag, sha: git(root, ['rev-parse', 'HEAD']), expectedSha,
    repository: env.GITHUB_REPOSITORY, publicKey: env.TAURI_UPDATER_PUBLIC_KEY, endpoint: env.TAURI_UPDATER_ENDPOINT,
    status: checkClean ? git(root, ['status', '--porcelain=v1', '--untracked-files=all']) : '', localTagSha,
    branch: ref, defaultBranch: env.GITHUB_DEFAULT_BRANCH || 'master' })
}

async function readArtifact(file, maxBytes) {
  const stats = await lstat(file)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) throw new Error('签名产物必须是限制大小内的普通文件。')
  const bytes = await readFile(file)
  if (bytes.length > maxBytes) throw new Error('读取期间签名产物超出大小限制。')
  return bytes
}

export async function prepareReleaseArtifacts({ context, publicKey, notes, bundleDir, output, runId, runAttempt, now = new Date().toISOString() }) {
  if (!context || context.tag !== `v${context.version}` || !/^[a-f0-9]{40}$/.test(context.commit || '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository || '')) throw new Error('发布上下文无效；必须先执行发布预检。')
  const names = await readdir(bundleDir)
  const installers = names.filter(name => name.toLowerCase().endsWith('.exe'))
  if (installers.length !== 1) throw new Error('NSIS 目录应包含且仅包含一个 EXE 安装包。')
  const fileName = installers[0]
  if (!/^[^<>:"/\\|?*\x00-\x1f]+\.exe$/i.test(fileName) || /[ .]$/.test(fileName)) throw new Error('安装包文件名无效。')
  const installer = await readArtifact(path.join(bundleDir, fileName), MAX_INSTALLER_BYTES)
  const signature = (await readArtifact(path.join(bundleDir, `${fileName}.sig`), 8192)).toString('utf8').trim()
  const checked = verifyUpdaterArtifact({ installer, signature, publicKey, version: context.version, fileName })
  if (checked.publicKeySha256 !== context.publicKeySha256) throw new Error('构建前后更新公钥不一致。')
  const url = `https://github.com/${context.repository}/releases/download/${context.tag}/${encodeURIComponent(fileName)}`
  const manifest = buildManifest({ version: context.version, platform: 'windows-x86_64', url, signature, notes, pubDate: now })
  const files = new Map([
    [fileName, installer],
    [`${fileName}.sig`, Buffer.from(`${signature}\n`)],
    ['latest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
  ])
  const receipt = { schemaVersion: 1, ...context, platform: 'windows-x86_64', generatedAt: now,
    ...(runId ? { runId: String(runId), runUrl: `https://github.com/${context.repository}/actions/runs/${encodeURIComponent(runId)}` } : {}),
    ...(runAttempt ? { runAttempt: String(runAttempt) } : {}),
    verification: { installerSignature: 'passed', trustedCommentSignature: 'passed', signedVersion: 'passed', authenticode: 'not-tested', desktopUpgrade: 'not-tested' },
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, { size: bytes.length, sha256: sha256(bytes) }])),
  }
  files.set('release-receipt.json', Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`))
  files.set('SHA256SUMS.txt', Buffer.from(`${[...files].map(([name, bytes]) => `${sha256(bytes)}  ${name}`).join('\n')}\n`))
  // 最后才创建新目录；验签/版本失败不产生看似可发布的半成品。
  await mkdir(path.dirname(output), { recursive: true })
  try { await mkdir(output) } catch (error) {
    if (error.code === 'EEXIST') throw new Error('发布输出目录已存在；拒绝覆盖，请使用新目录。')
    throw error
  }
  for (const [name, bytes] of files) await writeFile(path.join(output, name), bytes, { flag: 'wx' })
  return { receipt, output, manifest }
}

export function parseArgs(args) {
  if (!args.length || (args.length === 1 && args[0] === '--help')) return { help: true }
  const [command, ...rest] = args
  if (!['preflight', 'artifacts'].includes(command)) throw new Error('仅支持 preflight / artifacts；使用 --help 查看用法。')
  const result = { command }
  const flags = { '--tag': 'tag', '--expected-sha': 'expectedSha', '--bundle-dir': 'bundleDir', '--out': 'output' }
  for (let index = 0; index < rest.length; index += 1) {
    const key = flags[rest[index]]
    if (!key || result[key] !== undefined) throw new Error('参数未知或重复；不允许通过命令参数传递密钥。')
    const value = rest[++index]
    if (!value || value.startsWith('--') || value.includes('\0')) throw new Error('发布参数缺少有效值。')
    result[key] = value
  }
  if (!result.tag || !result.expectedSha || (command === 'artifacts' && (!result.bundleDir || !result.output)) || (command === 'preflight' && (result.bundleDir || result.output))) throw new Error('发布参数不完整或不适用于当前命令。')
  if (!/^[a-f0-9]{40}$/i.test(result.expectedSha)) throw new Error('--expected-sha 必须是完整的 40 位十六进制提交 SHA。')
  return result
}

export async function main(args = process.argv.slice(2), { env = process.env, root = ROOT, log = console.log } = {}) {
  const options = parseArgs(args)
  if (options.help) { log(HELP); return }
  const context = await inspectRelease({ ...options, env, root, checkClean: options.command === 'preflight' })
  if (options.command === 'preflight') { log(`签名发布预检通过：${context.tag} / ${context.commit}；尚未构建或发布。`); return context }
  const result = await prepareReleaseArtifacts({ context, publicKey: env.TAURI_UPDATER_PUBLIC_KEY, notes: env.RELEASE_NOTES, bundleDir: path.resolve(options.bundleDir), output: path.resolve(options.output), runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT })
  log(`实际安装包及版本签名通过；已生成：${result.output}。尚未上传或发布，仍需真实桌面升级验收。`)
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`签名发布检查失败：${error.message}`); process.exitCode = 1 })
}
