import { mkdtemp, mkdir, writeFile, rm, rename, appendFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourceBrowser } from '../src/main/source-browser'
import * as sqlite from '../src/main/source-sqlite'
import { claudeFixture } from './fixtures/claude-code'
import { createCindySchema } from './fixtures/cindy-database'

vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: vi.fn(fs.open), opendir: vi.fn(fs.opendir) }
})
vi.mock('../src/main/source-sqlite', async original => {
  const sqlite = await original<typeof import('../src/main/source-sqlite')>()
  return { ...sqlite, readSourceDatabase: vi.fn(sqlite.readSourceDatabase) }
})
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'pinekin-refresh-')); roots.push(root)
  const input = join(root, 'source'); await mkdir(input)
  const path = join(input, 'one.jsonl'); await writeFile(path, claudeFixture())
  const browser = new SourceBrowser(join(root, 'data'))
  const connection = await browser.connect('claude-code', input); await browser.waitForScan(connection.id)
  return { root, input, path, browser, connection, first: await browser.page({}) }
}

describe('来源增量检查与稳定快照', () => {
  it('刷新期间保留目录、计数和读取能力，完成后原子发布新增与删除', async () => {
    const { input, browser, connection, first } = await setup()
    await writeFile(join(input, 'two.jsonl'), claudeFixture())
    await browser.refresh(connection.id)
    const during = await browser.page({})
    expect(during.items).toEqual(first.items)
    expect(during.connections[0]).toMatchObject({ status: 'ready', total: 1, refreshing: true })
    expect((await browser.read(first.items[0].id)).session.messages.length).toBeGreaterThan(0)
    await browser.waitForScan(connection.id)
    expect((await browser.page({})).total).toBe(2)
  })
  it('未变化的日志只检查文件属性，不重开元数据；并发刷新合并为一次扫描', async () => {
    const { browser, connection, first } = await setup()
    vi.mocked(fs.open).mockClear(); vi.mocked(fs.opendir).mockClear()
    const results = await Promise.all(Array.from({ length: 5 }, () => browser.check({ mode: 'manual', connectionIds: [connection.id] })))
    expect(fs.opendir).toHaveBeenCalledTimes(1)
    expect(fs.open).not.toHaveBeenCalled()
    expect(results.every(result => result.version === first.version)).toBe(true)
    expect((await browser.page({})).items).toEqual(first.items)
  })
  it('只重新读取变更文件，选中项即使不在当前页也能返回更新版本和删除状态', async () => {
    const { input, path, browser, first } = await setup()
    await writeFile(join(input, 'two.jsonl'), claudeFixture())
    await browser.check({ mode: 'manual' })
    vi.mocked(fs.open).mockClear()
    await appendFile(path, '\n' + JSON.stringify({ type: 'custom-title', customTitle: '更新后的会话' }))
    const result = await browser.check({ mode: 'manual', selectedId: first.items[0].id })
    expect(result.selected).toMatchObject({ title: '更新后的会话' })
    expect(result.selected?.revision).not.toBe(first.items[0].revision)
    expect(result.version).toBeGreaterThan(first.version!)
    expect(fs.open).toHaveBeenCalledTimes(1)
    await rm(path)
    expect((await browser.check({ mode: 'manual', selectedId: first.items[0].id })).selected).toBeNull()
  })
  it('检查失败保留上次快照，自动检查退避，手动可立即重试且不复活已断开来源', async () => {
    const { root, input, browser, connection, first } = await setup()
    const moved = join(root, 'moved'); await rename(input, moved)
    const failed = await browser.check({ mode: 'manual', selectedId: first.items[0].id })
    expect(failed.connections[0]).toMatchObject({ status: 'error', total: 1 })
    expect(failed.selected?.id).toBe(first.items[0].id)
    expect((await browser.page({})).items).toEqual(first.items)
    await rename(moved, input)
    expect((await browser.check({})).connections[0].status).toBe('error')
    expect((await browser.check({ mode: 'manual' })).connections[0].status).toBe('ready')
    await browser.refresh(connection.id); await browser.disconnect(connection.id)
    expect((await browser.check({ mode: 'manual' })).connections).toEqual([])
    expect((await browser.page({})).total).toBe(0)
  })
  it('自动检查有最小间隔，不自动恢复用户暂停的扫描', async () => {
    const { browser, connection } = await setup()
    vi.mocked(fs.opendir).mockClear()
    await browser.check({}); await browser.check({})
    expect(fs.opendir).not.toHaveBeenCalled()
    await browser.refresh(connection.id); await browser.cancel(connection.id); await browser.waitForScan(connection.id)
    vi.mocked(fs.opendir).mockClear()
    expect((await browser.check({})).connections[0].status).toBe('cancelled')
    expect(fs.opendir).not.toHaveBeenCalled()
    await browser.check({ mode: 'manual' })
    expect((await browser.connections())[0].status).toBe('ready')
  })
  it('正文返回实际读取版本，避免读取后再次提示同一个变更', async () => {
    const { path, browser, first } = await setup()
    await appendFile(path, '\n' + JSON.stringify({ type: 'custom-title', customTitle: '新版本' }))
    const content = await browser.read(first.items[0].id)
    const checked = await browser.check({ mode: 'manual', selectedId: first.items[0].id })
    expect(content.revision).toBeTruthy()
    expect(content.revision).toBe(checked.selected?.revision)
  })
  it.runIf(process.platform === 'darwin')('SQLite 无变化不启动查询进程，活跃 WAL 提交后刷新目录且不读取正文', async () => {
    const { root } = await setup(), path = join(root, 'cindy.db'), db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0'); createCindySchema(db)
      db.exec("INSERT INTO sessions(id,title,updated_at) VALUES('one','第一条',1000)")
      const browser = new SourceBrowser(join(root, 'sqlite-data'))
      const connection = await browser.connect('cindy', path); await browser.waitForScan(connection.id)
      const first = await browser.page({})
      vi.mocked(sqlite.readSourceDatabase).mockClear()
      await browser.check({ mode: 'manual' })
      expect(sqlite.readSourceDatabase).not.toHaveBeenCalled()
      db.exec("INSERT INTO sessions(id,title,updated_at) VALUES('two','第二条',2000)")
      const result = await browser.check({ mode: 'manual', selectedId: first.items[0].id })
      expect((await browser.page({})).total).toBe(2)
      expect(sqlite.readSourceDatabase).toHaveBeenCalledExactlyOnceWith(await fs.realpath(path), 'cindy')
      expect(result.selected?.revision).toBe(first.items[0].revision)
    } finally { db.close() }
  })
  it.runIf(process.platform === 'darwin')('结果指纹区分来源和关键词，覆盖未加载页，不受分页和已读状态影响', async () => {
    const { root, path, browser, first } = await setup()
    const dbPath = join(root, 'cindy-filter.db'), db = new DatabaseSync(dbPath)
    try {
      createCindySchema(db)
      db.exec("INSERT INTO sessions(id,title,updated_at) VALUES('one','旧 Cindy 会话',1000)")
      const cindy = await browser.connect('cindy', dbPath); await browser.waitForScan(cindy.id)
      const before = await browser.page({ source: 'cindy' })
      const searched = await browser.page({ query: '旧 Cindy' })
      expect(before.snapshot).toMatch(/^[a-f0-9]{64}$/)
      expect((await browser.page({ source: 'cindy', offset: 1, limit: 1 })).snapshot).toBe(before.snapshot)
      await browser.read(first.items[0].id)
      const claude = await browser.page({ source: 'claude-code' })
      await browser.read(first.items[0].id)
      expect((await browser.page({ source: 'claude-code' })).snapshot).toBe(claude.snapshot)
      await appendFile(path, '\n' + JSON.stringify({ type: 'custom-title', customTitle: '其他来源的新标题' }))
      await browser.check({ mode: 'manual' })
      expect((await browser.page({ source: 'cindy' })).snapshot).toBe(before.snapshot)
      expect((await browser.page({ query: '旧 Cindy' })).snapshot).toBe(searched.snapshot)
      expect((await browser.page({ source: 'claude-code' })).snapshot).not.toBe(claude.snapshot)
      db.exec("INSERT INTO sessions(id,title,updated_at) VALUES('two','不匹配关键词',2000)")
      await browser.check({ mode: 'manual' })
      expect((await browser.page({ query: '旧 Cindy' })).snapshot).toBe(searched.snapshot)
      const top = await browser.page({ source: 'cindy', limit: 1 })
      db.exec("UPDATE sessions SET title='旧 Cindy 已更新',updated_at=1100 WHERE id='one'")
      await browser.check({ mode: 'manual' })
      expect((await browser.page({ source: 'cindy', limit: 1 })).items).toEqual(top.items)
      expect((await browser.page({ source: 'cindy', limit: 1 })).snapshot).not.toBe(top.snapshot)
      expect((await browser.page({ query: '旧 Cindy' })).snapshot).not.toBe(searched.snapshot)
      db.exec("DELETE FROM sessions WHERE id='one'")
      await browser.check({ mode: 'manual' })
      expect((await browser.page({ query: '旧 Cindy' })).total).toBe(0)
    } finally { db.close() }
  })
  it('新接口拒绝路径、非法 ID、超量范围和未知参数', async () => {
    const { browser } = await setup()
    for (const query of [{ selectedId: '../secret' }, { connectionIds: ['invalid'] }, { mode: 'force' }, { path: '/tmp' }, { connectionIds: Array(101).fill('11111111-1111-4111-8111-111111111111') }]) {
      await expect(browser.check(query as never)).rejects.toThrow()
    }
  })
})
