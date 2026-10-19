import { describe, expect, it, vi } from 'vitest'
import { SourceActions } from '../src/main/source-actions'
import type { SourceEntry } from '../src/core/sources'

const entry: SourceEntry = { id: 'a'.repeat(64), connectionId: '11111111-1111-4111-8111-111111111111', source: 'newmax', sourceSessionId: 'conv-123_abc', title: '合成会话', project: '', updatedAt: '2026-10-19T00:00:00Z', availability: 'readable' }
function setup(value = entry) {
  const getEntry = vi.fn().mockResolvedValue(value)
  const handler = vi.fn().mockResolvedValue('NewMax')
  const openExternal = vi.fn().mockResolvedValue(undefined)
  const assertAllowed = vi.fn()
  return { service: new SourceActions({ getEntry, handler, openExternal }), getEntry, handler, openExternal, assertAllowed }
}

describe('原 App 打开与目标能力门禁', () => {
  it('从已授权主进程元数据构造固定 NewMax 深链，不用正文或renderer URL', async () => {
    const { service, openExternal, assertAllowed } = setup()
    const state = await service.inspect(entry.id)
    expect(state.original.available).toBe(true)
    expect(state.targets).toEqual([])
    expect(openExternal).not.toHaveBeenCalled()
    expect(await service.openOriginal(entry.id, assertAllowed)).toEqual({ status: 'requested', app: 'NewMax' })
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('newmax://open?conversation=conv-123_abc')
    expect(assertAllowed).toHaveBeenCalled()
  })
  it('Codex 只使用官方客户端构造的线程协议与UUID，不把历史注入当作新建成功', async () => {
    const id = '0199e6ba-0000-7000-8000-000000000001'
    const { service, handler, openExternal } = setup({ ...entry, source: 'codex', sourceSessionId: id })
    handler.mockResolvedValue('Codex')
    expect((await service.inspect(entry.id)).original.available).toBe(true)
    expect((await service.openOriginal(entry.id)).status).toBe('requested')
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(`codex://threads/${id}`)
    const invalid = setup({ ...entry, source: 'codex', sourceSessionId: 'not-uuid' })
    expect((await invalid.service.inspect(entry.id)).original.available).toBe(false)
  })
  it.each(['claude-code', 'cindy', 'deepseek'] as const)('%s 未核验打开方式时不可伪造支持', async source => {
    const { service, handler, openExternal } = setup({ ...entry, source })
    expect((await service.inspect(entry.id)).original.available).toBe(false)
    await expect(service.openOriginal(entry.id)).rejects.toThrow('尚未验证')
    expect(handler).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })
  it.each(['', '../escape', 'id&action=delete', 'id?command=run', 'x\nhttps://evil.test', 'a'.repeat(129)])('拒绝非法原会话 ID %s', async sourceSessionId => {
    const { service, handler } = setup({ ...entry, sourceSessionId })
    expect((await service.inspect(entry.id)).original.available).toBe(false)
    await expect(service.openOriginal(entry.id)).rejects.toThrow('会话标识')
    expect(handler).not.toHaveBeenCalled()
  })
  it('缺少原始 ID 或非主会话不猜路径，不用 Pinekin opaque ID 代替', async () => {
    for (const value of [{ ...entry, sourceSessionId: undefined }, { ...entry, kind: 'subagent' as const }, { ...entry, availability: 'unsupported' as const }]) {
      const { service, openExternal } = setup(value)
      expect((await service.inspect(entry.id)).original.available).toBe(false)
      await expect(service.openOriginal(entry.id)).rejects.toThrow()
      expect(openExternal).not.toHaveBeenCalled()
    }
  })
  it.each(['', 'AnotherApp'])('没有已核验协议处理程序时不可打开：%s', async name => {
    const { service, handler, openExternal } = setup()
    handler.mockResolvedValue(name)
    expect((await service.inspect(entry.id)).original.available).toBe(false)
    await expect(service.openOriginal(entry.id)).rejects.toThrow('NewMax')
    expect(openExternal).not.toHaveBeenCalled()
  })
  it('协议查询失败显示原因，不能当成可打开', async () => {
    const { service, handler } = setup()
    handler.mockRejectedValue(new Error('合成协议查询失败'))
    expect((await service.inspect(entry.id)).original.reason).toContain('无法检查')
  })
  it('断开、元数据改变及发送者失效时，在实际打开前阻止操作', async () => {
    const disconnected = setup()
    disconnected.getEntry.mockResolvedValueOnce(entry).mockRejectedValueOnce(new Error('来源已断开'))
    await expect(disconnected.service.openOriginal(entry.id)).rejects.toThrow('来源已断开')
    expect(disconnected.openExternal).not.toHaveBeenCalled()
    const changed = setup()
    changed.getEntry.mockResolvedValueOnce(entry).mockResolvedValueOnce({ ...entry, sourceSessionId: 'changed' })
    await expect(changed.service.openOriginal(entry.id)).rejects.toThrow('已变化')
    expect(changed.openExternal).not.toHaveBeenCalled()
    const invalid = setup()
    invalid.assertAllowed.mockImplementation(() => { throw new Error('拒绝不可信请求') })
    await expect(invalid.service.openOriginal(entry.id, invalid.assertAllowed)).rejects.toThrow('拒绝不可信请求')
    expect(invalid.openExternal).not.toHaveBeenCalled()
  })
  it('打开失败如实报错，允许重试，不把系统受理当作已恢复', async () => {
    const { service, openExternal } = setup()
    openExternal.mockRejectedValueOnce(new Error('合成系统拒绝'))
    await expect(service.openOriginal(entry.id)).rejects.toThrow('合成系统拒绝')
    expect((await service.openOriginal(entry.id)).status).toBe('requested')
  })
  it('严格校验入口参数，不接受路径、URL或对象', async () => {
    const { service, getEntry } = setup()
    for (const value of ['file:///tmp/db', 'newmax://open?conversation=other', {}, null]) {
      await expect(service.inspect(value as string)).rejects.toThrow()
      await expect(service.openOriginal(value as string)).rejects.toThrow()
    }
    expect(getEntry).not.toHaveBeenCalled()
  })
  it('只串行处理同一个打开请求，结束后允许重试', async () => {
    const { service, openExternal } = setup()
    let done!: () => void
    openExternal.mockReturnValueOnce(new Promise<void>(resolve => { done = resolve }))
    const pending = service.openOriginal(entry.id)
    await expect(service.openOriginal(entry.id)).rejects.toThrow('正在打开')
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce())
    done(); await pending
    await service.openOriginal(entry.id)
    expect(openExternal).toHaveBeenCalledTimes(2)
  })
})
