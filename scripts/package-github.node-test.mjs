import assert from 'node:assert/strict'
import { readFile, readdir, rm, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import {
  ARTIFACT, WORKFLOW, parseArgs, parseRepository, inspectCheckout, resolveToken,
  createGitHubClient, checkGitHubStatus, verifyWorkflowContract, preflight,
  findRequestedRun, dispatchAndWait, downloadArchive, sha256, verifyArchive, saveArtifact,
} from './package-github.mjs'

const SHA = 'a'.repeat(40)
const context = { repository: 'example/editor', ref: 'master', sha: SHA, requestId: 'unique-request', workflowId: 7 }
const ownRun = {
  id: 99, workflow_id: 7, event: 'workflow_dispatch', head_branch: 'master', head_sha: SHA,
  display_title: 'Windows package [unique-request]', status: 'completed', conclusion: 'success',
}
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function makeZip({ name = 'Editor Pro.exe', installer = Buffer.from('MZ-test-installer'), checksum, extra, symlink = false } = {}) {
  const zip = new JSZip()
  zip.file(name, installer, { createFolders: false, ...(symlink ? { unixPermissions: 0o120777 } : {}) })
  zip.file('SHA256SUMS.txt', `${checksum || sha256(installer)}  ${name}\n`)
  if (extra) zip.file(extra, 'unexpected', { createFolders: false })
  return zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' })
}

test('参数默认值、显式选项与范围校验', () => {
  assert.deepEqual(parseArgs([]), { remote: 'origin', timeout: 60, poll: 10 })
  assert.deepEqual(parseArgs(['--dry-run', '--allow-dirty', '--ref', 'feature/editor', '--poll', '2']), {
    remote: 'origin', timeout: 60, poll: 2, dryRun: true, allowDirty: true, noPublish: true, ref: 'feature/editor',
  })
  for (const args of [['--unknown'], ['--token', 'private-token'], ['--timeout', '0'], ['--poll', 'NaN'], ['--ref'], ['--remote', 'bad/name']]) {
    assert.throws(() => parseArgs(args))
  }
})

test('接受 GitHub HTTPS 与 SSH，拒绝内嵌密码或其他主机', () => {
  for (const url of ['https://github.com/example/editor.git', 'git@github.com:example/editor.git', 'ssh://git@github.com/example/editor.git']) {
    assert.equal(parseRepository(url), 'example/editor')
  }
  for (const url of ['https://secret@github.com/example/editor.git', 'https://github.com.evil.test/example/editor', 'http://github.com/example/editor', 'https://github.com/example/editor?token=secret', 'git@github.com:../editor.git']) {
    assert.throws(() => parseRepository(url))
  }
})

function fakeGit({ dirty = '', remote = 'https://github.com/example/editor.git' } = {}) {
  return (_exe, args) => ({ status: 0, stdout: ({
    'rev-parse --show-toplevel': 'D:/repo', 'rev-parse HEAD': SHA,
    'status --porcelain=v1 --untracked-files=normal': dirty,
    'symbolic-ref --quiet --short HEAD': 'master', 'remote get-url origin': remote,
  })[args.join(' ')] || '' })
}

test('默认接受脏工作区自动发布，no-publish拒绝脏状态，allow-dirty仅打旧HEAD', () => {
  assert.equal(inspectCheckout(parseArgs([]), fakeGit({ dirty: ' M src/App.tsx' })).dirty, true)
  assert.throws(() => inspectCheckout(parseArgs(['--no-publish']), fakeGit({ dirty: ' M src/App.tsx' })), /要求工作区干净/)
  const checkout = inspectCheckout(parseArgs(['--allow-dirty']), fakeGit({ dirty: '?? local.txt' }))
  assert.equal(checkout.sha, SHA)
  assert.equal(checkout.dirty, true)
  assert.equal(inspectCheckout(parseArgs([]), fakeGit()).repository, 'example/editor')
})

test('环境变量或标准输入凭据不会进入任何子进程参数', async () => {
  const run = () => { throw new Error('不应调用子进程') }
  assert.equal(await resolveToken({}, { env: { GH_TOKEN: 'environment-token' }, run }), 'environment-token')
  assert.equal(await resolveToken({ tokenStdin: true }, { env: { GH_TOKEN: 'ignored' }, run, readStdin: async () => 'stdin-token\n' }), 'stdin-token')
  await assert.rejects(resolveToken({ tokenStdin: true }, { env: {}, run, readStdin: async () => '\n' }), /有效 Token/)
})

test('gh 和 Git Credential Manager 逐级回退并关闭交互', async () => {
  const calls = []
  const token = await resolveToken({}, { env: {}, run: (exe, args, options) => {
    calls.push({ exe, args, options })
    return exe === 'gh' ? { status: 1, stdout: '', stderr: 'hidden' } : { status: 0, stdout: 'username=example\npassword=credential-secret\n' }
  } })
  assert.equal(token, 'credential-secret')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].options.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(calls[1].options.env.GCM_INTERACTIVE, 'never')
  assert.ok(calls.every(call => !JSON.stringify(call.args).includes(token)))
  assert.equal(await resolveToken({}, { env: {}, run: () => ({ status: 0, stdout: 'gh-secret\n' }) }), 'gh-secret')
})

