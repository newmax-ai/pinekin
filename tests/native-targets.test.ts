import { describe, expect, it, vi } from 'vitest'
import { NativeTargets, type NativeTargetAdapter } from '../src/main/native-targets'
import { registerCodexTargetIpc } from '../src/main/codex-target-ipc'
import { browsableSources, sourceNames, type BrowsableSource } from '../src/core/sources'

const id = 'a'.repeat(64), token = '11111111-1111-4111-8111-111111111111'
function adapter(source: BrowsableSource = 'codex'): NativeTargetAdapter {
  return {
    id: source, configured: vi.fn().mockResolvedValue(true),
    inspect: vi.fn().mockResolvedValue({ app: sourceNames[source], dataPath: '/synthetic', configured: true, locationSource: 'saved', canChooseApplication: false, token }),
    configure: vi.fn().mockResolvedValue(true),
    listProjects: vi.fn().mockResolvedValue({ projects: [] }), chooseProject: vi.fn().mockResolvedValue(null),
    continue: vi.fn().mockResolvedValue({ status: 'created', app: sourceNames[source], receipt: token, threadId: token, messageCount: 2, opened: false }),
  }
}
function setup(sources: BrowsableSource[] = [...browsableSources], adapters = [adapter()]) {
  const connections = vi.fn().mockResolvedValue(sources.map(source => ({ source })))
  return { service: new NativeTargets({ connections, adapters }), connections, adapters }
}

