import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { inspectPublishPlan, logPublishPlan, publishWorkspace } from './publish-workspace.mjs'

const API_ORIGIN = 'https://api.github.com'
export const WORKFLOW = 'package-windows.yml'
export const ARTIFACT = 'svga-editor-pro-windows-installer'
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const HELP = `GitHub 一键打包（Node.js 20+，默认自动检查、提交、推送、云端构建和下载）

用法：npm run package:github -- [选项]
  --dry-run             展示待提交文件与完整计划；不联网、不提交、不读取凭据
  --no-publish          不提交、不推送，仅打包已推送的干净 HEAD
  --allow-dirty         忽略本地改动打包旧 HEAD（隐含 --no-publish）
  --message <说明>      自动提交的说明，默认 chore: prepare one-click Windows package
  --ref <分支>          默认当前分支；自动发布不能改写其他分支
  --remote <名称>       Git remote 名称，默认 origin（仅支持 github.com）
  --timeout <分钟>      排队与构建等待上限，默认 60，范围 1–180
  --poll <秒>           状态轮询间隔，默认 10，范围 2–60
  --token-stdin         从标准输入读取 Token，禁止在命令参数中直接传入 Token
  --help                显示帮助

凭据顺序：--token-stdin → GH_TOKEN → GITHUB_TOKEN → gh 登录 → Git 凭据管理器。
成功后下载到 release/<提交>-<run ID>-<随机后缀>/，校验 ZIP 与安装包 SHA-256。
默认会提交所有未被 Git 忽略的改动（包括已暂存内容和删除），不会打 Tag 或创建 Release。
若当前就是默认分支，新版脚本和 workflow 会一并自动提交推送；无需手动准备 Git 命令。
合并冲突、敏感文件、检查失败或非快进推送会停止，不强制覆盖，不丢弃本地文件。`

