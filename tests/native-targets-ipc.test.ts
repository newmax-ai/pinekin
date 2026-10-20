import { describe, expect, it, vi } from 'vitest'
import { registerNativeTargetIpc } from '../src/main/native-targets-ipc'

const id = 'a'.repeat(64), token = '11111111-1111-4111-8111-111111111111'
function setup() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const event = {}, assertSender = vi.fn()
  const targets = { inspect: vi.fn().mockResolvedValue({ token }), configure: vi.fn().mockResolvedValue(true),
    listProjects: vi.fn().mockResolvedValue({ projects: [] }), chooseProject: vi.fn().mockResolvedValue(null),
    continue: vi.fn().mockResolvedValue({ status: 'created', app: 'Codex' }), rollback: vi.fn().mockResolvedValue(undefined) }
  registerNativeTargetIpc({ handle: (channel, handler) => { handlers.set(channel, handler) }, assertSender, targets })
  const call = (name: string, ...args: unknown[]) => handlers.get(`pinekin:source-actions-${name}`)!(event, ...args)
  return { call, assertSender, targets, event }
}
describe('通用原生目标的具名 IPC', () => {
  it('各具名方法原样分发目标标识和来源令牌，并传递发送者门禁', async () => {
    const s = setup()
    await s.call('inspect-target', 'codex', 'automatic')
    await s.call('configure-target', 'codex', token)
    await s.call('list-target-projects', 'codex', id)
    await s.call('choose-target-project', 'codex', id, token)
    await s.call('continue-target', id, 'codex', { kind: 'standalone' })
    await s.call('rollback-target', 'newmax', token)
    expect(s.targets.rollback).toHaveBeenCalledWith('newmax', token, expect.any(Function))
    expect(s.targets.inspect).toHaveBeenCalledWith('codex', 'automatic', expect.any(Function))
    expect(s.targets.configure).toHaveBeenCalledWith('codex', token, expect.any(Function))
    expect(s.targets.listProjects).toHaveBeenCalledWith(id, 'codex', expect.any(Function))
    expect(s.targets.chooseProject).toHaveBeenCalledWith(id, 'codex', token, expect.any(Function))
    expect(s.targets.continue).toHaveBeenCalledWith(id, 'codex', { kind: 'standalone' }, expect.any(Function))
    const guard = s.targets.continue.mock.calls[0][3]
    s.assertSender.mockImplementation(() => { throw new Error('发送者已失效') })
    expect(guard).toThrow('发送者已失效')
  })
  it('任意通道的请求来自非主窗口或子 frame 时，在到达注册表前拒绝', async () => {
    const s = setup(); s.assertSender.mockImplementation(() => { throw new Error('拒绝不可信请求') })
    for (const [name, args] of [
      ['inspect-target', ['codex']], ['configure-target', ['codex', token]], ['list-target-projects', ['codex', id]],
      ['choose-target-project', ['codex', id]], ['continue-target', [id, 'codex', { kind: 'standalone' }]], ['rollback-target', ['newmax', token]],
    ] as const) await expect(s.call(name, ...args)).rejects.toThrow('不可信')
    for (const action of Object.values(s.targets)) expect(action).not.toHaveBeenCalled()
  })
  it('完成异步操作后再次检查发送者，不向失效页面返回候选或创建结果', async () => {
    const s = setup()
    s.targets.inspect.mockImplementationOnce(async () => { s.assertSender.mockImplementation(() => { throw new Error('页面已变化') }); return { token } })
    await expect(s.call('inspect-target', 'codex')).rejects.toThrow('页面已变化')
  })
})
