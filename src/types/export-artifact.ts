/** 与实际发出的 sprite 同时记录；不是按图层名或后来数组顺序猜测来源。 */
export interface ExportSpriteBinding {
  spriteIndex: number
  layerId: string | null
  originalSpriteIndex: number | null
  sourceImageKey: string | null
  sourceSlotKey: string | null
  baselineImageKey: string | null
}

export interface ProjectSvgaArtifact {
  blob: Blob
  bindings: ExportSpriteBinding[]
}