export function parseArgs(args) {
  const options = { remote: 'origin', timeout: 60, poll: 10 }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const flags = { '--help': 'help', '--dry-run': 'dryRun', '--no-publish': 'noPublish', '--allow-dirty': 'allowDirty', '--token-stdin': 'tokenStdin' }
    if (flags[arg]) { options[flags[arg]] = true; continue }
    if (!['--ref', '--remote', '--timeout', '--poll', '--message'].includes(arg)) {
      throw new Error('存在未知参数。使用 --help 查看用法；Token 只能通过环境变量或 --token-stdin 提供。')
    }
    const value = args[++index]
    if (!value || value.startsWith('-')) throw new Error('选项缺少有效值，请使用 --help 查看用法。')
    options[arg.slice(2)] = value
  }
  for (const [key, min, max] of [['timeout', 1, 180], ['poll', 2, 60]]) {
    const value = Number(options[key])
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 必须是 ${min}–${max} 之间的整数。`)
    options[key] = value
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(options.remote)) throw new Error('Git remote 名称无效。')
  if (options.message !== undefined && (!options.message.trim() || options.message.length > 2000 || options.message.includes('\0'))) throw new Error('提交说明必须为 1–2000 个有效字符。')
  if (options.allowDirty) options.noPublish = true
  return options
}

export function parseRepository(remoteUrl) {
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remoteUrl)
  let slug
  if (ssh) slug = `${ssh[1]}/${ssh[2]}`
  else {
    let url
    try { url = new URL(remoteUrl) } catch { throw new Error('远端必须是 github.com 仓库的 HTTPS 或 SSH 地址。') }
    const allowed = url.protocol === 'https:' ? !url.username : url.protocol === 'ssh:' && url.username === 'git'
    if (!allowed || url.password || url.hostname !== 'github.com' || url.port || url.search || url.hash) {
      throw new Error('仅支持无内嵌凭据的 github.com HTTPS/SSH 远端。')
    }
    slug = url.pathname.replace(/^\//, '').replace(/\.git$/, '')
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug) || slug.split('/').some(part => /^\.+$/.test(part))) {
    throw new Error('远端仓库名称无效。')
  }
  return slug
}

function command(executable, args, { input, cwd = process.cwd(), env = process.env } = {}) {
  return spawnSync(executable, args, { cwd, input, env, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
}

export function inspectCheckout(options, run = command) {
  const git = args => {
    const result = run('git', args)
    if (result.status !== 0) throw new Error('Git 本地检查失败，请确认位于有效仓库中且已安装 Git。')
    return result.stdout.trim()
  }
  const root = git(['rev-parse', '--show-toplevel'])
  const sha = git(['rev-parse', 'HEAD'])
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('无法确定当前完整提交 SHA。')
  const dirty = git(['status', '--porcelain=v1', '--untracked-files=normal']) !== ''
  if (dirty && options.noPublish && !options.allowDirty) throw new Error('--no-publish 要求工作区干净。直接运行 npm run package:github 可自动提交推送；仅打包旧 HEAD 请用 --allow-dirty。')
  const branch = options.ref ? null : run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (!options.ref && branch.status !== 0) throw new Error('当前处于分离 HEAD 状态，请使用 --ref 指定远端分支。')
  const ref = options.ref || branch.stdout.trim()
  if (run('git', ['check-ref-format', '--branch', ref]).status !== 0) throw new Error('分支名称无效；分离 HEAD 请使用 --ref 指定远端分支。')
  const remoteUrl = git(['remote', 'get-url', options.remote])
  const repository = parseRepository(remoteUrl)
  return { root, sha, dirty, ref, repository, remoteUrl }
}

export async function resolveToken(options, { env = process.env, run = command, readStdin = async () => {
  let result = ''
  for await (const chunk of process.stdin) {
    result += chunk.toString()
    if (result.length > 16_384) throw new Error('Token 输入过长。')
  }
  return result
} } = {}) {
  const clean = value => typeof value === 'string' && /^[^\s]+$/.test(value.trim()) ? value.trim() : null
  if (options.tokenStdin) {
    const token = clean(await readStdin())
    if (!token) throw new Error('标准输入未提供有效 Token。')
    return token
  }
  for (const value of [env.GH_TOKEN, env.GITHUB_TOKEN]) {
    const token = clean(value)
    if (token) return token
  }
  const gh = run('gh', ['auth', 'token', '--hostname', 'github.com'], { env: { ...env, GH_PROMPT_DISABLED: '1' } })
  if (gh.status === 0 && clean(gh.stdout)) return clean(gh.stdout)
  // 捕获凭据输出，只在内存中使用；禁止打印 stderr 或把密码放入命令参数。
  const credential = run('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  })
  if (credential.status === 0) {
    const value = credential.stdout.split(/\r?\n/).find(line => line.startsWith('password='))?.slice(9)
    if (clean(value)) return clean(value)
  }
  throw new Error('未找到 GitHub 凭据。请先 gh auth login，或设置 GH_TOKEN / GITHUB_TOKEN；需目标仓库 Actions 读写权限。')
}

export function createGitHubClient(token, fetchImpl = fetch) {
  async function raw(endpoint, { method = 'GET', body } = {}) {
    if (!endpoint.startsWith('/repos/') || endpoint.includes('://') || endpoint.includes('\\')) throw new Error('拒绝非 GitHub 仓库 API 地址。')
    let response
    try {
      response = await fetchImpl(`${API_ORIGIN}${endpoint}`, {
        method, redirect: 'manual', signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'svga-editor-pro-packaging',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch {
      throw new Error(method === 'POST'
        ? '打包请求网络中断，结果未知。请按已显示的请求 ID 检查 Actions；脚本不会自动重复提交。'
        : 'GitHub API 请求失败或超时，请检查网络；未输出认证信息。')
    }
    return response
  }
  async function json(endpoint, options) {
    const response = await raw(endpoint, options)
    if (!response.ok) {
      const hints = { 401: '凭据无效或已过期', 403: '权限不足、触发频率受限或 Actions 被禁用', 404: '仓库/分支/工作流不存在，或当前凭据不可见', 422: '工作流输入不匹配，请先推送新版 workflow' }
      throw new Error(`GitHub API HTTP ${response.status}：${hints[response.status] || '请求未成功，请查看 GitHub Status 和 Actions 页面'}。`)
    }
    if (response.status === 204) return null
    try { return await response.json() } catch {
      // JSON 原生错误可能包含响应正文片段，不能把代理回显的认证信息带进终端。
      throw new Error(options?.method === 'POST'
        ? '打包请求响应格式无效或读取中断，结果未知。请按请求 ID 检查 Actions，勿直接重复触发。'
        : 'GitHub API 响应格式无效或读取中断，未输出响应正文。')
    }
  }
  return { json, raw, fetchImpl }
}

export async function checkGitHubStatus(fetchImpl = fetch, log = console.log) {
  let status
  try {
    const response = await fetchImpl('https://www.githubstatus.com/api/v2/summary.json', { redirect: 'error', signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error()
    status = await response.json()
  } catch {
    log('提示：无法读取 GitHub Status，继续检查仓库与工作流。')
    return
  }
  const actions = status.components?.find(component => component.name === 'Actions')
  if (actions && actions.status !== 'operational') throw new Error('GitHub Actions 当前服务异常，未触发打包。请查看 https://www.githubstatus.com/ 后重试。')
}

export function verifyWorkflowContract(content) {
  return /^\s+request_id:\s*$/m.test(content) && /^\s+expected_sha:\s*$/m.test(content)
    && /^run-name:.*inputs\.request_id.*Windows package/m.test(content)
}

export async function preflight(client, context) {
  const prefix = `/repos/${context.repository}`
  const repo = await client.json(prefix)
  if (repo.archived || repo.disabled) throw new Error('目标仓库已归档或禁用，无法打包。')
  const branch = await client.json(`${prefix}/git/ref/heads/${encodeURIComponent(context.ref)}`)
  if (branch.object?.sha !== context.sha) throw new Error('远端分支与本地 HEAD 不一致，未触发打包。默认模式会自动推送；若远端同时发生变更请先同步，--no-publish 不执行推送。')
  const workflow = await client.json(`${prefix}/actions/workflows/${WORKFLOW}`)
  if (workflow.state !== 'active') throw new Error('Windows 打包工作流尚未启用，请在 GitHub Actions 中检查。')
  for (const ref of new Set([repo.default_branch, context.sha])) {
    const file = await client.json(`${prefix}/contents/.github/workflows/${WORKFLOW}?ref=${encodeURIComponent(ref)}`)
    if (file.encoding !== 'base64' || !verifyWorkflowContract(Buffer.from(file.content || '', 'base64').toString('utf8'))) {
      throw new Error('默认分支或待打包提交缺少新版一键打包 workflow。请先推送 request_id / expected_sha 与 run-name 配置。')
    }
  }
  return workflow.id
}

export function findRequestedRun(runs, context) {
  const matches = runs.filter(run => run.display_title === `Windows package [${context.requestId}]`)
  if (matches.length > 1) throw new Error('同一请求 ID 匹配到多个运行，拒绝猜测安装包来源。')
  const run = matches[0]
  if (!run) return null
  if (run.event !== 'workflow_dispatch' || run.head_branch !== context.ref || run.head_sha !== context.sha || run.workflow_id !== context.workflowId) {
    throw new Error('本次运行的分支、提交或工作流不一致（分支可能在请求期间变化），已停止，不下载错误版本。')
  }
  return run
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function dispatchAndWait(client, context, options, { log = console.log, sleep = wait, now = () => performance.now() } = {}) {
  const prefix = `/repos/${context.repository}`
  const deadline = now() + options.timeout * 60_000
  log(`请求 ID：${context.requestId}`)
  // POST 不重试，避免网络响应丢失时重复启动计费构建。
  const dispatched = await client.json(`${prefix}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST', body: { ref: context.ref, inputs: { request_id: context.requestId, expected_sha: context.sha } },
  })
  let runId = Number.isSafeInteger(dispatched?.workflow_run_id) ? dispatched.workflow_run_id : null
  let current = null
  let lastStatus = ''
  while (now() < deadline) {
    if (runId) {
      const run = await client.json(`${prefix}/actions/runs/${runId}`)
      current = findRequestedRun([run], context)
      if (!current) throw new Error('API 返回的运行不属于本次请求，已停止。')
    } else {
      for (let page = 1; page <= 10 && now() < deadline; page += 1) {
        // 唯一 ID 已足够区分请求，不依赖本机时钟与 GitHub 时钟一致。
        const query = new URLSearchParams({ event: 'workflow_dispatch', branch: context.ref, per_page: '100', page: String(page) })
        const result = await client.json(`${prefix}/actions/workflows/${WORKFLOW}/runs?${query}`)
        current = findRequestedRun(result.workflow_runs || [], context)
        if (current || (result.workflow_runs || []).length < 100) break
      }
      if (current) runId = current.id
    }
    if (current) {
      if (!lastStatus) log(`运行：https://github.com/${context.repository}/actions/runs/${runId}`)
      const status = `${current.status}${current.conclusion ? ` / ${current.conclusion}` : ''}`
      if (status !== lastStatus) { log(`打包状态：${status}`); lastStatus = status }
      if (current.status === 'completed') {
        if (current.conclusion !== 'success') {
          let failures = ''
          try {
            const result = await client.json(`${prefix}/actions/runs/${runId}/jobs?per_page=100`)
            failures = (result.jobs || []).flatMap(job => (job.steps || []).filter(step => step.conclusion === 'failure').map(step => `${job.name} / ${step.name}`)).join('；')
          } catch { /* 无读取日志权限时仍报告原始构建失败。 */ }
          throw new Error(`GitHub 打包未成功：${current.conclusion}${failures ? `，失败步骤：${failures}` : ''}。请查看上述运行链接。`)
        }
        return current
      }
    }
    await sleep(Math.max(0, Math.min(options.poll * 1000, deadline - now())))
  }
  throw new Error(`等待打包超时，未取消远端任务。请在 GitHub Actions 按请求 ID ${context.requestId} 查看进度并下载产物。`)
}

