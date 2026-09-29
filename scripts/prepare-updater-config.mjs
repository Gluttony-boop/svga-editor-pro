import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} 未配置；不会生成更新配置。`)
  return value
}

function repository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error('GITHUB_REPOSITORY 格式无效。')
  return value
}

function endpoint(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('更新端点必须是非空 HTTPS URL。')
  const normalized = value.trim()
  let parsed
  try { parsed = new URL(normalized) } catch { throw new Error('更新端点不是有效 URL。') }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || /(?:token|password|secret|apikey)/i.test(normalized)) {
    throw new Error('更新端点必须是无凭据、无查询参数的公开 HTTPS URL。')
  }
  return parsed.href
}

export function createUpdaterOverlay({ publicKey, repositoryName, updateEndpoint }) {
  if (typeof publicKey !== 'string' || !publicKey.trim() || /[\r\n]/.test(publicKey)) throw new Error('更新公钥必须是单行外层 Base64 文本。')
  const selectedEndpoint = updateEndpoint?.trim()
    ? endpoint(updateEndpoint)
    : `https://github.com/${repository(repositoryName)}/releases/latest/download/latest.json`
  return {
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        pubkey: publicKey,
        endpoints: [selectedEndpoint],
        requireSignedVersion: true,
        allowDowngrades: false,
        dangerousInsecureTransportProtocol: false,
        dangerousAcceptInvalidCerts: false,
        dangerousAcceptInvalidHostnames: false,
      },
    },
  }
}

export async function main({ env = process.env, output = path.join(root, '.github', 'generated', 'updater-config.json') } = {}) {
  const overlay = createUpdaterOverlay({ publicKey: env.TAURI_UPDATER_PUBLIC_KEY, repositoryName: env.GITHUB_REPOSITORY, updateEndpoint: env.TAURI_UPDATER_ENDPOINT })
  const target = path.resolve(output)
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('更新配置输出必须位于仓库目录内。')
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(overlay, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  return target
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(target => console.log(`已生成临时 updater 配置：${target}`)).catch(error => {
    console.error(`生成 updater 配置失败：${error.message}`)
    process.exitCode = 1
  })
}
