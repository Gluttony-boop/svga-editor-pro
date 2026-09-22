import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { OptimizationConfig } from '@/core/optimizer'
import { CommitNumberField } from '@/components/ui/CommitNumberField'
import { ImageResizeControls } from './ImageResizeControls'

type ImageConfig = OptimizationConfig['image']

const image = (overrides: Partial<ImageConfig> = {}): ImageConfig => ({
  format: 'png', quality: 85, pngColors: 0, resizeEnabled: false, resizePercent: 100,
  maxWidth: 0, maxHeight: 0, sizeLimitEnabled: false, autoResizeToCanvas: false, deduplicate: false,
  ...overrides,
})

const elements = (node: React.ReactNode): React.ReactElement[] => {
  if (!React.isValidElement(node)) return []
  return [node, ...React.Children.toArray(node.props.children).flatMap(elements)]
}

const checkbox = (root: React.ReactElement, label: string): React.ReactElement => {
  const result = elements(root).find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props['aria-label'] === label)
  expect(result, `应存在复选框：${label}`).toBeDefined()
  return result as React.ReactElement
}

describe('图片尺寸缩减控件', () => {
  it('兼容旧配置：沿用 resizeEnabled 作为指定尺寸开关并显示已有上限', () => {
    const html = renderToStaticMarkup(
      <ImageResizeControls
        image={image({ resizeEnabled: true, sizeLimitEnabled: undefined, maxWidth: 300, maxHeight: 0 })}
        canvasSize={{ width: 800, height: 600 }}
        onChange={vi.fn()}
      />
    )

    expect(html).toContain('aria-label="按指定尺寸缩减图片"')
    expect(html).toContain('checked=""')
    expect(html).toContain('aria-label="图片最大宽度"')
    expect(html).toContain('value="300"')
    expect(html).toContain('当前上限：300 × 不限 px。')
  })

  it('指定尺寸开关只更新尺寸模式并保留其它图片配置', () => {
    const onChange = vi.fn()
    const root = ImageResizeControls({
      image: image({ resizeEnabled: true, resizePercent: 70, autoResizeToCanvas: true, maxWidth: 0, maxHeight: 0 }),
      canvasSize: null,
      onChange,
    }) as React.ReactElement
    checkbox(root, '按指定尺寸缩减图片').props.onChange({ target: { checked: true } })

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      resizeEnabled: true,
      resizePercent: 70,
      autoResizeToCanvas: true,
      sizeLimitEnabled: true,
      maxWidth: 512,
      maxHeight: 512,
    }))
  })

  it('关闭指定尺寸时不关闭百分比缩放', () => {
    const onChange = vi.fn()
    const root = ImageResizeControls({
      image: image({ resizeEnabled: true, resizePercent: 70, sizeLimitEnabled: true, maxWidth: 512, maxHeight: 512 }),
      canvasSize: null,
      onChange,
    }) as React.ReactElement
    checkbox(root, '按指定尺寸缩减图片').props.onChange({ target: { checked: false } })

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      resizeEnabled: true,
      resizePercent: 70,
      sizeLimitEnabled: false,
      maxWidth: 512,
      maxHeight: 512,
    }))
  })

  it('提交宽高使用整数步长并允许独立限制', () => {
    const onChange = vi.fn()
    const root = ImageResizeControls({ image: image({ sizeLimitEnabled: true, maxWidth: 256, maxHeight: 1024 }), canvasSize: null, onChange }) as React.ReactElement
    const fields = elements(root).filter(node => node.type === CommitNumberField)
    expect(fields).toHaveLength(2)
    expect(fields.map(field => field.props.step)).toEqual([1, 1])

    fields[0].props.onCommit(511.6)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxWidth: 512, maxHeight: 1024 }))
  })

  it('快捷尺寸启用指定模式但不清除百分比和自动画布设置', () => {
    const onChange = vi.fn()
    const root = ImageResizeControls({
      image: image({ resizeEnabled: true, resizePercent: 65, autoResizeToCanvas: true, sizeLimitEnabled: true, maxWidth: 64, maxHeight: 96 }),
      canvasSize: { width: 400, height: 300 },
      onChange,
    }) as React.ReactElement
    const button = elements(root).find(node => node.type === 'button' && node.props['aria-label'] === '设置图片最大尺寸为 256×256 px')
    expect(button).toBeDefined()
    button?.props.onClick()

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      resizeEnabled: true,
      resizePercent: 65,
      autoResizeToCanvas: true,
      sizeLimitEnabled: true,
      maxWidth: 256,
      maxHeight: 256,
    }))
  })

  it('两个指定尺寸上限均为0时明确提示不限制尺寸', () => {
    const html = renderToStaticMarkup(<ImageResizeControls image={image({ sizeLimitEnabled: true })} canvasSize={null} onChange={vi.fn()} />)
    expect(html).toContain('当前不限制指定尺寸。')
    expect(html).toContain('仅影响导出纹理，动画布局不变；更小才替换，建议先预览。')
  })

  it('禁用时不允许修改开关、字段和快捷尺寸', () => {
    const html = renderToStaticMarkup(<ImageResizeControls image={image({ sizeLimitEnabled: true, maxWidth: 512, maxHeight: 512 })} canvasSize={null} disabled onChange={vi.fn()} />)
    expect(html).toContain('aria-label="按指定尺寸缩减图片"')
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(5)
  })
})
