import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SourceBrowser } from '../src/main/source-browser'
import { readSourceDatabase } from '../src/main/source-sqlite'
import { createCindyDatabase } from './fixtures/cindy-database'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(id?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-cindy-reader-'))); roots.push(root)
  const path = join(root, 'synthetic.db'), writer = new DatabaseSync(path)
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;'); createCindyDatabase(writer, id)
  return { root, path, writer, browser: new SourceBrowser(join(root, 'data')) }
}
async function snapshot(path: string) {
  return Promise.all(['', '-wal', '-shm'].map(async suffix => {
    const name = path + suffix, info = await stat(name)
    return { bytes: await readFile(name), size: info.size, mtimeMs: info.mtimeMs }
  }))
}
describe('Cindy 授权数据库的正文白名单投影', () => {
  it('目录与正文读活跃 WAL，仅显示当前问答、保留相同时间 rowid 顺序且不写原件', async () => {
    const { root, path, writer, browser } = await setup()
    try {
      const before = await snapshot(path)
      const connection = await browser.connect('cindy', path); await browser.waitForScan(connection.id)
      const item = (await browser.page({})).items[0]
      expect(item.availability).toBe('unread')
      const parsed = await browser.read(item.id)
      expect(parsed.session.messages).toEqual([{ role: 'user', content: '合成用户问题' }, { role: 'assistant', content: '## 合成回答\n\n**先确认目标**' }])
      expect(parsed.session.title).toBe(item.title)
      expect(JSON.stringify(parsed)).not.toMatch(/NEVER_READ|DO_NOT_PROJECT|do-not-read/)
      expect(parsed.warnings.join('\n')).toContain('结构')
      expect(await snapshot(path)).toEqual(before)
      expect(await readdir(join(root, 'data'))).toEqual(['connections.json'])
      expect(JSON.stringify(await readSourceDatabase(path, 'cindy'))).not.toContain('合成用户问题')
    } finally { writer.close() }
  })
  it.each([
    "UPDATE sessions SET source='bot'", "UPDATE sessions SET status='deleted'",
    "UPDATE sessions SET parent_session_id='parent'", "UPDATE sessions SET forked_at_message_id='fork'",
    "UPDATE sessions SET remote_host_id='remote'", "UPDATE sessions SET agent_device_id='device'",
    "UPDATE sessions SET orca_role='worker'", "UPDATE sessions SET orca_remote_lead='remote-lead'",
    'UPDATE sessions SET hidden_at=1800', "INSERT INTO orca_workers VALUES('synthetic-session')",
    "INSERT INTO orca_teams VALUES('synthetic-session')",
  ])('边界 %s 在 SQL 内阻止正文投影', async change => {
    const { path, writer, browser } = await setup()
    try {
      const connection = await browser.connect('cindy', path); await browser.waitForScan(connection.id)
      const item = (await browser.page({})).items[0]
      writer.exec(change)
      const result = await readSourceDatabase(path, 'cindy', 'synthetic-session')
      expect(result.rows).toEqual([])
      expect(JSON.stringify(result)).not.toContain('合成用户问题')
      await expect(browser.read(item.id)).rejects.toThrow(/普通.*会话|协作|边界/)
    } finally { writer.close() }
  })
  it('清空前、回退和非问答内容不输出；未提交消息不可见', async () => {
    const { path, writer } = await setup()
    try {
      writer.exec("UPDATE sessions SET cleared_at=1500; INSERT INTO messages VALUES('new','synthetic-session','user','新问题',2000,NULL); BEGIN; INSERT INTO messages VALUES('pending','synthetic-session','assistant','未提交',2100,NULL)")
      const result = await readSourceDatabase(path, 'cindy', 'synthetic-session')
      expect(result.rows.map(row => row.content)).toEqual(['新问题'])
      writer.exec('ROLLBACK')
    } finally { writer.close() }
  })
  it('超限和缺协作表均失败关闭；不按缺表猜测普通会话', async () => {
    const { path, writer } = await setup()
    try {
      writer.prepare("UPDATE messages SET content=? WHERE id='a-assistant'").run('x'.repeat(5 * 1024 * 1024 + 1))
      const result = await readSourceDatabase(path, 'cindy', 'synthetic-session')
      expect(Number(result.budget?.bytes)).toBeGreaterThan(5 * 1024 * 1024)
      expect(result.rows).toEqual([])
      writer.exec('DROP TABLE orca_workers')
      await expect(readSourceDatabase(path, 'cindy', 'synthetic-session')).rejects.toThrow(/结构/)
    } finally { writer.close() }
  })
  it('会话 ID 包含 SQL 字符仍只查询原 ID，空库会话显示清晰空文本错误', async () => {
    const id = "quote'; SELECT * FROM credentials; --", { path, writer, browser } = await setup(id)
    try {
      expect((await readSourceDatabase(path, 'cindy', id)).rows).toHaveLength(2)
      writer.exec('DELETE FROM messages')
      const connection = await browser.connect('cindy', path); await browser.waitForScan(connection.id)
      await expect(browser.read((await browser.page({})).items[0].id)).rejects.toThrow(/没有.*当前.*文本/)
    } finally { writer.close() }
  })
})
