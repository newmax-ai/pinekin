import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceBrowser } from '../src/main/source-browser'
import { readSourceDatabase } from '../src/main/source-sqlite'
import { createCindyDatabase } from './fixtures/cindy-database'
import { claudeFixture, claudeRecords } from './fixtures/claude-code'
import { deepseekFixture, deepseekRecords } from './fixtures/deepseek'
import { codexFixture, codexMeta, codexMessage } from './fixtures/codex'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-visible-'))); roots.push(root)
  return { root, browser: new SourceBrowser(join(root, 'data')) }
}

describe('只列出未被判定为不支持的来源会话', () => {
  it('Cindy 在点击前排除分叉、bot、协作、远程和隐藏条目，搜索、分页和连接数量一致', async () => {
    const { root, browser } = await setup(), path = join(root, 'synthetic.db'), db = new DatabaseSync(path)
    createCindyDatabase(db)
    const insert = db.prepare(`INSERT INTO sessions(id,title,source,status,created_at,updated_at,parent_session_id,remote_host_id,orca_role,hidden_at)
      VALUES(?,?,'desktop','active',1000,2000,?,?,?,?)`)
    insert.run('fork','不支持分叉','parent',null,null,null)
    insert.run('remote','不支持远程',null,'remote',null,null)
    insert.run('orca','不支持Orca',null,null,'worker',null)
    insert.run('hidden','不支持隐藏',null,null,null,1000)
    insert.run('worker','不支持协作成员',null,null,null,null)
    insert.run('lead','不支持协作主会话',null,null,null,null)
    insert.run('bot','不支持bot',null,null,null,null)
    db.exec("UPDATE sessions SET source='bot' WHERE id='bot'; INSERT INTO orca_workers VALUES('worker'); INSERT INTO orca_teams VALUES('lead')")
    for (let index = 0; index < 3; index++) insert.run(`normal-${index}`, `普通会话 ${index}`,null,null,null,null)
    db.close()
    const projection = await readSourceDatabase(path, 'cindy')
    expect(projection.rows.find(row => row.id === 'fork')?.readable).toBe(0)
    expect(JSON.stringify(projection)).not.toContain('合成用户问题')
    const connection = await browser.connect('cindy', path); await browser.waitForScan(connection.id)
    const page = await browser.page({ limit: 2 })
    expect(page).toMatchObject({ total: 4, hasMore: true })
    expect(page.connections[0]).toMatchObject({ total: 4, discovered: 4, status: 'ready' })
    expect((await browser.page({ query: '不支持' })).total).toBe(0)
    expect((await browser.page({ offset: 2, limit: 2 })).items).toHaveLength(2)
    expect((await browser.page({ offset: 4, limit: 2 })).hasMore).toBe(false)
    await browser.refresh(connection.id); await browser.waitForScan(connection.id)
    expect((await browser.connections())[0].total).toBe(4)
  })
  it('超限与纯辅助日志不出现在列表，但格式损坏等可重试错误保留；文件更新后恢复可见', async () => {
    const { root, browser } = await setup(), input = join(root, 'logs'); await mkdir(input)
    await writeFile(join(input, 'normal.jsonl'), claudeFixture())
    await writeFile(join(input, 'helper.jsonl'), JSON.stringify({ type: 'queue-operation' }) + '\n')
    await writeFile(join(input, 'huge.jsonl'), Buffer.alloc(5 * 1024 * 1024 + 1))
    await writeFile(join(input, 'broken.jsonl'), 'not-json')
    const connection = await browser.connect('claude-code', input); await browser.waitForScan(connection.id)
    expect((await browser.page({})).total).toBe(2)
    expect((await browser.connections())[0]).toMatchObject({ total: 2, discovered: 2 })
    expect((await browser.page({ query: 'helper' })).total).toBe(0)
    expect((await browser.page({ query: 'huge' })).total).toBe(0)
    const broken = (await browser.page({ query: 'broken' })).items[0]
    await expect(browser.read(broken.id)).rejects.toThrow()
    expect((await browser.page({ query: 'broken' })).items[0].availability).toBe('unreadable')
    await writeFile(join(input, 'helper.jsonl'), claudeFixture())
    await browser.refresh(connection.id); await browser.waitForScan(connection.id)
    expect((await browser.page({})).total).toBe(3)
  })
  it('Codex 已知跨文件继承在元数据阶段排除，不依赖点击正文', async () => {
    const { root, browser } = await setup(), input = join(root, 'logs'); await mkdir(input)
    const meta = codexMeta(); meta.payload = { ...meta.payload as object, history_base: { path: '/synthetic/not-followed' } }
    await writeFile(join(input, 'inherited.jsonl'), codexFixture([meta, codexMessage()]))
    const connection = await browser.connect('codex', input); await browser.waitForScan(connection.id)
    expect(await browser.page({})).toMatchObject({ items: [], total: 0 })
    expect((await browser.connections())[0]).toMatchObject({ total: 0, status: 'ready' })
  })
  it('Claude 压缩边界与 DeepSeek 非独立版本在列表阶段隐藏，不读完整正文', async () => {
    const { root, browser } = await setup(), claude = join(root, 'claude'), deepseek = join(root, 'deepseek')
    await mkdir(claude); await mkdir(deepseek)
    const records = claudeRecords(); records[1].isCompactSummary = true
    await writeFile(join(claude, 'compact.jsonl'), claudeFixture(records))
    const deep = deepseekRecords(); deep[0].isSeeded = true
    await writeFile(join(deepseek, 'seeded.jsonl'), deepseekFixture(deep))
    for (const [source, path] of [['claude-code', claude], ['deepseek', deepseek]] as const) {
      const connection = await browser.connect(source, path); await browser.waitForScan(connection.id)
    }
    expect((await browser.page({})).items).toEqual([])
    expect((await browser.connections()).map(connection => connection.total)).toEqual([0, 0])
  })
  it('读取时才发生的边界变化也标为不支持，立即更新目录计数，不把普通错误一起隐藏', async () => {
    const { root, browser } = await setup(), path = join(root, 'synthetic.db'), db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA journal_mode=WAL'); createCindyDatabase(db)
      const connection = await browser.connect('cindy', path); await browser.waitForScan(connection.id)
      const item = (await browser.page({})).items[0]
      db.exec("UPDATE sessions SET source='bot'")
      await expect(browser.read(item.id)).rejects.toThrow(/普通桌面/)
      expect((await browser.page({})).total).toBe(0)
      expect((await browser.connections())[0]).toMatchObject({ total: 0, discovered: 0 })
    } finally { db.close() }
  })
  it('已打开 Cindy 会话变为不支持时，刷新后从目录和计数移除；恢复普通边界后可重新发现', async () => {
    const { root, browser } = await setup(), path = join(root, 'synthetic.db'), db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA journal_mode=WAL'); createCindyDatabase(db)
      const connection = await browser.connect('cindy', path); await browser.waitForScan(connection.id)
      const item = (await browser.page({})).items[0]; await browser.read(item.id)
      db.exec("UPDATE sessions SET source='bot'")
      const check = await browser.check({ mode: 'manual', selectedId: item.id })
      expect(check.selected?.availability).toBe('unsupported')
      expect(check.connections[0]).toMatchObject({ total: 0, discovered: 0 })
      expect((await browser.page({})).items).toEqual([])
      db.exec("UPDATE sessions SET source='desktop'")
      await browser.check({ mode: 'manual' })
      expect((await browser.page({})).items[0].id).toBe(item.id)
    } finally { db.close() }
  })
})
