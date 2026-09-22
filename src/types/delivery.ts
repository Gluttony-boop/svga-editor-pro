import type { OptimizationConfig } from '@/core/optimizer'
import type { MovieParams, SlotTextConfig } from './svga'
import type { ExportSpriteBinding } from './export-artifact'

export interface DeliveryTarget {
  platform: 'unspecified' | 'web' | 'android' | 'ios' | 'other'
  player: string
  version: string
  maxFileBytes: number | null
  maxDecodedImageBytes: number | null
}

export interface DeliveryOptions {
  title: string
  target: DeliveryTarget
  /** 默认不附带工程，避免将未交付素材和可编辑源数据一并分享。 */
  includeProject: boolean
}

export interface DeliveryCheck {
  id: string
  title: string
  status: 'passed' | 'failed' | 'warning' | 'not-tested'
  detail: string
  key?: string
}

export interface DeliveryFile {
  path: string
  bytes: number
  sha256: string
  role: 'animation' | 'slots' | 'resource' | 'preview' | 'report' | 'guide' | 'project'
}

export interface DeliverySlotSource extends ExportSpriteBinding {
  layerName: string | null
  currentImageKey: string | null
  textEffect: 'none' | 'dynamic' | 'baked' | 'disabled' | 'empty'
  text: SlotTextConfig | null
}

/** 数组保留精确 Key，避免特殊资源名称变成对象原型或 ZIP 路径。 */
export interface DeliverySlot {
  key: string
  role: 'image' | 'matte' | 'vector' | 'audio' | 'unknown'
  state: 'referenced' | 'unreferenced' | 'missing'
  resource: { path: string; bytes: number; sha256: string; mimeType: string; width: number | null; height: number | null } | null
  spriteIndices: number[]
  matteForSpriteIndices: number[]
  sources: DeliverySlotSource[]
}

export interface DeliveryReport {
  format: 'svga-editor-delivery-report'
  schemaVersion: 1
  checks: DeliveryCheck[]
  decodedImageBytesEstimate: number
  /** 仅当前输出帧的编辑器检查，不冒充目标 SDK 或设备实测。 */
  previewFrame: number
}

export interface DeliveryManifest {
  format: 'svga-editor-delivery'
  schemaVersion: 1
  createdAt: string
  title: string
  sourceRevision: { schemaVersion: 1; algorithm: 'sha256'; value: string }
  params: MovieParams
  target: DeliveryTarget
  previewFrame: number
  optimization: OptimizationConfig
  independentKeysPreserved: true
  includesProject: boolean
  /** 包含实际载荷；manifest 自身的摘要另放 checksums.sha256，避免自引用。 */
  files: DeliveryFile[]
}

export interface DeliveryBundleResult {
  blob: Blob
  fileName: string
  manifest: DeliveryManifest
  slots: DeliverySlot[]
  report: DeliveryReport
  previews: { actual: Blob; design: Blob }
}
