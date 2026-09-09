export function calculatePreviewZoom(containerWidth: number, containerHeight: number, width: number, height: number): number {
  if (![containerWidth, containerHeight, width, height].every(value => Number.isFinite(value) && value > 0)) return 1
  return Math.max(0.1, Math.min(5, Math.min(Math.max(1, containerWidth - 80) / width, Math.max(1, containerHeight - 80) / height) * 0.95))
}

export function previewFileName(source: string | null): string {
  if (!source) return '未命名动画'
  let path = source
  if (/^https?:\/\//i.test(source)) {
    try { path = new URL(source).pathname } catch { /* Keep the provided source as a fallback. */ }
  }
  const name = path.replace(/\\/g, '/').split('/').pop() || '未命名动画'
  try { return decodeURIComponent(name) } catch { return name }
}
