import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  parseChangedPaths, assertPublishablePath, assertSafeContents, inspectPublishPlan, publishWorkspace, gitNetworkEnvironment,
} from './publish-workspace.mjs'

const REMOTE_URL = 'https://github.com/example/editor.git'
const QUALITY_TASKS = ['typecheck', 'lint', 'test:run', 'test:packaging', 'build:web']
// 只构造合成测试值，不读取真实凭据，也避免测试源码看起来像可用凭据。
const TEST_TOKEN = ['ghp', 'A'.repeat(36)].join('_')
const PRIVATE_HEADER = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
const success = () => ({ status: 0, stdout: '', stderr: '' })

function isolatedEnvironment(extra = {}, emptyConfig) {
  const env = { ...process.env, ...extra, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  return env
}

function assertInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), '测试路径必须位于独立临时目录内')
}

async function fixture(t) {
  const temporaryRoot = await realpath(os.tmpdir())
  const scratch = await mkdtemp(path.join(temporaryRoot, 'svga-publish-test-'))
  assertInside(temporaryRoot, scratch)
  const root = path.join(scratch, 'workspace')
  const bare = path.join(scratch, 'remote.git')
  const emptyConfig = path.join(scratch, 'empty-git-config')
  await mkdir(root)
  await writeFile(emptyConfig, '')
  t.after(async () => {
    // 清理只能针对本测试创建的专属目录，不接受仓库根、系统目录或符号链接替身。
    const resolved = await realpath(scratch)
    assert.equal(resolved, scratch)
    assertInside(temporaryRoot, resolved)
    assert.match(path.basename(resolved), /^svga-publish-test-/)
    await rm(resolved, { recursive: true, force: true })
  })

  const command = (cwd, args, input) => {
    assertInside(scratch, cwd)
    return spawnSync('git', args, {
      cwd, input, encoding: 'utf8', windowsHide: true, env: isolatedEnvironment({}, emptyConfig), timeout: 20_000,
    })
  }
  const git = (args, { cwd = root, input, allowFailure = false } = {}) => {
    const result = command(cwd, args, input)
    if (!allowFailure) assert.equal(result.status, 0, `临时 Git 操作失败：${args[0]}；${result.stderr}`)
    return result
  }
  const configure = cwd => {
    git(['config', 'user.name', 'SVGA Publish Tests'], { cwd })
    git(['config', 'user.email', 'publish-tests@example.invalid'], { cwd })
    git(['config', 'commit.gpgsign', 'false'], { cwd })
    git(['config', 'core.autocrlf', 'false'], { cwd })
    git(['config', 'core.safecrlf', 'false'], { cwd })
    git(['config', 'core.hooksPath', path.join(scratch, 'empty-hooks')], { cwd })
  }
  const put = async (relative, contents) => {
    const destination = path.resolve(root, relative)
    assertInside(root, destination)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, contents)
  }
  git(['init', '--initial-branch=master'])
  configure(root)
  git(['init', '--bare', '--initial-branch=master', bare])
  await put('.gitignore', 'dist/\nrelease/\nnode_modules/\nsrc-tauri/target/\noutput/\n')
  await put('tracked.txt', '初始内容\n')
  await put('delete me.txt', '准备删除\n')
  await put('rename old.txt', '准备改名\n')
  await put('package.json', JSON.stringify({ name: 'publish-fixture', private: true, scripts: Object.fromEntries(QUALITY_TASKS.map(name => [name, 'node -e "process.exit(0)"'])) }))
  git(['add', '-A'])
  git(['commit', '-m', 'Initial fixture'])
  git(['push', bare, 'HEAD:refs/heads/master'])
  // 生产模块看到合法 GitHub URL；注入器保证任何联网操作都改写为本地裸仓库。
  git(['remote', 'add', 'origin', REMOTE_URL])

  const calls = []
  const logs = []
  const behavior = { qualityFailure: null, identityFailure: null, commitFailure: false, pushFailure: false, stagedSecret: false, onQuality: null, beforeStage: null, beforeCommit: null, beforePush: null }
  const run = (exe, args, options = {}) => {
    const cwd = options.cwd || root
    assertInside(scratch, cwd)
    assert.deepEqual(path.resolve(cwd), root, '生产命令只允许针对本测试工作树')
    calls.push({ exe, args: [...args], input: options.input, env: options.env, cwd })
    const executable = path.basename(exe).toLowerCase()
    if (executable === 'node' || executable === 'node.exe') {
      const runAt = args.indexOf('run')
      assert.ok(runAt >= 0, '仅拦截 npm run 质量检查')
      const task = args[runAt + 1]
      assert.ok(QUALITY_TASKS.includes(task), `意外质量检查：${task}`)
      behavior.onQuality?.(task)
      return behavior.qualityFailure === task ? { status: 1, stdout: '', stderr: TEST_TOKEN } : success()
    }
    assert.ok(executable === 'git' || executable === 'git.exe', '测试禁止启动未知程序')
    assert.ok(!args.includes('credential'), '测试禁止访问 Git 凭据管理器')
    if (['fetch', 'push', 'ls-remote'].some(action => args.includes(action))) {
      assert.ok(args.includes(REMOTE_URL), '网络命令必须使用可被测试替换的显式仓库 URL，禁止通过 origin 访问网络')
    }
    const mapped = args.map(arg => arg === REMOTE_URL ? bare : arg)
    assert.ok(mapped.every(arg => !/^https?:\/\//.test(arg) && !/^git@/.test(arg)), '测试禁止访问真实网络远端')
    if (args.includes('push') && behavior.pushFailure) return { status: 1, stdout: '', stderr: TEST_TOKEN }
    if (args[0] === 'var' && args[1] === behavior.identityFailure) return { status: 1, stdout: '', stderr: TEST_TOKEN }
    if (args.includes('commit') && behavior.commitFailure) return { status: 1, stdout: '', stderr: TEST_TOKEN }
    if (args[0] === 'cat-file' && args[1] === 'blob' && behavior.stagedSecret) {
      return { status: 0, stdout: Buffer.from(TEST_TOKEN), stderr: Buffer.alloc(0) }
    }
    if (args.includes('add')) behavior.beforeStage?.()
    if (args.includes('commit')) behavior.beforeCommit?.()
    if (args.includes('push')) behavior.beforePush?.()
    return spawnSync(exe, mapped, {
      ...options, cwd, encoding: options.encoding === null ? null : 'utf8', windowsHide: true, timeout: 20_000,
      env: isolatedEnvironment(options.env, emptyConfig), stdio: 'pipe',
    })
  }
  const head = () => git(['rev-parse', 'HEAD']).stdout.trim()
  const remoteHead = () => git(['--git-dir', bare, 'rev-parse', 'refs/heads/master']).stdout.trim()
  const status = () => git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout
  const count = () => Number(git(['rev-list', '--count', 'HEAD']).stdout.trim())
  const context = () => ({ root, sha: head(), ref: 'master', repository: 'example/editor', remoteUrl: REMOTE_URL })
  const dependencies = extra => ({ run, log: line => logs.push(line), token: TEST_TOKEN, ...extra })
  const plan = () => inspectPublishPlan(context(), { run, log: line => logs.push(line) })
  const publish = extra => publishWorkspace(context(), { remote: 'origin', message: '发布：工作区变更' }, dependencies(extra))
  const mutations = () => calls.filter(call => path.basename(call.exe).toLowerCase().startsWith('git') && ['add', 'commit', 'push'].some(action => call.args.includes(action)))
  const qualityCalls = () => calls.filter(call => ['node', 'node.exe'].includes(path.basename(call.exe).toLowerCase())).map(call => call.args[call.args.indexOf('run') + 1])
  const advanceRemote = async () => {
    const peer = path.join(scratch, 'peer')
    git(['clone', bare, peer])
    configure(peer)
    await writeFile(path.join(peer, 'peer.txt'), '远端新增提交\n')
    git(['add', 'peer.txt'], { cwd: peer })
    git(['commit', '-m', 'Remote advance'], { cwd: peer })
    git(['push', 'origin', 'HEAD:refs/heads/master'], { cwd: peer })
  }
  return { root, bare, scratch, put, git, calls, logs, run, behavior, head, remoteHead, status, count, context, dependencies, plan, publish, mutations, qualityCalls, advanceRemote }
}

test('porcelain -z 包含新增修改删除和改名前后路径，保留空格与中文', () => {
  const raw = ' M src/main.ts\0?? docs/新增说明.md\0D  delete me.txt\0R  renamed file.txt\0rename old.txt\0A  already staged.txt\0'
  assert.deepEqual(new Set(parseChangedPaths(raw)), new Set(['src/main.ts', 'docs/新增说明.md', 'delete me.txt', 'renamed file.txt', 'rename old.txt', 'already staged.txt']))
  assert.deepEqual(parseChangedPaths(''), [])
})

test('porcelain 冲突状态一律拒绝', () => {
  for (const status of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
    assert.throws(() => parseChangedPaths(`${status} unresolved.txt\0`))
  }
})

test('发布路径拒绝凭据、私钥和明显产物，仅允许环境变量示例文件', () => {
  for (const name of ['.env', '.env.production', 'nested/.env.local', '.npmrc', '.netrc', 'certs/server.key', 'certs/server.pem', 'certs/server.p12', 'release/installer.exe', 'dist/app.js', 'node_modules/pkg/a.js', 'src-tauri/target/release/app.exe', '../outside.txt']) {
    assert.throws(() => assertPublishablePath(name), name)
  }
  for (const name of ['.env.example', 'src/env.d.ts', '.github/workflows/package-windows.yml', 'docs/github-packaging.md', 'public/third-party/moveable-LICENSE.txt']) {
    assert.doesNotThrow(() => assertPublishablePath(name), name)
  }
})

test('内容扫描拒绝私钥和 GitHub Token，异常不回显任何凭据内容', () => {
  const secrets = [
    PRIVATE_HEADER,
    ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
    ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' '),
    TEST_TOKEN,
    ['github', 'pat', 'A'.repeat(82)].join('_'),
  ]
  for (const secret of secrets) {
    assert.throws(() => assertSafeContents('src/config.ts', Buffer.from(`prefix\n${secret}\nsuffix`)), error => {
      assert.ok(error.message.includes('config.ts'))
      assert.ok(!error.message.includes(secret))
      assert.ok(!error.message.includes('prefix'))
      return true
    })
  }
  assert.doesNotThrow(() => assertSafeContents('docs/guide.md', Buffer.from('请通过 GH_TOKEN 环境变量提供凭据。\n')))
  assert.throws(() => assertSafeContents('.env.example', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TEST_TOKEN, 'utf16le')])), error => !error.message.includes(TEST_TOKEN))
})

