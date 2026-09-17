import type { LayoutOperation } from '@/core/layer-layout'

export const LAYOUT_LABELS: Record<LayoutOperation, string> = {
  'align-left': '左对齐',
  'align-center-x': '水平居中',
  'align-right': '右对齐',
  'align-top': '顶对齐',
  'align-center-y': '垂直居中',
  'align-bottom': '底对齐',
  'distribute-x': '水平等间距',
  'distribute-y': '垂直等间距'
}
