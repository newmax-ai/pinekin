import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSourceDatabase } from '../src/main/source-sqlite'
import { createCindyDatabase } from './fixtures/cindy-database'
import { sourceReadWindow } from '../src/main/source-read-window'

const runtime = vi.hoisted(() => ({ platform: process.platform, arch: process.arch, calls: [] as string[], unavailable: false }))
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execute = promisify(original.execFile), execFile = vi.fn(original.execFile)
  Object.defineProperty(execFile, promisify.custom, { value: (file: string, args: string[], options: object) => {
    runtime.calls.push(file)
    if (!file.endsWith('pinekin-sqlite.exe')) throw new Error('Windows 必须使用内置只读组件')
    // macOS 只验证 Windows 路由、固定 SQL 与同构协议；Win32 文件句柄必须另经原生 CI。
    const native = resolve(`resources/native/${runtime.platform}-${runtime.arch}/pinekin-sqlite${runtime.platform === 'win32' ? '.exe' : ''}`)
    return execute(runtime.unavailable ? native + '.missing' : native, args, { ...options, cwd: resolve('.') })
  } })
  return { ...original, execFile }
})
const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); runtime.calls.length = 0; runtime.unavailable = false; await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-windows-projection-'))); roots.push(root)
  const path = join(root, 'synthetic.db'), db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;')
  createCindyDatabase(db)
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }))
  return { root, path, db }
}
async function bytes(root: string) { return Promise.all((await readdir(root)).sort().map(async name => [name, await readFile(join(root, name))])) }

describe.runIf(runtime.platform === 'darwin' || runtime.platform === 'win32')('Windows 数据库投影路由', () => {
  it.each([false, true])('Electron defaultApp=%s 时使用正确的固定组件位置', async defaultApp => {
    const { path, db } = await setup()
    try {
      const resourcesPath = resolve('synthetic-electron-resources')
      vi.stubGlobal('process', Object.create(process, { resourcesPath: { value: resourcesPath }, defaultApp: { value: defaultApp } }))
      await readSourceDatabase(path, 'cindy')
      expect(runtime.calls).toEqual([defaultApp
        ? resolve(`resources/native/win32-${runtime.arch}/pinekin-sqlite.exe`)
        : join(resourcesPath, 'native', 'pinekin-sqlite.exe')])
    } finally { db.close() }
  })
  it('Cindy 活跃 WAL 目录、正文与窗口指纹使用原生受限组件', async () => {
    const { root, path, db } = await setup()
    try {
      const before = await bytes(root)
      expect((await readSourceDatabase(path, 'cindy')).rows).toMatchObject([{ id: 'synthetic-session' }])
      const projection = await readSourceDatabase(path, 'cindy', 'synthetic-session')
      expect(sourceReadWindow(projection, { offset: 0, textOffset: 0 }).messages).toHaveLength(2)
      expect(projection.snapshot).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.stringify(projection)).not.toContain('NEVER_READ_CREDENTIALS')
      expect(await bytes(root)).toEqual(before)
      expect(runtime.calls).toHaveLength(2)
    } finally { db.close() }
  })
  it('NewMax 活跃 WAL 正文、长片段与后续游标可读，隐私会话不投影', async () => {
    const { root, path, db } = await setup()
    try {
      db.exec('DROP TABLE messages; CREATE TABLE conversations(id TEXT,title TEXT,source TEXT,created_at INTEGER,updated_at INTEGER,forked_from_id TEXT,is_private INTEGER,message_count INTEGER); CREATE TABLE messages(seq INTEGER,id TEXT,conversation_id TEXT,role TEXT,content TEXT,timestamp INTEGER,data TEXT)')
      const message = { id: 'msg', role: 'user', content: '中文'.repeat(10_000), timestamp: 2000 }
      db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?)').run('one', '会话', 'app', 1000, 2000, null, 0, 1)
      db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run(0, message.id, 'one', message.role, message.content, message.timestamp, JSON.stringify(message))
      const before = await bytes(root)
      expect((await readSourceDatabase(path, 'newmax')).rows).toHaveLength(1)
      const first = sourceReadWindow(await readSourceDatabase(path, 'newmax', 'one'), { offset: 0, textOffset: 0 })
      expect(first.window.next?.textOffset).toBe(16_384)
      const next = first.window.next!
      const last = sourceReadWindow(await readSourceDatabase(path, 'newmax', 'one', next), next)
      expect(last.window.hasMore).toBe(false)
      expect(String(first.messages[0].content) + String(last.messages[0].content)).toBe(message.content)
      expect(await bytes(root)).toEqual(before)
      db.exec('UPDATE conversations SET is_private=1')
      expect((await readSourceDatabase(path, 'newmax', 'one')).rows).toEqual([])
    } finally { db.close() }
  })
  it('视图冒充白名单表时在查询正文前拒绝', async () => {
    const { path, db } = await setup()
    try {
      db.exec("DROP TABLE messages; CREATE VIEW messages AS SELECT 'fake' AS id,'synthetic-session' AS session_id,'assistant' AS role,secret AS content,1 AS created_at,NULL AS rewind_at FROM credentials")
      await expect(readSourceDatabase(path, 'cindy', 'synthetic-session')).rejects.toThrow(/结构/)
    } finally { db.close() }
  })
  it('原生组件不存在时明确失败，不调用系统 sqlite、PowerShell 或无隔离读取', async () => {
    const { path, db } = await setup()
    try {
      runtime.unavailable = true
      await expect(readSourceDatabase(path, 'cindy')).rejects.toThrow(/安全数据库读取组件不可用/)
      expect(runtime.calls).toHaveLength(1)
    } finally { db.close() }
  })
})
