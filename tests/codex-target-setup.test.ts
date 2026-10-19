import { describe, expect, it, vi } from 'vitest'
import { CodexTargetSetup } from '../src/main/codex-target-setup'

function setup() {
  const saved = vi.fn().mockResolvedValue(undefined)
  const application = vi.fn().mockResolvedValue({ name: 'Codex', path: '/Applications/Codex.app' })
  const resolveBinary = vi.fn().mockResolvedValue('/Applications/Codex.app/Contents/Resources/codex')
  const checkDirectory = vi.fn().mockResolvedValue(undefined)
  const chooseApplication = vi.fn().mockResolvedValue(null), chooseDirectory = vi.fn().mockResolvedValue(null)
  const configure = vi.fn().mockResolvedValue(undefined)
  let time = 1000
  const service = new CodexTargetSetup({ saved, application, resolveBinary, checkDirectory, chooseApplication, chooseDirectory, configure,
    defaultHome: '/synthetic/.codex', locationSource: 'default', platform: 'darwin', now: () => time })
  return { service, saved, application, resolveBinary, checkDirectory, chooseApplication, chooseDirectory, configure, expire: () => { time += 301_000 } }
}
describe('目标自动识别与显式授权分离', () => {
  it('系统关联显示名为 ChatGPT 时不误判未安装，以解析出的包内程序为准', async () => {
    const s = setup(), binary = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
    s.application.mockResolvedValue({ name: 'ChatGPT', path: '/Applications/ChatGPT.app' })
    s.resolveBinary.mockResolvedValue(binary)
    const preview = await s.service.inspect('automatic')
    expect(preview).toMatchObject({ applicationPath: '/Applications/ChatGPT.app', applicationName: 'ChatGPT', configured: false })
    expect(preview?.token).toBeTruthy()
    await s.service.confirm(preview!.token!)
    expect(s.configure).toHaveBeenCalledWith(binary, '/synthetic/.codex', expect.any(Function))
  })
  it('程序定位保留具体失败原因，不把路径或权限问题全部改成未安装提示', async () => {
    const s = setup()
    s.resolveBinary.mockRejectedValueOnce(new Error('已找到应用包，但内置 CLI 缺失'))
    expect((await s.service.inspect('automatic'))?.reason).toContain('内置 CLI 缺失')
    expect(s.configure).not.toHaveBeenCalled()
  })
  it('查询系统关联与默认目录，不弹文件框、不运行程序、不写配置；确认令牌才授权', async () => {
    const s = setup(), preview = await s.service.inspect('automatic')
    expect(preview).toMatchObject({ app: 'Codex', applicationPath: '/Applications/Codex.app', dataPath: '/synthetic/.codex', configured: false, locationSource: 'default' })
    expect(preview!.token).toMatch(/^[a-f0-9-]{36}$/)
    expect(s.chooseApplication).not.toHaveBeenCalled(); expect(s.chooseDirectory).not.toHaveBeenCalled(); expect(s.configure).not.toHaveBeenCalled()
    await s.service.confirm(preview!.token!)
    expect(s.configure).toHaveBeenCalledExactlyOnceWith('/Applications/Codex.app/Contents/Resources/codex', '/synthetic/.codex', expect.any(Function))
    await expect(s.service.confirm(preview!.token!)).rejects.toThrow('重新')
  })
  it('优先复用已授权位置；不把默认目录冒充客户端真实配置', async () => {
    const s = setup()
    s.saved.mockResolvedValue({ binary: '/Applications/Codex.app/Contents/Resources/codex', home: '/synthetic/custom' })
    expect(await s.service.inspect('automatic')).toMatchObject({ dataPath: '/synthetic/custom', configured: true, locationSource: 'saved' })
    expect(s.checkDirectory).toHaveBeenCalledWith('/synthetic/custom')
  })
  it('程序未识别时就地解释，不擅自弹框或伪装可执行；手动入口才选程序', async () => {
    const s = setup(); s.application.mockRejectedValueOnce(new Error('未注册协议'))
    const result = await s.service.inspect('automatic')
    expect(result?.token).toBeUndefined(); expect(result?.canChooseApplication).toBe(true)
    expect(result?.reason).toContain('Codex')
    expect(s.chooseApplication).not.toHaveBeenCalled()
    s.chooseApplication.mockResolvedValueOnce('/Applications/Codex.app')
    expect((await s.service.inspect('application'))?.token).toBeTruthy()
    expect(s.chooseDirectory).not.toHaveBeenCalled()
  })
  it('自定义仅选数据目录，取消保留之前识别的候选，不触发配置或第二个选择框', async () => {
    const s = setup(), first = await s.service.inspect('automatic')
    expect(await s.service.inspect('directory')).toBeNull()
    expect(s.configure).not.toHaveBeenCalled(); expect(s.chooseApplication).not.toHaveBeenCalled()
    await s.service.confirm(first!.token!)
    s.chooseDirectory.mockResolvedValueOnce('/synthetic/alternate')
    const custom = await s.service.inspect('directory')
    expect(custom).toMatchObject({ dataPath: '/synthetic/alternate', locationSource: 'custom', configured: false })
    await s.service.confirm(custom!.token!)
    expect(s.configure).toHaveBeenLastCalledWith('/Applications/Codex.app/Contents/Resources/codex', '/synthetic/alternate', expect.any(Function))
  })
  it('目录不存在或链接被拒绝时不给令牌，不创建目录或悄悄回退', async () => {
    const s = setup(); s.checkDirectory.mockRejectedValueOnce(new Error('目录不可用'))
    expect(await s.service.inspect('automatic')).toMatchObject({ dataPath: '/synthetic/.codex', reason: expect.stringContaining('目录'), configured: false })
    expect(s.configure).not.toHaveBeenCalled()
  })
  it('拒绝未知、过期、被新探测替换的令牌，以及任意路径载荷', async () => {
    const s = setup(), first = await s.service.inspect('automatic')
    await s.service.inspect('automatic')
    await expect(s.service.confirm(first!.token!)).rejects.toThrow('重新')
    const latest = await s.service.inspect('automatic'); s.expire()
    await expect(s.service.confirm(latest!.token!)).rejects.toThrow('重新')
    await expect(s.service.confirm({ binary: '/evil', home: '/evil' } as never)).rejects.toThrow()
    expect(s.configure).not.toHaveBeenCalled()
  })
  it('探测与选择过程互斥，发送者失效后不能授权', async () => {
    const s = setup(); let release!: (value: { name: string; path: string }) => void
    s.application.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const pending = s.service.inspect('automatic')
    await expect(s.service.inspect('automatic')).rejects.toThrow('正在')
    release({ name: 'Codex', path: '/Applications/Codex.app' })
    const preview = await pending
    await expect(s.service.confirm(preview!.token!, () => { throw new Error('请求已失效') })).rejects.toThrow('失效')
    expect(s.configure).not.toHaveBeenCalled()
  })
})
