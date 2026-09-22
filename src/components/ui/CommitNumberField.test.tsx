import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CommitNumberField } from './CommitNumberField'

const props = { label: '宽度', accessibleLabel: '文字框宽度', value: 100, unit: 'px', context: null, onStart: () => {}, onCommit: () => {} }

describe('提交式数值输入步长', () => {
  it('既有变换字段继续使用0.1步长', () => {
    expect(renderToStaticMarkup(<CommitNumberField {...props} />)).toContain('step="0.1"')
  })
  it('整数尺寸使用1px步长，不影响其它数值输入', () => {
    const html = renderToStaticMarkup(<CommitNumberField {...props} step={1} />)
    expect(html).toContain('step="1"')
    expect(html).toContain('aria-label="文字框宽度"')
    expect(html).toContain('value="100"')
  })
})
