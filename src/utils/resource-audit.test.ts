import { describe, expect, it } from 'vitest'
import type { SlotConfig } from '@/types'
import { auditResources, createResourceAuditReport, HEAVY_RESOURCE_BYTES, resourceAdvice } from './resource-audit'
import type { ResourceMetadata } from './resource-catalog'
import type { ResourceUsage } from './resource-usage'

const usage = (id: string, extra: Partial<ResourceUsage> = {}): ResourceUsage => ({
  id, name: id, image: true, matte: false, visible: true, locked: false, ...extra
})

describe('素材体检报告', () => {
  it('只导出元数据，不泄漏图片字节、URL、本地路径或内部资源对象', () => {
    const internalResource: { value: string; self?: unknown } = { value: 'private-resource' }
    internalResource.self = internalResource
    const source = {
      key: 'avatar', byteSize: 42, width: 64, height: 32,
      buffer: new ArrayBuffer(8), data: new Uint8Array([1, 2, 3]),
      url: 'file:///private/avatar.png', path: 'D:/private/avatar.png',
      resource: internalResource
    }
    const audit = auditResources([source], new Map([['avatar', [usage('avatar-layer')]]]), {
      avatar: { type: 'image', name: '头像', value: 'data:image/png;base64,PRIVATE' }
    })
    const report = createResourceAuditReport(audit, '2026-09-16T00:00:00.000Z')

    expect(report).toMatchObject({ schemaVersion: 1, generatedAt: '2026-09-16T00:00:00.000Z', heavyThresholdBytes: HEAVY_RESOURCE_BYTES })
    expect(report.resources[0]).toEqual({
      key: 'avatar', byteSize: 42, width: 64, height: 32, decodedBytes: 8192,
      tags: ['all', 'replaced'], usages: [usage('avatar-layer')]
    })
    const serialized = JSON.stringify(report)
    expect(JSON.parse(serialized)).toEqual(report)
    expect(serialized).not.toMatch(/private|PRIVATE|buffer|"url"|"path"|"data"|"resource"/)
    expect(audit.rows[0].resource).toBe(internalResource)
    expect(audit.rows[0].resource.self).toBe(internalResource)
  })

  it('报告保留缺失引用的图层、图片与遮罩用途及隐藏锁定状态', () => {
    const imageUsage = usage('avatar-layer', { name: '头像', visible: false })
    const matteUsage = usage('masked-layer', { name: '遮罩主体', image: false, matte: true, locked: true })
    const audit = auditResources([], new Map([
      ['missing-image', [imageUsage]], ['missing-mask', [matteUsage]]
    ]), {})

    expect(createResourceAuditReport(audit).missingReferences).toEqual([
      { key: 'missing-image', usages: [imageUsage] },
      { key: 'missing-mask', usages: [matteUsage] }
    ])
  })

  it('生成或修改报告不影响审计输入及其分类、统计和引用记录', () => {
    const audit = auditResources([{ key: 'avatar', byteSize: 42, width: 8, height: 8 }], new Map([
      ['avatar', [usage('avatar-layer')]], ['missing-mask', [usage('mask-layer', { matte: true })]]
    ]), {})
    const before = structuredClone(audit)
    const report = createResourceAuditReport(audit)

    expect(audit).toEqual(before)
    expect(Number.isNaN(Date.parse(report.generatedAt))).toBe(false)
    report.counts.all = 99
    report.stats.encodedBytes = 99
    report.resources[0].tags.push('heavy')
    report.resources[0].usages[0].name = '报告内改名'
    report.missingReferences[0].usages[0].locked = true

    expect(audit).toEqual(before)
  })

  it('未知尺寸可序列化，并保留明确的未知内存与统计说明', () => {
    const audit = auditResources([{ key: 'unknown', byteSize: 3 }], new Map(), {})
    const serialized = JSON.parse(JSON.stringify(createResourceAuditReport(audit)))

    expect(serialized.resources[0]).toMatchObject({ key: 'unknown', decodedBytes: null })
    expect(serialized.stats).toMatchObject({ unknownDimensions: 1, decodedBytes: 0 })
    expect(serialized.scope).toContain('源图片资源')
    expect(serialized.scope).toContain('未引用不等于可安全删除')
  })
})

