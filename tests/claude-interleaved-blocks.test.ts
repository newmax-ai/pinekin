import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceBrowser } from '../src/main/source-browser'
import { parseSourceArchive } from '../src/main/source-reader'
import { parseArchive } from '../src/main/imports'
import { claudeFixture, claudeRecords } from './fixtures/claude-code'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

// 仅合成结构：同一 API 回复的递增追加块之间可先落盘 user/tool_result。
function records(): Record<string, unknown>[] {
  const base = claudeRecords()[1]
  const assistant = (uuid: string, parentUuid: string, index: number, text: string, call?: string) => ({
    ...base, type: 'assistant', uuid, parentUuid, apiBlockIndex: index,
    message: { role: 'assistant', id: 'same-api-reply', content: [
      { type: 'text', text }, ...(call ? [{ type: 'tool_use', id: call, name: 'synthetic_tool', input: { command: '不会执行' } }] : []),
    ] },
  })
  const result = (uuid: string, parentUuid: string, call: string) => ({
    ...base, type: 'user', uuid, parentUuid,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content: '合成工具结果，不作为用户提问' }] },
  })
  return [
    { ...base, entrypoint: 'cli', message: { role: 'user', content: '合成分块兼容请求' } },
    assistant('a0', 'u1', 0, '执行前🙂', 'call-0'), result('r0', 'a0', 'call-0'),
    assistant('a1', 'r0', 1, '阶段结果', 'call-1'), result('r1', 'a1', 'call-1'),
    assistant('a2', 'r1', 2, '执行后'),
  ]
}
const expected = [
  { role: 'user', content: '合成分块兼容请求' },
  { role: 'assistant', content: '执行前🙂' },
  { role: 'assistant', content: '阶段结果' },
  { role: 'assistant', content: '执行后' },
]
async function setup(rows: Record<string, unknown>[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-claude-blocks-'))); roots.push(root)
  const path = join(root, 'synthetic.jsonl'), bytes = claudeFixture(rows), browser = new SourceBrowser(join(root, 'data'))
  await writeFile(path, bytes)
  const connection = await browser.connect('claude-code', root); await browser.waitForScan(connection.id)
  const item = (await browser.page({})).items[0]
  return { path, bytes, browser, connection, item }
}

describe('Claude 同一助手回复的追加块可穿插纯工具结果', () => {
  it('有索引追加块在两种来源解析入口一致可读，不丢文字、不伪造用户提问、不改变旧档案门禁', async () => {
    const { path, bytes, browser, item } = await setup(records())
    const parsed = await parseSourceArchive(bytes), content = await browser.read(item.id)
    expect(parsed.session.messages).toEqual(expected)
    expect(content.session.messages).toEqual(expected)
    expect(content.window).toMatchObject({ totalMessages: 4, hasMore: false })
    expect(content.presentation).toMatchObject({ textMessages: 4, toolCalls: 2, toolResults: 2 })
    expect(content.presentation?.activities.map(activity => activity.kind)).toEqual(['call', 'result', 'call', 'result'])
    expect(JSON.stringify(content.session.messages)).not.toContain('合成工具结果')
    expect(await readFile(path)).toEqual(bytes)
    expect((await browser.page({})).total).toBe(1)
    await expect(parseArchive(bytes)).rejects.toThrow(/追加块索引/)
  })
  it('物理行交错不改变父链顺序，工具结果前后保留独立文本片段', async () => {
    const rows = records(), shuffled = [rows[0], rows[2], rows[1], rows[4], rows[3], rows[5]]
    const { bytes, browser, item } = await setup(shuffled)
    expect((await parseSourceArchive(bytes)).session.messages).toEqual(expected)
    expect((await browser.read(item.id)).session.messages).toEqual(expected)
  })
  it('批量工具结果和内部 isMeta 记录不打断同一助手回复的索引连续性', async () => {
    const rows = records(), original = rows[2].message as { content: unknown[] }
    original.content.push({ type: 'tool_result', tool_use_id: 'call-extra', content: '第二个合成结果' })
    rows.splice(3, 0, { ...rows[2], uuid: 'meta', parentUuid: 'r0', isMeta: true, message: { role: 'user', content: '不会进入问答的内部记录' } })
    rows[4].parentUuid = 'meta'
    const { bytes, browser, item } = await setup(rows)
    expect((await parseSourceArchive(bytes)).session.messages).toEqual(expected)
    const content = await browser.read(item.id)
    expect(content.session.messages).toEqual(expected)
    expect(content.presentation?.toolResults).toBe(3)
  })
  it('一致无索引的旧记录在工具结果前后仍保留独立片段，不猜测合并或去重', async () => {
    const rows = records().map(row => { const { apiBlockIndex: _index, ...legacy } = row; return legacy })
    const { bytes, browser, item } = await setup(rows)
    const parsed = await parseSourceArchive(bytes), content = await browser.read(item.id)
    expect(parsed.session.messages).toEqual(expected)
    expect(content.session.messages).toEqual(expected)
    expect(content.warnings.join('\n')).toMatch(/旧版.*索引/)
    await expect(parseArchive(bytes)).rejects.toThrow(/追加块索引/)
  })
  it('追加块中的长文字跨读取窗口继续，不把工具结果复制到文本中', async () => {
    const rows = records(), message = rows[3].message as { content: { type: string; text?: string }[] }
    const longText = '🙂合成'.repeat(6000)
    message.content[0].text = longText
    const { browser, item } = await setup(rows), first = await browser.read(item.id)
    expect(first.window).toMatchObject({ totalMessages: 4, hasMore: true })
    const second = await browser.read(item.id, first.window!.next)
    expect(first.session.messages[2].content + second.session.messages[0].content).toBe(longText)
    expect(second.session.messages.at(-1)?.content).toBe('执行后')
    expect(second.window?.hasMore).toBe(false)
  })
  it('大量同 ID 追加块穿插 120 次工具往返仍能分页，活动预算不影响文字完整性', async () => {
    const sample = records(), rows = [sample[0], sample[1]]
    for (let index = 0; index < 120; index++) {
      rows.push({ ...sample[2], uuid: `result-${index}`, parentUuid: `a${index}`,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${index}`, content: '合成工具结果' }] } })
      rows.push({ ...sample[3], uuid: `a${index + 1}`, parentUuid: `result-${index}`, apiBlockIndex: index + 1,
        message: { role: 'assistant', id: 'same-api-reply', content: [{ type: 'text', text: `片段${index + 1}` },
          ...(index < 119 ? [{ type: 'tool_use', id: `call-${index + 1}`, name: 'synthetic_tool', input: {} }] : [])] } })
    }
    const { bytes, browser, item } = await setup(rows), first = await browser.read(item.id)
    expect(first.window).toMatchObject({ totalMessages: 122, hasMore: true })
    expect(first.session.messages).toHaveLength(100)
    expect(first.presentation).toMatchObject({ toolCalls: 120, toolResults: 120, activitiesTruncated: true })
    const second = await browser.read(item.id, first.window!.next)
    expect(second.window?.hasMore).toBe(false)
    expect([...first.session.messages, ...second.session.messages]).toEqual((await parseSourceArchive(bytes)).session.messages)
    expect(second.session.messages.at(-1)?.content).toBe('片段120')
  })
  it.each([
    { name: '纯文字用户输入', content: '这是新一轮用户提问' },
    { name: '工具结果混入用户文本', content: [{ type: 'tool_result', tool_use_id: 'call-0', content: '合成结果' }, { type: 'text', text: '追加的真实用户输入' }] },
    { name: '空用户消息', content: [] },
    { name: '附件用户输入', content: [{ type: 'image', source: { type: 'base64', data: 'synthetic' } }] },
  ])('仍拒绝跨越 $name 复用旧助手 ID', async ({ content }) => {
    const rows = records(); rows[2].message = { role: 'user', content }
    const { bytes, browser, item } = await setup(rows)
    await expect(parseSourceArchive(bytes)).rejects.toThrow(/追加块索引/)
    await expect(browser.read(item.id)).rejects.toThrow(/追加块索引/)
  })
  it.each([
    { name: '索引重复', patch: (rows: Record<string, unknown>[]) => { rows[3].apiBlockIndex = 0 } },
    { name: '索引倒退', patch: (rows: Record<string, unknown>[]) => { rows[1].apiBlockIndex = 2 } },
    { name: '混合缺失索引', patch: (rows: Record<string, unknown>[]) => { delete rows[3].apiBlockIndex } },
    { name: '穿插其他助手 ID', patch: (rows: Record<string, unknown>[]) => { (rows[3].message as { id: string }).id = 'another-reply' } },
  ])('纯工具结果也不能掩盖 $name', async ({ patch }) => {
    const rows = records(); patch(rows)
    const { bytes, browser, item } = await setup(rows)
    await expect(parseSourceArchive(bytes)).rejects.toThrow(/追加块索引/)
    await expect(browser.read(item.id)).rejects.toThrow(/追加块索引/)
  })
  it('仍验证完整父链，不拿链外助手块或工具结果拼凑选中链', async () => {
    const rows = records()
    rows.splice(1, 0, { ...rows[1], uuid: 'off-chain', parentUuid: 'u1', message: { id: 'same-api-reply', role: 'assistant', content: [{ type: 'text', text: '禁止补拼的旁支' }] } })
    const { bytes, browser, item, path } = await setup(rows)
    expect((await parseSourceArchive(bytes)).session.messages).toEqual(expected)
    expect((await browser.read(item.id)).session.messages).toEqual(expected)
    rows[3].parentUuid = 'missing-parent'
    await writeFile(path, claudeFixture(rows))
    await expect(browser.read(item.id)).rejects.toThrow(/父链缺失/)
  })
})