test('认证 API 禁止自动重定向且错误不回显服务端内容', async () => {
  const calls = []
  const client = createGitHubClient('never-print-this-token', async (url, options) => {
    calls.push({ url, options })
    return jsonResponse({ message: 'never-print-this-token' }, 403)
  })
  await assert.rejects(client.json('/repos/example/editor'), error => /403/.test(error.message) && !error.message.includes('never-print'))
  assert.equal(calls[0].options.redirect, 'manual')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer never-print-this-token')
  await assert.rejects(client.json('https://evil.test/steal'), /拒绝/)
  assert.equal(calls.length, 1)
})

test('非法 JSON 响应不在异常中暴露 Token 或原始响应内容', async () => {
  const client = createGitHubClient('private-token', async () => new Response('private-token was echoed by a faulty proxy'))
  await assert.rejects(client.json('/repos/example/editor'), error => /响应格式无效/.test(error.message) && !error.message.includes('private-token'))
  await assert.rejects(client.json('/repos/example/editor/actions/workflows/package-windows.yml/dispatches', { method: 'POST', body: {} }), error => /结果未知/.test(error.message) && !error.message.includes('private-token'))
})

test('GitHub Actions 异常时阻止 dispatch，状态页面断网给出提示', async () => {
  await assert.rejects(checkGitHubStatus(async () => jsonResponse({ components: [{ name: 'Actions', status: 'major_outage' }] })), /服务异常/)
  const logs = []
  await checkGitHubStatus(async () => { throw new Error('offline') }, text => logs.push(text))
  assert.equal(logs.length, 1)
  await checkGitHubStatus(async () => jsonResponse({ components: [{ name: 'Actions', status: 'operational' }] }))
})

test('实际 workflow 包含脚本所需关联输入及校验步骤', async () => {
  const content = await readFile(new URL('../.github/workflows/package-windows.yml', import.meta.url), 'utf8')
  assert.equal(verifyWorkflowContract(content), true)
  assert.equal(verifyWorkflowContract('workflow_dispatch: {}'), false)
  assert.match(content, /EXPECTED_SHA: \$\{\{ inputs\.expected_sha \}\}/)
  assert.match(content, /Generate installer checksum/)
  assert.match(content, /npm run test:packaging/)
})

test('远端 SHA 不同立即拒绝，不读取工作流、不触发构建', async () => {
  const paths = []
  const client = { json: async endpoint => {
    paths.push(endpoint)
    return paths.length === 1 ? { default_branch: 'master' } : { object: { sha: 'b'.repeat(40) } }
  } }
  await assert.rejects(preflight(client, context), /远端分支与本地 HEAD 不一致/)
  assert.equal(paths.length, 2)
})

test('检查默认分支及目标提交上的新版工作流均存在', async () => {
  const content = await readFile(new URL('../.github/workflows/package-windows.yml', import.meta.url), 'utf8')
  const checkedRefs = []
  const client = { json: async endpoint => {
    if (endpoint.includes('/contents/')) {
      checkedRefs.push(new URL(endpoint, 'https://api.github.com').searchParams.get('ref'))
      return { encoding: 'base64', content: Buffer.from(content).toString('base64') }
    }
    if (endpoint.includes('/git/ref/')) return { object: { sha: SHA } }
    if (endpoint.includes('/actions/workflows/')) return { id: 7, state: 'active' }
    return { default_branch: 'master' }
  } }
  assert.equal(await preflight(client, context), 7)
  assert.deepEqual(checkedRefs, ['master', SHA])
})

