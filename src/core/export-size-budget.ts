/** 以实际字节比较阈值，显示时的舍入不能把超标文件判成达标。 */
export function evaluateSizeBudget(target: string, actualBytes: number | undefined, stale: boolean) {
  if (!target.trim()) return { status: 'empty', message: '可选；填写目标后，根据实际导出文件核对。' }
  const kib = Number(target)
  if (!Number.isFinite(kib) || kib <= 0 || kib > 1024 * 1024) return { status: 'invalid', message: '请输入大于 0 且不超过 1,048,576 的 KiB 数值。' }
  if (stale) return { status: 'stale', message: '编辑或配置已变化，请重新生成预览后核对。' }
  if (actualBytes === undefined) return { status: 'pending', message: '请生成导出预览，使用实际文件大小核对。' }
  return actualBytes <= kib * 1024
    ? { status: 'passed', message: `体积达标：实际 ${(actualBytes / 1024).toFixed(2)} KiB / 目标 ${kib} KiB。请继续检查画质。` }
    : { status: 'failed', message: `未达标：实际 ${(actualBytes / 1024).toFixed(2)} KiB，超出 ${((actualBytes - kib * 1024) / 1024).toFixed(2)} KiB。请调整压缩方案后重新预览。` }
}
