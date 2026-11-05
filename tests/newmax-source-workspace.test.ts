import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SourceBrowser } from '../src/main/source-browser'
import { readSourceDatabase } from '../src/main/source-sqlite'

// 仅合成数据库；工作区路径只作元数据，不创建或扫描这些目录。
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-newmax-workspace-'))); roots.push(root)
  const path = join(root, 'newmax.db'), db = new DatabaseSync(path)
  db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT,source TEXT,created_at INTEGER,updated_at INTEGER,
    forked_from_id TEXT,is_private INTEGER,message_count INTEGER,workspace_id TEXT);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT,path TEXT,default_model TEXT);
    CREATE TABLE credentials(secret TEXT); INSERT INTO credentials VALUES('NEVER_PROJECT_CREDENTIALS');
    INSERT INTO workspaces VALUES('a','自定义名称甲','/synthetic/work/alpha','NEVER_PROJECT_MODEL');
    INSERT INTO workspaces VALUES('b','自定义名称乙','/synthetic/work/beta','NEVER_PROJECT_MODEL');
    INSERT INTO conversations VALUES('one','会话甲','app',1000,3000,NULL,0,1,'a');
    INSERT INTO conversations VALUES('two','会话乙','app',1000,2000,NULL,0,1,'b');
    INSERT INTO conversations VALUES('three','会话丙','app',1000,1000,NULL,0,1,'a');`)
  return { root, path, db, browser: new SourceBrowser(join(root, 'pinekin')) }
}
async function connect(browser: SourceBrowser, path: string) {
  const connection = await browser.connect('newmax', path)
  await browser.waitForScan(connection.id)
  return connection
}

describe.runIf(process.platform === 'darwin')('NewMax 来源工作区', () => {
  it('只投影实际归属工作区路径，不读取消息、凭据或工作区模型设置，不改写来源', async () => {
    const { path, db } = await setup(); db.close()
    const before = await readFile(path)
    const result = await readSourceDatabase(path, 'newmax')
    expect(result.rows).toMatchObject([{ id: 'one', workspace: '/synthetic/work/alpha' },
      { id: 'three', workspace: '/synthetic/work/alpha' }, { id: 'two', workspace: '/synthetic/work/beta' }])
    expect(JSON.stringify(result)).not.toMatch(/NEVER_PROJECT|default_model|自定义名称/)
    expect(await readFile(path)).toEqual(before)
  })
  it('按工作区精确筛选、分页及计数，分面保留其他工作区，搜索可以匹配工作区路径', async () => {
    const { path, db, browser } = await setup(); db.close()
    const connection = await connect(browser, path)
    const page = await browser.page({ source: 'newmax', workspace: '/synthetic/work/alpha', limit: 1 })
    expect(page.items.map(item => item.sourceSessionId)).toEqual(['one'])
    expect(page).toMatchObject({ total: 2, hasMore: true, workspaces: [
      { path: '/synthetic/work/alpha', count: 2 }, { path: '/synthetic/work/beta', count: 1 },
    ] })
    expect((await browser.page({ connectionId: connection.id, workspace: '/synthetic/work/alpha', offset: 1, limit: 1 })).items.map(item => item.sourceSessionId)).toEqual(['three'])
    expect((await browser.page({ source: 'newmax', query: '/synthetic/work/beta' })).items.map(item => item.sourceSessionId)).toEqual(['two'])
    expect((await browser.page({ workspace: '/synthetic/work/alph' })).total).toBe(0)
  })
  it.each(['', '../relative', 'bad\npath', '/x'.repeat(513), null, 42])('无效路径 %j 不成为工作区筛选项，孤立归属也不猜测路径', async value => {
    const { path, db, browser } = await setup()
    db.prepare('UPDATE workspaces SET path=? WHERE id=\'a\'').run(value)
    db.exec("UPDATE conversations SET workspace_id='missing' WHERE id='two'"); db.close()
    await connect(browser, path)
    const page = await browser.page({})
    expect(page.items).toHaveLength(3)
    expect(page.items.every(item => item.workspace === undefined)).toBe(true)
    expect(page.workspaces).toEqual([])
  })
  it('工作区路径变更后刷新更新归属与快照，不复用旧筛选元数据', async () => {
    const { path, db, browser } = await setup()
    try {
      db.exec('PRAGMA journal_mode=WAL')
      const connection = await connect(browser, path)
      const before = await browser.page({ source: 'newmax' })
      db.exec("UPDATE workspaces SET path='C:\\synthetic\\gamma' WHERE id='a'")
      await browser.refresh(connection.id); await browser.waitForScan(connection.id)
      const after = await browser.page({ source: 'newmax' })
      expect(after.snapshot).not.toBe(before.snapshot)
      expect(after.items.find(item => item.sourceSessionId === 'one')?.workspace).toBe('C:\\synthetic\\gamma')
      expect((await browser.page({ workspace: '/synthetic/work/alpha' })).total).toBe(0)
    } finally { db.close() }
  })
  it('没有工作区字段的旧数据库仍能列出会话，不伪造归属', async () => {
    const { path, db, browser } = await setup()
    db.exec('ALTER TABLE conversations DROP COLUMN workspace_id; DROP TABLE workspaces'); db.close()
    await connect(browser, path)
    const page = await browser.page({})
    expect(page.items).toHaveLength(3)
    expect(page.workspaces).toEqual([])
    expect(page.connections[0].status).toBe('ready')
  })
  it.each(['DROP TABLE workspaces', 'ALTER TABLE conversations DROP COLUMN workspace_id'])('部分缺少可选工作区结构仍可浏览：%s', async change => {
    const { path, db, browser } = await setup()
    db.exec(change); db.close()
    await connect(browser, path)
    const page = await browser.page({})
    expect(page.items).toHaveLength(3)
    expect(page.workspaces).toEqual([])
    expect(page.connections[0].status).toBe('ready')
  })
  it('工作区 ID 重复时拒绝含糊归属，不任选一条路径', async () => {
    const { path, db } = await setup()
    db.exec(`ALTER TABLE workspaces RENAME TO original_workspaces;
      CREATE TABLE workspaces AS SELECT * FROM original_workspaces;
      INSERT INTO workspaces SELECT * FROM original_workspaces WHERE id='a'`); db.close()
    await expect(readSourceDatabase(path, 'newmax')).rejects.toThrow(/结构/)
  })
  it('工作区表缺少路径字段时明确报错', async () => {
    const { path, db } = await setup()
    db.exec('ALTER TABLE workspaces DROP COLUMN path'); db.close()
    await expect(readSourceDatabase(path, 'newmax')).rejects.toThrow(/结构/)
  })
  it('工作区视图伪装成表时拒绝读取，不将凭据当作工作区路径', async () => {
    const { path, db } = await setup()
    db.exec("DROP TABLE workspaces; CREATE VIEW workspaces AS SELECT 'a' AS id, secret AS path FROM credentials"); db.close()
    await expect(readSourceDatabase(path, 'newmax')).rejects.toThrow(/结构/)
  })
})