async function limitedBody(response, maxBytes) {
  if (!response.body) throw new Error('下载响应没有文件内容。')
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('下载文件超过安全大小限制。')
  const chunks = []
  let length = 0
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > maxBytes) throw new Error('下载文件超过安全大小限制。')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export async function downloadArchive(client, repository, artifactId) {
  let response = await client.raw(`/repos/${repository}/actions/artifacts/${artifactId}/zip`)
  for (let redirects = 0; [301, 302, 303, 307, 308].includes(response.status); redirects += 1) {
    if (redirects >= 5) throw new Error('安装包下载重定向过多。')
    let target
    try { target = new URL(response.headers.get('location')) } catch { throw new Error('安装包下载地址无效。') }
    if (target.protocol !== 'https:' || target.username || target.password) throw new Error('拒绝不安全的安装包下载重定向。')
    // 预签名地址自身包含短期授权，不携带 GitHub Token，也不打印其 URL。
    try {
      response = await client.fetchImpl(target.href, { redirect: 'manual', signal: AbortSignal.timeout(120_000), headers: { Accept: 'application/octet-stream' } })
    } catch { throw new Error('安装包下载网络中断或超时，未暴露预签名地址。') }
  }
  if (!response.ok) throw new Error(`安装包下载失败（HTTP ${response.status}）。`)
  try { return await limitedBody(response, MAX_ARCHIVE_BYTES) } catch {
    // 底层流错误也可能包含预签名地址；仅保留不会泄露凭据的摘要。
    throw new Error('安装包下载未完整完成或超过安全大小限制，未保存文件。')
  }
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

async function readZipEntry(entry, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    const stream = entry.internalStream('nodebuffer')
    stream.on('data', chunk => {
      size += chunk.length
      if (size > maxBytes) { stream.pause(); reject(new Error('压缩包解压大小超过安全限制。')); return }
      chunks.push(chunk)
    }).on('error', () => reject(new Error('安装包 ZIP 解压失败。')))
      .on('end', () => resolve(Buffer.concat(chunks))).resume()
  })
}