test('只匹配本次唯一 request_id，不认同 SHA 的 push 或其他 dispatch', () => {
  const other = { ...ownRun, id: 100, display_title: 'Windows package [other-request]' }
  assert.equal(findRequestedRun([other], context), null)
  assert.equal(findRequestedRun([other, ownRun], context).id, 99)
  assert.throws(() => findRequestedRun([ownRun, ownRun], context), /多个运行/)
  for (const changed of [{ event: 'push' }, { head_sha: 'b'.repeat(40) }, { head_branch: 'wrong' }, { workflow_id: 8 }]) {
    assert.throws(() => findRequestedRun([{ ...ownRun, ...changed }], context), /不一致/)
  }
})

test('旧版 204 dispatch 从运行列表关联唯一请求并只提交一次', async () => {
  const calls = []
  const client = { json: async (endpoint, options) => {
    calls.push({ endpoint, options })
    if (options?.method === 'POST') return null
    return { workflow_runs: [{ ...ownRun, id: 88, display_title: 'Windows package [unrelated]' }, ownRun] }
  } }
  const run = await dispatchAndWait(client, context, { timeout: 1, poll: 2 }, { log: () => {}, sleep: () => assert.fail('完成后不应等待') })
  assert.equal(run.id, 99)
  assert.equal(calls.filter(call => call.options?.method === 'POST').length, 1)
  assert.deepEqual(calls[0].options.body, { ref: 'master', inputs: { request_id: context.requestId, expected_sha: SHA } })
})

test('新版 dispatch 直接返回 run ID，仍核对请求与提交', async () => {
  const client = { json: async (endpoint, options) => options?.method === 'POST' ? { workflow_run_id: 99 } : ownRun }
  assert.equal((await dispatchAndWait(client, context, { timeout: 1, poll: 2 }, { log: () => {} })).id, 99)
  const wrong = { json: async (endpoint, options) => options?.method === 'POST' ? { workflow_run_id: 99 } : { ...ownRun, display_title: 'wrong' } }
  await assert.rejects(dispatchAndWait(wrong, context, { timeout: 1, poll: 2 }, { log: () => {} }), /不属于本次请求/)
})

test('构建失败列出失败步骤，不下载产物', async () => {
  const client = { json: async (endpoint, options) => {
    if (options?.method === 'POST') return { workflow_run_id: 99 }
    if (endpoint.includes('/jobs?')) return { jobs: [{ name: 'package-win', steps: [{ name: 'Typecheck', conclusion: 'failure' }] }] }
    return { ...ownRun, conclusion: 'failure' }
  } }
  await assert.rejects(dispatchAndWait(client, context, { timeout: 1, poll: 2 }, { log: () => {} }), /package-win \/ Typecheck/)
})

test('超时不取消远端任务且提供请求 ID', async () => {
  let clock = 0
  const client = { json: async (_endpoint, options) => options?.method === 'POST' ? null : { workflow_runs: [] } }
  await assert.rejects(dispatchAndWait(client, context, { timeout: 1, poll: 2 }, { log: () => {}, now: () => clock, sleep: async () => { clock += 60_000 } }), /未取消远端任务.*unique-request/)
})

test('分页期间耗尽超时预算时不继续请求下一页或多等待一个 poll', async () => {
  let clock = 0
  let queries = 0
  const sleeps = []
  const client = { json: async (_endpoint, options) => {
    if (options?.method === 'POST') return null
    queries += 1
    clock += 60_000
    return { workflow_runs: Array.from({ length: 100 }, (_, id) => ({ id, display_title: 'unrelated' })) }
  } }
  await assert.rejects(dispatchAndWait(client, context, { timeout: 1, poll: 60 }, { log: () => {}, now: () => clock, sleep: async ms => { sleeps.push(ms) } }), /超时/)
  assert.equal(queries, 1)
  assert.deepEqual(sleeps, [0])
})

test('下载重定向不向其他域名发送 GitHub Token', async () => {
  const requests = []
  const client = createGitHubClient('github-private-token', async (url, options) => {
    requests.push({ url, options })
    return requests.length === 1
      ? new Response(null, { status: 302, headers: { location: 'https://signed-download.example/installer?temporary-signature=opaque' } })
      : new Response(Buffer.from('zip-bytes'))
  })
  assert.equal((await downloadArchive(client, context.repository, 12)).toString(), 'zip-bytes')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer github-private-token')
  assert.equal(requests[1].options.headers.Authorization, undefined)
  assert.equal(requests[1].options.redirect, 'manual')
})

