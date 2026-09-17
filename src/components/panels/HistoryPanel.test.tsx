import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { useEditorStore } from '@/stores/editorStore'
import { HistoryPanel } from './HistoryPanel'

type EditorState = ReturnType<typeof useEditorStore.getState>
type History = EditorState['history']
type PanelState = Pick<EditorState, 'history' | 'videoItem' | 'canUndo' | 'canRedo' | 'undo' | 'redo' | 'jumpToHistory' | 'restoreHistorySnapshot'>

const store = vi.hoisted(() => ({ state: {} as PanelState }))

vi.mock('@/stores', () => ({
  useEditorStore: Object.assign(
    <T,>(selector: (state: PanelState) => T) => selector(store.state),
    { getState: () => store.state }
  )
}))

const snapshot = {} as History['past'][number]['snapshot']
const entry = (label: string): History['past'][number] => ({ snapshot, label })

const createHistory = (overrides: Partial<History> = {}): History => ({
  past: [entry('隐藏图层'), entry('修改透明度')],
  future: [entry('删除图层')],
  baseLabel: '打开',
  snapshots: [
    { id: 'opened', name: '打开', snapshot },
    { id: 'before-edit', name: '变更前', snapshot }
  ],
  activeSnapshotId: null,
  timelineSnapshot: null,
  maxDepth: 100,
  isApplyingHistory: false,
  ...overrides
})

const buttonWithAttribute = (html: string, attribute: string, value: string): string => {
  const button = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
    ?.find(item => item.includes(`${attribute}="${value}"`))
  expect(button, `应存在 ${attribute}="${value}" 的按钮`).toBeDefined()
  return button || ''
}