export async function verifyArchive(bytes, artifact) {
  const archiveHash = sha256(bytes)
  if (!/^sha256:[a-f0-9]{64}$/i.test(artifact.digest || '') || artifact.digest.toLowerCase() !== `sha256:${archiveHash}`) {
    throw new Error('ZIP 的 SHA-256 与 GitHub artifact digest 不一致或校验值缺失，拒绝保存安装包。')
  }
  let zip
  try { zip = await JSZip.loadAsync(bytes) } catch { throw new Error('下载产物不是有效 ZIP。') }
  const entries = Object.values(zip.files)
  const validName = name => /^[^<>:"/\\|?*\x00-\x1f]+$/.test(name) && !/[ .]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  for (const entry of entries) {
    const originalName = entry.unsafeOriginalName ?? entry.name
    if (entry.dir || !validName(originalName) || originalName !== entry.name || ((Number(entry.unixPermissions) >> 12) & 15) === 10) {
      throw new Error('ZIP 包含目录、路径穿越、符号链接或非法文件名，拒绝解压。')
    }
  }
  const installers = entries.filter(entry => entry.name.toLowerCase().endsWith('.exe'))
  const checksumEntry = zip.file('SHA256SUMS.txt')
  if (entries.length !== 2 || installers.length !== 1 || !checksumEntry) throw new Error('产物应仅包含一个 .exe 安装包及 SHA256SUMS.txt，请确认已推送新版 workflow。')
  const checksums = (await readZipEntry(checksumEntry, 16_384)).toString('utf8').trim()
  const checksum = /^([a-f0-9]{64})  (.+)$/i.exec(checksums)
  if (!checksum || checksum[2] !== installers[0].name) throw new Error('安装包校验清单无效或文件名不匹配。')
  const installer = await readZipEntry(installers[0], MAX_ARCHIVE_BYTES)
  const installerHash = sha256(installer)
  if (installerHash !== checksum[1].toLowerCase() || installer.subarray(0, 2).toString('ascii') !== 'MZ') throw new Error('安装包 SHA-256 或 Windows 可执行文件格式校验失败。')
  return { archiveHash, installerHash, installer, installerName: installers[0].name, checksums }
}

