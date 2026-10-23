import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveNewMaxApplication } from '../src/main/newmax-application'

const roots: string[] = []
const protocol = [{ CFBundleURLSchemes: ['newmax'] }]
async function fixture(info: Record<string, unknown>, name = 'Electron.app') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-newmax-identity-')))
  roots.push(root)
  const app = join(root, name), metadata = join(app, 'Contents/Info.plist')
  await mkdir(join(app, 'Contents'), { recursive: true })
  await writeFile(metadata, JSON.stringify(info))
  return { root, app, metadata }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

// .app 包身份验证是 macOS 能力，不代表 Windows 协议关联已验证。
describe.runIf(process.platform === 'darwin')('NewMax 系统协议关联的应用包身份识别', () => {
  it.each(['cc.newmax.desktop.cn.dev', 'cc.newmax.desktop.intl.dev'])('开发包 %s 不依赖 Electron 显示名或静态协议字段', async bundleId => {
    const { app } = await fixture({ CFBundleIdentifier: bundleId, CFBundleName: 'Electron', CFBundleShortVersionString: '44.7.2' })
    expect(await resolveNewMaxApplication(app)).toEqual({ path: app, bundleId, mode: 'development' })
  })
  it.each(['cc.newmax.desktop', 'com.newmaxai.app'])('正式包 %s 按包身份和 newmax 声明识别，允许改显示名', async bundleId => {
    const { app } = await fixture({ CFBundleIdentifier: bundleId, CFBundleName: '已改名', CFBundleURLTypes: protocol }, 'Renamed.app')
    expect(await resolveNewMaxApplication(app)).toEqual({ path: app, bundleId, mode: 'packaged' })
  })
  it.each(['com.github.Electron', 'org.electronjs.Electron', 'cc.newmax.desktop.fake.dev', 'cc.newmax.desktop.cn.dev.evil', 'com.attacker.client', ''])('拒绝仅凭名字或协议伪装的应用 %s', async bundleId => {
    const { app } = await fixture({ CFBundleIdentifier: bundleId, CFBundleName: 'NewMax AI', CFBundleURLTypes: protocol })
    await expect(resolveNewMaxApplication(app)).rejects.toThrow('身份')
  })
  it.each([undefined, [], [{ CFBundleURLSchemes: ['codex'] }]])('正式包缺少 newmax 协议声明时拒绝：%j', async types => {
    const { app } = await fixture({ CFBundleIdentifier: 'cc.newmax.desktop', CFBundleURLTypes: types })
    await expect(resolveNewMaxApplication(app)).rejects.toThrow('协议')
  })
  it('协议声明结构无效时不放行，即使是开发包', async () => {
    const { app } = await fixture({ CFBundleIdentifier: 'cc.newmax.desktop.cn.dev', CFBundleURLTypes: 'newmax' })
    await expect(resolveNewMaxApplication(app)).rejects.toThrow('协议')
  })
  it('只接受已解析的绝对 .app 路径，不扫描目录或猜测安装位置', async () => {
    const { app, root } = await fixture({ CFBundleIdentifier: 'cc.newmax.desktop.cn.dev' })
    await expect(resolveNewMaxApplication(root)).rejects.toThrow('应用包')
    await expect(resolveNewMaxApplication('Electron.app')).rejects.toThrow('绝对')
    await expect(resolveNewMaxApplication(join(app, 'Contents'))).rejects.toThrow('应用包')
  })
  it('拒绝越界 metadata 符号链接', async () => {
    const { app, root, metadata } = await fixture({ CFBundleIdentifier: 'cc.newmax.desktop.cn.dev' })
    const outside = join(root, 'outside.plist')
    await writeFile(outside, JSON.stringify({ CFBundleIdentifier: 'cc.newmax.desktop.cn.dev' }))
    await rm(metadata); await symlink(outside, metadata)
    await expect(resolveNewMaxApplication(app)).rejects.toThrow('链接')
  })
  it('拒绝以符号链接伪装应用包', async () => {
    const { app, root } = await fixture({ CFBundleIdentifier: 'cc.newmax.desktop.cn.dev' })
    const linked = join(root, 'Linked.app'); await symlink(app, linked)
    await expect(resolveNewMaxApplication(linked)).rejects.toThrow('链接')
  })
  it('拒绝超限、非文件和不可解析的 metadata', async () => {
    const { app, metadata } = await fixture({ CFBundleIdentifier: 'cc.newmax.desktop.cn.dev' })
    await writeFile(metadata, 'x'.repeat(256 * 1024 + 1))
    await expect(resolveNewMaxApplication(app)).rejects.toThrow('上限')
    await writeFile(metadata, 'not a plist')
    await expect(resolveNewMaxApplication(app)).rejects.toThrow('解析')
    await rm(metadata); await mkdir(metadata)
    await expect(resolveNewMaxApplication(app)).rejects.toThrow('普通文件')
  })
})
