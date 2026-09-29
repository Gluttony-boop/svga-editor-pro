import { expect, it, vi } from 'vitest'
import { beginBatchExportActivity, isBatchExportActive, subscribeBatchExportActivity } from './batch-export-activity'

it('任务门卫同步生效，独立释放且幂等，不因其他任务结束误放行', () => {
  const listener = vi.fn(), unsubscribe = subscribeBatchExportActivity(listener)
  expect(isBatchExportActive()).toBe(false)
  const a = beginBatchExportActivity(), b = beginBatchExportActivity()
  expect(isBatchExportActive()).toBe(true)
  a(); a()
  expect(isBatchExportActive()).toBe(true)
  b()
  expect(isBatchExportActive()).toBe(false)
  expect(listener).toHaveBeenCalledTimes(4)
  unsubscribe()
  beginBatchExportActivity()()
  expect(listener).toHaveBeenCalledTimes(4)
})