test('网络凭据只进入URL限定的临时环境，关闭跳转和交互，不改写原环境', () => {
  const base = { PATH: 'unchanged', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'fixture' }
  const snapshot = { ...base }
  const env = gitNetworkEnvironment({ remoteUrl: REMOTE_URL }, TEST_TOKEN, base)
  assert.deepEqual(base, snapshot)
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GCM_INTERACTIVE, 'never')
  const entries = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index) => [env[`GIT_CONFIG_KEY_${index}`], env[`GIT_CONFIG_VALUE_${index}`]])
  assert.ok(entries.some(([key, value]) => key === 'http.followRedirects' && value === 'false'))
  const headers = entries.filter(([key]) => key === `http.${REMOTE_URL}.extraheader`).map(([, value]) => value)
  assert.equal(headers[0], '')
  assert.equal(headers[1], `Authorization: Basic ${Buffer.from(`x-access-token:${TEST_TOKEN}`).toString('base64')}`)
  assert.ok(!entries.some(([key]) => key === 'http.extraheader'))
  const ssh = gitNetworkEnvironment({ remoteUrl: 'git@github.com:example/editor.git' }, TEST_TOKEN, {})
  assert.ok(!JSON.stringify(ssh).includes(TEST_TOKEN))
  assert.ok(!JSON.stringify(ssh).includes('Authorization:'))
  for (const count of ['NaN', '-1', '1000']) assert.throws(() => gitNetworkEnvironment({ remoteUrl: REMOTE_URL }, TEST_TOKEN, { GIT_CONFIG_COUNT: count }))
})

