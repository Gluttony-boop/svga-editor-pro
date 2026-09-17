export function historyActionLabel(action: '撤销' | '重做', entry?: { label?: string }): string {
  return entry ? `${action}：${entry.label || '修改编辑内容'}` : action
}
