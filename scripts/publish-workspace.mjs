import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

export const QUALITY_SCRIPTS = ['typecheck', 'lint', 'test:run', 'test:packaging', 'build:web']
const MAX_SOURCE_BYTES = 10 * 1024 * 1024
const quote = value => JSON.stringify(value)

export function runCommand(executable, args, options = {}) {
  return spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...options })
}

/** NUL 分隔避免中文、空格和换行文件名被 shell 或 Git 路径规则重新解释。 */
export function parseChangedPaths(raw) {
  const records = String(raw).split('\0')
  const files = new Set()
  for (let index = 0; index < records.length; index += 1) {
    const entry = records[index]
    if (!entry) continue
    if (entry.length < 4 || entry[2] !== ' ') throw new Error('无法解析 Git 文件列表，未自动暂存。')
    const status = entry.slice(0, 2)
    if (status.includes('U') || ['AA', 'DD'].includes(status)) throw new Error('仓库存在未解决的合并冲突，请先解决冲突后再一键打包。')
    files.add(entry.slice(3))
    if (/[RC]/.test(status)) {
      const previous = records[++index]
      if (!previous) throw new Error('Git 重命名记录不完整，未自动暂存。')
      files.add(previous)
    }
  }
  return [...files].sort()
}

export function assertPublishablePath(relativePath) {
  const parts = relativePath.split('/')
  const name = parts.at(-1)
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\\') || parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error(`拒绝异常的提交路径：${quote(relativePath)}`)
  }
  const envFile = /^\.env(?:\.|$)/i.test(name) && !/^\.env\.(?:example|sample|template)$/i.test(name)
  const credentials = /^(?:\.npmrc|\.netrc|_netrc|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i.test(name)
  if (envFile || credentials || /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(name) || parts.some(part => /^(?:\.ssh|\.aws)$/i.test(part))) {
    throw new Error(`疑似敏感文件，不会自动提交：${quote(relativePath)}。请移出待提交范围或手动审核处理。`)
  }
  if (parts.some(part => /^(?:node_modules|dist|release|target|\.playwright-cli)$/i.test(part)) || /\.(?:exe|msi|dmg|zip|7z|log)$/i.test(name)) {
    throw new Error(`疑似生成产物，不会自动提交：${quote(relativePath)}。请检查 .gitignore 或手动审核。`)
  }
}

export function assertSafeContents(relativePath, bytes) {
  const text = bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ? bytes.toString('utf16le') : bytes.toString('utf8')
  const privateKey = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/
  const token = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/
  if (privateKey.test(text) || token.test(text)) throw new Error(`检测到疑似私钥或访问凭据，不会自动提交：${quote(relativePath)}。不会输出命中的内容。`)
}

const gitRunner = (context, run) => (args, extra = {}) => {
  const result = run('git', args, { cwd: context.root, ...extra })
  if (result.status !== 0) throw new Error(`Git ${args[0]} 失败，流程已停止；未输出可能含凭据的命令错误。请检查 Git 配置、权限或网络。`)
  return result.stdout || ''
}