test('自动发布包含新增修改删除及已有暂存的空格路径，不提交忽略产物', async t => {
  const f = await fixture(t)
  const previous = f.head()
  await f.put('tracked.txt', '更新已有文件\n')
  await f.put('docs/new note.md', '新增说明\n')
  await f.put('already staged.txt', '原本已暂存\n')
  f.git(['add', '--', 'already staged.txt'])
  await rm(path.join(f.root, 'delete me.txt'))
  await rename(path.join(f.root, 'rename old.txt'), path.join(f.root, 'renamed file.txt'))
  await f.put('dist/app.js', '不要提交\n')
  await f.put('release/installer.exe', '不要提交\n')
  await f.put('node_modules/pkg/cache', '不要提交\n')
  const plan = await f.plan()
  assert.deepEqual(new Set(plan.files), new Set(['tracked.txt', 'docs/new note.md', 'already staged.txt', 'delete me.txt', 'rename old.txt', 'renamed file.txt']))
  const result = await f.publish({ plan })
  assert.equal(result.sha, f.head())
  assert.notEqual(result.sha, previous)
  assert.equal(f.remoteHead(), result.sha)
  assert.equal(f.count(), 2)
  assert.equal(f.status(), '')
  assert.match(f.git(['log', '-1', '--format=%B']).stdout, /\[skip ci\]/)
  assert.match(f.git(['log', '-1', '--format=%B']).stdout, /发布：工作区变更/)
  assert.deepEqual(f.qualityCalls(), QUALITY_TASKS)
  const tree = f.git(['ls-tree', '-r', '--name-only', 'HEAD']).stdout
  assert.ok(tree.includes('docs/new note.md'))
  assert.ok(tree.includes('already staged.txt'))
  assert.ok(!tree.includes('delete me.txt') && !tree.includes('rename old.txt'))
  assert.ok(!tree.includes('dist/') && !tree.includes('release/') && !tree.includes('node_modules/'))
  const stage = f.calls.find(call => call.args.includes('add'))
  assert.ok(stage.args.includes('--literal-pathspecs'))
  assert.ok(stage.args.includes('--pathspec-from-file=-') && stage.args.includes('--pathspec-file-nul'))
  assert.deepEqual(new Set(String(stage.input).split('\0').filter(Boolean)), new Set(plan.files))
  const push = f.calls.find(call => call.args.includes('push'))
  assert.ok(push.args.includes(`${result.sha}:refs/heads/master`))
  assert.ok(!push.args.includes('--force') && !push.args.includes('--force-with-lease') && !push.args.includes('-f'))
  assert.ok(f.calls.every(call => !JSON.stringify(call.args).includes(TEST_TOKEN)))
  assert.ok(f.logs.every(line => !String(line).includes(TEST_TOKEN)))
})

