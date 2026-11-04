import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveNewMaxApplication, resolveNewMaxWindowsApplication, type WindowsApplicationDeps } from '../src/main/newmax-application'

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

// Windows 身份校验通过注入的注册表／文件系统／PowerShell 替身运行，不读取真实注册表，也不执行任何目标程序。
describe('NewMax 系统协议关联的 Windows 应用身份识别', () => {
  const exe = 'C:\\Users\\Jay\\AppData\\Local\\Programs\\NewMax\\NewMax.exe'
  const reg = (value: string) => `\r\nHKEY_CLASSES_ROOT\\newmax\\shell\\open\\command\r\n    (默认)    REG_SZ    ${value}\r\n`
  interface World { command: string; userChoice: boolean; product: string; link: boolean; file: boolean; real: string; size: number; mtime: number; productFails: boolean; regFails: boolean }
  function setup(patch: Partial<World> = {}) {
    const world: World = { command: `"${exe}" "%1"`, userChoice: false, product: 'NewMax', link: false, file: true, real: exe, size: 100, mtime: 1, productFails: false, regFails: false, ...patch }
    const run = vi.fn(async (file: string, args: string[], _env?: Record<string, string>) => {
      if (file.toLowerCase().endsWith('\\reg.exe')) {
        if (args.join(' ').includes('UserChoice')) return world.userChoice ? { code: 0, stdout: 'ProgId    REG_SZ    Other' } : { code: 1, stdout: '' }
        return world.regFails ? { code: 1, stdout: '' } : { code: 0, stdout: reg(world.command) }
      }
      return world.productFails ? { code: 1, stdout: '' } : { code: 0, stdout: `${world.product}\r\n` }
    })
    const deps: WindowsApplicationDeps = { run, systemRoot: 'C:\\Windows',
      lstat: async () => ({ isSymbolicLink: () => world.link, isFile: () => world.file, size: world.size, mtimeMs: world.mtime }),
      realpath: async () => world.real }
    return { run, deps, world }
  }
  it('按注册表命令、可执行文件规范路径与产品名识别正式版和国际版', async () => {
    const { deps } = setup()
    expect(await resolveNewMaxWindowsApplication(deps)).toEqual({ path: exe, productName: 'NewMax' })
    const intl = 'D:\\Apps\\NewMax AI\\NewMax AI.exe'
    const second = setup({ command: `"${intl}" "%1"`, real: intl, product: 'NewMax AI' })
    expect(await resolveNewMaxWindowsApplication(second.deps)).toEqual({ path: intl, productName: 'NewMax AI' })
  })
  it('只调用系统目录下固定的 reg.exe 与 powershell.exe，可执行文件路径仅经环境变量传入', async () => {
    const { deps, run } = setup()
    await resolveNewMaxWindowsApplication(deps)
    const files = run.mock.calls.map(call => call[0])
    expect(files).toEqual(['C:\\Windows\\System32\\reg.exe', 'C:\\Windows\\System32\\reg.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'])
    const powershell = run.mock.calls[2]
    expect(powershell[1].join(' ')).not.toContain('NewMax.exe')
    expect(powershell[2]).toMatchObject({ PINEKIN_APPLICATION: exe })
  })
  it.each([
    ['用户另选了默认应用', { userChoice: true }, /默认应用/],
    ['注册表读取失败', { regFails: true }, /协议|注册/],
    ['未加引号', { command: `${exe} "%1"` }, /命令/],
    ['带额外参数', { command: `"${exe}" "%1" --evil` }, /命令/],
    ['经解释器转调', { command: 'cmd.exe /c start "%1"' }, /命令/],
    ['网络路径', { command: '"\\\\server\\share\\NewMax.exe" "%1"', real: '\\\\server\\share\\NewMax.exe' }, /本地绝对路径/],
    ['相对路径', { command: '"NewMax.exe" "%1"', real: 'NewMax.exe' }, /本地绝对路径/],
    ['路径穿越', { command: '"C:\\Apps\\..\\NewMax.exe" "%1"', real: 'C:\\NewMax.exe' }, /本地绝对路径/],
    ['文件名不符', { command: '"C:\\Apps\\electron.exe" "%1"', real: 'C:\\Apps\\electron.exe' }, /文件名/],
    ['产品名为通用 Electron', { product: 'Electron' }, /产品名/],
    ['文件名与产品名不配对', { command: '"C:\\Apps\\NewMax AI.exe" "%1"', real: 'C:\\Apps\\NewMax AI.exe', product: 'NewMax' }, /产品名/],
    ['符号链接', { link: true }, /符号链接/],
    ['路径经过联接点', { real: 'C:\\Other\\NewMax.exe' }, /符号链接|联接/],
    ['不是普通文件', { file: false }, /普通文件/],
    ['产品名读取失败', { productFails: true }, /产品名|版本信息/],
  ] as const)('拒绝：%s', async (_name, patch, message) => {
    const { deps } = setup(patch)
    await expect(resolveNewMaxWindowsApplication(deps)).rejects.toThrow(message)
  })
  it('检查期间可执行文件变化时拒绝', async () => {
    const { deps, world } = setup()
    let calls = 0
    deps.lstat = async () => ({ isSymbolicLink: () => false, isFile: () => true, size: world.size, mtimeMs: calls++ === 0 ? 1 : 2 })
    await expect(resolveNewMaxWindowsApplication(deps)).rejects.toThrow(/变化/)
  })
})
