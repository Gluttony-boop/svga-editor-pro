/** 内容摘要只校验一致性，不提供签名、加密或授权保护。 */
export async function sha256Bytes(value: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  const buffer = value instanceof Blob ? await value.arrayBuffer()
    : value instanceof Uint8Array ? new Uint8Array(value).buffer : value.slice(0)
  if (!globalThis.crypto?.subtle) throw new Error('当前环境不支持内容校验，请使用桌面应用、HTTPS 或 localhost。')
  const result = await globalThis.crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('')
}