test('工作树与远端一致时不会创建空提交', async t => {
  const f = await fixture(t)
  const before = f.head()
  const plan = await f.plan()
  assert.deepEqual(plan.files, [])
  assert.ok(typeof plan.fingerprint === 'string' && plan.fingerprint.length > 0)
  const result = await f.publish({ plan })
  assert.equal(result.sha, before)
  assert.equal(f.head(), before)
  assert.equal(f.count(), 1)
  assert.equal(f.remoteHead(), before)
  assert.ok(!f.mutations().some(call => call.args.includes('commit')))
})

test('干净工作树上的本地未推送提交也会精确推送，不产生额外提交', async t => {
  const f = await fixture(t)
  await f.put('tracked.txt', '已由用户提交\n')
  f.git(['add', '--', 'tracked.txt'])
  f.git(['commit', '-m', 'User local commit'])
  const before = f.head()
  assert.notEqual(f.remoteHead(), before)
  const result = await f.publish()
  assert.equal(result.sha, before)
  assert.equal(f.remoteHead(), before)
  assert.equal(f.count(), 2)
  assert.ok(!f.mutations().some(call => call.args.includes('commit')))
})

for (const diverged of [false, true]) {
  test(`远端${diverged ? '分叉' : '领先'}时拒绝发布，不暂存、不提交、不强制推送`, async t => {
    const f = await fixture(t)
    if (diverged) {
      await f.put('local-only.txt', '本地分支提交\n')
      f.git(['add', '--', 'local-only.txt'])
      f.git(['commit', '-m', 'Local branch commit'])
    }
    await f.advanceRemote()
    await f.put('tracked.txt', '尚未暂存的工作\n')
    const before = { head: f.head(), status: f.status(), remote: f.remoteHead() }
    await assert.rejects(f.publish())
    assert.deepEqual({ head: f.head(), status: f.status(), remote: f.remoteHead() }, before)
    assert.equal(f.mutations().length, 0)
    assert.equal(f.qualityCalls().length, 0)
  })
}

