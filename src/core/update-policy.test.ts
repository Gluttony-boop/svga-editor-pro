import { describe, expect, it } from 'vitest'
import { canInstallUpdate, classifyUpdateError, updateStatusForError } from './update-policy'

describe('桌面更新策略', () => {
  it.each([
    ['pubkey missing', 'not-configured'], ['signature invalid', 'signature'], ['network timeout', 'network'],
    ['version downgrade', 'version'], ['其它错误', 'unknown']
  ] as const)('分类 %s', (message, expected) => expect(classifyUpdateError(new Error(message))).toBe(expected))

  it('网页/未配置不伪报最新版', () => {
    expect(updateStatusForError(new Error('updater endpoint not configured'))).toMatchObject({ phase: 'disabled', errorCode: 'not-configured' })
    expect(updateStatusForError(new Error('network timeout'))).toMatchObject({ phase: 'error', errorCode: 'network' })
  })

  it.each([
    [{ dirty: true, busy: false, exporting: false, same: true }, '未保存'],
    [{ dirty: false, busy: true, exporting: false, same: true }, '打开'],
    [{ dirty: false, busy: false, exporting: true, same: true }, '导出'],
    [{ dirty: false, busy: false, exporting: false, same: false }, '发生变化'],
  ] as const)('安装前阻止危险状态：%s', (value, text) => {
    const result = canInstallUpdate({ ...value, currentInputs: value.same ? [] : [], downloadedInputs: value.same ? [] : [{}] })
    expect(result).toMatchObject({ ok: false })
    expect((result as { reason: string }).reason).toContain(text)
  })

  it('没有脏状态、没有忙任务且输入仍相同才允许安装', () => {
    const token: unknown[] = []
    expect(canInstallUpdate({ dirty: false, busy: false, exporting: false, currentInputs: token, downloadedInputs: token })).toEqual({ ok: true })
  })

  it('每次渲染创建新数组但引用内容相同仍允许安装，真正内容引用变化才阻止', () => {
    const video = {}, buffer = {}, first = [video, buffer], second = [video, buffer]
    expect(canInstallUpdate({ dirty: false, busy: false, exporting: false, currentInputs: first, downloadedInputs: second })).toEqual({ ok: true })
    expect(canInstallUpdate({ dirty: false, busy: false, exporting: false, currentInputs: [video, {}], downloadedInputs: second })).toMatchObject({ ok: false })
  })
})
