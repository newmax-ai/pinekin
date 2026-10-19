import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceBrowser } from '../src/main/source-browser'
import { claudeFixture, claudeRecords, claudeSessionId } from './fixtures/claude-code'
import { codexFixture, codexMessage, codexMeta, codexThreadId } from './fixtures/codex'

// 仅合成数据；不读取真实客户端，不执行历史终端内容。
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(source: 'claude-code' | 'codex', bytes: Buffer, name = 'session.jsonl') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-title-stability-'))); roots.push(root)
  const input = join(root, 'source'), data = join(root, 'data'), path = join(input, name)
  await mkdir(input); await writeFile(path, bytes)
  const browser = new SourceBrowser(data), connection = await browser.connect(source, input)
  await browser.waitForScan(connection.id)
  return { browser, path, bytes, data, item: (await browser.page({})).items[0] }
}
function terminalThenAnswer() {
  const records = claudeRecords()
  records[1].entrypoint = 'cli'
  // 用既有 isMeta 省略规则独立验证标题回写，不依赖另一批未提交的终端分类扩展。
  records[1].isMeta = true
  records[1].message = { role: 'user', content: '<bash-input>synthetic-command --version</bash-input>' }
  return records
}
function assistantOnly(count = 1) {
  const base = claudeRecords()[4]
  return Array.from({ length: count }, (_, index) => ({ ...base, uuid: `answer-${index}`, parentUuid: index ? `answer-${index - 1}` : null,
    apiBlockIndex: 0, message: { role: 'assistant', id: `message-${index}`, content: [{ type: 'text', text: `合成答复 ${index}` }] } }))
}

describe('按需读取标题只能补齐，不能降级为内部 ID', () => {
  it.each(['session.jsonl', `${claudeSessionId}.jsonl`])('Claude 终端输入被排除后，保留原文件名 %s', async name => {
    const { browser, item, path, bytes, data } = await setup('claude-code', claudeFixture(terminalThenAnswer()), name)
    expect(item.title).toBe(name)
    const before = await browser.page({}), content = await browser.read(item.id)
    expect(content.session.title).toBe(name)
    expect(content.session.messages).toEqual([{ role: 'assistant', content: '合成答复：先确认目标。' }])
    expect((await browser.page({})).items[0].title).toBe(name)
    expect((await browser.page({})).snapshot).toBe(before.snapshot)
    expect((await browser.page({ query: name })).total).toBe(1)
    expect(await readFile(path)).toEqual(bytes)
    expect(await readdir(data)).toEqual(['connections.json'])
  })
  it('只有助手文字、没有用户提问时，翻页和重复读取也不能改变标题或结果指纹', async () => {
    const { browser, item } = await setup('claude-code', claudeFixture(assistantOnly(105)), 'answers.jsonl')
    const before = await browser.page({}), first = await browser.read(item.id)
    expect(first.session.title).toBe('answers.jsonl')
    expect(first.window).toMatchObject({ totalMessages: 105, hasMore: true })
    const next = await browser.read(item.id, first.window!.next)
    expect(next.session.title).toBe('answers.jsonl')
    expect(next.session.messages).toHaveLength(5)
    expect((await browser.read(item.id)).session.title).toBe('answers.jsonl')
    await browser.check({ mode: 'manual' })
    expect((await browser.page({})).snapshot).toBe(before.snapshot)
    expect((await browser.page({})).items[0]).toMatchObject({ id: item.id, title: 'answers.jsonl' })
  })
  it.each([
    ['元数据注入', { isMeta: true, message: { role: 'user', content: '合成注入不是用户提问' } }],
    ['工具结果', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'synthetic-call', content: '合成工具结果' }] } }],
  ])('排除%s后没有真实提问，也保留文件名', async (_name, fields) => {
    const records = claudeRecords(); Object.assign(records[1], fields)
    const { browser, item } = await setup('claude-code', claudeFixture(records))
    expect(item.title).toBe('session.jsonl')
    expect((await browser.read(item.id)).session.title).toBe('session.jsonl')
    expect((await browser.page({})).items[0].title).toBe('session.jsonl')
  })
  it.each([
    { type: 'custom-title', customTitle: '用户已命名' },
    { type: 'ai-title', aiTitle: '已有自动标题' },
    { type: 'summary', summary: '已有摘要标题' },
  ])('没有真实用户提问也不能覆盖已有标题元数据 %j', async record => {
    const bytes = claudeFixture([...terminalThenAnswer(), record]), { browser, item } = await setup('claude-code', bytes)
    expect(item.title).not.toBe('session.jsonl')
    expect((await browser.read(item.id)).session.title).toBe(item.title)
    expect((await browser.page({})).items[0].title).toBe(item.title)
  })
  it.each(['完整读取后发现的真实提问', claudeSessionId.slice(0, 8)])('允许真实首问补齐文件名，即使首问恰好像短 ID：%s', async text => {
    const records = claudeRecords(); records[1].message = { role: 'user', content: text }
    const bytes = claudeFixture([{ type: 'file-history-snapshot', snapshot: 'x'.repeat(1_100_000) }, ...records])
    const { browser, item } = await setup('claude-code', bytes)
    expect(item.title).toBe('session.jsonl')
    expect((await browser.read(item.id)).session.title).toBe(text)
    expect((await browser.page({})).items[0].title).toBe(text)
    expect((await browser.page({ query: text })).total).toBe(1)
    expect((await browser.page({ query: 'session.jsonl' })).total).toBe(1)
  })
  it('Codex 同样不能用自动生成的来源／短 ID 覆盖文件名', async () => {
    const bytes = codexFixture([codexMeta(), codexMessage('assistant', [{ type: 'output_text', text: '只有合成助手答复' }], { id: 'synthetic-answer' })])
    const { browser, item } = await setup('codex', bytes, 'codex-answers.jsonl')
    expect(item.title).toBe('codex-answers.jsonl')
    expect((await browser.read(item.id)).session.title).toBe('codex-answers.jsonl')
    expect((await browser.page({})).items[0].title).toBe('codex-answers.jsonl')
  })
  it('Codex 预览后的真实首问仍可补齐标题，不以短 ID 字符串猜测标题来源', async () => {
    const text = codexThreadId.slice(0, 8)
    const bytes = codexFixture([codexMeta(), { timestamp: '2026-10-16T00:00:00.000Z', type: 'event_msg', payload: { type: 'synthetic-filler', text: 'x'.repeat(1_100_000) } },
      codexMessage('user', [{ type: 'input_text', text }], { id: 'synthetic-question' })])
    const { browser, item } = await setup('codex', bytes)
    expect(item.title).toBe('session.jsonl')
    expect((await browser.read(item.id)).session.title).toBe(text)
    expect((await browser.page({})).items[0].title).toBe(text)
  })
})