test('真实合并冲突状态拒绝发布并完整保留冲突文件和暂存区', async t => {
  const f = await fixture(t)
  f.git(['switch', '-c', 'conflict-side'])
  await f.put('tracked.txt', '分支一\n')
  f.git(['commit', '-am', 'First side'])
  f.git(['switch', 'master'])
  await f.put('tracked.txt', '分支二\n')
  f.git(['commit', '-am', 'Second side'])
  assert.notEqual(f.git(['merge', '--no-edit', 'conflict-side'], { allowFailure: true }).status, 0)
  const before = { head: f.head(), status: f.status() }
  await assert.rejects(f.plan())
  assert.deepEqual({ head: f.head(), status: f.status() }, before)
  assert.equal(f.mutations().length, 0)
})

test('重排进行中、分离HEAD或上下文分支不一致时停止', async t => {
  const f = await fixture(t)
  await mkdir(path.join(f.root, '.git', 'rebase-merge'))
  await assert.rejects(f.plan())
  const rebaseMarker = path.join(f.root, '.git', 'rebase-merge')
  assertInside(f.root, rebaseMarker)
  await rm(rebaseMarker, { recursive: true })
  f.git(['checkout', '--detach', 'HEAD'])
  await assert.rejects(f.plan())
  f.git(['switch', 'master'])
  await assert.rejects(inspectPublishPlan({ ...f.context(), ref: 'other-branch' }, { run: f.run }))
  assert.equal(f.mutations().length, 0)
})

test('敏感路径或敏感内容不能进入发布计划，错误只包含文件提示', async t => {
  const f = await fixture(t)
  await f.put('.env', 'PRIVATE=value\n')
  await assert.rejects(f.plan(), error => !error.message.includes('PRIVATE=value'))
  await rm(path.join(f.root, '.env'))
  await f.put('src/config.ts', `const value = '${TEST_TOKEN}'\n`)
  await assert.rejects(f.plan(), error => error.message.includes('config.ts') && !error.message.includes(TEST_TOKEN))
  assert.equal(f.mutations().length, 0)
})

test('符号链接不能绕过内容安全检查或把仓库外文件带入提交', async t => {
  const f = await fixture(t)
  const target = path.join(f.scratch, 'outside-worktree.txt')
  await writeFile(target, '工作树外数据\n')
  try {
    await symlink(target, path.join(f.root, 'linked-file.txt'), 'file')
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('当前系统未授予创建符号链接权限'); return }
    throw error
  }
  await assert.rejects(f.plan())
  assert.equal(f.mutations().length, 0)
})

test('质量检查失败不改变已有暂存，不创建提交或推送，也不回显子进程Token', async t => {
  const f = await fixture(t)
  await f.put('already staged.txt', '原有暂存工作\n')
  f.git(['add', '--', 'already staged.txt'])
  await f.put('tracked.txt', '未暂存工作\n')
  const before = { head: f.head(), status: f.status(), index: f.git(['write-tree']).stdout.trim() }
  f.behavior.qualityFailure = 'lint'
  await assert.rejects(f.publish(), error => !error.message.includes(TEST_TOKEN))
  assert.deepEqual({ head: f.head(), status: f.status(), index: f.git(['write-tree']).stdout.trim() }, before)
  assert.equal(f.mutations().length, 0)
  assert.deepEqual(f.qualityCalls(), ['typecheck', 'lint'])
})

test('质量检查期间文件内容改变，即使status字符串相同也拒绝提交', async t => {
  const f = await fixture(t)
  await f.put('tracked.txt', '检查前内容\n')
  const original = f.head()
  f.behavior.onQuality = task => {
    if (task === 'lint') writeFileSync(path.join(f.root, 'tracked.txt'), '检查期间编辑器又保存了内容\n')
  }
  await assert.rejects(f.publish())
  assert.equal(f.head(), original)
  assert.equal(await readFile(path.join(f.root, 'tracked.txt'), 'utf8'), '检查期间编辑器又保存了内容\n')
  assert.equal(f.mutations().length, 0)
})

test('发布计划指纹覆盖文件内容和暂存区；计划过期不能提交', async t => {
  const f = await fixture(t)
  await f.put('tracked.txt', '第一版\n')
  const first = await f.plan()
  await f.put('tracked.txt', '第二版\n')
  const second = await f.plan()
  assert.notEqual(first.fingerprint, second.fingerprint)
  f.git(['add', '--', 'tracked.txt'])
  const third = await f.plan()
  assert.notEqual(second.fingerprint, third.fingerprint)
  const before = { head: f.head(), status: f.status() }
  await assert.rejects(f.publish({ plan: first }))
  assert.deepEqual({ head: f.head(), status: f.status() }, before)
  assert.equal(f.mutations().length, 0)
})

