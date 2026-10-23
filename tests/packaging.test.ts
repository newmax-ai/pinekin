import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseSigningEnv, resolveSignedBuild } from '../scripts/dist-mac-signed.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('macOS 打包配置', () => {
  it('只产出 Apple 芯片 DMG，不打 Intel 或 universal 包', () => {
    expect(pkg.build.mac.target).toEqual([{ target: 'dmg', arch: ['arm64'] }])
  })
  it('显式 ad-hoc 签名并关闭公证，不自动拾取开发证书冒充分发签名', () => {
    expect(pkg.build.mac.identity).toBe('-')
    // ad-hoc 签名无法公证；开启 hardened runtime 会因库校验导致启动失败。
    expect(pkg.build.mac.hardenedRuntime).toBe(false)
    expect(pkg.build.mac.notarize).toBe(false)
  })
  it('打包脚本先经过 typecheck 与生产构建', () => {
    expect(pkg.scripts['dist:mac']).toBe('npm run build && electron-builder --mac')
    expect(pkg.scripts.pack).toBe('npm run build && electron-builder --dir')
    expect(pkg.scripts['dist:mac:signed']).toBe('node scripts/dist-mac-signed.mjs')
  })
})

const IDENTITY = 'Developer ID Application: Example Dev (ABCDE12345)'
const credentials = {
  APPLE_ID: 'dev@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop',
  APPLE_TEAM_ID: 'ABCDE12345',
  CSC_NAME: IDENTITY,
}
const keychain = `  1) 0123456789ABCDEF "${IDENTITY}"\n     1 valid identities found\n`

describe('parseSigningEnv', () => {
  it('忽略注释与空行，去掉 export 前缀和成对引号', () => {
    const text = [
      '# 注释',
      '',
      'APPLE_ID=dev@example.com',
      'export APPLE_TEAM_ID = "ABCDE12345"',
      `CSC_NAME='${IDENTITY}'`,
      'APPLE_APP_SPECIFIC_PASSWORD=a=b',
    ].join('\n')
    expect(parseSigningEnv(text)).toEqual({
      APPLE_ID: 'dev@example.com',
      APPLE_TEAM_ID: 'ABCDE12345',
      CSC_NAME: IDENTITY,
      APPLE_APP_SPECIFIC_PASSWORD: 'a=b',
    })
  })
})

describe('resolveSignedBuild', () => {
  const base = { appId: 'ai.newmax.staithe', directories: { output: 'release' }, mac: { ...pkg.build.mac } }

  it('用 Developer ID 签名、开启 hardened runtime 与公证，产物单独输出', () => {
    const plan = resolveSignedBuild(base, credentials, keychain)
    expect(plan.config.mac).toMatchObject({
      target: [{ target: 'dmg', arch: ['arm64'] }],
      identity: 'Example Dev (ABCDE12345)',
      hardenedRuntime: true,
      notarize: true,
    })
    expect(plan.config.directories.output).toBe('release/signed')
    expect(plan.config.appId).toBe('ai.newmax.staithe')
    expect(plan.env).toEqual({
      APPLE_ID: 'dev@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop',
      APPLE_TEAM_ID: 'ABCDE12345',
    })
    expect(plan.identity).toBe(IDENTITY)
  })

  it('不修改传入的基础配置', () => {
    resolveSignedBuild(base, credentials, keychain)
    expect(base.mac.identity).toBe('-')
    expect(base.directories.output).toBe('release')
  })

  it.each(['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'CSC_NAME'])('缺少 %s 时失败，不退回 ad-hoc', (key) => {
    const vars: Record<string, string> = { ...credentials }
    delete vars[key]
    expect(() => resolveSignedBuild(base, vars, keychain)).toThrow(key)
  })

  it('拒绝非 Developer ID Application 证书', () => {
    const name = 'Apple Development: Example Dev (ABCDE12345)'
    expect(() => resolveSignedBuild(base, { ...credentials, CSC_NAME: name }, `1) X "${name}"`)).toThrow('Developer ID Application')
  })

  it('证书团队与 APPLE_TEAM_ID 不一致时失败', () => {
    expect(() => resolveSignedBuild(base, { ...credentials, APPLE_TEAM_ID: 'ZZZZZ99999' }, keychain)).toThrow('APPLE_TEAM_ID')
  })

  it('钥匙串里没有该证书时失败', () => {
    expect(() => resolveSignedBuild(base, credentials, '0 valid identities found')).toThrow('钥匙串')
  })
})
