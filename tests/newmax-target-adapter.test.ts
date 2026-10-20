import { describe, expect, it, vi } from 'vitest'
import { createNewMaxTargetAdapter } from '../src/main/newmax-target-adapter'
const id = 'a'.repeat(64), token = '11111111-1111-4111-8111-111111111111'
function setup() {
  const source = { getEntry: vi.fn().mockResolvedValue({ id }), read: vi.fn().mockResolvedValue({}),
    transfer: vi.fn().mockResolvedValue({ title: '合成', source: 'codex', snapshot: 'snapshot', messages: [{ role: 'user', content: 'hello' }] }) }
  const target = { configured: vi.fn().mockResolvedValue(true), inspect: vi.fn().mockResolvedValue(null), configure: vi.fn().mockResolvedValue(true),
    listProjects: vi.fn().mockResolvedValue({ projects: [] }), chooseProject: vi.fn().mockResolvedValue(null), rollback: vi.fn().mockResolvedValue(undefined),
    continue: vi.fn().mockResolvedValue({ app: 'NewMax', status: 'created', opened: false, receipt: token, threadId: token, messageCount: 1 }) }
  return { source, target, adapter: createNewMaxTargetAdapter({ source, target }) }
}
describe('NewMax 接续具名适配', () => {
  it('使用完整来源读取及原快照复核，不调用 Codex 或复制文本', async () => {
    const { source, target, adapter } = setup(), guard = vi.fn()
    await adapter.continue(id, { kind: 'project', token }, guard)
    expect(source.transfer).toHaveBeenCalledWith(id, guard)
    const check = target.continue.mock.calls[0][2]
    await check()
    expect(source.read).toHaveBeenCalledWith(id, { offset: 0, textOffset: 0, snapshot: 'snapshot' })
    expect(target.continue).toHaveBeenCalledWith(id, expect.objectContaining({ snapshot: 'snapshot' }), expect.any(Function), token, guard)
    expect(adapter.id).toBe('newmax')
  })
  it('来源与发送者失效时不向目标提交，异步项目结果再次核验来源', async () => {
    const { source, target, adapter } = setup()
    const guard = () => { throw new Error('sender revoked') }
    await expect(adapter.continue(id, { kind: 'standalone' }, guard)).rejects.toThrow('sender revoked')
    expect(target.continue).not.toHaveBeenCalled()
    source.getEntry.mockRejectedValueOnce(new Error('source disconnected'))
    await expect(adapter.listProjects(id, () => {})).rejects.toThrow('source disconnected')
    expect(target.listProjects).not.toHaveBeenCalled()
  })
})
