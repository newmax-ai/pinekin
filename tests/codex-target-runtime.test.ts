import { expect, it } from 'vitest'
import { codexSandboxProfile, codexEnvironment, resolveCodexBinary, resolveCodexApplication } from '../src/main/codex-target-runtime'
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const nested = 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
const manifest = { CFBundleIdentifier: 'com.openai.codex', CFBundleName: 'ChatGPT', CFBundleURLTypes: [{ CFBundleURLSchemes: ['codex', 'http', 'https'] }] }
async function bundle(name = 'ChatGPT.app', relative = nested, metadata = manifest) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-codex-bundle-')))
  const app = join(root, name), binary = join(app, relative)
  await mkdir(dirname(binary), { recursive: true })
  await writeFile(join(app, 'Contents/Info.plist'), JSON.stringify(metadata))
  await writeFile(binary, 'synthetic metadata-only executable', { mode: 0o755 })
  return { root, app, binary }
}
it.each([
  ['Codex.app', 'Contents/Resources/codex'], ['Codex.app', 'Contents/Resources/bin/codex'],
  ['ChatGPT.app', nested], ['已重命名.app', nested],
])('按包身份和协议识别 %s 的内置程序，不按显示名推断', async (name, relative) => {
  const s = await bundle(name, relative)
  try {
    expect(await resolveCodexApplication(s.app)).toMatchObject({ path: s.app, binary: s.binary, bundleId: 'com.openai.codex' })
    expect(await resolveCodexBinary(s.app)).toBe(s.binary)
    expect(await resolveCodexBinary(s.binary)).toBe(s.binary)
    const gui = join(s.app, 'Contents/MacOS/ChatGPT'); await mkdir(dirname(gui), { recursive: true }); await writeFile(gui, 'synthetic GUI')
    expect(await resolveCodexBinary(gui)).toBe(s.binary)
    await expect(resolveCodexApplication(s.root)).rejects.toThrow('应用包')
  } finally { await rm(s.root, { recursive: true, force: true }) }
})
it.each([
  { ...manifest, CFBundleIdentifier: 'com.other.app' },
  { ...manifest, CFBundleURLTypes: [{ CFBundleURLSchemes: ['other'] }] },
])('即使叫 Codex.app，也拒绝错误包身份或缺失协议 %j', async metadata => {
  const s = await bundle('Codex.app', 'Contents/Resources/codex', metadata)
  try { await expect(resolveCodexApplication(s.app)).rejects.toThrow(/身份|协议/) }
  finally { await rm(s.root, { recursive: true, force: true }) }
})
it('显式 CLI 文件仍可解析，但系统应用识别不接受任意裸程序', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-codex-cli-')))
  try {
    const file = join(root, 'codex'); await writeFile(file, 'synthetic')
    expect(await resolveCodexBinary(file)).toBe(file)
    await expect(resolveCodexApplication(file)).rejects.toThrow('应用包')
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('缺失内置程序和外跳符号链接保留具体原因，不静默转用 PATH 中另一版 CLI', async () => {
  const s = await bundle()
  try {
    await rm(s.binary)
    await expect(resolveCodexApplication(s.app)).rejects.toThrow('内置')
    const outside = join(s.root, 'outside'); await writeFile(outside, 'synthetic')
    await symlink(outside, s.binary)
    await expect(resolveCodexApplication(s.app)).rejects.toThrow(/链接|范围/)
    await rm(s.binary); await rm(join(s.app, 'Contents/Info.plist'))
    await symlink(outside, join(s.app, 'Contents/Info.plist'))
    await expect(resolveCodexApplication(s.app)).rejects.toThrow(/链接|范围/)
  } finally { await rm(s.root, { recursive: true, force: true }) }
})
it('Codex 验证进程无网络、无真实 HOME、无任意子进程权限', () => {
  const profile = codexSandboxProfile('/synthetic/Codex/codex', '/private/tmp/synthetic')
  expect(profile).toContain('(deny default)')
  expect(profile).not.toContain('(allow network')
  expect(profile).not.toContain('(subpath "/Users")')
  expect(profile).toContain('(allow process-exec (literal "/synthetic/Codex/codex"))')
  const env = codexEnvironment('/private/tmp/synthetic')
  expect(env.HOME).toBe('/private/tmp/synthetic/home')
  expect(env.CODEX_HOME).toBe('/private/tmp/synthetic/codex')
  expect(Object.keys(env).some(key => /TOKEN|KEY|SECRET|PROXY/.test(key))).toBe(false)
  expect(() => codexSandboxProfile('/bad\npath', '/private/tmp/synthetic')).toThrow()
})
