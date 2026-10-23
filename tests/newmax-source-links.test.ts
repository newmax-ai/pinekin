import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, readlink, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourceBrowser } from '../src/main/source-browser'
import { autoConnectSource, type SourceLocationContext } from '../src/main/source-discovery'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function seed(path: string, title = '共享合成会话', wal = false) {
  const db = new DatabaseSync(path)
  if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;')
  db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT,source TEXT,created_at INTEGER,updated_at INTEGER,forked_from_id TEXT,is_private INTEGER,message_count INTEGER);
    CREATE TABLE messages(seq INTEGER,id TEXT,conversation_id TEXT,role TEXT,content TEXT,timestamp INTEGER,data TEXT);`)
  db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?)').run('one', title, 'app', 1000, 2000, null, 0, 1)
  const message = { id: 'm1', role: 'user', content: '仅合成正文', timestamp: 2000 }
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run(0, message.id, 'one', message.role, message.content, message.timestamp, JSON.stringify(message))
  return db
}
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-newmax-links-'))); roots.push(root)
  const home = join(root, 'home'), canonical = join(home, '.newmax'), replica = join(home, '.newmax-clean'), data = join(root, 'pinekin')
  await mkdir(canonical, { recursive: true }); await mkdir(replica)
  const target = join(canonical, 'newmax.db'), alias = join(replica, 'newmax.db')
  const context: SourceLocationContext = { home, appData: join(root, 'appData'), platform: 'darwin', env: { NEWMAX_USER_DATA_DIR: replica } }
  return { root, home, canonical, replica, data, target, alias, context, browser: new SourceBrowser(data) }
}
async function snapshot(directory: string) {
  return Promise.all((await readdir(directory)).sort().map(async name => {
    const path = join(directory, name), info = await stat(path)
    return { name, bytes: await readFile(path), mtimeMs: info.mtimeMs }
  }))
}

describe('NewMax 共享数据库链接', () => {
  it.runIf(process.platform === 'darwin').each(['relative-file', 'absolute-file', 'directory'] as const)('%s 链接到默认数据库时可自动连接，保存真实路径且不改原件或副文件', async kind => {
    const { canonical, replica, target, alias, context, data, browser } = await setup()
    const writer = seed(target, '共享合成会话', true)
    try {
      if (kind === 'directory') { await rm(replica, { recursive: true }); await symlink(canonical, replica) }
      else await symlink(kind === 'relative-file' ? '../.newmax/newmax.db' : target, alias)
      const before = await snapshot(canonical), link = await readlink(kind === 'directory' ? replica : alias)
      const result = await autoConnectSource(browser, 'newmax', context)
      expect(result.warnings).toEqual([])
      expect(result.connections).toMatchObject([{ source: 'newmax', status: 'ready', total: 1 }])
      const page = await browser.page({})
      expect(page.items[0].title).toBe('共享合成会话')
      expect((await browser.read(page.items[0].id)).session.messages[0].content).toBe('仅合成正文')
      expect(JSON.parse(await readFile(join(data, 'connections.json'), 'utf8')).connections).toMatchObject([{ path: target }])
      const again = await autoConnectSource(browser, 'newmax', context)
      expect(again.connections.map(item => item.id)).toEqual(result.connections.map(item => item.id))
      expect(await browser.connections()).toHaveLength(1)
      expect(await snapshot(canonical)).toEqual(before)
      expect(await readlink(kind === 'directory' ? replica : alias)).toBe(link)
    } finally { writer.close() }
  })
  it.runIf(process.platform === 'darwin')('连接后改变副本链接不会转移既有授权，刷新和重启仍读取原真实数据库', async () => {
    const { root, target, alias, context, data, browser } = await setup()
    seed(target).close(); await symlink(target, alias)
    const result = await autoConnectSource(browser, 'newmax', context)
    expect(result.connections).toHaveLength(1)
    const outside = join(root, 'elsewhere'); await mkdir(outside)
    seed(join(outside, 'newmax.db'), '不得跟随的新目标').close()
    await rm(alias); await symlink(join(outside, 'newmax.db'), alias)
    await browser.refresh(result.connections[0].id); await browser.waitForScan(result.connections[0].id)
    expect((await browser.page({})).items.map(item => item.title)).toEqual(['共享合成会话'])
    const restarted = new SourceBrowser(data); await restarted.restoreConnections(); await restarted.waitForScan(result.connections[0].id)
    expect((await restarted.page({})).items.map(item => item.title)).toEqual(['共享合成会话'])
  })
  it.each(['outside-database', 'other-file'] as const)('%s 不能借数据库链接扩大自动授权范围', async kind => {
    const { root, canonical, alias, context, data, browser } = await setup()
    const outside = join(root, 'elsewhere'); await mkdir(outside)
    const target = kind === 'other-file' ? join(canonical, 'credentials.json') : join(outside, 'newmax.db')
    if (kind === 'other-file') await writeFile(target, '不得读取')
    else seed(target).close()
    await symlink(target, alias)
    const connect = vi.spyOn(browser, 'connect')
    const result = await autoConnectSource(browser, 'newmax', context)
    expect(result.connections).toEqual([])
    expect(result.warnings.join('')).toMatch(/链接目标.*目录|实际数据库/)
    expect(connect).not.toHaveBeenCalled()
    expect(await readdir(root)).not.toContain('pinekin')
  })
  it.each(['broken', 'loop', 'directory-target'] as const)('%s 返回具体错误，不假装连接成功或读取默认库兜底', async kind => {
    const { canonical, target, alias, context, browser } = await setup()
    if (kind === 'directory-target') await mkdir(target)
    await symlink(kind === 'loop' ? alias : target, alias)
    const result = await autoConnectSource(browser, 'newmax', context)
    expect(result.connections).toEqual([])
    expect(result.warnings.join('')).toMatch(kind === 'broken' ? /链接.*(不存在|失效)/ : kind === 'loop' ? /循环/ : /普通文件/)
  })
  it('解析后父目录被换成链接时拒绝重新解析到新目标，不保存授权', async () => {
    const { root, canonical, target, alias, context, browser } = await setup()
    seed(target).close(); await symlink(target, alias)
    const outside = join(root, 'outside'); await mkdir(outside); seed(join(outside, 'newmax.db'), '不得读取').close()
    const original = browser.connect.bind(browser)
    vi.spyOn(browser, 'connect').mockImplementationOnce(async (source, path, options) => {
      await rename(canonical, canonical + '-original'); await symlink(outside, canonical)
      return original(source, path, options)
    })
    const result = await autoConnectSource(browser, 'newmax', context)
    expect(result.connections).toEqual([])
    expect(result.warnings.join('')).toMatch(/位置.*变化|授权/)
    expect(await browser.connections()).toEqual([])
  })
})
