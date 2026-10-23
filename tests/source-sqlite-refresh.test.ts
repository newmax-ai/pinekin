import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSourceDatabase } from '../src/main/source-sqlite'
import { SourceBrowser } from '../src/main/source-browser'
import { createCindySchema } from './fixtures/cindy-database'

// 使用真实受限 sqlite3 读取；只在子进程完成后精确制造并发写入和副文件变化。
const trace = vi.hoisted(() => ({ reads: 0, afterRead: undefined as (() => void | Promise<void>) | undefined }))
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execute = promisify(original.execFile), execFile = vi.fn(original.execFile)
  Object.defineProperty(execFile, promisify.custom, { value: (...args: Parameters<typeof execute>) => {
    trace.reads += 1
    const pending = execute(...args)
    const observed = pending.then(async result => { await trace.afterRead?.(); return result })
    return Object.assign(observed, { child: pending.child })
  } })
  return { ...original, execFile }
})
const roots: string[] = []
afterEach(async () => {
  trace.reads = 0; trace.afterRead = undefined
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function setup(source: 'newmax' | 'cindy', wal = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-directory-refresh-'))); roots.push(root)
  const path = join(root, 'synthetic.db'), db = new DatabaseSync(path)
  if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;')
  if (source === 'cindy') createCindySchema(db)
  else db.exec('CREATE TABLE conversations(id TEXT,title TEXT,source TEXT,created_at INTEGER,updated_at INTEGER,forked_from_id TEXT,is_private INTEGER,message_count INTEGER);')
  const table = source === 'cindy' ? 'sessions' : 'conversations'
  if (source === 'cindy') db.exec("INSERT INTO sessions(id,title,updated_at) VALUES('one','初始标题',1)")
  else db.exec("INSERT INTO conversations VALUES('one','初始标题','app',1,1,NULL,0,1)")
  return { root, path, db, table }
}

describe.runIf(process.platform === 'darwin').each(['newmax', 'cindy'] as const)('%s 目录并发读取自动恢复', source => {
  it('正常 WAL 提交不否定已经完成的事务，也不反复重读', async () => {
    const { path, db, table } = await setup(source)
    try {
      const before = await readSourceDatabase(path, source)
      trace.reads = 0
      trace.afterRead = () => db.exec(`UPDATE ${table} SET title='较新的标题',updated_at=2`)
      const during = await readSourceDatabase(path, source)
      expect(during.rows).toEqual(before.rows)
      expect(during.snapshot).toBe(before.snapshot)
      expect(trace.reads).toBe(1)
      trace.afterRead = undefined
      const next = await readSourceDatabase(path, source)
      expect(next.rows).toMatchObject([{ title: '较新的标题' }])
      expect(next.snapshot).not.toBe(before.snapshot)
    } finally { db.close() }
  })
  it('WAL checkpoint 不使未变目录快照失效', async () => {
    const { path, db } = await setup(source)
    try {
      const before = await readSourceDatabase(path, source)
      trace.reads = 0
      trace.afterRead = () => { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') }
      const after = await readSourceDatabase(path, source)
      expect(after.rows).toEqual(before.rows)
      expect(after.snapshot).toBe(before.snapshot)
      expect(trace.reads).toBe(1)
    } finally { db.close() }
  })
  it('副文件在读取后消失时，自动重新读取完整事务', async () => {
    const { path, db } = await setup(source)
    trace.afterRead = () => { trace.afterRead = undefined; db.close() }
    const result = await readSourceDatabase(path, source)
    expect(result.rows).toMatchObject([{ id: 'one', title: '初始标题' }])
    expect(trace.reads).toBe(2)
  })
  it('静态库读取期间变化时丢弃旧结果，自动取得更新后的目录', async () => {
    const { path, db, table } = await setup(source, false)
    try {
      trace.afterRead = () => { trace.afterRead = undefined; db.exec(`UPDATE ${table} SET title='重试后的标题',updated_at=2`) }
      const result = await readSourceDatabase(path, source)
      expect(result.rows).toMatchObject([{ title: '重试后的标题' }])
      expect(trace.reads).toBe(2)
    } finally { db.close() }
  })
  it('持续变化只尝试三次，不无限循环或返回已丢弃的结果', async () => {
    const { path, db, table } = await setup(source, false)
    try {
      trace.afterRead = () => { db.exec(`UPDATE ${table} SET updated_at=updated_at+1`) }
      await expect(readSourceDatabase(path, source)).rejects.toThrow(/已自动重试/)
      expect(trace.reads).toBe(3)
    } finally { db.close() }
  })
  it.each(['database is locked', 'database is busy'])('SQLite 报 %s 时丢弃失败结果，自动重试', async detail => {
    const { path, db } = await setup(source)
    try {
      trace.afterRead = () => {
        trace.afterRead = undefined
        throw Object.assign(new Error('合成 SQLite 忙碌退出'), { stderr: `Runtime error: ${detail} (5)` })
      }
      expect((await readSourceDatabase(path, source)).rows).toMatchObject([{ id: 'one' }])
      expect(trace.reads).toBe(2)
    } finally { db.close() }
  })
  it('结构错误不重试，也不伪装为零条成功', async () => {
    const { path, db, table } = await setup(source, false)
    db.exec(`DROP TABLE ${table}`); db.close()
    await expect(readSourceDatabase(path, source)).rejects.toThrow(/结构/)
    expect(trace.reads).toBe(1)
  })
  it('出现副文件链接时立即拒绝，不将安全错误当成瞬态变化重试', async () => {
    const { path, db } = await setup(source, false); db.close()
    trace.afterRead = async () => { await symlink(path, path + '-wal') }
    await expect(readSourceDatabase(path, source)).rejects.toThrow(/链接|授权/)
    expect(trace.reads).toBe(1)
  })
  it('主文件身份替换时不交付旧事务，重新校验后再返回', async () => {
    const original = await setup(source, false), replacement = await setup(source, false)
    original.db.close()
    replacement.db.exec(`UPDATE ${replacement.table} SET title='替换后的标题'`); replacement.db.close()
    trace.afterRead = async () => { trace.afterRead = undefined; await rename(replacement.path, original.path) }
    const result = await readSourceDatabase(original.path, source)
    expect(result.rows).toMatchObject([{ title: '替换后的标题' }])
    expect(trace.reads).toBe(2)
  })
  it('连接扫描在 WAL 正常写入时仍完成统计，不发布读取失败', async () => {
    const { root, path, db, table } = await setup(source)
    try {
      trace.afterRead = () => { db.exec(`UPDATE ${table} SET updated_at=updated_at+1`) }
      const browser = new SourceBrowser(join(root, 'pinekin-data'))
      const connection = await browser.connect(source, path)
      await browser.waitForScan(connection.id)
      expect(await browser.connections()).toMatchObject([{ status: 'ready', total: 1, discovered: 1, error: undefined }])
      expect(trace.reads).toBe(1)
    } finally { db.close() }
  })
})
