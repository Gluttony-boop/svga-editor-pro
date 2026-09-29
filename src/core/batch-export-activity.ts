// 原生关闭与安装更新读取同一个同步门卫，不依赖 React 下一次重绘。
const tasks = new Set<symbol>()
const listeners = new Set<() => void>()
export const isBatchExportActive = () => tasks.size > 0
export const subscribeBatchExportActivity = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function beginBatchExportActivity(): () => void {
  const token = Symbol('batch-export')
  tasks.add(token)
  listeners.forEach(listener => listener())
  return () => {
    if (tasks.delete(token)) listeners.forEach(listener => listener())
  }
}