test('拒绝不安全的下载重定向', async () => {
  const client = { raw: async () => new Response(null, { status: 302, headers: { location: 'http://plain.example/file' } }), fetchImpl: () => assert.fail('不可下载') }
  await assert.rejects(downloadArchive(client, context.repository, 12), /不安全/)
})

test('下载流中断不暴露底层预签名地址', async () => {
  const stream = new ReadableStream({ start(controller) { controller.error(new Error('https://download.example/?private-signature=secret')) } })
  const client = { raw: async () => new Response(stream) }
  await assert.rejects(downloadArchive(client, context.repository, 12), error => /下载未完整/.test(error.message) && !error.message.includes('private-signature'))
})

test('ZIP 与安装包双重校验，支持中文及空格文件名', async () => {
  const bytes = await makeZip({ name: '动画编辑器 Pro.exe' })
  const result = await verifyArchive(bytes, { digest: `sha256:${sha256(bytes)}` })
  assert.equal(result.installerName, '动画编辑器 Pro.exe')
  assert.equal(result.installerHash, sha256(Buffer.from('MZ-test-installer')))
  await assert.rejects(verifyArchive(bytes, {}), /校验值缺失/)
  await assert.rejects(verifyArchive(bytes, { digest: `sha256:${'0'.repeat(64)}` }), /不一致/)
})

test('安装包摘要错误或伪装 exe 都被拒绝', async () => {
  for (const config of [{ checksum: '0'.repeat(64) }, { installer: Buffer.from('not-a-windows-executable') }]) {
    const bytes = await makeZip(config)
    await assert.rejects(verifyArchive(bytes, { digest: `sha256:${sha256(bytes)}` }), /校验失败/)
  }
})

test('拒绝 ZIP 路径穿越、非法 Windows 名称、符号链接及多余文件', async () => {
  for (const config of [{ name: '../escape.exe' }, { name: 'folder/installer.exe' }, { name: 'con.exe' }, { name: 'bad:installer.exe' }, { symlink: true }, { extra: 'extra.exe' }]) {
    const bytes = await makeZip(config)
    await assert.rejects(verifyArchive(bytes, { digest: `sha256:${sha256(bytes)}` }))
  }
})

test('完整模拟下载只写 release 独立目录，生成可追溯记录且不覆盖既有文件', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'svga-package-test-'))
  try {
    const bytes = await makeZip()
    const artifact = { id: 12, name: ARTIFACT, expired: false, digest: `sha256:${sha256(bytes)}`, workflow_run: { id: 99, head_sha: SHA } }
    const client = {
      json: async () => ({ artifacts: [artifact] }),
      raw: async () => new Response(bytes),
      fetchImpl: () => assert.fail('不需要重定向'),
    }
    const first = await saveArtifact(client, { ...context, root: temp }, ownRun)
    const second = await saveArtifact(client, { ...context, root: temp }, ownRun)
    assert.notEqual(first.output, second.output)
    assert.ok(first.output.startsWith(path.join(temp, 'release')))
    const receipt = JSON.parse(await readFile(path.join(first.output, 'build-receipt.json'), 'utf8'))
    assert.equal(receipt.commit, SHA)
    assert.equal(receipt.requestId, 'unique-request')
    assert.equal(receipt.installerSha256, sha256(await readFile(first.installerPath)))
    assert.equal((await readdir(first.output)).length, 4)
  } finally {
    // 仅清理测试独有的 mkdtemp 目录，不涉及用户 release 产物。
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert.match(path.basename(temp), /^svga-package-test-/)
    await rm(temp, { recursive: true, force: true })
  }
})

test('缺失/过期/多个同名产物及错误提交不进入下载', async () => {
  for (const artifacts of [[], [{ name: ARTIFACT, expired: true }], [{ name: ARTIFACT }, { name: ARTIFACT }], [{ name: ARTIFACT, workflow_run: { id: 99, head_sha: 'b'.repeat(40) } }]]) {
    const client = { json: async () => ({ artifacts }), raw: () => assert.fail('不可下载') }
    await assert.rejects(saveArtifact(client, context, ownRun))
  }
})
