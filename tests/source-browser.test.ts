import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as filesystem from 'node:fs/promises'
import { SourceBrowser } from '../src/main/source-browser'
import { claudeFixture } from './fixtures/claude-code'
import { codexFixture } from './fixtures/codex'
import { deepseekFixture } from './fixtures/deepseek'
import { createCindySchema } from './fixtures/cindy-database'
import { zstdCompressSync } from 'node:zlib'

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open) }
})
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'pinekin-browser-test-')); directories.push(root)
  const input = join(root, 'source'), data = join(root, 'pinekin')
  await mkdir(input)
  return { root, input, data, browser: new SourceBrowser(data) }
}
async function settle(browser: SourceBrowser, id: string) {
  await browser.waitForScan(id)
  return browser.page({ connectionId: id, offset: 0, limit: 100 })
}
function seedDatabase(path: string) {
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, source TEXT, created_at INTEGER, updated_at INTEGER,
    forked_from_id TEXT, is_private INTEGER, message_count INTEGER);
    CREATE TABLE messages (seq INTEGER, id TEXT, conversation_id TEXT, role TEXT, content TEXT, timestamp INTEGER, data TEXT);
    CREATE TABLE settings (secret TEXT); INSERT INTO settings VALUES ('SECRET_SETTINGS');`)
  for (let index = 0; index < 125; index++) {
    db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?)').run(`s${index}`, `合成会话 ${index}`, 'app', 1000, 2000, index === 3 ? 's1' : null, index === 2 ? 1 : 0, 1)
    const message = { id: `m${index}`, role: 'user', content: '正文不应缓存', timestamp: 2000 }
    db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(0, message.id, `s${index}`, message.role, message.content, 2000, JSON.stringify(message))
  }
  db.close()
}

describe('来源直读：发现与正文读取分离', () => {
  it('空档案库可遍历超过旧上限的全部日志，分页且不生成档案或正文缓存', async () => {
    const { input, data, browser } = await setup()
    await mkdir(join(input, 'project'))
    for (let index = 0; index < 135; index++) await writeFile(join(input, 'project', `${index}.jsonl`), claudeFixture())
    const connection = await browser.connect('claude-code', input)
    const first = await settle(browser, connection.id)
    expect(first.connections[0]).toMatchObject({ status: 'ready', discovered: 135, total: 135, issues: 0 })
    expect(first.items).toHaveLength(100)
    expect(first.items.every(item => !('messages' in item))).toBe(true)
    const second = await browser.page({ connectionId: connection.id, offset: 100, limit: 100 })
    expect(second.items).toHaveLength(35)
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(135)
    const body = await browser.read(first.items[0].id)
    expect(body.session.messages.length).toBeGreaterThan(0)
    expect(body.session.archive).toBeUndefined()
    expect(body.warnings.length).toBeGreaterThan(0)
    expect(await readdir(data)).toEqual(['connections.json'])
    expect(await readFile(join(data, 'connections.json'), 'utf8')).not.toMatch(/正文|messages|合成问题|sessionId/)
  })
  it('不按总大小过滤日志，保留可读子会话与可重试的损坏记录', async () => {
    const { input, browser } = await setup()
    await writeFile(join(input, 'broken.jsonl'), 'broken')
    await writeFile(join(input, 'huge.jsonl'), Buffer.alloc(5 * 1024 * 1024 + 1))
    await mkdir(join(input, 'subagents')); await writeFile(join(input, 'subagents', 'sub.jsonl'), claudeFixture())
    const connection = await browser.connect('claude-code', input)
    const page = await settle(browser, connection.id)
    expect(page.total).toBe(3)
    expect(page.items.find(item => item.title === 'huge.jsonl')?.availability).toBe('unreadable')
    const broken = page.items.find(item => item.title === 'broken.jsonl')!
    await expect(browser.read(broken.id)).rejects.toThrow()
    expect((await browser.page({ connectionId: connection.id })).items.find(item => item.id === broken.id)?.availability).toBe('unreadable')
    expect((await browser.page({ connectionId: connection.id })).total).toBe(3)
  })
  it.each(['codex', 'deepseek'] as const)('%s 支持多层目录与压缩日志的按需读取', async source => {
    const { input, browser } = await setup()
    await mkdir(join(input, '2026', '10', '18'), { recursive: true })
    const bytes = source === 'codex' ? codexFixture() : deepseekFixture()
    await writeFile(join(input, '2026', '10', '18', 'one.jsonl.zstd'), zstdCompressSync(bytes))
    const connection = await browser.connect(source, input)
    const page = await settle(browser, connection.id)
    expect(page.total).toBe(1)
    expect((await browser.read(page.items[0].id)).session.source).toBe(source)
  })
  it('同一目录重复连接定位已有连接，允许显式连接另一个项目或归档目录', async () => {
    const { root, input, browser } = await setup()
    const first = await browser.connect('codex', input)
    expect((await browser.connect('codex', input)).id).toBe(first.id)
    const other = join(root, 'archived_sessions'); await mkdir(other)
    const second = await browser.connect('codex', other)
    expect(second.id).not.toBe(first.id)
    await settle(browser, first.id); await settle(browser, second.id)
    expect(await browser.connections()).toHaveLength(2)
  })
  it('NewMax 分页与计数排除已知不支持的隐私和分叉会话', async () => {
    const { input, browser, data } = await setup(), path = join(input, 'newmax.db')
    seedDatabase(path)
    const before = await readFile(path)
    const connection = await browser.connect('newmax', path)
    const page = await settle(browser, connection.id)
    expect(page.total).toBe(123)
    const items = [...page.items, ...(await browser.page({ connectionId: connection.id, offset: 100 })).items]
    expect(items.find(item => item.sourceSessionId === 's2')).toBeUndefined()
    expect(items.find(item => item.sourceSessionId === 's3')).toBeUndefined()
    const ordinary = items.find(item => item.sourceSessionId === 's0')!
    expect((await browser.read(ordinary.id)).session.messages[0].content).toBe('正文不应缓存')
    expect(await readFile(path)).toEqual(before)
    expect(await readdir(data)).toEqual(['connections.json'])
    expect(JSON.stringify(page)).not.toContain('SECRET_SETTINGS')
  })
  it('未知 SQLite 结构显示连接错误而非零条；不创建或迁移外部数据库', async () => {
    const { input, browser } = await setup(), path = join(input, 'unknown.db')
    const db = new DatabaseSync(path); db.exec('CREATE TABLE unexpected (value TEXT)'); db.close()
    const before = await readFile(path)
    const connection = await browser.connect('newmax', path)
    const page = await settle(browser, connection.id)
    expect(page.connections[0]).toMatchObject({ status: 'error', total: null })
    expect(page.connections[0].error).toMatch(/结构/)
    expect(await readFile(path)).toEqual(before)
  })
  it('搜索覆盖未加载页的标题和项目，不暗中建立全文副本', async () => {
    const { input, browser } = await setup()
    await mkdir(join(input, 'special-project'))
    for (let index = 0; index < 105; index++) await writeFile(join(input, `${index}.jsonl`), 'unsupported')
    await writeFile(join(input, 'special-project', 'needle.jsonl'), 'unsupported')
    const connection = await browser.connect('claude-code', input); await settle(browser, connection.id)
    const result = await browser.page({ query: 'needle', limit: 20 })
    expect(result.total).toBe(1)
    expect(result.items[0].title).toBe('needle.jsonl')
    expect((await browser.page({ query: 'special-project' })).total).toBe(1)
  })
  it('刷新可发现新增和删除，旧的条目不能读取，新实例不自动扫描但保留授权', async () => {
    const { input, data, browser } = await setup(), path = join(input, 'one.jsonl')
    await writeFile(path, claudeFixture())
    const connection = await browser.connect('claude-code', input)
    const first = await settle(browser, connection.id)
    await rm(path); await writeFile(join(input, 'two.jsonl'), claudeFixture())
    await browser.refresh(connection.id); const next = await settle(browser, connection.id)
    expect(next.total).toBe(1); expect(next.items[0].id).not.toBe(first.items[0].id)
    await expect(browser.read(first.items[0].id)).rejects.toThrow(/不存在|刷新/)
    const restarted = new SourceBrowser(data)
    expect(await restarted.connections()).toMatchObject([{ id: connection.id, status: 'idle', total: null }])
    expect((await restarted.page({})).items).toEqual([])
    await restarted.refresh(connection.id); expect((await settle(restarted, connection.id)).total).toBe(1)
  })
  it('取消统计不冒充完整总数，重新刷新可恢复；断开后撤销读取并持久化', async () => {
    const { input, data, browser } = await setup()
    for (let index = 0; index < 20; index++) await writeFile(join(input, `${index}.jsonl`), claudeFixture())
    const connection = await browser.connect('claude-code', input)
    await browser.cancel(connection.id); await browser.waitForScan(connection.id)
    expect((await browser.connections())[0]).toMatchObject({ status: 'cancelled', total: null })
    await browser.refresh(connection.id); const page = await settle(browser, connection.id)
    expect(page.total).toBe(20)
    await browser.disconnect(connection.id)
    expect(await browser.connections()).toEqual([])
    expect(await new SourceBrowser(data).connections()).toEqual([])
    await expect(browser.read(page.items[0].id)).rejects.toThrow()
  })
  it('不跟随授权根、子目录、文件符号链接，读取前再次核验路径', async () => {
    const { root, input, browser } = await setup(), outside = join(root, 'outside')
    await mkdir(outside); await writeFile(join(outside, 'private.jsonl'), claudeFixture())
    await symlink(outside, join(input, 'linked-directory')); await symlink(join(outside, 'private.jsonl'), join(input, 'linked.jsonl'))
    const alias = join(root, 'alias'); await symlink(input, alias)
    await expect(browser.connect('claude-code', alias)).rejects.toThrow(/链接/)
    await writeFile(join(input, 'real.jsonl'), claudeFixture())
    const connection = await browser.connect('claude-code', input), page = await settle(browser, connection.id)
    expect(page.total).toBe(1)
    expect(page.connections[0].ignoredLinks).toBe(2)
    await rm(join(input, 'real.jsonl')); await symlink(join(outside, 'private.jsonl'), join(input, 'real.jsonl'))
    await expect(browser.read(page.items[0].id)).rejects.toThrow(/链接|授权/)
  })
  it('打开到不同 inode 时在读取正文前拒绝，不只依赖打开前后的路径字符串', async () => {
    const { input, root, browser } = await setup(), path = join(input, 'one.jsonl')
    await writeFile(path, claudeFixture())
    const outside = join(root, 'outside.jsonl'); await writeFile(outside, claudeFixture())
    const connection = await browser.connect('claude-code', input), page = await settle(browser, connection.id)
    const externalHandle = await filesystem.open(outside, 'r')
    const read = vi.spyOn(externalHandle, 'read')
    const open = vi.spyOn(filesystem, 'open').mockResolvedValueOnce(externalHandle)
    try {
      await expect(browser.read(page.items[0].id)).rejects.toThrow(/身份|授权/)
      expect(read).not.toHaveBeenCalled()
    } finally { open.mockRestore(); read.mockRestore(); await externalHandle.close() }
  })
  it('已 checkpoint 的 WAL 数据库可只读列出和读取正文，不创建副文件', async () => {
    const { input, browser } = await setup(), path = join(input, 'wal.db')
    seedDatabase(path)
    const database = new DatabaseSync(path); database.exec('PRAGMA journal_mode=WAL'); database.close()
    const before = await readdir(input), bytes = await readFile(path)
    const connection = await browser.connect('newmax', path), page = await settle(browser, connection.id)
    expect(page.connections[0]).toMatchObject({ status: 'ready', total: 123 })
    const ordinary = (await browser.page({ connectionId: connection.id, query: 's0' })).items[0]
    expect((await browser.read(ordinary.id)).session.messages[0].content).toBe('正文不应缓存')
    expect(await readdir(input)).toEqual(before)
    expect(await readFile(path)).toEqual(bytes)
  })
  it('Cindy 活跃 WAL 连接后不再报错，已提交会话可列出，未验证的正文仍明确标记', async () => {
    const { input, browser } = await setup(), path = join(input, 'cindy.db'), writer = new DatabaseSync(path)
    try {
      writer.exec('PRAGMA journal_mode=WAL'); createCindySchema(writer)
      writer.exec("INSERT INTO sessions(id,title,updated_at) VALUES('one','Cindy 合成会话',2000)")
      const connection = await browser.connect('cindy', path), page = await settle(browser, connection.id)
      expect(page.connections[0]).toMatchObject({ status: 'ready', total: 1 })
      expect(page.items[0]).toMatchObject({ title: 'Cindy 合成会话', availability: 'unread' })
      await expect(browser.read(page.items[0].id)).rejects.toThrow(/没有.*文本/)
    } finally { writer.close() }
  })
  it('重复数据库 ID 不能静默覆盖后宣称完整总数，Cindy 正常目录仍可显示', async () => {
    const { input, browser } = await setup(), path = join(input, 'cindy.db')
    const database = new DatabaseSync(path)
    createCindySchema(database)
    database.exec("ALTER TABLE sessions RENAME TO original_sessions; CREATE TABLE sessions AS SELECT * FROM original_sessions; DROP TABLE original_sessions; INSERT INTO sessions(id,title,updated_at,created_at,source,status) VALUES ('same','A',1000,1000,'desktop','active'),('same','B',2000,1000,'desktop','active')")
    database.close()
    const connection = await browser.connect('cindy', path), page = await settle(browser, connection.id)
    expect(page.connections[0]).toMatchObject({ status: 'error', total: null })
    expect(page.connections[0].error).toMatch(/重复/)
    const repair = new DatabaseSync(path); repair.exec("DELETE FROM sessions WHERE title = 'B'"); repair.close()
    await browser.refresh(connection.id)
    const fixed = await settle(browser, connection.id)
    expect(fixed.total).toBe(1)
    expect(fixed.items[0].availability).toBe('unread')
    await expect(browser.read(fixed.items[0].id)).rejects.toThrow(/没有.*文本/)
  })
  it('拒绝非法来源、分页、任意路径读取和损坏配置，不覆盖已有授权文件', async () => {
    const { input, browser, data } = await setup()
    await expect(browser.connect('other' as never, input)).rejects.toThrow()
    await expect(browser.page({ limit: 501 })).rejects.toThrow()
    await expect(browser.page({ offset: -1 })).rejects.toThrow()
    await expect(browser.read('../private')).rejects.toThrow()
    await mkdir(data); await writeFile(join(data, 'connections.json'), 'broken')
    const corrupt = new SourceBrowser(data)
    await expect(corrupt.connections()).rejects.toThrow(/连接配置/)
    await expect(corrupt.connect('claude-code', input)).rejects.toThrow(/连接配置/)
    expect(await readFile(join(data, 'connections.json'), 'utf8')).toBe('broken')
  })
})