describe('已实现原生目标的注册与门禁', () => {
  it('仅列出注册适配的目标，不把已连接来源展示成迁移能力', async () => {
    const { service, connections } = setup([...browsableSources, 'codex', 'newmax'], [adapter(), adapter('newmax')])
    const targets = await service.list()
    expect(targets.map(target => target.id)).toEqual(['newmax', 'codex'])
    expect(targets.every(target => target.implemented && target.available && target.configured)).toBe(true)
    expect(connections).not.toHaveBeenCalled()
  })
  it('来源列表读取失败不影响已注册目标，也不读取来源连接', async () => {
    const { service, connections } = setup(['newmax'])
    connections.mockRejectedValue(new Error('来源连接不可读'))
    expect((await service.list()).map(target => target.id)).toEqual(['codex'])
    expect(connections).not.toHaveBeenCalled()
  })
  it('无原生适配的平台返回空列表，主进程仍拒绝伪造的创建请求', async () => {
    const { service } = setup([...browsableSources], [])
    expect(await service.list()).toEqual([])
    await expect(service.continue(id, 'codex', { kind: 'standalone' })).rejects.toThrow('原生接续尚未支持')
  })
  it('一项配置检查失败不会隐藏其他 App，也不将失败当作未配置成功', async () => {
    const codex = adapter(), newmax = adapter('newmax')
    vi.mocked(codex.configured).mockRejectedValue(new Error('合成配置损坏'))
    const { service } = setup(['newmax', 'codex'], [codex, newmax])
    const targets = await service.list()
    expect(targets.find(target => target.id === 'codex')).toMatchObject({ available: false, reason: expect.stringContaining('配置检查失败') })
    expect(targets.find(target => target.id === 'newmax')).toMatchObject({ available: true, configured: true })
  })
  it('新的原生适配按目标分发全部操作，不隐式回落 Codex', async () => {
    const codex = adapter(), newmax = adapter('newmax'), guard = vi.fn()
    const { service } = setup(['newmax'], [codex, newmax])
    await service.inspect('newmax', 'automatic', guard)
    await service.configure('newmax', token, guard)
    await service.listProjects(id, 'newmax', guard)
    await service.chooseProject(id, 'newmax', undefined, guard)
    await service.continue(id, 'newmax', { kind: 'project', token }, guard)
    expect(newmax.inspect).toHaveBeenCalledWith('automatic', guard)
    expect(newmax.configure).toHaveBeenCalledWith(token, guard)
    expect(newmax.listProjects).toHaveBeenCalledWith(id, guard)
    expect(newmax.chooseProject).toHaveBeenCalledWith(id, undefined, guard)
    expect(newmax.continue).toHaveBeenCalledWith(id, { kind: 'project', token }, guard)
    for (const action of [codex.inspect, codex.configure, codex.listProjects, codex.chooseProject, codex.continue]) expect(action).not.toHaveBeenCalled()
  })
  it.each(browsableSources.filter(source => source !== 'codex'))('%s 尚无适配时所有入口均拒绝，不能借用 Codex 或复制兜底', async source => {
    const { service, adapters: [codex] } = setup()
    for (const call of [() => service.inspect(source, 'automatic'), () => service.configure(source, token),
      () => service.listProjects(id, source), () => service.chooseProject(id, source), () => service.continue(id, source, { kind: 'standalone' })]) {
      await expect(call()).rejects.toThrow('原生接续尚未支持')
    }
    for (const action of [codex.inspect, codex.configure, codex.listProjects, codex.chooseProject, codex.continue]) expect(action).not.toHaveBeenCalled()
  })
  it('未知目标、来源 ID、任意路径与附加参数不能到达适配器', async () => {
    const { service, adapters: [codex] } = setup()
    for (const target of ['file:///tmp/log', '../codex', {}, null, 'Codex']) await expect(service.inspect(target, 'automatic')).rejects.toThrow()
    for (const input of ['file:///etc/passwd', {}, null]) await expect(service.continue(input, 'codex', { kind: 'standalone' })).rejects.toThrow()
    for (const destination of [undefined, {}, { kind: 'standalone', path: '/evil' }, { kind: 'project', token: '/evil' }]) await expect(service.continue(id, 'codex', destination)).rejects.toThrow()
    await expect(service.inspect('codex', '/evil')).rejects.toThrow()
    await expect(service.configure('codex', '/evil')).rejects.toThrow()
    await expect(service.chooseProject(id, 'codex', '/evil')).rejects.toThrow()
    expect(codex.continue).not.toHaveBeenCalled(); expect(codex.inspect).not.toHaveBeenCalled()
  })
  it('发送者失效时在分发前拒绝，适配器继续接收原门禁以保护异步提交', async () => {
    const { service, adapters: [codex] } = setup()
    const guard = vi.fn(() => { throw new Error('不可信请求') })
    await expect(service.continue(id, 'codex', { kind: 'standalone' }, guard)).rejects.toThrow('不可信请求')
    expect(codex.continue).not.toHaveBeenCalled()
  })
  it('通用分发复用生产 Codex 适配，保留完整读取、项目令牌及提交前来源快照复核', async () => {
    const snapshot = 'b'.repeat(64), guard = vi.fn(), project = { path: '/synthetic/project', dev: 1, ino: 2 }
    const setup = { inspect: vi.fn().mockResolvedValue({ token }), confirm: vi.fn().mockResolvedValue(true) }
    const source = { getEntry: vi.fn().mockResolvedValue({}), read: vi.fn().mockResolvedValue({}), transfer: vi.fn().mockResolvedValue({ snapshot, messages: [{ role: 'user', content: '合成完整历史' }] }) }
    const projects = { list: vi.fn().mockResolvedValue({ projects: [] }), choose: vi.fn().mockResolvedValue(null), resolve: vi.fn().mockResolvedValue(project) }
    const target = { rollback: vi.fn(), continue: vi.fn().mockImplementation(async (_id, _transfer, assertSource) => { await assertSource(); return { app: 'Codex', status: 'created' } }) }
    const configured = vi.fn().mockResolvedValue(true)
    const codex = registerCodexTargetIpc({ handle: vi.fn(), assertSender: vi.fn(), configured, setup, source, projects, target })
    const service = new NativeTargets({ connections: async () => [], adapters: [codex] })
    expect((await service.list())[0]).toMatchObject({ id: 'codex', available: true, configured: true })
    await service.inspect('codex', 'automatic', guard)
    await service.configure('codex', token, guard)
    await service.listProjects(id, 'codex', guard)
    await service.chooseProject(id, 'codex', token, guard)
    await service.continue(id, 'codex', { kind: 'project', token }, guard)
    expect(setup.inspect).toHaveBeenCalledWith('automatic', guard)
    expect(setup.confirm).toHaveBeenCalledWith(token, guard)
    expect(projects.choose).toHaveBeenCalledWith(id, guard, token)
    expect(projects.resolve).toHaveBeenCalledWith(id, token)
    expect(source.transfer).toHaveBeenCalledWith(id, guard)
    expect(source.read).toHaveBeenCalledWith(id, { offset: 0, textOffset: 0, snapshot })
    expect(target.continue).toHaveBeenCalledWith(id, expect.objectContaining({ snapshot }), expect.any(Function), project)
    source.read.mockRejectedValueOnce(new Error('来源正文已变化'))
    await expect(service.continue(id, 'codex', { kind: 'standalone' }, guard)).rejects.toThrow('来源正文已变化')
    expect(target.rollback).not.toHaveBeenCalled()
  })
  it('工作区能力和回滚按目标分发，不能把 NewMax 回执交给 Codex', async () => {
    const newmax = adapter('newmax'), codex = adapter()
    newmax.destinationKind = 'workspace'; newmax.rollback = vi.fn().mockResolvedValue(undefined)
    const { service } = setup(['newmax'], [codex, newmax]), guard = vi.fn()
    expect((await service.list()).find(item => item.id === 'newmax')).toMatchObject({ destinationKind: 'workspace' })
    await service.rollback('newmax', token, guard)
    expect(newmax.rollback).toHaveBeenCalledWith(token, guard)
    await expect(service.rollback('newmax', '/arbitrary', guard)).rejects.toThrow()
    await expect(service.rollback('codex', token, guard)).rejects.toThrow(/撤销/)
  })
  it('拒绝重复原生适配注册，防止后注册静默覆盖已验证实现', () => {
    expect(() => setup([], [adapter(), adapter()])).toThrow('重复的原生目标')
  })
})