/** 只读取状态和源文件，不改索引；同一指纹也用于阻止检查期间的并行修改。 */
export async function inspectPublishPlan(context, { run = runCommand, sourcePaths = [] } = {}) {
  const git = gitRunner(context, run)
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim()
  if (branch !== context.ref) throw new Error('自动发布只能操作当前分支，--ref 不能指向其他分支；打包旧提交请用 --no-publish。')
  const sha = git(['rev-parse', 'HEAD']).trim()
  if (sha !== context.sha) throw new Error('当前 HEAD 已变化，请重新运行；不会自动切换或修改其他提交。')
  const gitDir = git(['rev-parse', '--absolute-git-dir']).trim()
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG']) {
    try {
      await lstat(path.join(gitDir, marker))
      throw new Error('仓库正在合并、变基、拣选或二分检查，请先完成或自行取消该操作。')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  // 暂存可能消除“新增后又删除”的路径；仍按原清单复核，新增的并行变更也不能遗漏。
  const files = [...new Set([...parseChangedPaths(status), ...sourcePaths])].sort()
  const hash = createHash('sha256').update(sha).update(status).update(git(['ls-files', '--stage', '-z']))
  const sourceHash = createHash('sha256').update(sha)
  const root = await realpath(context.root)
  for (const file of files) {
    assertPublishablePath(file)
    const target = path.resolve(context.root, file)
    let stats
    try { stats = await lstat(target) } catch (error) {
      if (error.code === 'ENOENT') {
        hash.update(file).update('\0deleted\0')
        sourceHash.update(file).update('\0deleted\0')
        continue
      }
      throw new Error(`无法检查待提交文件：${quote(file)}`)
    }
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`暂不自动提交符号链接、子模块或目录：${quote(file)}`)
    const resolved = await realpath(target)
    const relative = path.relative(root, resolved)
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error(`待提交文件指向仓库之外：${quote(file)}`)
    if (stats.size > MAX_SOURCE_BYTES) throw new Error(`待提交文件超过 10 MiB，请先手动审核：${quote(file)}`)
    const bytes = await readFile(target)
    assertSafeContents(file, bytes)
    hash.update(file).update('\0').update(bytes).update('\0')
    sourceHash.update(file).update('\0').update(bytes).update('\0')
  }
  return { files, fingerprint: hash.digest('hex'), sourceFingerprint: sourceHash.digest('hex') }
}

export function logPublishPlan(plan, log = console.log) {
  if (!plan.files.length) { log('工作区干净，不创建空提交；会自动推送尚未推送的当前提交。'); return }
  log(`将提交本仓库 ${plan.files.length} 个变更路径（包括新增、修改、删除与已暂存内容）：`)
  for (const file of plan.files) log(`  ${quote(file)}`)
}

