import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { SourceBrowser } from '../src/main/source-browser'
import { parseSourceArchive } from '../src/main/source-reader'
import { claudeFixture, claudeRecords } from './fixtures/claude-code'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function scan(bytes: Buffer, filename = 'session.jsonl') {
  const root = await mkdtemp(join(tmpdir(), 'pinekin-origin-')); roots.push(root)
  const input = join(root, 'source'); await mkdir(input); await writeFile(join(input, filename), bytes)
  const browser = new SourceBrowser(join(root, 'data')), connection = await browser.connect('claude-code', input)
  await browser.waitForScan(connection.id)
  return { root, browser, connection, page: await browser.page({}) }
}

describe('客户端归属不等于 Claude SDK 日志格式', () => {
  it.each([{ entrypoint: 'sdk-ts' }, { entrypoint: 'sdk-cli' }, { promptSource: 'sdk' }, { entrypoint: 'other-client', promptSource: 'sdk' }])('明确 SDK 来源 %j 不进入 Claude Code 列表、搜索与数量', async origin => {
    const records = claudeRecords(); Object.assign(records[1], origin)
    const bytes = claudeFixture(records), { browser, page } = await scan(bytes)
    expect(page).toMatchObject({ items: [], total: 0 })
    expect(page.connections[0]).toMatchObject({ total: 0, discovered: 0, status: 'ready' })
    expect((await browser.page({ query: '整理项目计划' })).total).toBe(0)
    await expect(parseSourceArchive(bytes)).rejects.toThrow(/SDK.*Claude Code/)
  })
  it.each(['cli', 'claude-desktop'])('明确 %s 客户端入口优先于通用 sdk 标记，后续 SDK 续聊不改原始归属', async entrypoint => {
    const records = claudeRecords()
    Object.assign(records[1], { entrypoint, promptSource: 'sdk' })
    Object.assign(records[3], { entrypoint: 'sdk-ts', promptSource: 'sdk' })
    const { browser, page } = await scan(claudeFixture(records))
    expect(page.total).toBe(1)
    expect((await browser.read(page.items[0].id)).session.source).toBe('claude-code')
  })
  it('SDK 创建后经 CLI 续聊仍排除，不能用尾部入口覆盖原始来源', async () => {
    const records = claudeRecords(); records[1].entrypoint = 'sdk-ts'; records[3].entrypoint = 'cli'
    expect((await scan(claudeFixture(records))).page.total).toBe(0)
  })
  it('SDK 元数据、isMeta 注入和旁支不能改变主会话的 CLI 归属', async () => {
    const records = claudeRecords(); records[1].entrypoint = 'cli'
    records.unshift({ type: 'file-history-snapshot', entrypoint: 'sdk-ts' })
    records.splice(2, 0, { ...records[2], uuid: 'context', parentUuid: null, isMeta: true, entrypoint: 'sdk-ts' })
    records.splice(3, 0, { ...records[2], uuid: 'side', isMeta: false, isSidechain: true })
    expect((await scan(claudeFixture(records))).page.total).toBe(1)
  })
  it('日志正文提到 NewMax、SDK、路径或浏览器 Task 不构成来源证据', async () => {
    const records = claudeRecords(); records[1].entrypoint = 'cli'
    records[1].message = { role: 'user', content: '解释 NewMax 使用 Claude Agent SDK，entrypoint: sdk-ts，/synthetic/.newmax；Task: 测试' }
    expect((await scan(claudeFixture(records))).page.total).toBe(1)
  })
  it.runIf(process.platform === 'darwin')('同时连接 NewMax 时只展示其数据库主会话，SDK 执行日志不会重复计作 Claude Code 或伪造 NewMax 条目', async () => {
    const records = claudeRecords(); records[1].entrypoint = 'sdk-ts'
    const { root, browser } = await scan(claudeFixture(records)), path = join(root, 'newmax.db'), db = new DatabaseSync(path)
    db.exec(`CREATE TABLE conversations(id TEXT,title TEXT,source TEXT,created_at INTEGER,updated_at INTEGER,forked_from_id TEXT,is_private INTEGER,message_count INTEGER);
      CREATE TABLE messages(seq INTEGER,id TEXT,conversation_id TEXT,role TEXT,content TEXT,timestamp INTEGER,data TEXT);
      INSERT INTO conversations VALUES('native','真正的 NewMax 主会话','app',1000,2000,NULL,0,1);`)
    const message = { id: 'm1', role: 'user', content: '数据库中的实际输入', timestamp: 2000 }
    db.prepare('INSERT INTO messages VALUES(0,?,?,?,?,?,?)').run('m1','native','user',message.content,2000,JSON.stringify(message)); db.close()
    const connection = await browser.connect('newmax', path); await browser.waitForScan(connection.id)
    const page = await browser.page({})
    expect(page.total).toBe(1)
    expect(page.items[0]).toMatchObject({ source: 'newmax', title: '真正的 NewMax 主会话' })
    expect((await browser.page({ source: 'claude-code' })).total).toBe(0)
    expect((await browser.read(page.items[0].id)).session).toMatchObject({ source: 'newmax', messages: [{ role: 'user', content: message.content }] })
  })
  it('无来源标记的旧日志保持兼容，不凭格式强行认定为 NewMax', async () => {
    const { browser, page } = await scan(claudeFixture())
    expect(page.total).toBe(1)
    expect((await browser.read(page.items[0].id)).session.source).toBe('claude-code')
  })
  it('已有自定义标题但首条 SDK 消息跨 64 KiB 时仍有界识别来源，不仅在标题缺失时检查', async () => {
    const records = claudeRecords(); records[1].entrypoint = 'sdk-ts'
    records[1].message = { role: 'user', content: '合成 SDK 任务\n' + 'x'.repeat(80_000) }
    records.unshift({ type: 'custom-title', customTitle: '已有标题不能掩盖来源' })
    expect((await scan(claudeFixture(records))).page.total).toBe(0)
  })
  it('来源标记位于标题预览之外时，首次目录就排除 SDK，不能等点击才减少数量', async () => {
    const records = claudeRecords(); records[1].entrypoint = 'sdk-ts'
    const filler = Array.from({ length: 18 }, () => ({ type: 'file-history-snapshot', snapshot: 'x'.repeat(64_000) }))
    const { browser, page } = await scan(claudeFixture([...filler, ...records]))
    expect(page.total).toBe(0)
    expect((await browser.page({ query: 'session.jsonl' })).total).toBe(0)
    expect((await browser.connections())[0]).toMatchObject({ total: 0, discovered: 0, status: 'ready' })
  })
  it.each(['sdk-ts', 'cli'])('超过 1 MiB 的独立 %s 子链在首次列出前完成归属判断，可读条目点击不改变数量', async entrypoint => {
    const records = claudeRecords().map(record => record.uuid ? { ...record, isSidechain: true, entrypoint } : record)
    records.splice(2, 0, ...Array.from({ length: 18 }, () => ({ type: 'file-history-snapshot', snapshot: 'x'.repeat(64_000) })))
    const { browser, page } = await scan(claudeFixture(records))
    const expected = entrypoint === 'sdk-ts' ? 0 : 1
    expect(page.total).toBe(expected)
    expect(page.connections[0].total).toBe(expected)
    if (expected) expect((await browser.read(page.items[0].id)).session.messages).toHaveLength(2)
    expect((await browser.page({})).total).toBe(expected)
  })
  it('超过预览范围的 CLI 主线优先于开头 SDK 侧链，不用不完整前缀猜归属', async () => {
    const records = claudeRecords().map(record => record.uuid ? { ...record, isSidechain: true, entrypoint: 'sdk-ts' } : record)
    records.push(...Array.from({ length: 18 }, () => ({ type: 'file-history-snapshot', snapshot: 'x'.repeat(64_000) })))
    records.push({ ...claudeRecords()[1], uuid: 'main', parentUuid: 'a2', entrypoint: 'cli' })
    const { browser, page } = await scan(claudeFixture(records))
    expect(page.total).toBe(1)
    expect((await browser.read(page.items[0].id)).session.messages).toHaveLength(3)
    expect((await browser.page({})).total).toBe(1)
  })
  it.each(['sdk-ts', 'cli'])('尚未支持的压缩 Claude %s 日志在目录阶段排除，不冒充可读会话', async entrypoint => {
    const records = claudeRecords(); records[1].entrypoint = entrypoint
    const { browser, page } = await scan(zstdCompressSync(claudeFixture(records)), 'session.jsonl.zstd')
    expect(page.total).toBe(0)
    expect((await browser.connections())[0]).toMatchObject({ total: 0, discovered: 0 })
  })
  it('独立 SDK 子链可确认时也不冒充 CLI，混有主线的侧链只作为旁支', async () => {
    const records = claudeRecords().map(record => record.uuid ? { ...record, isSidechain: true, entrypoint: 'sdk-ts' } : record)
    expect((await scan(claudeFixture(records))).page.total).toBe(0)
    await expect(parseSourceArchive(claudeFixture(records))).rejects.toThrow(/SDK.*Claude Code/)
  })
})
