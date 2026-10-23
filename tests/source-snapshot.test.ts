import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSourceDatabase } from '../src/main/source-sqlite'
import { sourceReadWindow } from '../src/main/source-read-window'
import { createCindySchema } from './fixtures/cindy-database'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(source: 'newmax' | 'cindy', wal = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-session-snapshot-'))); roots.push(root)
  const path = join(root, 'synthetic.db'), db = new DatabaseSync(path)
  if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;')
  if (source === 'cindy') createCindySchema(db)
  else db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT,source TEXT,created_at INTEGER,updated_at INTEGER,forked_from_id TEXT,is_private INTEGER,message_count INTEGER);
    CREATE TABLE messages(seq INTEGER,id TEXT,conversation_id TEXT,role TEXT,content TEXT,timestamp INTEGER,data TEXT);`)
  for (const id of ['chosen', 'other']) {
    if (source === 'cindy') db.prepare('INSERT INTO sessions(id,title,updated_at) VALUES(?,?,?)').run(id, id, 2000)
    else db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?)').run(id, id, 'app', 1000, 2000, null, 0, 1)
    const message = { id: `${id}-m`, role: 'assistant', content: '开头🙂' + '中'.repeat(20_000) + '结尾', timestamp: 2000 }
    if (source === 'cindy') db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(message.id, id, message.role, message.content, 2000, null)
    else db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run(0, message.id, id, message.role, message.content, 2000, JSON.stringify(message))
  }
  return { path, db, table: source === 'cindy' ? 'sessions' : 'conversations' }
}

describe.runIf(process.platform === 'darwin').each(['newmax', 'cindy'] as const)('%s 会话级正文快照', source => {
  it.each([true, false])('其他会话提交后所选会话仍能续读（WAL=%s）', async wal => {
    const { path, db, table } = await setup(source, wal)
    try {
      const first = await readSourceDatabase(path, source, 'chosen')
      const cursor = sourceReadWindow(first, { offset: 0, textOffset: 0 }).window.next!
      db.exec(`UPDATE ${table} SET title='另一会话有更新',updated_at=3000 WHERE id='other';
        UPDATE messages SET content='另外一段文本' WHERE id='other-m';`)
      const next = await readSourceDatabase(path, source, 'chosen', cursor)
      expect(next.snapshot).toBe(first.snapshot)
      expect(sourceReadWindow(next, cursor).window.hasMore).toBe(false)
      // 不同会话不能共用同一个快照。
      expect((await readSourceDatabase(path, source, 'other')).snapshot).not.toBe(first.snapshot)
    } finally { db.close() }
  })
  it('WAL checkpoint 不改变正文快照', async () => {
    const { path, db } = await setup(source)
    try {
      const before = await readSourceDatabase(path, source, 'chosen')
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      expect((await readSourceDatabase(path, source, 'chosen')).snapshot).toBe(before.snapshot)
    } finally { db.close() }
  })
  it('未读尾部等长修改且元数据不变，首窗口复核仍检测到变化', async () => {
    const { path, db } = await setup(source)
    try {
      const first = await readSourceDatabase(path, source, 'chosen')
      const text = '开头🙂' + '中'.repeat(20_000) + '变化'
      if (source === 'cindy') db.prepare("UPDATE messages SET content=? WHERE id='chosen-m'").run(text)
      else db.prepare("UPDATE messages SET content=?,data=json_set(data,'$.content',?) WHERE id='chosen-m'").run(text, text)
      const changed = await readSourceDatabase(path, source, 'chosen')
      expect(changed.rows[0].content).toBe(first.rows[0].content)
      expect(changed.budget).toEqual(first.budget)
      expect(changed.snapshot).not.toBe(first.snapshot)
      expect(() => sourceReadWindow(changed, { offset: 0, textOffset: 0, snapshot: first.snapshot })).toThrow('来源正文已变化')
    } finally { db.close() }
  })
  it('所选会话变为不可读仍使旧快照失效，不能读取正文', async () => {
    const { path, db, table } = await setup(source)
    try {
      const first = await readSourceDatabase(path, source, 'chosen')
      db.exec(`UPDATE ${table} SET ${source === 'cindy' ? 'hidden_at=3000' : 'is_private=1'} WHERE id='chosen'`)
      const changed = await readSourceDatabase(path, source, 'chosen')
      expect(changed.rows).toEqual([])
      expect(changed.snapshot).not.toBe(first.snapshot)
      expect(() => sourceReadWindow(changed, { offset: 0, textOffset: 0, snapshot: first.snapshot })).toThrow('来源正文已变化')
    } finally { db.close() }
  })
})
