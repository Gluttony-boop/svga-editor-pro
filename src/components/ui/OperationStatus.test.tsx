import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OperationStatus, type OperationStatusValue } from './OperationStatus'

describe('导出状态呈现', () => {
  it('无状态时不显示提示', () => {
    expect(renderToStaticMarkup(<OperationStatus status={null} />)).toBe('')
  })
  it.each([
    ['processing', 'text-text-secondary', 'status'],
    ['ready', 'text-accent', 'status'],
    ['success', 'text-success', 'status'],
    ['cancelled', 'text-text-muted', 'status'],
    ['error', 'text-error', 'alert'],
    ['stale', 'text-warning', 'status'],
    ['warning', 'text-warning', 'status']
  ] as const)('%s 使用独立颜色和可访问角色', (kind, color, role) => {
    const status: OperationStatusValue = { kind, message: '任意文案，不依赖成功失败关键词' }
    const html = renderToStaticMarkup(<OperationStatus status={status} />)
    expect(html).toContain(color)
    expect(html).toContain(`role="${role}"`)
    expect(html).toContain(`data-status="${kind}"`)
    if (kind !== 'success') expect(html).not.toContain('text-success')
  })
})
