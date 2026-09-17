import type { useEditorStore } from '@/stores/editorStore'

type History = ReturnType<typeof useEditorStore.getState>['history']

export function historyStepRows(history: History) {
  const actions = [...history.past, ...history.future]
  const isSnapshot = history.timelineSnapshot != null
  return [history.baseLabel || '打开', ...actions.map(entry => entry.label || '修改编辑内容')]
    .map((label, index) => ({
      index,
      label,
      isCurrent: !isSnapshot && index === history.past.length,
      isFuture: isSnapshot || index > history.past.length
    }))
}

export function historyStepIcon(label: string): string {
  if (/打开/.test(label)) return 'folder-open'
  if (/隐藏/.test(label)) return 'eye-closed'
  if (/显示/.test(label)) return 'eye-open'
  if (/解锁/.test(label)) return 'unlock'
  if (/锁定/.test(label)) return 'lock'
  if (/删除|移除/.test(label)) return 'trash'
  if (/图片|资源|插槽/.test(label)) return 'image'
  if (/关键帧|动画|帧率|帧数|时序/.test(label)) return 'animation'
  if (/变换|对齐|分布/.test(label)) return 'select'
  if (/图层/.test(label)) return 'layer'
  if (/快照/.test(label)) return 'camera'
  return 'edit'
}
