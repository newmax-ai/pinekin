import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isClaudeCodeLog, parseClaudeCode } from '../src/main/claude-code'
import { parseArchive } from '../src/main/imports'
import { parseSourceArchive } from '../src/main/source-reader'
import { SourceBrowser } from '../src/main/source-browser'
import { claudeFixture, claudeRecords, claudeSessionId } from './fixtures/claude-code'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const settings = () => [
  { type: 'mode', mode: 'synthetic-mode', sessionId: claudeSessionId },
  { type: 'permission-mode', permissionMode: 'synthetic-permission-sentinel', sessionId: claudeSessionId },
  { type: 'atis-latch', atis: false, sessionId: claudeSessionId },
]
async function setup(bytes: Buffer) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-claude-metadata-'))); roots.push(root)
  const path = join(root, 'synthetic.jsonl'), browser = new SourceBrowser(join(root, 'data'))
  await writeFile(path, bytes)
  const connection = await browser.connect('claude-code', root); await browser.waitForScan(connection.id)
  return { path, browser, connection }
}

describe('Claude permission-mode 是设置元数据，不是父链消息', () => {
  it('第二行权限设置不阻断识别、档案解析和来源解析，也不进入正文或工具活动', async () => {
    const bytes = claudeFixture([...settings(), ...claudeRecords()]), text = bytes.toString('utf8')
    expect(isClaudeCodeLog(text)).toBe(true)
    expect(isClaudeCodeLog(text, true)).toBe(true)
    const expected = parseClaudeCode(claudeFixture().toString('utf8')).session.messages
    expect(parseClaudeCode(text).session.messages).toEqual(expected)
    expect((await parseArchive(bytes)).session.messages).toEqual(expected)
    const source = await parseSourceArchive(bytes)
    expect(source.session.messages).toEqual(expected)
    expect(source.presentation).toMatchObject({ textMessages: 2, toolCalls: 0, toolResults: 0 })
    expect(JSON.stringify(source)).not.toContain('synthetic-permission-sentinel')
  })
  it('真实读取入口接受设置头，点击前后列表计数不变，设置不执行且来源原文件不变', async () => {
    const bytes = claudeFixture([...settings(), ...claudeRecords()]), { path, browser, connection } = await setup(bytes)
    const page = await browser.page({}), item = page.items[0]
    expect(page).toMatchObject({ total: 1 })
    const content = await browser.read(item.id)
    expect(content.session.messages).toEqual([
      { role: 'user', content: '合成问题：整理项目计划' },
      { role: 'assistant', content: '合成答复：先确认目标。' },
    ])
    expect(content.window).toMatchObject({ totalMessages: 2, hasMore: false })
    expect(JSON.stringify(content)).not.toContain('synthetic-permission-sentinel')
    expect((await browser.page({})).items[0]).toMatchObject({ id: item.id, availability: 'readable' })
    expect((await browser.connections())[0]).toMatchObject({ id: connection.id, total: 1 })
    expect(await readFile(path)).toEqual(bytes)
  })
  it('消息之间的权限设置不打断助手追加块，也不改变父链', async () => {
    const records = claudeRecords(); records.splice(4, 0, settings()[1])
    const bytes = claudeFixture(records), { browser } = await setup(bytes)
    const content = await browser.read((await browser.page({})).items[0].id)
    expect(content.session.messages).toEqual((await parseSourceArchive(claudeFixture())).session.messages)
    expect(content.presentation?.textMessages).toBe(2)
  })
  it('只有权限设置和其他元数据的文件仍是辅助记录，不伪造成可打开的会话', async () => {
    const bytes = claudeFixture(settings()), { browser, connection } = await setup(bytes)
    expect(isClaudeCodeLog(bytes.toString('utf8'))).toBe(false)
    expect((await browser.page({})).total).toBe(0)
    expect((await browser.connections())[0]).toMatchObject({ id: connection.id, total: 0 })
    await expect(parseSourceArchive(bytes)).rejects.toThrow(/辅助运行记录/)
  })
  it('未知记录仍拒绝，不因兼容权限设置而忽略任意未知类型', async () => {
    const bytes = claudeFixture([...settings(), { type: 'unknown-permission-setting', sessionId: claudeSessionId }, ...claudeRecords()])
    expect(() => parseClaudeCode(bytes.toString('utf8'))).toThrow(/第 4 行/)
    const { browser } = await setup(bytes), item = (await browser.page({})).items[0]
    await expect(browser.read(item.id)).rejects.toThrow(/第 4 行/)
    expect((await browser.page({})).items[0]).toMatchObject({ id: item.id, availability: 'unreadable' })
  })
  it('权限元数据不会掩盖缺失父链，不能靠跳过设置拼接外部历史', async () => {
    const records = claudeRecords(); records[1].parentUuid = 'external-parent'
    const bytes = claudeFixture([...settings(), ...records]), { browser } = await setup(bytes)
    expect(() => parseClaudeCode(bytes.toString('utf8'))).toThrow(/父链缺失/)
    await expect(browser.read((await browser.page({})).items[0].id)).rejects.toThrow(/父链缺失/)
  })
})
