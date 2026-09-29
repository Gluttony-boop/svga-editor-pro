import { execFileSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..')

const LEVEL_ORDER = { pass: 0, warn: 1, block: 2 }

export const HELP = `商业化上线前预检（只读，不读取私钥、不联网、不部署）

用法：node scripts/commercial-preflight.mjs [选项]

选项：
  --strict       将所有待配置项（warn）也视为失败，适合 CI 上线门禁
  --json         输出机器可读 JSON
  --root <目录>  指定项目根目录（主要用于测试）
  --help         显示帮助

预检内容：版本一致性、Tauri 更新门卫、桌面授权配置、CI 工作流、交付脚本和工作区状态。
本工具不会读取环境变量中的密钥，不会请求网络，也不会修改文件。`

function result(id, level, title, detail) {
  return { id, level, title, detail }
}

function readJson(text, label) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} 不是有效 JSON。`)
  }
}

async function readRequired(root, relative) {
  try {
    return await readFile(path.join(root, relative), 'utf8')
  } catch {
    throw new Error(`缺少必要文件：${relative}`)
  }
}

async function readOptional(root, relative) {
  try {
    return await readFile(path.join(root, relative), 'utf8')
  } catch {
    return null
  }
}

function versionFromCargo(text) {
  const match = /^version\s*=\s*"([^"]+)"/m.exec(text)
  return match?.[1] ?? null
}

function staticHttps(value, label) {
  if (typeof value !== 'string' || !value.trim()) return `${label}未配置。`
  let url
  try { url = new URL(value) } catch { return `${label}不是有效 URL。` }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
    return `${label}必须是无凭据、无查询参数的 HTTPS 地址。`
  }
  return null
}

function validateLicenseConfig(value) {
  if (value === undefined) return '未配置 license；当前桌面版不会联网激活。'
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'license 配置必须是对象。'
  const endpointError = staticHttps(value.endpoint, '授权 endpoint')
  if (endpointError) return endpointError
  if (typeof value.issuer !== 'string' || !value.issuer || typeof value.audience !== 'string' || !value.audience || typeof value.kid !== 'string' || !value.kid) {
    return '授权配置缺少 issuer、audience 或 kid。'
  }
  if (typeof value.publicKey !== 'string' || !value.publicKey.trim()) return '授权公钥未配置。'
  try {
    const jwk = JSON.parse(value.publicKey)
    if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk) || jwk.d !== undefined || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') return '授权公钥不是不含私钥的 Ed25519 JWK。'
  } catch {
    return '授权公钥不是有效 JSON JWK。'
  }
  return null
}

function validateUpdaterConfig(value) {
  if (value === undefined) return '未配置 updater；桌面检查更新会保持关闭。'
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'updater 配置必须是对象。'
  if (typeof value.pubkey !== 'string' || !value.pubkey.trim()) return 'updater 公钥未配置。'
  if (!Array.isArray(value.endpoints) || value.endpoints.length === 0) return 'updater 至少需要一个静态 HTTPS endpoint。'
  for (const endpoint of value.endpoints) {
    const error = staticHttps(endpoint, '更新 endpoint')
    if (error) return error
  }
  if (value.requireSignedVersion !== true) return 'updater 必须启用 requireSignedVersion。'
  for (const key of ['allowDowngrades', 'dangerousInsecureTransportProtocol', 'dangerousAcceptInvalidCerts', 'dangerousAcceptInvalidHostnames']) {
    if (value[key] === true) return `updater 禁止启用危险选项 ${key}。`
  }
  return null
}

function gitStatus(root) {
  try {
    return execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function trackedSuspiciousFiles(root) {
  try {
    const output = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    return output.split(/\r?\n/).filter(Boolean).filter(file => /(?:^|[\\/])(?:\.env(?:\.|$)|\.dev\.vars$|wrangler\.local|.*private[-_]?key.*)$/i.test(file))
  } catch {
    return []
  }
}

export function parseArgs(args) {
  const options = { strict: false, json: false, root: DEFAULT_ROOT, help: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (arg === '--strict') { options.strict = true; continue }
    if (arg === '--json') { options.json = true; continue }
    if (arg === '--root') {
      const value = args[++index]
      if (!value || value.startsWith('-')) throw new Error('--root 需要一个目录。')
      options.root = path.resolve(value)
      continue
    }
    throw new Error(`未知选项：${arg}。使用 --help 查看帮助。`)
  }
  return options
}

export async function collectChecks(root = DEFAULT_ROOT, { git = true } = {}) {
  const checks = []
  const packageText = await readRequired(root, 'package.json')
  const tauriText = await readRequired(root, 'src-tauri/tauri.conf.json')
  const cargoText = await readRequired(root, 'src-tauri/Cargo.toml')
  const packageJson = readJson(packageText, 'package.json')
  const tauri = readJson(tauriText, 'src-tauri/tauri.conf.json')
  const cargoVersion = versionFromCargo(cargoText)
  const versions = [packageJson.version, tauri.version, cargoVersion]
  if (versions.every(version => typeof version === 'string' && version === versions[0])) {
    checks.push(result('versions', 'pass', '版本一致', `package.json、tauri.conf.json 与 Cargo.toml 均为 ${versions[0]}。`))
  } else {
    checks.push(result('versions', 'block', '版本不一致', `检测到 ${versions.filter(Boolean).join(' / ')}；发布前必须统一版本号。`))
  }

  const bundle = tauri.bundle && typeof tauri.bundle === 'object' ? tauri.bundle : {}
  if (Array.isArray(bundle.targets) && bundle.targets.includes('nsis')) checks.push(result('windows-bundle', 'pass', 'Windows 安装目标已声明', 'bundle.targets 包含 nsis。'))
  else checks.push(result('windows-bundle', 'block', '缺少 Windows 安装目标', 'bundle.targets 必须包含 nsis，才能生成桌面 Windows 安装包。'))

  const updaterError = validateUpdaterConfig(tauri.plugins?.updater)
  checks.push(updaterError ? result('updater', 'warn', '桌面更新尚未接通', updaterError) : result('updater', 'pass', '桌面更新配置形状通过', '端点、公钥、签名版本和危险开关满足本地门卫。'))

  const licenseError = validateLicenseConfig(tauri.plugins?.license)
  checks.push(licenseError ? result('license', 'warn', '桌面授权尚未接通', licenseError) : result('license', 'pass', '桌面授权配置形状通过', '授权端点、公钥和固定身份字段满足本地门卫。'))

  const requiredScripts = ['package:github', 'release:manifest', 'test:licensing', 'test:release-manifest']
  const missingScripts = requiredScripts.filter(name => typeof packageJson.scripts?.[name] !== 'string')
  checks.push(missingScripts.length ? result('scripts', 'block', '发布脚本不完整', `缺少 npm 脚本：${missingScripts.join('、')}。`) : result('scripts', 'pass', '发布脚本齐全', '一键打包、清单校验和授权原型检查入口均存在。'))

  const requiredFiles = [
    '.github/workflows/package-windows.yml',
    '.github/workflows/commercial-foundations.yml',
    'scripts/package-github.mjs',
    'scripts/release-manifest.mjs',
    'docs/commercial/STATUS.md',
  ]
  const missingFiles = []
  for (const relative of requiredFiles) {
    try { await access(path.join(root, relative)) } catch { missingFiles.push(relative) }
  }
  checks.push(missingFiles.length ? result('artifacts', 'block', '商业化基础文件缺失', missingFiles.join('、')) : result('artifacts', 'pass', '商业化基础文件齐全', 'CI、清单工具和状态文档均可找到。'))

  const resourcesReadme = await readOptional(root, 'src-tauri/resources/README.md')
  if (resourcesReadme?.toLowerCase().includes('secret') || resourcesReadme?.includes('私钥')) checks.push(result('resource-boundary', 'pass', '桌面资源边界有说明', '资源目录明确提示不得放入授权或更新私钥。'))
  else checks.push(result('resource-boundary', 'warn', '桌面资源边界说明不足', '请确认安装包 resources 目录不包含授权码、刷新令牌或签名私钥。'))

  const suspicious = trackedSuspiciousFiles(root)
  checks.push(suspicious.length ? result('tracked-secrets', 'block', '疑似敏感文件已被 Git 跟踪', suspicious.join('、')) : result('tracked-secrets', 'pass', '未发现明显敏感文件名', '仅按 Git 跟踪文件名检查，未读取任何密钥内容。'))

  if (git) {
    const status = gitStatus(root)
    checks.push(status === null ? result('git', 'warn', '无法读取 Git 状态', '请在 Git 仓库内运行预检。') : status ? result('git', 'warn', '工作区存在未提交修改', '发布前应提交并推送；本预检不会自动提交或丢弃修改。') : result('git', 'pass', '工作区干净', '当前没有未提交或未跟踪文件。'))
  }
  return checks
}

export function summarize(checks) {
  return checks.reduce((summary, check) => {
    summary[check.level] += 1
    return summary
  }, { pass: 0, warn: 0, block: 0 })
}

export function formatText(checks, { strict = false } = {}) {
  const summary = summarize(checks)
  const lines = ['SVGA Editor Pro 商业化预检', '']
  for (const check of checks) {
    const marker = check.level === 'pass' ? '通过' : check.level === 'warn' ? '待配置' : '阻断'
    lines.push(`[${marker}] ${check.title}：${check.detail}`)
  }
  lines.push('', `汇总：${summary.pass} 项通过，${summary.warn} 项待配置，${summary.block} 项阻断。`)
  lines.push(strict && summary.warn ? '结论：strict 模式将待配置项视为失败。' : summary.block ? '结论：尚不能进入发布流程。' : '结论：本地预检通过；仍需按文档完成外部账户、密钥和真实桌面验收。')
  return lines.join('\n')
}

export async function runCli(args = process.argv.slice(2), { stdout = text => process.stdout.write(`${text}\n`), stderr = text => process.stderr.write(`${text}\n`) } = {}) {
  const options = parseArgs(args)
  if (options.help) { stdout(HELP); return { exitCode: 0 } }
  const checks = await collectChecks(options.root)
  const summary = summarize(checks)
  if (options.json) stdout(JSON.stringify({ root: options.root, checks, summary }, null, 2))
  else stdout(formatText(checks, options))
  const failed = summary.block > 0 || (options.strict && summary.warn > 0)
  if (failed) stderr('预检未通过；未修改文件、未联网、未读取私钥。')
  return { exitCode: failed ? 1 : 0, checks, summary }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().then(({ exitCode }) => { process.exitCode = exitCode }).catch(error => {
    process.stderr.write(`商业化预检失败：${error.message}\n`)
    process.exitCode = 1
  })
}
