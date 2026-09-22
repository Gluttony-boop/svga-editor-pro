import { mkdir, open, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_HOSTS = ['github.com']
const PLATFORM = /^(windows|darwin|linux)-(x86_64|aarch64|i686|armv7)$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const METADATA_WARNING = '仅校验更新清单与签名格式；未联网、未验证安装包数字签名、未发布。正式安装必须由 Tauri updater 使用内置公钥验签。'

export const HELP = `Tauri 2 静态更新清单工具（Node.js 20+，不需要私钥）

默认只预览，不写文件、不联网、不打 Tag、不上传或发布。

生成预览：
  node scripts/release-manifest.mjs build --version 2.1.0 --platform windows-x86_64 --url <HTTPS安装包地址> --signature-file <同名安装包.exe.sig> --notes <更新说明>

写入新文件（绝不覆盖）：
  在 build 命令后添加 --out release/2.1.0/latest.json --write

校验已有清单（包括所有平台）：
  node scripts/release-manifest.mjs validate --file release/2.1.0/latest.json

选项：
  --notes-file <文件>     从 UTF-8 文件读取说明，与 --notes 二选一
  --pub-date <RFC3339>    发布时间，默认当前 UTC 时间
  --allow-host <主机名>   允许一个额外 HTTPS 下载主机，可重复；默认仅 github.com
  --dry-run              显式只预览，与 --write 互斥
  --help                 显示帮助

仅支持 Tauri 2 原生安装包：Windows .exe/.msi、macOS .app.tar.gz、Linux .AppImage。
GitHub URL 必须固定到 releases/download/<tag>/<asset>，不能使用 latest/download。
URL 文件名、.sig 文件名与签名中的 file 元数据必须一致，不支持上传后改名。
不得传入私钥、公钥路径、Token 或签名 URL；这里只读取 Tauri 生成的 .sig 内容。
${METADATA_WARNING}`

function fail(message) {
  throw new Error(message)
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} 必须是普通对象。`)
}

function exactKeys(value, allowed, label) {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${label} 含未知字段。`)
}

export function normalizeVersion(value) {
  if (typeof value !== 'string' || value.length > 200) fail('版本号必须是有效 SemVer。')
  const version = value.startsWith('v') ? value.slice(1) : value
  if (!SEMVER.test(version)) fail('版本号必须是有效 SemVer，例如 2.1.0 或 2.1.0-beta.1。')
  return version
}

export function validateDate(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (!match) fail('pub_date 必须是带时区的 RFC3339 时间。')
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHour, offsetMinute] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || Number(dayText) < 1 || Number(dayText) > monthDays[month - 1] ||
    Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59 ||
    Number(offsetHour || 0) > 23 || Number(offsetMinute || 0) > 59) fail('pub_date 日期或时间无效；本工具不接受闰秒。')
  return value
}

function parseBase64(value, label) {
  if (typeof value !== 'string' || !value || !BASE64.test(value)) fail(`${label} 不是规范 Base64。`)
  const buffer = Buffer.from(value, 'base64')
  if (buffer.toString('base64') !== value) fail(`${label} 不是规范 Base64。`)
  return buffer
}

export function inspectSignature(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) fail('必须提供安装包对应的 .sig 内容，不能使用空签名或占位符。')
  const signature = value.trim()
  const decoded = parseBase64(signature, 'Tauri 签名')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(decoded) } catch { fail('Tauri 签名封装不是 UTF-8。') }
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  if (lines.length !== 4 || !/^untrusted comment: \S[^\r\n]*$/.test(lines[0]) ||
    /(?:placeholder|dummy|do not publish|not for publication)/i.test(text)) fail('签名封装无效；请使用 Tauri 为本次安装包生成的 .sig。')
  const trusted = /^trusted comment: timestamp:(0|[1-9]\d*)\tfile:([^\t\r\n/\\]+)(?:\tversion:([^\t\r\n]+))?$/.exec(lines[2])
  if (!trusted || /[\x00-\x1f\x7f]/.test(trusted[2]) || ['.', '..'].includes(trusted[2])) fail('签名缺少有效的 Tauri timestamp/file 元数据。')
  const body = parseBase64(lines[1], 'Minisign 签名')
  const global = parseBase64(lines[3], 'Minisign 全局签名')
  // 这里只校验格式，不能将长度正确的随机字节当作验签成功。
  if (body.length !== 74 || body[0] !== 0x45 || ![0x64, 0x44].includes(body[1]) || global.length !== 64 ||
    body.subarray(2, 10).every(byte => byte === 0) || body.subarray(10).every(byte => byte === body[10]) ||
    global.every(byte => byte === global[0])) fail('Minisign 数据长度、算法或签名字节无效。')
  if (trusted[3] !== undefined) normalizeVersion(trusted[3])
  return { signature, fileName: trusted[2], ...(trusted[3] !== undefined ? { version: normalizeVersion(trusted[3]) } : {}) }
}

