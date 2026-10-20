import { describe, expect, it, vi } from 'vitest'
import { collectSourceTransfer, type TransferPage } from '../src/main/source-transfer'

const snapshot = 'a'.repeat(64)
function page(overrides: Partial<TransferPage> = {}): TransferPage {
  return { title: '合成会话', source: 'codex', snapshot, totalMessages: 2, offset: 0, textOffset: 0,
    fragments: [{ position: 0, role: 'user', content: '问题' }, { position: 1, role: 'assistant', content: '回答' }], ...overrides }
}

describe('接续读取完整文本，不依赖阅读器当前分页', () => {
  it('从零开始读到结束，按来源消息位置拼接 Unicode 长消息，保留空白', async () => {
    const read = vi.fn().mockResolvedValueOnce(page({ fragments: [{ position: 0, role: 'user', content: '问🙂' }], next: { offset: 0, textOffset: 2, snapshot } }))
      .mockResolvedValueOnce(page({ offset: 0, textOffset: 2, fragments: [{ position: 0, role: 'user', content: '  ' }], next: { offset: 0, textOffset: 4, snapshot } }))
      .mockResolvedValueOnce(page({ offset: 0, textOffset: 4, fragments: [{ position: 0, role: 'user', content: '题' }, { position: 1, role: 'assistant', content: '回答' }] }))
    const result = await collectSourceTransfer(read)
    expect(read.mock.calls.map(call => call[0])).toEqual([{ offset: 0, textOffset: 0 }, { offset: 0, textOffset: 2, snapshot }, { offset: 0, textOffset: 4, snapshot }])
    expect(result.messages).toEqual([{ role: 'user', content: '问🙂  题' }, { role: 'assistant', content: '回答' }])
    expect(result.snapshot).toBe(snapshot)
  })
  it('收集每页读取说明并去重，保留来源消息数而非冒充所有内容均已迁移', async () => {
    const read = vi.fn().mockResolvedValueOnce(page({ warnings: ['附件未携带'], fragments: [{ position: 0, role: 'user', content: '问题' }], next: { offset: 1, textOffset: 0, snapshot } }))
      .mockResolvedValueOnce(page({ offset: 1, warnings: ['附件未携带', '工具状态未迁移'], fragments: [{ position: 1, role: 'assistant', content: '回答' }] }))
    expect(await collectSourceTransfer(read)).toMatchObject({ warnings: ['附件未携带', '工具状态未迁移'], sourceMessageCount: 2 })
  })
  it('不把过滤的内部消息接到上一条可见消息上', async () => {
    const read = vi.fn().mockResolvedValueOnce(page({ fragments: [{ position: 0, role: 'user', content: '问题' }], next: { offset: 1, textOffset: 0, snapshot } }))
      .mockResolvedValueOnce(page({ offset: 1, fragments: [], next: { offset: 1, textOffset: 10, snapshot } }))
      .mockResolvedValueOnce(page({ offset: 1, textOffset: 10, fragments: [] }))
    expect((await collectSourceTransfer(read)).messages).toEqual([{ role: 'user', content: '问题' }])
  })
  it.each([
    { snapshot: 'b'.repeat(64) }, { totalMessages: 3 }, { source: 'newmax' as const }, { offset: 0 },
  ])('读取期间快照或窗口变化就停止，不混合历史 %j', async patch => {
    const read = vi.fn().mockResolvedValueOnce(page({ fragments: [{ position: 0, role: 'user', content: '问题' }], next: { offset: 1, textOffset: 0, snapshot } }))
      .mockResolvedValueOnce(page({ offset: 1, fragments: [{ position: 1, role: 'assistant', content: '回答' }], ...patch }))
    await expect(collectSourceTransfer(read)).rejects.toThrow()
  })
  it('拒绝倒退游标、重复位置和角色变更，不无限循环或混淆角色', async () => {
    await expect(collectSourceTransfer(vi.fn().mockResolvedValue(page({ next: { offset: 0, textOffset: 0, snapshot } })))).rejects.toThrow()
    await expect(collectSourceTransfer(vi.fn().mockResolvedValue(page({ fragments: [{ position: 1, role: 'user', content: 'a' }, { position: 0, role: 'assistant', content: 'b' }] })))).rejects.toThrow()
    const read = vi.fn().mockResolvedValueOnce(page({ fragments: [{ position: 0, role: 'user', content: 'a' }], next: { offset: 0, textOffset: 1, snapshot } }))
      .mockResolvedValueOnce(page({ textOffset: 1, fragments: [{ position: 0, role: 'assistant', content: 'b' }] }))
    await expect(collectSourceTransfer(read)).rejects.toThrow()
  })
  it('拒绝无可接续文本、超限和撤销授权，不静默截断', async () => {
    await expect(collectSourceTransfer(vi.fn().mockResolvedValue(page({ fragments: [] })))).rejects.toThrow('没有')
    await expect(collectSourceTransfer(vi.fn().mockResolvedValue(page()), () => {}, 3)).rejects.toThrow('超过')
    const assertAllowed = vi.fn(() => { throw new Error('已断开') })
    const read = vi.fn()
    await expect(collectSourceTransfer(read, assertAllowed)).rejects.toThrow('已断开')
    expect(read).not.toHaveBeenCalled()
  })
})
