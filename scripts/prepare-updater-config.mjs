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

export function createUpdaterOverlay({ publicKey, repositoryName }) {
  if (typeof publicKey !== 'string' || !publicKey.trim() || /[\r\n]/.test(publicKey)) throw new Error('更新公钥必须是单行外层 Base64 文本。')
  const repo = repository(repositoryName)
  return {
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        pubkey: publicKey,
        endpoints: [`https://github.com/${repo}/releases/latest/download/latest.json`],
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
  const overlay = createUpdaterOverlay({ publicKey: env.TAURI_UPDATER_PUBLIC_KEY, repositoryName: env.GITHUB_REPOSITORY })
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