function allowedHost(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase() ||
    isIP(value) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value) ||
    /\.(?:localhost|local|internal|invalid|test)$/.test(value)) fail('允许的主机必须是完整公网域名，不能带协议、端口、通配符或凭据。')
  return value
}

export function validateArtifactUrl(value, platform, allowedHosts = []) {
  if (!PLATFORM.test(platform)) fail('平台必须使用 OS-ARCH 格式，例如 windows-x86_64。')
  const hosts = new Set([...DEFAULT_HOSTS, ...allowedHosts.map(allowedHost)])
  if (typeof value !== 'string' || value.length > 4096 || /[\s\x00-\x1f\x7f\\]/.test(value)) fail('安装包 URL 必须是无空白的 HTTPS 地址。')
  let url
  try { url = new URL(value) } catch { fail('安装包 URL 无效。') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !hosts.has(url.hostname)) {
    fail('安装包 URL 必须使用允许主机的 HTTPS，不得含凭据、查询参数、片段或非标准端口。')
  }
  const parts = url.pathname.split('/').filter(Boolean)
  let fileName
  try { fileName = decodeURIComponent(parts.at(-1) || '') } catch { fail('安装包文件名编码无效。') }
  if (!fileName || /[/\\\x00-\x1f\x7f]/.test(fileName)) fail('安装包 URL 必须包含明确文件名。')
  if (url.hostname === 'github.com' && (parts.length !== 6 || parts[2] !== 'releases' || parts[3] !== 'download')) {
    fail('GitHub 安装包 URL 必须固定到 releases/download/<tag>/<asset>，不能指向网页或 latest。')
  }
  const extension = platform.startsWith('windows-') ? /\.(?:exe|msi)$/i : platform.startsWith('darwin-') ? /\.app\.tar\.gz$/ : /\.AppImage$/
  if (!extension.test(fileName)) fail('安装包扩展名与平台不符；本工具只生成 Tauri 2 原生更新清单，不支持 v1 ZIP。')
  return { url: url.href, fileName }
}

function validateNotes(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 65_536 || value.includes('\0')) fail('更新说明必须为非空 UTF-8 文本，最多 64 KiB。')
  return value
}

export function validateManifest(manifest, { allowedHosts = [] } = {}) {
  record(manifest, '更新清单')
  exactKeys(manifest, ['version', 'notes', 'pub_date', 'platforms'], '更新清单')
  const version = normalizeVersion(manifest.version)
  if (manifest.notes !== undefined) validateNotes(manifest.notes)
  if (manifest.pub_date !== undefined) validateDate(manifest.pub_date)
  record(manifest.platforms, 'platforms')
  const platforms = Object.entries(manifest.platforms)
  if (!platforms.length || platforms.length > 12) fail('platforms 必须包含 1–12 个完整平台配置。')
  const normalized = {}
  for (const [platform, release] of platforms) {
    record(release, '平台配置')
    exactKeys(release, ['url', 'signature'], '平台配置')
    const artifact = validateArtifactUrl(release.url, platform, allowedHosts)
    const signed = inspectSignature(release.signature)
    if (artifact.fileName !== signed.fileName) fail('URL 文件名与签名的 file 元数据不一致；请勿给签名后的产物改名。')
    if (signed.version !== undefined && signed.version !== version) fail('签名中的 version 与更新清单版本不一致；请使用同一版本的 Tauri 产物。')
    normalized[platform] = { url: artifact.url, signature: signed.signature }
  }
  return {
    version,
    ...(manifest.notes !== undefined ? { notes: manifest.notes } : {}),
    ...(manifest.pub_date !== undefined ? { pub_date: manifest.pub_date } : {}),
    platforms: normalized,
  }
}

export function buildManifest({ version, platform, url, signature, notes, pubDate = new Date().toISOString() }, options) {
  if (typeof platform !== 'string' || !PLATFORM.test(platform)) fail('平台必须使用 OS-ARCH 格式，例如 windows-x86_64。')
  validateNotes(notes)
  return validateManifest({ version, notes, pub_date: pubDate, platforms: { [platform]: { url, signature } } }, options)
}

