import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSourceDatabase } from '../src/main/source-sqlite'
import { createCindyDatabase } from './fixtures/cindy-database'

const trace = vi.hoisted(() => ({ outputs: [] as string[] }))
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execute = promisify(original.execFile), execFile = vi.fn(original.execFile)
  Object.defineProperty(execFile, promisify.custom, { value: (...args: Parameters<typeof execute>) => {
    const pending = execute(...args)
    const observed = pending.then(result => { trace.outputs.push(String(result.stdout)); return result },
      error => { trace.outputs.push(String((error as { stdout?: string }).stdout ?? '')); throw error })
    return Object.assign(observed, { child: pending.child })
  } })
  return { ...original, execFile }
})
const roots: string[] = []
afterEach(async () => { trace.outputs.length = 0; await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-schema-guard-'))); roots.push(root)
  const path = join(root, 'synthetic.db'), db = new DatabaseSync(path)
  createCindyDatabase(db)
  return { path, db }
}

describe.runIf(process.platform === 'darwin')('SQLite 在正文语句之前校验对象类型与列', () => {
  it('Cindy messages 视图伪装字段时，子进程 stdout 也不能投影非白名单标记', async () => {
    const { path, db } = await setup()
    db.exec(`DROP TABLE messages; CREATE VIEW messages AS SELECT 'view-message' AS id, 'synthetic-session' AS session_id,
      'assistant' AS role, secret AS content, 1500 AS created_at, NULL AS rewind_at, 1 AS rowid FROM credentials;`)
    db.close()
    await expect(readSourceDatabase(path, 'cindy', 'synthetic-session')).rejects.toThrow(/结构/)
    expect(trace.outputs).toHaveLength(1)
    expect(trace.outputs.join('')).not.toContain('NEVER_READ_CREDENTIALS')
    expect(trace.outputs.join('')).not.toContain('"kind":"budget"')
    expect(trace.outputs.join('')).not.toContain('"kind":"session"')
  })
  it('会话目录同样不能在拒绝视图之前查询它的元数据', async () => {
    const { path, db } = await setup()
    db.exec(`DROP TABLE sessions; CREATE VIEW sessions AS SELECT 'fake' AS id, secret AS title, 1 AS updated_at FROM credentials;`)
    db.close()
    await expect(readSourceDatabase(path, 'cindy')).rejects.toThrow(/结构/)
    expect(trace.outputs.join('')).not.toContain('NEVER_READ_CREDENTIALS')
    expect(trace.outputs.join('')).not.toContain('"kind":"row"')
  })
  it('缺少必要列时不能先返回会话元数据，再因正文语句准备失败拒绝', async () => {
    const { path, db } = await setup()
    db.exec('ALTER TABLE messages DROP COLUMN rewind_at'); db.close()
    await expect(readSourceDatabase(path, 'cindy', 'synthetic-session')).rejects.toThrow(/结构/)
    expect(trace.outputs.join('')).not.toContain('"kind":"session"')
  })
  it('正常表仍通过同一连接的结构校验并返回正文', async () => {
    const { path, db } = await setup(); db.close()
    const result = await readSourceDatabase(path, 'cindy', 'synthetic-session')
    expect(result.rows).toHaveLength(2)
    expect(trace.outputs).toHaveLength(1)
    expect(trace.outputs.join('')).not.toContain('NEVER_READ_CREDENTIALS')
  })
})
