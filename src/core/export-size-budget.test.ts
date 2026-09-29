import { describe, expect, it } from 'vitest'
import { evaluateSizeBudget } from './export-size-budget'

describe('实际导出体积目标', () => {
  it.each(['0', '-10', 'no', 'Infinity', '1048577'])('拒绝无效阈值 %s', value => {
    expect(evaluateSizeBudget(value, 10, false).status).toBe('invalid')
  })
  it('未设置阈值/尚未生成时不报告达标', () => {
    expect(evaluateSizeBudget('', 10, false).status).toBe('empty')
    expect(evaluateSizeBudget('1', undefined, false).status).toBe('pending')
  })
  it('按字节而不是舍入后的显示数值判断，等于阈值允许', () => {
    expect(evaluateSizeBudget('1', 1024, false).status).toBe('passed')
    expect(evaluateSizeBudget('1', 1025, false).status).toBe('failed')
    expect(evaluateSizeBudget('0.5', 513, false).status).toBe('failed')
  })
  it('不以旧预览为新编辑背书', () => {
    expect(evaluateSizeBudget('1', 1024, true).status).toBe('stale')
  })
})