test('推送失败保留本地提交，不回滚、不强推，也不在参数或异常泄漏Token', async t => {
  const f = await fixture(t)
  await f.put('tracked.txt', '可以再次手动推送的改动\n')
  const originalRemote = f.remoteHead()
  f.behavior.pushFailure = true
  await assert.rejects(f.publish(), error => !error.message.includes(TEST_TOKEN))
  assert.notEqual(f.head(), originalRemote)
  assert.equal(f.remoteHead(), originalRemote)
  assert.equal(f.count(), 2)
  assert.equal(f.status(), '')
  assert.match(f.git(['log', '-1', '--format=%B']).stdout, /\[skip ci\]/)
  assert.ok(f.calls.every(call => !JSON.stringify(call.args).includes(TEST_TOKEN)))
  assert.ok(f.logs.every(line => !String(line).includes(TEST_TOKEN)))
  assert.ok(!f.calls.some(call => call.args.includes('reset') || call.args.includes('--force') || call.args.includes('--force-with-lease')))
})

test('提交失败保留已暂存工作，不推送、不自动清空索引', async t => {
  const f = await fixture(t)
  await f.put('tracked.txt', '准备发布的内容\n')
  await f.put('new file.txt', '新增内容\n')
  const original = f.head()
  f.behavior.commitFailure = true
  await assert.rejects(f.publish(), error => !error.message.includes(TEST_TOKEN))
  assert.equal(f.head(), original)
  assert.equal(f.remoteHead(), original)
  const staged = f.git(['diff', '--cached', '--name-only']).stdout.trim().split(/\r?\n/)
  assert.deepEqual(new Set(staged), new Set(['tracked.txt', 'new file.txt']))
  assert.equal(f.git(['diff', '--name-only']).stdout.trim(), '')
  assert.ok(!f.mutations().some(call => call.args.includes('push')))
})

test('暂存新增后又从工作区删除会抵消，不创建空提交', async t => {
  const f = await fixture(t)
  await f.put('added then removed.txt', '已暂存但不再需要的文件\n')
  f.git(['add', '--', 'added then removed.txt'])
  const removed = path.join(f.root, 'added then removed.txt')
  assertInside(f.root, removed)
  await rm(removed)
  assert.ok(f.status().startsWith('AD '))
  const before = f.head()
  const plan = await f.plan()
  assert.deepEqual(plan.files, ['added then removed.txt'])
  const result = await f.publish({ plan })
  assert.equal(result.sha, before)
  assert.equal(f.head(), before)
  assert.equal(f.remoteHead(), before)
  assert.equal(f.count(), 1)
  assert.equal(f.status(), '')
  assert.ok(f.mutations().some(call => call.args.includes('add')))
  assert.ok(!f.mutations().some(call => call.args.includes('commit')))
})

for (const identity of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
  test(`${identity} 不可用时在暂存前停止并保留用户索引`, async t => {
    const f = await fixture(t)
    await f.put('already staged.txt', '保留原暂存\n')
    f.git(['add', '--', 'already staged.txt'])
    await f.put('tracked.txt', '尚未暂存的更改\n')
    const before = { head: f.head(), status: f.status(), index: f.git(['write-tree']).stdout.trim() }
    f.behavior.identityFailure = identity
    await assert.rejects(f.publish(), error => /user\.name|user\.email/.test(error.message) && !error.message.includes(TEST_TOKEN))
    assert.deepEqual({ head: f.head(), status: f.status(), index: f.git(['write-tree']).stdout.trim() }, before)
    assert.equal(f.mutations().length, 0)
    assert.ok(f.calls.some(call => call.args[0] === 'var' && call.args[1] === identity))
  })
}

