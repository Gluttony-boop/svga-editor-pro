import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { LocalProjectSnapshot, LocalProjectSummary } from '@/types/project-library'
import { LocalProjectLibraryDialog, type LocalProjectLibraryDialogProps } from './LocalProjectLibraryDialog'

const entry = (id: string, kind: LocalProjectSummary['kind'], overrides: Partial<LocalProjectSummary> = {}): LocalProjectSummary => ({
  id, kind, name: '礼物动画.svgaproj', updatedAt: Date.UTC(2026, 8, 20, 10, 30, 45), size: 1024, revision: 1, ...overrides,
})

const snapshot = (entries: LocalProjectSummary[] = []): LocalProjectSnapshot => ({
  entries,
  preferences: { recoveryEnabled: true, recentEnabled: true, epoch: 0 },
  bytesUsed: entries.reduce((sum, item) => sum + item.size, 0),
})

const props = (overrides: Partial<LocalProjectLibraryDialogProps> = {}): LocalProjectLibraryDialogProps => ({
  isOpen: true, onClose: vi.fn(), snapshot: snapshot(), loading: false, error: null,
  onOpen: vi.fn(), onDownload: vi.fn(), onRemove: vi.fn(), onClear: vi.fn(), onConfigure: vi.fn(), onRefresh: vi.fn(),
  ...overrides,
})

function button(html: string, label: string): string {
  const result = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(item => item.includes(`aria-label="${label}"`))
  expect(result, `应显示可访问按钮：${label}`).toBeDefined()
  return result ?? ''
}

function checkbox(html: string, label: string): string {
  const result = html.match(/<input\b[^>]*\/>/g)?.find(item => item.includes(`aria-label="${label}"`))
  expect(result, `应显示可访问设置：${label}`).toBeDefined()
  return result ?? ''
}

