import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceBrowser } from '../src/main/source-browser'
import { parseSourceArchive } from '../src/main/source-reader'
import { UnsupportedSourceError } from '../src/main/source-origin'
import { claudeFixture, claudeRecords } from './fixtures/claude-code'

// 只复现已核对的字段结构，所有 ID、标签和结果均为合成内容。
const journal = () => claudeFixture([
  { type: 'launched' },
  { type: 'started', agentId: 'synthetic-agent', key: 'synthetic-key', label: '合成任务' },
  { type: 'result', agentId: 'synthetic-agent', key: 'synthetic-key', result: '合成任务结果，不是 Claude 消息' },
])
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'pinekin-journals-')); roots.push(root)
  const input = join(root, 'source'); await mkdir(input)
  const browser = new SourceBrowser(join(root, 'data'))
  return { input, browser, async scan() {
    const connection = await browser.connect('claude-code', input)
    await browser.waitForScan(connection.id)
    return browser.page({})
  } }
}

describe('Claude 会话与任务流水分离', () => {
  it('子目录中的任务 journal 不进入列表、搜索、分页和数量，保留真正子会话', async () => {
    const { input, browser, scan } = await setup()
    const subagents = join(input, 'subagents'); await mkdir(subagents)
    await writeFile(join(subagents, 'journal.jsonl'), journal())
    await writeFile(join(input, 'renamed.jsonl'), journal())
    await writeFile(join(input, 'normal.jsonl'), claudeFixture())
    const side = claudeRecords().map(record => record.uuid ? { ...record, isSidechain: true } : record)
    await writeFile(join(subagents, 'agent.jsonl'), claudeFixture(side))
    const page = await scan()
    expect(page).toMatchObject({ total: 2, hasMore: false })
    expect(page.connections[0]).toMatchObject({ status: 'ready', total: 2, discovered: 2 })
    expect((await browser.page({ query: 'journal.jsonl' })).total).toBe(0)
    expect((await browser.page({ query: 'renamed.jsonl' })).total).toBe(0)
    expect((await browser.page({ offset: 1, limit: 1 }))).toMatchObject({ total: 2, hasMore: false, items: [expect.anything()] })
    for (const item of page.items) expect((await browser.read(item.id)).session.messages).toHaveLength(2)
    expect(page.items.find(item => item.project === 'subagents')?.kind).toBe('subagent')
    expect(await readFile(join(subagents, 'journal.jsonl'))).toEqual(journal())
  })
  it('真实 Claude 消息即使名为 journal.jsonl 也保留，不按文件名封禁', async () => {
    const { input, browser, scan } = await setup()
    await writeFile(join(input, 'journal.jsonl'), claudeFixture())
    const page = await scan()
    expect(page.total).toBe(1)
    expect(page.items[0].title).toBe('合成问题：整理项目计划')
    expect((await browser.read(page.items[0].id)).session.messages).toHaveLength(2)
  })
  it('正文入口对任务流水返回类型化不支持，而非泛化格式错误', async () => {
    await expect(parseSourceArchive(journal())).rejects.toBeInstanceOf(UnsupportedSourceError)
    await expect(parseSourceArchive(journal())).rejects.toThrow(/辅助运行记录/)
  })
  it('扫描后内容变为任务流水时，读取立即过滤；更新为会话后刷新恢复', async () => {
    const { input, browser, scan } = await setup(), path = join(input, 'journal.jsonl')
    await writeFile(path, claudeFixture())
    const page = await scan(), item = page.items[0]
    await writeFile(path, journal())
    await expect(browser.read(item.id)).rejects.toThrow(/辅助运行记录/)
    expect((await browser.page({})).total).toBe(0)
    expect((await browser.connections())[0]).toMatchObject({ total: 0, discovered: 0 })
    expect((await browser.check({ mode: 'manual', selectedId: item.id })).selected?.availability).toBe('unsupported')
    await writeFile(path, claudeFixture())
    await browser.check({ mode: 'manual' })
    expect((await browser.page({})).items[0].id).toBe(item.id)
  })
  it('完整辅助日志跨 64 KiB 时使用已有扩展预览过滤，不止识别小文件', async () => {
    const { input, scan } = await setup()
    const bytes = claudeFixture(Array.from({ length: 1200 }, () => ({ type: 'result', agentId: 'agent', key: 'key', result: 'x'.repeat(100) })))
    expect(bytes.byteLength).toBeGreaterThan(64 * 1024)
    expect(bytes.byteLength).toBeLessThan(1024 * 1024)
    await writeFile(join(input, 'journal.jsonl'), bytes)
    expect((await scan()).total).toBe(0)
  })
  it('辅助记录占满预览但文件未读完时不能断言整份都是流水，正文仍可识别预算后的会话', async () => {
    const { input, browser, scan } = await setup()
    const prefix = Array.from({ length: 180 }, () => ({ type: 'file-history-snapshot', snapshot: 'x'.repeat(6500) }))
    await writeFile(join(input, 'session.jsonl'), claudeFixture([...prefix, ...claudeRecords()]))
    const page = await scan()
    expect(page.total).toBe(1)
    expect((await browser.read(page.items[0].id)).session.messages).toHaveLength(2)
  })
  it('前置辅助元数据超过 64 行的真实会话仍能读取，不让详情识别比目录更短', async () => {
    const { input, browser, scan } = await setup()
    const prefix = Array.from({ length: 80 }, () => ({ type: 'file-history-snapshot', snapshot: {} }))
    await writeFile(join(input, 'session.jsonl'), claudeFixture([...prefix, ...claudeRecords()]))
    const page = await scan()
    expect(page.items[0].title).toBe('合成问题：整理项目计划')
    expect((await browser.read(page.items[0].id)).session.messages).toHaveLength(2)
  })
  it('未知或损坏记录不冒充已确认的辅助流水，仍保留可重试状态', async () => {
    const { input, browser, scan } = await setup()
    const cases = [Buffer.from('broken'), Buffer.from('null\n'), claudeFixture([{ type: 'future-event', payload: {} }]),
      claudeFixture([{ type: 'result', result: '缺少任务身份字段' }]), Buffer.concat([journal(), Buffer.from('{"type":')]),
      claudeFixture([{ type: 'started', agentId: 'a', key: 'b', message: { role: 'user', content: '不能忽略消息结构' } }])]
    for (const [index, bytes] of cases.entries()) await writeFile(join(input, `${index}.jsonl`), bytes)
    const page = await scan()
    expect(page.total).toBe(cases.length)
    for (const item of page.items) await expect(browser.read(item.id)).rejects.toThrow()
    expect((await browser.page({})).items.every(item => item.availability === 'unreadable')).toBe(true)
  })
  it('纯标题或运行元数据没有用户助手消息时不列作对话', async () => {
    const { input, scan } = await setup()
    await writeFile(join(input, 'metadata.jsonl'), claudeFixture([{ type: 'custom-title', customTitle: '仅元数据' }, { type: 'cost-state', cost: 0 }]))
    expect((await scan()).total).toBe(0)
  })
})