test('提交过程改变暂存树时保留产生的本地提交但拒绝推送', async t => {
  const f = await fixture(t)
  await f.put('tracked.txt', '已经通过检查的版本\n')
  const before = f.remoteHead()
  // 模拟提交钩子在 Git commit 内部改写并暂存文件，仍让真实 Git 创建提交。
  f.behavior.beforeCommit = () => {
    writeFileSync(path.join(f.root, 'tracked.txt'), '提交钩子改写的版本\n')
    f.git(['add', '--', 'tracked.txt'])
  }
  await assert.rejects(f.publish(), /钩子|本次内容/)
  assert.notEqual(f.head(), before)
  assert.equal(f.remoteHead(), before)
  assert.equal(f.count(), 2)
  assert.equal(f.status(), '')
  assert.equal(f.git(['show', 'HEAD:tracked.txt']).stdout, '提交钩子改写的版本\n')
  assert.ok(!f.mutations().some(call => call.args.includes('push')))
})

test('最后校验后HEAD并发改变，推送也只能使用已审核提交的固定SHA', async t => {
  const f = await fixture(t)
  await f.put('tracked.txt', '已通过本次质量检查的内容\n')
  let reviewedSha
  f.behavior.beforePush = () => {
    reviewedSha = f.head()
    writeFileSync(path.join(f.root, 'parallel-task.txt'), '其他任务刚刚提交的未审核内容\n')
    f.git(['add', '--', 'parallel-task.txt'])
    f.git(['commit', '-m', 'Concurrent task commit'])
  }
  const result = await f.publish()
  assert.equal(result.sha, reviewedSha)
  assert.equal(f.remoteHead(), reviewedSha)
  assert.notEqual(f.head(), reviewedSha)
  assert.equal(f.count(), 3)
  assert.equal(f.status(), '')
  const remoteTree = f.git(['--git-dir', f.bare, 'ls-tree', '-r', '--name-only', 'refs/heads/master']).stdout
  assert.ok(!remoteTree.includes('parallel-task.txt'))
  assert.ok(f.calls.find(call => call.args.includes('push')).args.includes(`${reviewedSha}:refs/heads/master`))
})

test('最终内容检查与git add之间发生保存时停止，保留文件和暂存区但不提交', async t => {
  const f = await fixture(t)
  await f.put('tracked.txt', '已通过检查的版本\n')
  const original = f.head()
  f.behavior.beforeStage = () => {
    writeFileSync(path.join(f.root, 'tracked.txt'), '检查后刚保存的新版本\n')
  }
  await assert.rejects(f.publish())
  assert.equal(f.head(), original)
  assert.equal(f.remoteHead(), original)
  assert.equal(await readFile(path.join(f.root, 'tracked.txt'), 'utf8'), '检查后刚保存的新版本\n')
  assert.ok(f.mutations().some(call => call.args.includes('add')))
  assert.ok(!f.mutations().some(call => call.args.includes('commit') || call.args.includes('push')))
})

test('已抵消的AD路径与其他真实修改混合时正常提交，不误判源码并发变化', async t => {
  const f = await fixture(t)
  await f.put('added then removed.txt', '暂存后撤回的新增\n')
  f.git(['add', '--', 'added then removed.txt'])
  const removed = path.join(f.root, 'added then removed.txt')
  assertInside(f.root, removed)
  await rm(removed)
  await f.put('tracked.txt', '仍需提交的真实更改\n')
  const result = await f.publish()
  assert.equal(result.sha, f.head())
  assert.equal(f.remoteHead(), result.sha)
  assert.equal(f.count(), 2)
  assert.equal(f.status(), '')
  assert.equal(f.git(['show', 'HEAD:tracked.txt']).stdout, '仍需提交的真实更改\n')
  assert.ok(!f.git(['ls-tree', '-r', '--name-only', 'HEAD']).stdout.includes('added then removed.txt'))
})

test('暂存blob被clean filter注入凭据时仍拒绝提交，不只扫描磁盘源文件', async t => {
  const f = await fixture(t)
  await f.put('tracked.txt', '磁盘上的安全内容\n')
  const original = f.head()
  // 仅替换 cat-file 的输出，模拟过滤器生成敏感 blob，不在真实文件中放凭据。
  f.behavior.stagedSecret = true
  await assert.rejects(f.publish(), error => error.message.includes('tracked.txt') && !error.message.includes(TEST_TOKEN))
  assert.equal(f.head(), original)
  assert.equal(f.remoteHead(), original)
  assert.equal(await readFile(path.join(f.root, 'tracked.txt'), 'utf8'), '磁盘上的安全内容\n')
  assert.ok(f.calls.some(call => call.args[0] === 'cat-file' && call.args[1] === 'blob'))
  assert.ok(!f.mutations().some(call => call.args.includes('commit') || call.args.includes('push')))
})