/** Token 只放进 Git 进程环境，作用于已验证 URL；不进入命令行或持久化 Git 配置。 */
export function gitNetworkEnvironment(context, token, base = process.env) {
  const env = { ...base, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
  let count = Number(env.GIT_CONFIG_COUNT || 0)
  if (!Number.isSafeInteger(count) || count < 0 || count > 100) throw new Error('Git 临时配置无效，请检查 GIT_CONFIG_COUNT。')
  const add = (key, value) => { env[`GIT_CONFIG_KEY_${count}`] = key; env[`GIT_CONFIG_VALUE_${count++}`] = value }
  add('http.followRedirects', 'false')
  if (token && context.remoteUrl.startsWith('https://github.com/')) {
    add(`http.${context.remoteUrl}.extraheader`, '')
    add(`http.${context.remoteUrl}.extraheader`, `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`)
  }
  env.GIT_CONFIG_COUNT = String(count)
  return env
}

async function runQualityChecks(context, run, log) {
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  for (const script of QUALITY_SCRIPTS) {
    log(`本地检查：npm run ${script}`)
    const result = run(process.execPath, [npmCli, 'run', script], { cwd: context.root, stdio: 'inherit', timeout: 15 * 60_000 })
    if (result.status !== 0) throw new Error(`本地检查 ${script} 失败或超时，尚未自动暂存、提交或推送。`)
  }
}

/** 不自动拉取合并、不覆盖远端；失败时保留用户文件及已产生的本地提交。 */
export async function publishWorkspace(context, options, { run = runCommand, log = console.log, token, plan } = {}) {
  const git = gitRunner(context, run)
  const original = plan || await inspectPublishPlan(context, { run })
  const env = gitNetworkEnvironment(context, token)
  const network = { env, timeout: 120_000 }
  const remoteRef = `refs/heads/${context.ref}`
  log('检查远端分支，确保可以普通快进推送…')
  const remote = git(['ls-remote', '--heads', context.remoteUrl, remoteRef], network).trim()
  const remoteSha = remote ? remote.split(/\s+/)[0] : null
  if (remoteSha && !/^[a-f0-9]{40}$/i.test(remoteSha)) throw new Error('远端提交响应无效，未提交或推送。')
  if (remoteSha) {
    git(['fetch', '--no-tags', context.remoteUrl, remoteRef], network)
    if (run('git', ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'], { cwd: context.root }).status !== 0) {
      throw new Error('远端分支领先或与本地分叉，已停止；请先自行同步远端。脚本不会强制推送、变基或丢弃改动。')
    }
  }
  await runQualityChecks(context, run, log)
  const verified = await inspectPublishPlan(context, { run })
  if (verified.fingerprint !== original.fingerprint) throw new Error('本地检查期间文件或暂存区发生变化，未自动提交。请暂停其他编辑后重新运行。')
  let next = { ...context }
  if (verified.files.length) {
    for (const identity of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
      if (run('git', ['var', identity], { cwd: context.root }).status !== 0) {
        throw new Error('Git 提交者信息不可用，请设置 user.name 和 user.email；尚未自动暂存或提交。')
      }
    }
    log('检查通过，正在暂存本次列出的变更并创建提交…')
    git(['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: `${verified.files.join('\0')}\0` })
    const staged = run('git', ['diff', '--cached', '--quiet'], { cwd: context.root })
    if (![0, 1].includes(staged.status)) throw new Error('暂存区检查失败，未提交；已暂存的内容会保留。')
    if (staged.status === 1) {
      const stagedPlan = await inspectPublishPlan(context, { run, sourcePaths: verified.files })
      if (stagedPlan.sourceFingerprint !== verified.sourceFingerprint || run('git', ['diff', '--quiet'], { cwd: context.root }).status !== 0) {
        throw new Error('暂存期间文件或索引发生并行变化，未提交或推送；暂存状态已保留，请检查后重试。')
      }
      // clean filter 可能改变入库内容，因此还要检查真正将被提交的 blob。
      const stagedFiles = git(['diff', '--cached', '--no-renames', '--name-only', '--diff-filter=ACMT', '-z']).split('\0').filter(Boolean)
      for (const file of stagedFiles) {
        assertPublishablePath(file)
        const size = Number(git(['cat-file', '-s', `:${file}`]).trim())
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SOURCE_BYTES) throw new Error(`暂存内容超出安全大小：${quote(file)}，未提交。`)
        const bytes = git(['cat-file', 'blob', `:${file}`], { encoding: null, maxBuffer: MAX_SOURCE_BYTES + 1024 })
        assertSafeContents(file, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))
      }
      const expectedTree = git(['write-tree']).trim()
      const message = options.message?.trim() || 'chore: prepare one-click Windows package'
      // 手动 dispatch 自带完整检查；跳过本次 push 的重复打包，不改写任何已有提交。
      git(['commit', '--file=-'], { input: `${message}\n\n[skip ci]\n`, timeout: 120_000 })
      next.sha = git(['rev-parse', 'HEAD']).trim()
      log(`已创建提交：${next.sha}`)
      if (git(['rev-parse', 'HEAD^{tree}']).trim() !== expectedTree) {
        throw new Error('Git 提交钩子修改了本次内容，已保留本地提交但尚未推送。请重新检查后再运行。')
      }
    } else log('工作区与暂存区的相反修改已抵消，不创建空提交。')
  }
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim()
  if (branch !== context.ref || git(['rev-parse', 'HEAD']).trim() !== next.sha || git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])) {
    throw new Error('提交后工作区或分支发生变化，未推送。已产生的本地提交会保留，请检查后重新运行。')
  }
  if (remoteSha !== next.sha) {
    log(`正在推送 ${context.ref} 到 ${context.repository}…`)
    try { git(['push', context.remoteUrl, `${next.sha}:${remoteRef}`], network) } catch {
      throw new Error('推送失败或结果未知，本地提交已保留。请检查网络、GitHub Contents/Workflows 写权限或分支保护后重试；不会强制推送。')
    }
  } else log('远端已经是当前提交，无需再次推送。')
  const pushed = git(['ls-remote', '--heads', context.remoteUrl, remoteRef], network).trim().split(/\s+/)[0]
  if (pushed !== next.sha) throw new Error('推送后远端提交不一致，未触发打包。请确认是否有人同时更新了分支。')
  next.dirty = false
  return next
}