describe('素材审计', () => {
  it('独立累计可重叠的分类，保留隐藏与锁定引用', () => {
    const resources = [
      { key: 'shared-mask', byteSize: 20, width: 1024, height: 1024 },
      { key: 'single', byteSize: 10, width: 8, height: 8 },
      { key: 'spare', byteSize: 30 }
    ]
    const usageIndex = new Map([
      ['shared-mask', [usage('avatar'), usage('decoration', { image: false, matte: true, visible: false, locked: true })]],
      ['single', [usage('title')]]
    ])
    const slots: Record<string, SlotConfig> = {
      'shared-mask': { type: 'image', name: '头像', value: 'data:image/png;base64,AA==' },
      spare: { type: 'text', name: '昵称', value: '新昵称' }
    }

    const result = auditResources(resources, usageIndex, slots)

    expect(result.counts).toEqual({ all: 3, shared: 1, matte: 1, unused: 1, replaced: 2, heavy: 1 })
    expect(result.rows[0].tags).toEqual(['all', 'shared', 'matte', 'replaced', 'heavy'])
    expect(result.rows[0].usages[1]).toMatchObject({ visible: false, locked: true, matte: true })
    expect(result.rows[2].tags).toEqual(['all', 'unused', 'replaced'])
    expect(result.stats).toEqual({ encodedBytes: 60, decodedBytes: HEAVY_RESOURCE_BYTES + 256, unknownDimensions: 1 })
    expect(result.missing).toEqual([])
  })

  it('以解码内存而非文件大小判断高内存，包含恰好达到阈值的素材', () => {
    const resources = [
      { key: 'below', byteSize: HEAVY_RESOURCE_BYTES * 2, width: 1024, height: 1023 },
      { key: 'boundary', byteSize: 1, width: 1024, height: 1024 },
      { key: 'above', byteSize: 1, width: 1024, height: 1025 },
      { key: 'unknown', byteSize: HEAVY_RESOURCE_BYTES * 2 }
    ]
    const result = auditResources(resources, new Map(), {})

    expect(result.rows.filter(row => row.tags.includes('heavy')).map(row => row.key)).toEqual(['boundary', 'above'])
    expect(result.rows[0].decodedBytes).toBe(HEAVY_RESOURCE_BYTES - 4096)
    expect(result.rows[1].decodedBytes).toBe(HEAVY_RESOURCE_BYTES)
    expect(result.rows[3].decodedBytes).toBeNull()
    expect(result.counts.heavy).toBe(2)
  })

  it('同时报告缺失的图片与遮罩资源，忽略无引用的索引条目', () => {
    const missingImage = usage('avatar')
    const missingMatte = usage('frame', { image: false, matte: true })
    const usageIndex = new Map([
      ['present', [usage('background')]],
      ['missing-image', [missingImage]],
      ['missing-matte', [missingMatte]],
      ['empty', []]
    ])
    const result = auditResources([{ key: 'present', byteSize: 1 }], usageIndex, {})

    expect(result.missing).toEqual([
      { key: 'missing-image', usages: [missingImage] },
      { key: 'missing-matte', usages: [missingMatte] }
    ])
    expect(result.counts.all).toBe(1)
    expect(result.counts.unused).toBe(0)
  })

  it('未知及无效尺寸不计为零内存，也不错误归类为高内存', () => {
    const resources: ResourceMetadata[] = [
      { key: 'missing', byteSize: 1 },
      { key: 'partial', byteSize: 1, width: 64 },
      { key: 'zero', byteSize: 1, width: 64, height: 0 },
      { key: 'negative', byteSize: 1, width: -64, height: 64 },
      { key: 'nan', byteSize: 1, width: Number.NaN, height: 64 },
      { key: 'infinite', byteSize: 1, width: 64, height: Number.POSITIVE_INFINITY }
    ]
    const result = auditResources(resources, new Map(), {})

    expect(result.rows.every(row => row.decodedBytes === null)).toBe(true)
    expect(result.counts.heavy).toBe(0)
    expect(result.stats).toEqual({ encodedBytes: 6, decodedBytes: 0, unknownDimensions: 6 })
    expect(resourceAdvice(result.rows[0].tags, null)).toContain('源图尺寸未知，未计入解码内存估算；不要把未知视为零占用。')
  })

  it('分析不修改源资源、引用索引或插槽配置', () => {
    const source = Object.freeze({ key: 'avatar', byteSize: 1, width: 16, height: 16, extra: '保留扩展信息' })
    const resources = Object.freeze([source])
    const usages = [Object.freeze(usage('avatar'))]
    const usageIndex = new Map([['avatar', usages]])
    const slots: Record<string, SlotConfig> = Object.freeze({
      avatar: Object.freeze({ type: 'image', name: '头像', value: null })
    })
    const beforeUsages = structuredClone([...usageIndex])
    const beforeSlots = structuredClone(slots)

    const result = auditResources(resources, usageIndex, slots)

    expect(result.rows[0]).not.toBe(source)
    expect(result.rows[0]).toMatchObject(source)
    expect(source).not.toHaveProperty('tags')
    expect(source).not.toHaveProperty('decodedBytes')
    expect([...usageIndex]).toEqual(beforeUsages)
    expect(slots).toEqual(beforeSlots)
  })

  it('空素材库返回全零分类和统计', () => {
    expect(auditResources([], new Map(), {})).toEqual({
      rows: [], missing: [],
      counts: { all: 0, shared: 0, matte: 0, unused: 0, replaced: 0, heavy: 0 },
      stats: { encodedBytes: 0, decodedBytes: 0, unknownDimensions: 0 }
    })
  })

  it('只把插槽自身的属性视为已配置，不误判与原型属性同名的资源', () => {
    const resources = ['constructor', 'toString', '__proto__', 'avatar'].map(key => ({ key, byteSize: 1 }))
    const slots: Record<string, SlotConfig> = {
      avatar: { type: 'image', name: '头像', value: 'avatar.png' }
    }

    const result = auditResources(resources, new Map(), slots)

    expect(result.rows.filter(row => row.tags.includes('replaced')).map(row => row.key)).toEqual(['avatar'])
    expect(result.counts.replaced).toBe(1)
  })

  it('风险建议区分源资源统计、外部插槽约定与平台限制', () => {
    const advice = resourceAdvice(['all', 'shared', 'matte', 'unused', 'replaced', 'heavy'], HEAVY_RESOURCE_BYTES)

    expect(advice).toHaveLength(5)
    expect(advice.join('\n')).toContain('不是平台限制')
    expect(advice.join('\n')).toContain('外部动态插槽约定')
    expect(advice.join('\n')).toContain('统计仍基于源资源')
    expect(resourceAdvice(['all'], 256)).toEqual([])
  })
})
