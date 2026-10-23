#!/usr/bin/env node
// 正式分发打包：读取仓库根目录 .env.signing，用 Developer ID 签名、开启 hardened runtime 并公证。
// 自用包仍走 `npm run dist:mac`（ad-hoc）；这里缺任何凭据或证书都直接失败，不退回 ad-hoc。
// 用法：node scripts/dist-mac-signed.mjs [--check]   --check 只校验凭据与证书，不构建。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID_PREFIX = 'Developer ID Application:'
const REQUIRED = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'CSC_NAME']

/** 解析 KEY=VALUE 文本；忽略注释与空行，去掉 export 前缀和成对引号。 */
export function parseSigningEnv(text) {
  const vars = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim()
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1)
    if (key) vars[key] = value
  }
  return vars
}

/** 校验凭据与钥匙串证书，生成签名版 electron-builder 配置与公证所需环境变量。 */
export function resolveSignedBuild(baseConfig, vars, keychainIdentities) {
  const missing = REQUIRED.filter((key) => !vars[key])
  if (missing.length) throw new Error(`.env.signing 缺少 ${missing.join('、')}`)
  const identity = vars.CSC_NAME
  if (!identity.startsWith(ID_PREFIX)) throw new Error(`CSC_NAME 必须是 ${ID_PREFIX} 证书，当前为「${identity}」`)
  const team = /\(([A-Z0-9]+)\)\s*$/.exec(identity)?.[1]
  if (team !== vars.APPLE_TEAM_ID) throw new Error(`证书团队 ${team ?? '未知'} 与 APPLE_TEAM_ID 不一致`)
  if (!keychainIdentities.includes(`"${identity}"`)) throw new Error(`钥匙串中没有有效的签名证书「${identity}」`)
  return {
    identity,
    config: {
      ...baseConfig,
      directories: { ...baseConfig.directories, output: 'release/signed' },
      // electron-builder 要求去掉证书类型前缀；未指定 entitlements 时使用其内置的 Electron 默认值。
      mac: { ...baseConfig.mac, identity: identity.slice(ID_PREFIX.length).trim(), hardenedRuntime: true, notarize: true },
    },
    env: { APPLE_ID: vars.APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD: vars.APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID: vars.APPLE_TEAM_ID },
  }
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const envFile = join(root, '.env.signing')
  if (!existsSync(envFile)) throw new Error('缺少 .env.signing；自用包请改用 npm run dist:mac')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  const plan = resolveSignedBuild(pkg.build, parseSigningEnv(readFileSync(envFile, 'utf8')), identities)
  console.log(`==> 签名证书：${plan.identity}`)
  console.log(`==> 产物目录：${plan.config.directories.output}`)
  if (process.argv.includes('--check')) return

  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
  // 只用钥匙串里的指定证书，避免外部 CSC_* 变量改走其它证书。
  for (const key of ['CSC_NAME', 'CSC_LINK', 'CSC_KEY_PASSWORD']) delete process.env[key]
  Object.assign(process.env, plan.env)
  const builder = await import('electron-builder')
  const { build, Platform } = builder.default ?? builder
  await build({ projectDir: root, targets: Platform.MAC.createTarget(), config: plan.config })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`dist:mac:signed 失败：${error instanceof Error ? error.message : error}`)
    process.exit(1)
  })
}
