import { describe, expect, it } from 'vitest'
import { historyStepIcon, historyStepRows } from './history-list'

type History = Parameters<typeof historyStepRows>[0]

// 列表只读取标签与游标，不需要装配完整的编辑器快照。
const snapshot = {} as History['past'][number]['snapshot']
const entry = (label?: string): History['past'][number] => ({ snapshot, label })
const createHistory = (overrides: Partial<History> = {}): History => ({
  past: [],
  future: [],
  maxDepth: 100,
  isApplyingHistory: false,
  ...overrides
})

describe('历史记录列表', () => {
  it('按起点、已执行步骤、可恢复步骤的顺序生成列表', () => {
    const history = createHistory({
      past: [entry('隐藏图层'), entry('修改透明度')],
      future: [entry('变换图层'), entry('删除图层')]
    })

    expect(historyStepRows(history)).toEqual([
      { index: 0, label: '打开', isCurrent: false, isFuture: false },
      { index: 1, label: '隐藏图层', isCurrent: false, isFuture: false },
      { index: 2, label: '修改透明度', isCurrent: true, isFuture: false },
      { index: 3, label: '变换图层', isCurrent: false, isFuture: true },
      { index: 4, label: '删除图层', isCurrent: false, isFuture: true }
    ])
    expect(history.past.map(item => item.label)).toEqual(['隐藏图层', '修改透明度'])
    expect(history.future.map(item => item.label)).toEqual(['变换图层', '删除图层'])
  })

  it('新文件仅显示选中的打开起点', () => {
    expect(historyStepRows(createHistory())).toEqual([
      { index: 0, label: '打开', isCurrent: true, isFuture: false }
    ])
  })

  it('撤回到起点时保留可恢复的全部后续步骤', () => {
    const rows = historyStepRows(createHistory({ future: [entry('隐藏图层'), entry('删除图层')] }))

    expect(rows.map(row => row.isCurrent)).toEqual([true, false, false])
    expect(rows.map(row => row.isFuture)).toEqual([false, true, true])
  })

  it('恢复快照时所有线性历史步骤灰显且不标记当前步骤', () => {
    const rows = historyStepRows(createHistory({
      past: [entry('隐藏图层')],
      future: [entry('删除图层')],
      timelineSnapshot: snapshot,
      activeSnapshotId: 'snapshot-1'
    }))

    expect(rows).toHaveLength(3)
    expect(rows.every(row => row.isFuture && !row.isCurrent)).toBe(true)
  })

  it('未命名或空标签的旧历史记录使用通用操作名称', () => {
    const rows = historyStepRows(createHistory({
      baseLabel: '',
      past: [entry()],
      future: [entry('')]
    }))

    expect(rows.map(row => row.label)).toEqual(['打开', '修改编辑内容', '修改编辑内容'])
  })

  it('历史深度裁剪后使用保留下来的起点名称', () => {
    const rows = historyStepRows(createHistory({
      baseLabel: '隐藏图层',
      past: [entry('修改透明度')],
      maxDepth: 1
    }))

    expect(rows).toEqual([
      { index: 0, label: '隐藏图层', isCurrent: false, isFuture: false },
      { index: 1, label: '修改透明度', isCurrent: true, isFuture: false }
    ])
  })
})

describe('历史记录图标', () => {
  it.each([
    ['打开', 'folder-open'],
    ['隐藏图层', 'eye-closed'],
    ['显示图层', 'eye-open'],
    ['解锁图层', 'unlock'],
    ['锁定图层', 'lock'],
    ['删除图层', 'trash'],
    ['移除图片', 'trash'],
    ['替换图片', 'image'],
    ['更新资源', 'image'],
    ['编辑插槽', 'image'],
    ['修改关键帧', 'animation'],
    ['添加动画', 'animation'],
    ['修改帧率', 'animation'],
    ['修改帧数', 'animation'],
    ['调整时序', 'animation'],
    ['变换图层', 'select'],
    ['左对齐图层', 'select'],
    ['水平分布图层', 'select'],
    ['重命名图层', 'layer'],
    ['恢复快照', 'camera'],
    ['修改透明度', 'edit']
  ])('%s 使用对应操作图标', (label, icon) => {
    expect(historyStepIcon(label)).toBe(icon)
  })
})
