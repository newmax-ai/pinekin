import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SourceBrowser } from '../src/main/source-browser'
import { readSourceDatabase } from '../src/main/source-sqlite'
import { createCindyDatabase } from './fixtures/cindy-database'

// 仅合成数据库；字段语义来自 makecindy/cindy 77e2c32 的 schema.ts，不访问真实客户端。
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(withProjects = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-cindy-workspace-'))); roots.push(root)
  const path = join(root, 'synthetic.db'), db = new DatabaseSync(path)
  createCindyDatabase(db)
  if (withProjects) db.exec(`ALTER TABLE sessions ADD COLUMN working_dir TEXT;
    ALTER TABLE sessions ADD COLUMN workspace_kind TEXT;
    UPDATE sessions SET working_dir='/synthetic/work/alpha', workspace_kind='project';
    INSERT INTO sessions(id,title,updated_at,working_dir,workspace_kind) VALUES('two','合成乙',3000,'C:\\synthetic\\beta','project');
    INSERT INTO sessions(id,title,updated_at,working_dir,workspace_kind) VALUES('three','合成丙',1000,'/synthetic/work/alpha','project');
    INSERT INTO sessions(id,title,updated_at,working_dir,workspace_kind) VALUES('dialogue','普通对话',4000,'/synthetic/dialogue','dialogue');`)
  return { root, path, db, browser: new SourceBrowser(join(root, 'pinekin')) }
}
async function connect(browser: SourceBrowser, path: string) {
  const connection = await browser.connect('cindy', path); await browser.waitForScan(connection.id)
  return connection
}

describe.runIf(process.platform === 'darwin')('Cindy 项目目录筛选', () => {
  it('只投影项目目录，普通对话的运行目录不冒充项目，且不读取正文或凭据', async () => {
    const { path, db, browser } = await setup(); db.close()
    const before = await readFile(path), projection = await readSourceDatabase(path, 'cindy')
    expect(projection.rows.find(row => row.id === 'synthetic-session')?.workspace).toBe('/synthetic/work/alpha')
    expect(projection.rows.find(row => row.id === 'dialogue')?.workspace).toBeNull()
    expect(JSON.stringify(projection)).not.toMatch(/NEVER_READ|合成用户问题|DO_NOT_PROJECT/)
    await connect(browser, path)
    const all = await browser.page({ source: 'cindy' })
    expect(all.items).toHaveLength(4)
    expect(all.workspaces).toEqual([{ path: '/synthetic/work/alpha', count: 2 }, { path: 'C:\\synthetic\\beta', count: 1 }])
    const filtered = await browser.page({ source: 'cindy', workspace: '/synthetic/work/alpha', limit: 1 })
    expect(filtered).toMatchObject({ total: 2, hasMore: true, workspaces: all.workspaces })
    expect(filtered.items[0].workspace).toBe('/synthetic/work/alpha')
    expect((await browser.page({ source: 'cindy', workspace: '/synthetic/work/alpha', offset: 1, limit: 1 })).items[0].id).not.toBe(filtered.items[0].id)
    expect((await browser.page({ source: 'cindy', query: 'C:\\synthetic\\beta' })).items.map(item => item.sourceSessionId)).toEqual(['two'])
    expect((await browser.page({ source: 'cindy', workspace: '/synthetic/work/alph' })).total).toBe(0)
    expect(await readFile(path)).toEqual(before)
  })
  it.each(['', '../relative', 'bad\npath', '/x'.repeat(513), null, 42])('无效项目目录 %j 不进入分面', async value => {
    const { path, db, browser } = await setup()
    db.prepare('UPDATE sessions SET working_dir=?').run(value); db.close()
    await connect(browser, path)
    const page = await browser.page({ source: 'cindy' })
    expect(page.items).toHaveLength(4)
    expect(page.workspaces).toEqual([])
    expect(page.items.every(item => item.workspace === undefined)).toBe(true)
  })
  it.each([null, 'unknown', 'dialogue'])('未明确声明 project 的类型 %j 不进入项目分面', async kind => {
    const { path, db, browser } = await setup()
    db.prepare('UPDATE sessions SET workspace_kind=?').run(kind); db.close()
    await connect(browser, path)
    expect((await browser.page({ source: 'cindy' })).workspaces).toEqual([])
  })
  it.each(['none', 'working_dir', 'workspace_kind'])('旧库缺少可选项目字段时仍可浏览，不猜测归属：%s', async kept => {
    const { path, db, browser } = await setup(false)
    if (kept !== 'none') db.exec(`ALTER TABLE sessions ADD COLUMN ${kept} TEXT`)
    db.close()
    await connect(browser, path)
    const page = await browser.page({ source: 'cindy' })
    expect(page.connections[0].status).toBe('ready')
    expect(page.items).toHaveLength(1)
    expect(page.workspaces).toEqual([])
  })
  it('项目目录或类型变更后刷新更新快照，隐藏及远程项目仍不进入分面', async () => {
    const { path, db, browser } = await setup()
    try {
      db.exec('PRAGMA journal_mode=WAL')
      const connection = await connect(browser, path), before = await browser.page({ source: 'cindy' })
      db.exec("UPDATE sessions SET working_dir='/synthetic/new' WHERE id='synthetic-session'; UPDATE sessions SET hidden_at=1 WHERE id='two'; UPDATE sessions SET remote_host_id='remote' WHERE id='three'")
      await browser.refresh(connection.id); await browser.waitForScan(connection.id)
      const after = await browser.page({ source: 'cindy' })
      expect(after.snapshot).not.toBe(before.snapshot)
      expect(after.workspaces).toEqual([{ path: '/synthetic/new', count: 1 }])
      db.exec("UPDATE sessions SET workspace_kind='dialogue' WHERE id='synthetic-session'")
      await browser.refresh(connection.id); await browser.waitForScan(connection.id)
      expect((await browser.page({ source: 'cindy' })).workspaces).toEqual([])
    } finally { db.close() }
  })
})