describe('历史记录面板', () => {
  beforeEach(() => {
    store.state = {
      history: createHistory(),
      videoItem: {
        movie: {
          version: '2.0',
          params: { viewBoxWidth: 100, viewBoxHeight: 100, fps: 24, frames: 24 },
          images: {},
          sprites: []
        },
        images: {},
        buffers: {}
      },
      canUndo: true,
      canRedo: true,
      undo: vi.fn(),
      redo: vi.fn(),
      jumpToHistory: vi.fn(),
      restoreHistorySnapshot: vi.fn()
    }
  })

  it('无文件时显示空态且禁用编辑按钮', () => {
    store.state.videoItem = null
    store.state.history = createHistory({ past: [], future: [], snapshots: [] })
    const html = renderToStaticMarkup(<HistoryPanel />)

    expect(html).toContain('打开 SVGA 文件后记录编辑步骤')
    expect(html).not.toContain('role="listbox"')
    expect(html).not.toContain('data-history-index')
    for (const label of ['撤销', '重做', '新建快照', '删除当前状态']) {
      expect(buttonWithAttribute(html, 'aria-label', label)).toContain('disabled=""')
    }
  })

  it('按快照在前、操作步骤在后的顺序显示文件历史', () => {
    const html = renderToStaticMarkup(<HistoryPanel />)

    expect(html).toContain('role="listbox" aria-label="历史状态与快照"')
    expect(html).toContain('2 / 3')
    expect(html.indexOf('data-snapshot-id="opened"')).toBeLessThan(html.indexOf('data-snapshot-id="before-edit"'))
    expect(html.indexOf('data-snapshot-id="before-edit"')).toBeLessThan(html.indexOf('data-history-index="0"'))
    expect(html.match(/data-history-index="\d+"/g)).toEqual([
      'data-history-index="0"', 'data-history-index="1"', 'data-history-index="2"', 'data-history-index="3"'
    ])
    expect(buttonWithAttribute(html, 'data-snapshot-id', 'before-edit')).toContain('快照：变更前')
    expect(buttonWithAttribute(html, 'data-history-index', '1')).toContain('步骤 1：隐藏图层')
  })

  it('仅当前步骤显示选择标记并让后续步骤灰显但仍可选择', () => {
    const html = renderToStaticMarkup(<HistoryPanel />)
    const current = buttonWithAttribute(html, 'data-history-index', '2')
    const future = buttonWithAttribute(html, 'data-history-index', '3')
    const previous = buttonWithAttribute(html, 'data-history-index', '1')

    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
    expect(current).toContain('aria-selected="true"')
    expect(current).toContain('tabindex="0"')
    expect(current).toContain('▶')
    expect(current).toContain('，当前状态')
    expect(current).toContain('data-history-future="false"')
    expect(future).toContain('aria-selected="false"')
    expect(future).toContain('data-history-future="true"')
    expect(future).toContain('opacity-50')
    expect(future).toContain('可恢复')
    expect(future).not.toContain('disabled=""')
    expect(previous).toContain('data-history-future="false"')
    expect(previous).not.toContain('opacity-50')
    expect(html).toContain('灰色步骤可恢复；继续编辑会替换后续步骤')
  })

  it('快照模式仅选中快照并灰显全部操作步骤', () => {
    store.state.history = createHistory({
      timelineSnapshot: snapshot,
      activeSnapshotId: 'before-edit'
    })
    store.state.canRedo = false
    const html = renderToStaticMarkup(<HistoryPanel />)
    const selected = buttonWithAttribute(html, 'data-snapshot-id', 'before-edit')

    expect(selected).toContain('aria-selected="true"')
    expect(selected).toContain('▶')
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
    for (let index = 0; index < 4; index += 1) {
      const button = buttonWithAttribute(html, 'data-history-index', String(index))
      expect(button).toContain('aria-selected="false"')
      expect(button).toContain('data-history-future="true"')
      expect(button).toContain('opacity-50')
    }
    expect(buttonWithAttribute(html, 'aria-label', '撤销：选择快照')).not.toContain('disabled=""')
    expect(buttonWithAttribute(html, 'aria-label', '重做')).toContain('disabled=""')
    expect(buttonWithAttribute(html, 'aria-label', '删除当前快照')).not.toContain('disabled=""')
    expect(html).toContain('从快照继续编辑会替换原有操作步骤')
  })

  it('已删除的当前快照仍标记保留的画面并禁用重复删除', () => {
    store.state.history = createHistory({
      timelineSnapshot: snapshot,
      activeSnapshotId: 'deleted',
      activeSnapshotLabel: '已保存版本'
    })
    const html = renderToStaticMarkup(<HistoryPanel />)

    expect(html).toContain('已保存版本（已删除）')
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
    expect(buttonWithAttribute(html, 'aria-label', '删除当前快照')).toContain('disabled=""')
  })

  it('折叠时只保留面板标题和可访问的展开入口', () => {
    const html = renderToStaticMarkup(<HistoryPanel collapsed />)

    expect(html).toContain('aria-expanded="false" aria-controls="history-panel-content"')
    expect(html).toContain('历史记录')
    expect(html).not.toContain('id="history-panel-content"')
    expect(html).not.toContain('role="listbox"')
    expect(html).not.toContain('data-history-index')
    expect(html).not.toContain('aria-label="新建快照"')
  })

  it('处于忙碌状态时禁用快照、历史跳转和全部编辑按钮', () => {
    const html = renderToStaticMarkup(<HistoryPanel disabled />)

    expect(html).toContain('aria-busy="true"')
    for (const id of ['opened', 'before-edit']) {
      expect(buttonWithAttribute(html, 'data-snapshot-id', id)).toContain('disabled=""')
    }
    for (let index = 0; index < 4; index += 1) {
      expect(buttonWithAttribute(html, 'data-history-index', String(index))).toContain('disabled=""')
    }
    for (const label of ['撤销：修改透明度', '重做：删除图层', '新建快照', '删除当前状态']) {
      expect(buttonWithAttribute(html, 'aria-label', label)).toContain('disabled=""')
    }
  })

  it('初始状态不能撤销、重做或删除但可以创建快照', () => {
    store.state.history = createHistory({ past: [], future: [] })
    store.state.canUndo = false
    store.state.canRedo = false
    const html = renderToStaticMarkup(<HistoryPanel />)

    for (const label of ['撤销', '重做', '删除当前状态']) {
      expect(buttonWithAttribute(html, 'aria-label', label)).toContain('disabled=""')
    }
    expect(buttonWithAttribute(html, 'aria-label', '新建快照')).not.toContain('disabled=""')
    expect(buttonWithAttribute(html, 'data-history-index', '0')).toContain('aria-selected="true"')
  })
})
