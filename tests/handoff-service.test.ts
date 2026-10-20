import { describe, expect, it, vi } from 'vitest'
import { HandoffService } from '../src/main/handoff-service'

const id = 'a'.repeat(64)
const transfer = { title: '合成正文', source: 'codex' as const, snapshot: 'b'.repeat(64), warnings: ['附件未携带'], sourceMessageCount: 2,
  messages: [{ role: 'user' as const, content: '跨页问题' }, { role: 'assistant' as const, content: '完整末尾' }] }
function setup() {
  const deps = { getEntry: vi.fn().mockResolvedValue({ id }), transfer: vi.fn().mockResolvedValue(transfer),
    copyFile: vi.fn().mockResolvedValue(undefined), save: vi.fn().mockResolvedValue(true), now: vi.fn(() => 1000) }
  return { deps, service: new HandoffService(deps) }
}
describe('通用文件主进程事务：无目标、无启动、无文本复制', () => {
  it('准备只返回令牌，交付完整文件；不要求连接任何目标 App', async () => {
    const { deps, service } = setup()
    deps.transfer.mockResolvedValueOnce({ ...transfer, messages: [{ role: 'user', content: 'x'.repeat(12_000) + '完整末尾' }] })
    const prepared = await service.prepare(id)
    expect(deps.transfer).toHaveBeenCalledWith(id, expect.any(Function))
    expect(Object.keys(prepared)).toEqual(['token'])
    expect(deps.copyFile).not.toHaveBeenCalled(); expect(deps.save).not.toHaveBeenCalled()
    expect(await service.deliver(prepared.token, 'copy-file')).toEqual({ status: 'file-copied' })
    expect(deps.copyFile.mock.calls[0][0]).toContain('完整末尾')
    expect(deps.copyFile.mock.calls[0][0]).toContain('附件未携带')
    expect(deps.copyFile.mock.calls[0][0]).not.toContain('目标：')
    expect(deps.copyFile).toHaveBeenCalledWith(expect.any(String), expect.any(Function))
    expect(deps.transfer).toHaveBeenCalledOnce()
  })
  it('超出旧文本剪贴板预算仍可复制完整文件，保存取消不算成功', async () => {
    const { service, deps } = setup()
    const content = 'x'.repeat(1024 * 1024 + 1)
    deps.transfer.mockResolvedValueOnce({ ...transfer, messages: [{ role: 'user', content }] })
    const prepared = await service.prepare(id)
    expect(await service.deliver(prepared.token, 'copy-file')).toEqual({ status: 'file-copied' })
    expect(deps.copyFile.mock.calls[0][0]).toContain(content)
    deps.save.mockResolvedValueOnce(false)
    expect(await service.deliver(prepared.token, 'export')).toEqual({ status: 'cancelled' })
    expect(await service.deliver(prepared.token, 'export')).toEqual({ status: 'exported' })
    expect(deps.save.mock.calls[1][0]).toContain(content)
  })
  it('文件复制失败如实报错，不降级复制文字或谎报成功', async () => {
    const { service, deps } = setup()
    const prepared = await service.prepare(id)
    deps.copyFile.mockRejectedValueOnce(new Error('剪贴板失败'))
    await expect(service.deliver(prepared.token, 'copy-file')).rejects.toThrow('剪贴板失败')
    expect(await service.deliver(prepared.token, 'copy-file')).toEqual({ status: 'file-copied' })
  })
  it('拒绝任意路径、URL、旧文字复制与打开动作', async () => {
    const { service, deps } = setup()
    await expect(service.prepare('/etc/passwd')).rejects.toThrow()
    await expect(service.prepare('https://evil.test')).rejects.toThrow()
    await expect(service.deliver('/tmp/file', 'export')).rejects.toThrow()
    const prepared = await service.prepare(id)
    for (const action of ['copy', 'copy-open', 'execute']) await expect(service.deliver(prepared.token, action)).rejects.toThrow()
    expect(deps.copyFile).not.toHaveBeenCalled()
  })
  it.each(['source', 'expired', 'discard', 'clear'])('%s 失效后不复制、不导出', async kind => {
    const { service, deps } = setup()
    const prepared = await service.prepare(id)
    if (kind === 'source') deps.getEntry.mockRejectedValue(new Error('来源已断开'))
    if (kind === 'expired') deps.now.mockReturnValue(1_000_000)
    if (kind === 'discard') service.discard(prepared.token)
    if (kind === 'clear') service.clear()
    await expect(service.deliver(prepared.token, 'copy-file')).rejects.toThrow()
    expect(deps.copyFile).not.toHaveBeenCalled(); expect(deps.save).not.toHaveBeenCalled()
  })
  it('读取中重载、发送者失效或断开来源不能留下可投递快照', async () => {
    const { service, deps } = setup()
    deps.transfer.mockImplementationOnce(async () => { service.clear(); return transfer })
    await expect(service.prepare(id)).rejects.toThrow()
    const guard = vi.fn()
    deps.transfer.mockImplementationOnce(async () => { guard.mockImplementation(() => { throw new Error('页面失效') }); return transfer })
    await expect(service.prepare(id, guard)).rejects.toThrow('页面失效')
    deps.transfer.mockImplementationOnce(async () => { deps.getEntry.mockRejectedValue(new Error('来源断开')); return transfer })
    await expect(service.prepare(id)).rejects.toThrow('来源断开')
  })
  it.each(['copy-file', 'export'] as const)('%s 副作用前再次验证授权，投递互斥', async action => {
    const { service, deps } = setup()
    const prepared = await service.prepare(id)
    let finish!: () => void
    const operation = async (_text: string, guard: () => Promise<void>) => {
      await new Promise<void>(resolve => { finish = resolve }); await guard(); return true
    }
    deps.copyFile.mockImplementationOnce(operation); deps.save.mockImplementationOnce(operation)
    const pending = service.deliver(prepared.token, action)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await expect(service.deliver(prepared.token, action)).rejects.toThrow('正在')
    await expect(service.prepare(id)).rejects.toThrow('正在')
    service.discard(prepared.token); finish()
    await expect(pending).rejects.toThrow()
  })
  it('准备互斥，新准备替换旧令牌', async () => {
    const { service, deps } = setup()
    const first = await service.prepare(id)
    let finish!: () => void
    deps.transfer.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve }); return transfer })
    const pending = service.prepare(id)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await expect(service.prepare(id)).rejects.toThrow('正在')
    await expect(service.deliver(first.token, 'copy-file')).rejects.toThrow('正在')
    finish(); await pending
    await expect(service.deliver(first.token, 'copy-file')).rejects.toThrow('失效')
  })
})