export function parseArgs(args) {
  if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) return { help: true }
  const [command, ...rest] = args
  if (!['build', 'validate'].includes(command)) fail('命令必须为 build 或 validate；使用 --help 查看用法。')
  const options = { command, allowedHosts: [], write: false }
  const names = { '--version': 'version', '--platform': 'platform', '--url': 'url', '--signature-file': 'signatureFile', '--notes': 'notes', '--notes-file': 'notesFile', '--pub-date': 'pubDate', '--out': 'out', '--file': 'file' }
  const seen = new Set()
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === '--help') { options.help = true; continue }
    if (arg !== '--allow-host' && seen.has(arg)) fail('参数不可重复（--allow-host 除外）。')
    seen.add(arg)
    if (['--write', '--dry-run'].includes(arg)) { options[arg === '--write' ? 'write' : 'dryRun'] = true; continue }
    if (arg !== '--allow-host' && !names[arg]) fail('未知选项；不接受私钥或 Token 参数。使用 --help 查看用法。')
    const value = rest[++index]
    if (!value || value.startsWith('--') || value.includes('\0')) fail('选项缺少有效值。')
    if (arg === '--allow-host') options.allowedHosts.push(allowedHost(value))
    else options[names[arg]] = value
  }
  if (options.help) return options
  if (options.write && options.dryRun) fail('--write 和 --dry-run 不能同时使用。')
  if (command === 'validate') {
    if (!options.file || Object.keys(names).some(flag => flag !== '--file' && seen.has(flag)) || options.write) fail('validate 仅接受 --file、--allow-host 和 --dry-run。')
  } else {
    if (options.file) fail('build 不接受 --file；校验已有清单请使用 validate。')
    if (['version', 'platform', 'url', 'signatureFile'].some(key => !options[key])) fail('build 需要 --version、--platform、--url 和 --signature-file。')
    if (Boolean(options.notes) === Boolean(options.notesFile)) fail('--notes 和 --notes-file 必须且只能提供一个。')
    if (options.write && !options.out) fail('--write 必须同时提供显式 --out 路径。')
    if (options.out && path.extname(options.out).toLowerCase() !== '.json') fail('--out 必须是明确的 .json 文件路径。')
  }
  return options
}

async function readLimited(file, limit, label) {
  let handle
  try {
    handle = await open(file, 'r')
    const info = await handle.stat()
    if (!info.isFile() || info.size > limit) fail(`${label} 必须是大小限制内的普通文件。`)
    const content = await handle.readFile()
    if (content.length > limit) fail(`${label} 超过大小限制。`)
    try { return new TextDecoder('utf-8', { fatal: true }).decode(content) } catch { fail(`${label} 必须是 UTF-8 文本。`) }
  } catch (error) {
    if (error.code) fail(`${label} 无法读取，请检查路径与权限。`)
    throw error
  } finally { await handle?.close() }
}

export async function runCli(args, { stdout = text => process.stdout.write(`${text}\n`), stderr = text => process.stderr.write(`${text}\n`) } = {}) {
  const options = parseArgs(args)
  if (options.help) { stdout(HELP); return }
  if (options.command === 'validate') {
    const text = await readLimited(options.file, 1_048_576, '清单文件')
    let manifest
    try { manifest = JSON.parse(text) } catch { fail('清单文件不是有效 JSON；未回显文件内容。') }
    const valid = validateManifest(manifest, options)
    stdout(`清单格式通过：${valid.version}；平台：${Object.keys(valid.platforms).join(', ')}`)
    stderr(METADATA_WARNING)
    return valid
  }
  if (!options.signatureFile.endsWith('.sig')) fail('--signature-file 必须指向 Tauri 生成的 .sig 文件，不接收密钥文件。')
  const signature = await readLimited(options.signatureFile, 8192, '签名文件')
  const signed = inspectSignature(signature)
  if (path.basename(options.signatureFile) !== `${signed.fileName}.sig`) fail('.sig 文件名与其 file 元数据不一致。')
  const notes = options.notesFile ? await readLimited(options.notesFile, 65_536, '更新说明文件') : options.notes
  const manifest = buildManifest({ ...options, signature, notes }, options)
  const json = `${JSON.stringify(manifest, null, 2)}\n`
  if (options.write) {
    const output = path.resolve(options.out)
    await mkdir(path.dirname(output), { recursive: true })
    try { await writeFile(output, json, { encoding: 'utf8', flag: 'wx' }) } catch (error) {
      if (error.code === 'EEXIST') fail('输出文件已存在，已拒绝覆盖。请选择新目录或新文件名。')
      fail('清单写入失败，请检查输出路径与权限；未发布远程文件。')
    }
    stdout(`已生成本地清单：${output}`)
  } else {
    stdout(json.trimEnd())
    stderr('DRY RUN：没有写入文件。确认后添加 --out <新文件.json> --write。')
  }
  stderr(METADATA_WARNING)
  return manifest
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`更新清单失败：${error.message}\n`)
    process.exitCode = 1
  })
}