describe('恢复与最近工程弹窗', () => {
  it('关闭时不输出内容，也不触发任何数据操作', () => {
    const input = props({ isOpen: false })
    expect(renderToStaticMarkup(<LocalProjectLibraryDialog {...input} />)).toBe('')
    for (const callback of [input.onOpen, input.onDownload, input.onRemove, input.onClear, input.onConfigure, input.onRefresh]) {
      expect(callback).not.toHaveBeenCalled()
    }
  })

  it('使用键盘隔离弹窗并准确区分未保存恢复与最近副本', () => {
    const html = renderToStaticMarkup(<LocalProjectLibraryDialog {...props()} />)
    expect(html).toContain('role="dialog" aria-modal="true" aria-label="恢复与最近工程"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('aria-label="未保存恢复副本"')
    expect(html).toContain('aria-label="最近工程（本机副本）"')
    expect(html).toContain('暂无未保存恢复副本。')
    expect(html).toContain('暂无最近工程副本。')
    expect(html).toContain('0 B / 256 MiB')
    expect(html).toContain('0 / 5')
    expect(html).toContain('0 / 8')
    expect(button(html, '清空全部本机工程副本')).toContain('disabled=""')
    expect(button(html, '刷新本机工程列表')).not.toContain('disabled=""')
  })

  it('保留数据安全边界说明，不将本机副本称为已保存或云端备份', () => {
    const html = renderToStaticMarkup(<LocalProjectLibraryDialog {...props()} />)
    for (const text of [
      '本机用户配置', '不会上传云端', '不是云备份', '可能导致副本丢失',
      'Ctrl+S 保存为 .svgaproj 工程', '恢复副本不代表工程已保存',
      '不自动淘汰', '当前未保存修改将先由编辑器询问处理',
      '不会跟随磁盘文件更新', '保存需要重新选择路径', '不会自动覆盖原文件',
      '关闭设置只停止后续写入', '淘汰较旧缓存',
    ]) expect(html).toContain(text)
    expect(html).not.toContain('确认清空全部本机工程副本')
    expect(html).not.toContain('确认删除本机副本')
  })

  it('在各分组内按副本更新时间倒序显示，不修改父级原数组', () => {
    const source = snapshot([
      entry('recent-old', 'recent', { updatedAt: 1000 }),
      entry('recovery-old', 'recovery', { updatedAt: 2000 }),
      entry('recent-new', 'recent', { updatedAt: 3000 }),
      entry('recovery-new', 'recovery', { updatedAt: 4000 }),
    ])
    const originalIds = source.entries.map(item => item.id)
    const html = renderToStaticMarkup(<LocalProjectLibraryDialog {...props({ snapshot: source })} />)
    expect(html.match(/data-local-project-id="[^"]+"/g)).toEqual([
      'data-local-project-id="recovery-new"', 'data-local-project-id="recovery-old"',
      'data-local-project-id="recent-new"', 'data-local-project-id="recent-old"',
    ])
    expect(source.entries.map(item => item.id)).toEqual(originalIds)
    expect(html).toContain('4.0 KiB / 256 MiB')
  })

  it('每个同名副本的三个操作均包含唯一id，恢复和最近副本可被精确选择', () => {
    const source = snapshot([entry('recover-1', 'recovery'), entry('recent-1', 'recent')])
    const html = renderToStaticMarkup(<LocalProjectLibraryDialog {...props({ snapshot: source })} />)
    for (const id of ['recover-1', 'recent-1']) {
      for (const operation of ['打开本机副本', '下载工程', '删除本机副本']) {
        expect(button(html, `${operation}：礼物动画.svgaproj（${id}）`)).not.toContain('disabled=""')
      }
    }
    expect(button(html, '清空全部本机工程副本')).not.toContain('disabled=""')
    expect(html.match(/1.0 KiB/g)).toHaveLength(2)
    expect(html.match(/dateTime="2026-09-20T10:30:45.000Z"/g)).toHaveLength(2)
    expect(html.match(/title="本机本地时间"/g)).toHaveLength(2)
  })

  it('只读快照为关闭的偏好正确显示，不在组件内擅自写回', () => {
    const source = snapshot()
    source.preferences.recoveryEnabled = false
    source.preferences.recentEnabled = false
    const input = props({ snapshot: source })
    const html = renderToStaticMarkup(<LocalProjectLibraryDialog {...input} />)
    expect(checkbox(html, '自动保留未保存修改的恢复副本')).not.toContain('checked=""')
    expect(checkbox(html, '保留最近工程的本机副本')).not.toContain('checked=""')
    expect(input.onConfigure).not.toHaveBeenCalled()
  })

  it('默认快照偏好均开启', () => {
    const html = renderToStaticMarkup(<LocalProjectLibraryDialog {...props()} />)
    expect(checkbox(html, '自动保留未保存修改的恢复副本')).toContain('checked=""')
    expect(checkbox(html, '保留最近工程的本机副本')).toContain('checked=""')
  })

  it('读取中保留已有列表，但禁用所有操作和设置', () => {
    const source = snapshot([entry('recover-1', 'recovery')])
    const html = renderToStaticMarkup(<LocalProjectLibraryDialog {...props({ snapshot: source, loading: true })} />)
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('role="status"')
    expect(html).toContain('正在读取本机工程副本')
    expect(html).toContain('<fieldset disabled=""')
    for (const operation of ['打开本机副本', '下载工程', '删除本机副本']) {
      expect(button(html, `${operation}：礼物动画.svgaproj（recover-1）`)).toContain('disabled=""')
    }
    for (const label of ['清空全部本机工程副本', '刷新本机工程列表', '关闭工程库']) {
      expect(button(html, label)).toContain('disabled=""')
    }
  })

  it('首次读取中不显示假空态，不开放未读取的偏好配置', () => {
    const html = renderToStaticMarkup(<LocalProjectLibraryDialog {...props({ snapshot: null, loading: true })} />)
    expect(html).toContain('正在读取本机工程副本')
    expect(html).not.toContain('暂无未保存恢复副本')
    expect(html).not.toContain('暂无最近工程副本')
    expect(html).not.toContain('尚未读取到本机副本列表')
    expect(html).toContain('<fieldset disabled=""')
  })

  it('存储不可用时提供刷新和手动清空入口，明确数量未知但不虚报副本丢失或成功', () => {
    const html = renderToStaticMarkup(<LocalProjectLibraryDialog {...props({ snapshot: null, error: '浏览器拒绝访问存储' })} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('本机工程库暂不可用')
    expect(html).toContain('浏览器拒绝访问存储')
    expect(html).toContain('先手动保存工程')
    expect(html).toContain('无法读取本机副本的数量和内容')
    expect(html).toContain('不会自动清理')
    expect(html).toContain('手动选择“清空本机副本”并再次确认')
    expect(html).toContain('所有本机副本将不可恢复')
    expect(html).not.toContain('暂无未保存恢复副本')
    expect(html).not.toContain('暂无最近工程副本')
    expect(html).not.toContain('已删除')
    expect(button(html, '刷新本机工程列表')).not.toContain('disabled=""')
    expect(button(html, '清空全部本机工程副本')).not.toContain('disabled=""')
    expect(html).toContain('<fieldset disabled=""')
  })

  it('错误态渲染不会直接清空库，仍须用户打开删除确认', () => {
    const input = props({ snapshot: null, error: '本机工程库设置损坏' })
    const html = renderToStaticMarkup(<LocalProjectLibraryDialog {...input} />)
    expect(html).not.toContain('aria-label="确认清空全部本机工程副本"')
    expect(input.onClear).not.toHaveBeenCalled()
    expect(input.onConfigure).not.toHaveBeenCalled()
  })

  it('没有快照也没有错误时不提供无依据的清空操作', () => {
    const html = renderToStaticMarkup(<LocalProjectLibraryDialog {...props({ snapshot: null })} />)
    expect(button(html, '清空全部本机工程副本')).toContain('disabled=""')
    expect(html).toContain('<fieldset disabled=""')
    expect(html).not.toContain('所有本机副本将不可恢复')
  })

  it('错误尚未解决但正在读取时，不允许同时清空工程库', () => {
    const html = renderToStaticMarkup(<LocalProjectLibraryDialog {...props({ snapshot: null, error: '存储设置损坏', loading: true })} />)
    expect(button(html, '清空全部本机工程副本')).toContain('disabled=""')
    expect(button(html, '刷新本机工程列表')).toContain('disabled=""')
    expect(html).toContain('<fieldset disabled=""')
  })

  it('错误存在时空的旧快照也不能封死手动清空入口', () => {
    const html = renderToStaticMarkup(<LocalProjectLibraryDialog {...props({ snapshot: snapshot(), error: '读取工程库失败' })} />)
    expect(button(html, '清空全部本机工程副本')).not.toContain('disabled=""')
    expect(html).toContain('本机工程操作未完成')
    expect(html).not.toContain('无法读取本机副本的数量和内容')
  })

  it('快照已读取时操作错误不掩盖其他可下载副本', () => {
    const source = snapshot([entry('recover-1', 'recovery')])
    const html = renderToStaticMarkup(<LocalProjectLibraryDialog {...props({ snapshot: source, error: '读取工程内容失败' })} />)
    expect(html).toContain('本机工程操作未完成')
    expect(html).toContain('读取工程内容失败')
    expect(html).toContain('data-local-project-id="recover-1"')
    expect(button(html, '下载工程：礼物动画.svgaproj（recover-1）')).not.toContain('disabled=""')
  })

  it('将名称、id、父级错误作为文本安全转义，不渲染文件带入的HTML', () => {
    const source = snapshot([entry('key"<unsafe>', 'recovery', { name: '<img src=x onerror=alert(1)>.svgaproj' })])
    const html = renderToStaticMarkup(<LocalProjectLibraryDialog {...props({ snapshot: source, error: '<script>unsafe</script>' })} />)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.svgaproj')
    expect(html).toContain('key&quot;&lt;unsafe&gt;')
    expect(html).toContain('&lt;script&gt;unsafe&lt;/script&gt;')
    expect(html).not.toContain('<img ')
    expect(html).not.toContain('<script>')
  })

  it('无效元信息退回未知文案，避免日期格式化异常使整个副本库打不开', () => {
    const source = snapshot([entry('bad', 'recovery', { updatedAt: NaN, size: NaN })])
    const html = renderToStaticMarkup(<LocalProjectLibraryDialog {...props({ snapshot: source })} />)
    expect(html).toContain('时间未知')
    expect(html).toContain('大小未知')
    expect(html).not.toContain('datetime=')
  })
})
