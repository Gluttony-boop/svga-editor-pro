import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ReplacementScopeControls } from './ReplacementScopeControls'

const usages = [
  { id: 'one', name: '前景头像', image: true, matte: false, visible: true, locked: false },
  { id: 'two', name: '背景头像', image: true, matte: false, visible: false, locked: true },
  { id: 'three', name: '遮罩层', image: false, matte: true, visible: true, locked: false }
]

const elements = (node: React.ReactNode): React.ReactElement[] => !React.isValidElement(node) ? [] : [node, ...React.Children.toArray(node.props.children).flatMap(elements)]

describe('换图范围选择与影响名单', () => {
  it('单层模式只列出目标，其余引用不会混进影响名单', () => {
    const html = renderToStaticMarkup(<ReplacementScopeControls scope="current-layer" currentLayerId="one" usages={usages} onChange={vi.fn()} />)
    expect(html).toContain('仅当前图层')
    expect(html).toContain('所有引用图层（3）')
    expect(html).toContain('将影响 1 个图层')
    expect(html).toContain('前景头像')
    expect(html).not.toContain('背景头像')
    expect(html).not.toContain('遮罩层')
  })

  it('全部引用列出名字/隐藏/锁定/遮罩并明确作用范围', () => {
    const html = renderToStaticMarkup(<ReplacementScopeControls scope="all-references" currentLayerId="one" usages={usages} onChange={vi.fn()} />)
    expect(html).toContain('将影响 3 个图层')
    expect(html).toContain('text-accent">当前图层</span>')
    for (const text of ['前景头像', '背景头像', '遮罩层', '· 隐藏', '· 锁定', '遮罩引用']) expect(html).toContain(text)
  })

  it('没有有效单层选择时禁用单层选项并说明原因', () => {
    const onChange = vi.fn()
    const root = ReplacementScopeControls({ scope: 'all-references', usages, onChange, currentLayerError: '请选择一个未锁定图层' })
    const radios = elements(root).filter(element => element.type === 'input')
    expect(radios[0].props.disabled).toBe(true)
    expect(radios[1].props.disabled).toBeUndefined()
    radios[1].props.onChange()
    expect(onChange).toHaveBeenCalledWith('all-references')
    expect(renderToStaticMarkup(root)).toContain('请选择一个未锁定图层')
  })
})
