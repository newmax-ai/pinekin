import { describe, expect, it, vi } from 'vitest'
import { registerCodexTargetIpc } from '../src/main/codex-target-ipc'
const id = 'a'.repeat(64), snapshot = 'b'.repeat(64), token = '11111111-1111-4111-8111-111111111111'
const standalone = { kind: 'standalone' }
function setup() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const assertSender = vi.fn(), targetSetup = { inspect: vi.fn().mockResolvedValue({ token }), confirm: vi.fn().mockResolvedValue(true) }
  const target = { continue: vi.fn().mockImplementation(async (_id, _text, guard) => { await guard(); return { status: 'created' } }), rollback: vi.fn() }
  const source = { transfer: vi.fn().mockResolvedValue({ snapshot, messages: [{ role: 'user', content: '合成' }] }), getEntry: vi.fn().mockResolvedValue({}), read: vi.fn().mockResolvedValue({}) }
  const project = { path: '/synthetic/project', dev: 1, ino: 2 }
  const projects = { list: vi.fn().mockResolvedValue({ projects: [{ id: token, name: 'project', path: project.path }] }),
    choose: vi.fn().mockResolvedValue({ token, path: project.path, name: 'project' }), resolve: vi.fn().mockResolvedValue(project) }
  registerCodexTargetIpc({ handle: (channel, handler) => { handlers.set(channel, handler) }, assertSender, setup: targetSetup, target, source, projects })
  const call = (channel: string, ...args: unknown[]) => handlers.get(`pinekin:source-actions-${channel}`)!({}, ...args)
  return { call, assertSender, targetSetup, target, source, projects, project }
}
describe('接续 IPC 只信任主进程候选与来源授权', () => {
  it('显式选择独立会话才创建，从主进程补读全量并在提交前复核快照', async () => {
    const s = setup()
    await s.call('continue-codex', id, standalone)
    expect(s.source.transfer).toHaveBeenCalledWith(id, expect.any(Function))
    expect(s.source.read).toHaveBeenCalledWith(id, { offset: 0, textOffset: 0, snapshot })
    expect(s.target.continue).toHaveBeenCalledWith(id, expect.objectContaining({ snapshot }), expect.any(Function), undefined)
    expect(s.projects.resolve).not.toHaveBeenCalled()
  })
  it('任意 URL、对象和历史载荷不能越过 IPC，撤销只接受 UUID', async () => {
    const s = setup()
    for (const input of ['codex://threads/other', '../escape', {}, null]) await expect(s.call('continue-codex', input, standalone)).rejects.toThrow()
    await expect(s.call('rollback-transfer', '../escape')).rejects.toThrow()
    expect(s.source.transfer).not.toHaveBeenCalled()
  })
  it('未选择继续位置、任意项目路径或附加字段均不能创建或静默回退', async () => {
    const s = setup()
    for (const destination of [undefined, null, {}, '/project', { kind: 'project', path: '/evil' }, { kind: 'standalone', path: '/evil' }, { kind: 'project', token: '/evil' }]) {
      await expect(s.call('continue-codex', id, destination)).rejects.toThrow()
    }
    expect(s.target.continue).not.toHaveBeenCalled(); expect(s.source.transfer).not.toHaveBeenCalled()
  })
  it('项目目录只来自主进程令牌，选择阶段不读取正文、不配置、不创建', async () => {
    const s = setup()
    expect(await s.call('choose-codex-project', id)).toMatchObject({ token, name: 'project' })
    expect(s.projects.choose).toHaveBeenCalledWith(id, expect.any(Function))
    expect(s.source.transfer).not.toHaveBeenCalled(); expect(s.targetSetup.confirm).not.toHaveBeenCalled()
    expect(s.target.continue).not.toHaveBeenCalled()
    await s.call('continue-codex', id, { kind: 'project', token })
    expect(s.projects.resolve).toHaveBeenCalledWith(id, token)
    expect(s.target.continue).toHaveBeenCalledWith(id, expect.anything(), expect.any(Function), s.project)
  })
  it('已有项目列表只读取元数据；选择只接收列表 UUID 而非路径', async () => {
    const s = setup()
    expect(await s.call('list-codex-projects', id)).toMatchObject({ projects: [{ id: token }] })
    expect(s.projects.list).toHaveBeenCalledWith(id, expect.any(Function))
    expect(s.source.transfer).not.toHaveBeenCalled(); expect(s.target.continue).not.toHaveBeenCalled()
    await s.call('choose-codex-project', id, token)
    expect(s.projects.choose).toHaveBeenLastCalledWith(id, expect.any(Function), token)
    for (const bad of ['/project', {}, null]) await expect(s.call('choose-codex-project', id, bad)).rejects.toThrow()
    s.assertSender.mockImplementation(() => { throw new Error('不可信') })
    await expect(s.call('list-codex-projects', id)).rejects.toThrow('不可信')
  })
  it('列表完成前来源断开不得返回旧列表', async () => {
    const s = setup()
    s.source.getEntry.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('来源已断开'))
    await expect(s.call('list-codex-projects', id)).rejects.toThrow('来源已断开')
  })
  it('项目选择取消返回 null，选完时来源断开与令牌失效均拒绝', async () => {
    const s = setup(); s.projects.choose.mockResolvedValueOnce(null)
    expect(await s.call('choose-codex-project', id)).toBeNull()
    s.source.getEntry.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('来源已断开'))
    await expect(s.call('choose-codex-project', id)).rejects.toThrow('来源已断开')
    s.projects.resolve.mockRejectedValueOnce(new Error('项目选择已过期'))
    await expect(s.call('continue-codex', id, { kind: 'project', token })).rejects.toThrow('项目选择已过期')
    expect(s.source.transfer).not.toHaveBeenCalled(); expect(s.target.continue).not.toHaveBeenCalled()
  })
  it('识别与确认是不同通道；无令牌或任意路径不能授权，模式只接受枚举', async () => {
    const s = setup()
    expect(await s.call('inspect-codex')).toEqual({ token })
    expect(s.targetSetup.inspect).toHaveBeenCalledWith('automatic', expect.any(Function))
    expect(s.targetSetup.confirm).not.toHaveBeenCalled()
    await expect(s.call('configure-codex')).rejects.toThrow()
    await expect(s.call('configure-codex', { binary: '/evil', home: '/evil' })).rejects.toThrow()
    await expect(s.call('inspect-codex', '/evil')).rejects.toThrow()
    expect(await s.call('configure-codex', token)).toBe(true)
    expect(s.targetSetup.confirm).toHaveBeenCalledWith(token, expect.any(Function))
  })
  it('手动选择取消原样返回null，发送者失效不能识别、选项目或创建', async () => {
    const s = setup(); s.targetSetup.inspect.mockResolvedValueOnce(null)
    expect(await s.call('inspect-codex', 'directory')).toBeNull()
    expect(s.targetSetup.confirm).not.toHaveBeenCalled()
    s.assertSender.mockImplementation(() => { throw new Error('不可信') })
    await expect(s.call('inspect-codex')).rejects.toThrow('不可信')
    await expect(s.call('choose-codex-project', id)).rejects.toThrow('不可信')
    await expect(s.call('continue-codex', id, standalone)).rejects.toThrow('不可信')
  })
  it('授权断开或快照变化时，在目标提交之前终止', async () => {
    const s = setup(); s.source.read.mockRejectedValueOnce(new Error('来源已变化'))
    await expect(s.call('continue-codex', id, standalone)).rejects.toThrow('已变化')
  })
})