export async function saveArtifact(client, context, run) {
  const result = await client.json(`/repos/${context.repository}/actions/runs/${run.id}/artifacts?per_page=100`)
  const artifacts = (result.artifacts || []).filter(artifact => artifact.name === ARTIFACT && !artifact.expired)
  if (artifacts.length !== 1) throw new Error('未找到唯一且未过期的 Windows 安装包产物，请查看运行页面。')
  const artifact = artifacts[0]
  if (artifact.workflow_run && (artifact.workflow_run.id !== run.id || artifact.workflow_run.head_sha !== context.sha)) throw new Error('产物所属运行或提交与本次请求不一致。')
  const bytes = await downloadArchive(client, context.repository, artifact.id)
  const verified = await verifyArchive(bytes, artifact)
  const release = path.join(context.root, 'release')
  await mkdir(release, { recursive: true })
  if ((await lstat(release)).isSymbolicLink()) throw new Error('release 目录不能是符号链接，拒绝写入其他位置。')
  const output = await mkdtemp(path.join(release, `${context.sha.slice(0, 8)}-${run.id}-`))
  const runUrl = `https://github.com/${context.repository}/actions/runs/${run.id}`
  const receipt = { repository: context.repository, commit: context.sha, requestId: context.requestId, runId: run.id, runUrl, artifactId: artifact.id, archiveSha256: verified.archiveHash, installer: verified.installerName, installerSha256: verified.installerHash }
  await writeFile(path.join(output, `${ARTIFACT}.zip`), bytes, { flag: 'wx' })
  await writeFile(path.join(output, verified.installerName), verified.installer, { flag: 'wx' })
  await writeFile(path.join(output, 'SHA256SUMS.txt'), `${verified.checksums}\n${verified.archiveHash}  ${ARTIFACT}.zip\n`, { flag: 'wx' })
  await writeFile(path.join(output, 'build-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
  return { ...receipt, output, installerPath: path.join(output, verified.installerName) }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args)
  if (options.help) { console.log(HELP); return }
  let context = inspectCheckout(options)
  console.log(`仓库：${context.repository}\n分支：${context.ref}\n提交：${context.sha}`)
  const plan = options.noPublish ? null : await inspectPublishPlan(context)
  if (plan) logPublishPlan(plan)
  if (plan) {
    let workflow
    try { workflow = await readFile(path.join(context.root, '.github/workflows', WORKFLOW), 'utf8') } catch {
      throw new Error('本地缺少 Windows 打包工作流，未自动提交或推送。')
    }
    if (!verifyWorkflowContract(workflow)) throw new Error('本地打包工作流缺少一键脚本所需输入，请恢复配套 workflow；未自动提交或推送。')
  }
  if (context.dirty && options.allowDirty) console.log('注意：已明确忽略未提交修改；此次安装包不包含这些修改，也不会自动提交推送。')
  if (options.dryRun) {
    console.log(`检查计划：${plan ? '本地质量检查 → 自动提交改动 → 普通推送当前分支' : '确认已推送 HEAD（不提交/推送）'} → 检查远端 workflow → 唯一请求触发 → 等待 → 校验下载。\n输出位置：${path.join(context.root, 'release')}\nDry run 完成：未联网、未读取 Token、未暂存、未提交、未推送、未触发构建。`)
    return
  }
  await checkGitHubStatus()
  const token = await resolveToken(options)
  const client = createGitHubClient(token)
  if (plan) {
    const prefix = `/repos/${context.repository}`
    const repo = await client.json(prefix)
    if (repo.archived || repo.disabled || repo.permissions?.push === false) throw new Error('仓库不可写、已归档或禁用，未自动提交推送。')
    if (repo.default_branch !== context.ref) {
      const file = await client.json(`${prefix}/contents/.github/workflows/${WORKFLOW}?ref=${encodeURIComponent(repo.default_branch)}`)
      if (file.encoding !== 'base64' || !verifyWorkflowContract(Buffer.from(file.content || '', 'base64').toString('utf8'))) {
        throw new Error('默认分支尚未部署新版工作流。请先在默认分支运行一键打包，或按仓库流程合并工作流；脚本不会替你改写其他分支。')
      }
    }
    context = await publishWorkspace(context, options, { token, plan })
  }
  context.workflowId = await preflight(client, context)
  context.requestId = randomUUID()
  const run = await dispatchAndWait(client, context, options)
  const result = await saveArtifact(client, context, run)
  console.log(`安装包：${result.installerPath}\nSHA-256：${result.installerSha256}\nZIP 与安装包校验均通过。构建记录：${path.join(result.output, 'build-receipt.json')}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`打包失败：${error.message}`); process.exitCode = 1 })
}
