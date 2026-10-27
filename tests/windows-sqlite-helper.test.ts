import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const binary = resolve(`resources/native/${process.platform}-${process.arch}/pinekin-sqlite${process.platform === 'win32' ? '.exe' : ''}`)
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-native-sqlite-'))); roots.push(root)
  const path = join(root, '中文 space # ?.db'.replace('?', 'percent%'))
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE conversations(id TEXT, title TEXT); CREATE TABLE credentials(secret TEXT);')
  db.exec("INSERT INTO conversations VALUES('one','已提交'); INSERT INTO credentials VALUES('NEVER_READ_CREDENTIALS')")
  return { root, path, db }
}
async function snapshot(root: string) {
  return Promise.all((await readdir(root)).sort().map(async name => {
    const info = await stat(join(root, name))
    return { name, mtime: info.mtimeMs, size: info.size, hash: createHash('sha256').update(await readFile(join(root, name))).digest('hex') }
  }))
}
async function query(path: string, sql: string, immutable = false) {
  const pending = execute(binary, [path, `${pathToFileURL(path).href}?mode=ro&readonly_shm=1${immutable ? '&immutable=1' : ''}`],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  pending.child.stdin?.on('error', () => {})
  pending.child.stdin?.end(sql)
  return (await pending).stdout.trim()
}

describe.runIf(process.platform === 'darwin' || process.platform === 'win32')('原生 SQLite 只读组件（非 Windows 仅验证可移植协议）', () => {
  beforeAll(async () => {
    expect((await execute(binary, ['--version'], { encoding: 'utf8', windowsHide: true })).stdout.trim()).toBe('pinekin-readonly-v1 SQLite 3.54.1')
  })
  it('来源 WAL 缺少 SHM 时不创建副文件或忽略 WAL 返回旧记录', async () => {
    const { root, path, db } = await setup()
    try {
      db.exec("PRAGMA journal_mode=WAL; INSERT INTO conversations VALUES('two','WAL 中新记录')")
      const copy = join(root, 'incomplete.db')
      await writeFile(copy, await readFile(path)); await writeFile(copy + '-wal', await readFile(path + '-wal'))
      const before = await snapshot(root)
      await expect(query(copy, 'SELECT title FROM conversations')).rejects.toThrow(/SQLite readonly error/)
      expect(await snapshot(root)).toEqual(before)
    } finally { db.close() }
  })
  it.runIf(process.platform === 'win32')('Windows 拒绝目录 junction 重定向，不读取跳转目标', async () => {
    const { root, path, db } = await setup(); db.close()
    const container = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-junction-'))); roots.push(container)
    const alias = join(container, 'redirect'); await symlink(root, alias, 'junction')
    await expect(query(join(alias, path.slice(root.length + 1)), 'SELECT title FROM conversations', true)).rejects.toThrow(/SQLite readonly error/)
  })
  it('读取活跃 WAL 的已提交记录，DB/WAL/SHM 字节、修改时间及目录均不变', async () => {
    const { root, path, db } = await setup()
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO conversations VALUES('two','WAL 已提交'); BEGIN; INSERT INTO conversations VALUES('three','未提交')")
      const before = await snapshot(root)
      expect(JSON.parse(await query(path, "SELECT json_group_array(title) FROM conversations"))).toEqual(['已提交', 'WAL 已提交'])
      expect(await snapshot(root)).toEqual(before)
      db.exec('COMMIT')
      expect(JSON.parse(await query(path, "SELECT json_group_array(title) FROM conversations"))).toEqual(['已提交', 'WAL 已提交', '未提交'])
    } finally { db.close() }
  })
  it('同一事务中的 sha3_query 指纹支持后续窗口，不带出凭据', async () => {
    const { path, db } = await setup(); db.close()
    const sql = "BEGIN; SELECT lower(hex(sha3_query('SELECT id,title FROM conversations ORDER BY id',256))); COMMIT;"
    const first = await query(path, sql, true)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(await query(path, sql, true)).toBe(first)
  })
  it('已关闭的 WAL 库使用 immutable，不创建副文件', async () => {
    const { root, path, db } = await setup(); db.exec('PRAGMA journal_mode=WAL'); db.close()
    const before = await snapshot(root)
    expect(await query(path, 'SELECT count(*) FROM conversations', true)).toBe('1')
    expect(await snapshot(root)).toEqual(before)
  })
  it.each([
    "UPDATE conversations SET title='changed'", 'PRAGMA journal_mode=DELETE', 'PRAGMA writable_schema=ON',
    "VACUUM INTO 'unauthorized.db'", "ATTACH ':memory:' AS other", 'SELECT * FROM credentials',
    "SELECT sha3_query('SELECT * FROM credentials')", "SELECT load_extension('untrusted')",
  ])('拒绝越权 SQL：%s', async sql => {
    const { root, path, db } = await setup(); db.close()
    const before = await snapshot(root)
    await expect(query(path, sql, true)).rejects.toThrow()
    expect(await snapshot(root)).toEqual(before)
  })
  it('视图不能绕过表白名单读取凭据', async () => {
    const { root, path, db } = await setup()
    db.exec('DROP TABLE conversations; CREATE VIEW conversations AS SELECT secret AS title FROM credentials'); db.close()
    const before = await snapshot(root)
    await expect(query(path, 'SELECT title FROM conversations', true)).rejects.toThrow()
    expect(await snapshot(root)).toEqual(before)
  })
  it('首个语句失败后不执行后续查询', async () => {
    const { path, db } = await setup(); db.close()
    try { await query(path, "SELECT json('PINEKIN_SCHEMA_MISMATCH'); SELECT title FROM conversations", true); throw new Error('预期拒绝') }
    catch (error) { expect((error as { stdout?: string }).stdout).toBe('') }
  })
  it('不存在的数据库不创建文件', async () => {
    const { root, db } = await setup(); db.close()
    const before = await snapshot(root)
    await expect(query(join(root, 'missing.db'), 'SELECT 1')).rejects.toThrow()
    expect(await snapshot(root)).toEqual(before)
  })
  it.runIf(process.platform !== 'win32')('数据库和 WAL 链接不能越过已授权路径', async () => {
    const { root, path, db } = await setup(); db.close()
    const alias = join(root, 'alias.db'); await symlink(path, alias)
    await expect(query(alias, 'SELECT title FROM conversations', true)).rejects.toThrow()
    const outside = join(root, 'secret'); await writeFile(outside, 'PRIVATE')
    await symlink(outside, path + '-wal')
    await expect(query(path, 'SELECT title FROM conversations')).rejects.toThrow()
    expect(await readFile(outside, 'utf8')).toBe('PRIVATE')
  })
})
