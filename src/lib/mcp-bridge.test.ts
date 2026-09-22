import { describe, expect, it } from 'vitest'
import { __mcpTest } from './mcp-bridge'

describe('MCP 编辑器桥接输入校验', () => {
  it('只保留允许通过 MCP 修改的图层字段', () => {
    expect(__mcpTest.allowedLayerUpdates({ name: '标题', visible: false, sprites: { unsafe: true } })).toEqual({
      name: '标题',
      visible: false
    })
    expect(__mcpTest.allowedLayerUpdates({ opacity: Number.NaN })).toBeNull()
    expect(__mcpTest.allowedLayerUpdates({ canvasTransform: { x: 0, y: 0, scaleX: 1, scaleY: 1 } })).toBeNull()
  })

  it('接受受支持的 Base64 图片并拒绝 SVG 或超限数据', () => {
    expect(__mcpTest.normalizeBase64Image('data:image/png;base64,aGVsbG8=', undefined)).toEqual({
      base64: 'aGVsbG8=',
      mimeType: 'image/png'
    })
    expect(__mcpTest.normalizeBase64Image('PHN2Zz48L3N2Zz4=', 'image/svg+xml')).toBeNull()
    expect(__mcpTest.normalizeBase64Image('A'.repeat(14 * 1024 * 1024), 'image/png')).toBeNull()
  })
})
