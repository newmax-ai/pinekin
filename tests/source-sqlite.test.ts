import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readSourceDatabase } from '../src/main/source-sqlite'
import { createCindySchema } from './fixtures/cindy-database'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-sqlite-'))); roots.push(root)
  return { root, path: join(root, 'synthetic.db') }
}
async function snapshot(root: string) {
  return Promise.all((await readdir(root)).sort().map(async name => {
    const path = join(root, name), info = await stat(path)
    return { name, bytes: await readFile(path), mtimeMs: info.mtimeMs, size: info.size }
  }))
}
function newmax(db: DatabaseSync) {
  db.exec(`CREATE TABLE conversations(id TEXT, title TEXT, source TEXT, created_at INTEGER, updated_at INTEGER, forked_from_id TEXT, is_private INTEGER, message_count INTEGER);
    CREATE TABLE messages(seq INTEGER, id TEXT, conversation_id TEXT, role TEXT, content TEXT, timestamp INTEGER, data TEXT);
    CREATE TABLE credentials(secret TEXT); INSERT INTO credentials VALUES('DO_NOT_PROJECT_CREDENTIALS');`)
}
function seedMessage(db: DatabaseSync, id: string) {
  const message = { id: 'message-one', role: 'user', content: 'WAL 中已经提交的正文', timestamp: 2000 }
  db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?)').run(id, 'WAL 会话', 'app', 1000, 2000, null, 0, 1)
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run(0, message.id, id, message.role, message.content, 2000, JSON.stringify(message))
}

describe('SQLite 受限只读投影', () => {
  it.each(['newmax', 'cindy'] as const)('%s 读取活跃 WAL 的已提交目录，不写 DB/WAL/SHM、不复制整库', async source => {
    const { root, path } = await setup(), writer = new DatabaseSync(path)
    try {
      writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;')
      if (source === 'newmax') { newmax(writer); seedMessage(writer, 'one') }
      else { createCindySchema(writer); writer.exec("INSERT INTO sessions(id,title,updated_at) VALUES('one','WAL 会话',2000)") }
      const before = await snapshot(root)
      const result = await readSourceDatabase(path, source)
      expect(result.rows).toMatchObject([{ id: 'one', title: 'WAL 会话', updated_at: 2000 }])
      expect(JSON.stringify(result)).not.toContain('DO_NOT_PROJECT_CREDENTIALS')
      expect(JSON.stringify(result)).not.toContain('已经提交的正文')
      expect(await snapshot(root)).toEqual(before)
    } finally { writer.close() }
  })
  it('只读取指定会话，带引号和 SQL 片段的 ID 仍按原值绑定', async () => {
    const { root, path } = await setup(), writer = new DatabaseSync(path)
    const id = "quote'; SELECT * FROM credentials; --"
    try {
      writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;'); newmax(writer); seedMessage(writer, id)
      const before = await snapshot(root)
      const result = await readSourceDatabase(path, 'newmax', id)
      expect(result.session).toMatchObject({ id })
      expect(result.budget).toMatchObject({ count: 1 })
      expect(result.rows).toMatchObject([{ content: 'WAL 中已经提交的正文', consistent: 1 }])
      expect(JSON.stringify(result)).not.toContain('DO_NOT_PROJECT_CREDENTIALS')
      expect(await snapshot(root)).toEqual(before)
    } finally { writer.close() }
  })
  it.each(['is_private=1', "source='bot'", "forked_from_id='parent'"])('会话边界变化为 %s 时不读取该会话正文', async change => {
    const { path } = await setup(), writer = new DatabaseSync(path)
    newmax(writer); seedMessage(writer, 'one'); writer.exec(`UPDATE conversations SET ${change}`); writer.close()
    const result = await readSourceDatabase(path, 'newmax', 'one')
    expect(result.rows).toEqual([])
    expect(JSON.stringify(result)).not.toContain('已经提交的正文')
  })
  it('未提交事务不可见，读取后刷新才能发现新提交', async () => {
    const { path } = await setup(), writer = new DatabaseSync(path)
    try {
      writer.exec('PRAGMA journal_mode=WAL'); createCindySchema(writer)
      writer.exec("INSERT INTO sessions(id,title,updated_at) VALUES('committed','已提交',1); BEGIN; INSERT INTO sessions(id,title,updated_at) VALUES('pending','未提交',2)")
      expect((await readSourceDatabase(path, 'cindy')).rows.map(row => row.id)).toEqual(['committed'])
      writer.exec('COMMIT')
      expect((await readSourceDatabase(path, 'cindy')).rows.map(row => row.id)).toEqual(['committed', 'pending'])
    } finally { writer.close() }
  })
  it('已关闭且 checkpoint 完成的 WAL 库无副文件时仍可读，不创建 WAL/SHM', async () => {
    const { root, path } = await setup(), writer = new DatabaseSync(path)
    writer.exec('PRAGMA journal_mode=WAL'); createCindySchema(writer)
    writer.exec("INSERT INTO sessions(id,title,updated_at) VALUES('one','已关闭',1)"); writer.close()
    expect(await readdir(root)).toEqual(['synthetic.db'])
    const before = await snapshot(root)
    expect((await readSourceDatabase(path, 'cindy')).rows).toMatchObject([{ id: 'one' }])
    expect(await snapshot(root)).toEqual(before)
  })
  it('拒绝数据库、副文件符号链接与事务日志，不触碰链接目标', async () => {
    const { root, path } = await setup(), writer = new DatabaseSync(path)
    writer.exec('CREATE TABLE sessions(id TEXT,title TEXT,updated_at INTEGER)'); writer.close()
    const alias = join(root, 'alias.db'); await symlink(path, alias)
    await expect(readSourceDatabase(alias, 'cindy')).rejects.toThrow(/链接|授权/)
    const target = join(root, 'external'); await writeFile(target, 'PRIVATE')
    await symlink(target, path + '-wal')
    await expect(readSourceDatabase(path, 'cindy')).rejects.toThrow(/链接|授权/)
    await rm(path + '-wal'); await writeFile(path + '-journal', 'active')
    await expect(readSourceDatabase(path, 'cindy')).rejects.toThrow(/事务/)
    expect(await readFile(target, 'utf8')).toBe('PRIVATE')
  })
  it('坏文件和缺字段明确报错，不把结构错误当零条成功', async () => {
    const { path } = await setup()
    await writeFile(path, 'not sqlite')
    await expect(readSourceDatabase(path, 'cindy')).rejects.toThrow(/数据库|SQLite/)
    await rm(path)
    const writer = new DatabaseSync(path); writer.exec('CREATE TABLE sessions(id TEXT)'); writer.close()
    await expect(readSourceDatabase(path, 'cindy')).rejects.toThrow(/结构|column|字段/)
  })
  it('正文超过旧总预算时只投影有界片段，仍报告原长度而不清空会话', async () => {
    const { path } = await setup(), writer = new DatabaseSync(path)
    newmax(writer); seedMessage(writer, 'one')
    writer.prepare('UPDATE messages SET content = ?').run('X'.repeat(5 * 1024 * 1024 + 1)); writer.close()
    const result = await readSourceDatabase(path, 'newmax', 'one')
    expect(Number(result.budget?.bytes)).toBeGreaterThan(5 * 1024 * 1024)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ text_length: 5 * 1024 * 1024 + 1, text_offset: 0 })
    expect(result.rows[0].content).toBe('X'.repeat(16_384))
  })
})
