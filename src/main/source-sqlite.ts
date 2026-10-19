import { execFile } from 'node:child_process'
import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { sourceReadCursorSchema, type SourceReadCursor } from '../core/sources'
import { textWindowQuery } from './source-read-window'
import { cindyDirectoryQuery, cindyRequiredTables, cindySourceQuery } from './cindy-source-query'

const execute = promisify(execFile)
export type DatabaseRow = Record<string, unknown>
export interface DatabaseProjection { rows: DatabaseRow[]; session?: DatabaseRow; budget?: DatabaseRow; snapshot?: string }
const conversationColumns = ['id', 'title', 'source', 'created_at', 'updated_at', 'forked_from_id', 'is_private', 'message_count']
const messageColumns = ['seq', 'id', 'conversation_id', 'role', 'content', 'timestamp', 'data']
// SQLite 的 readOnly 仍可能写共享内存。由操作系统拒绝所有文件写入，不能回退到无沙箱读取。
// 用户目录及来源同目录默认禁止读数据，只为明确授权的 DB/WAL/SHM 开例外。
const profile = `(version 1)(allow default)(deny file-write*)(deny network*)
(deny file-read-data (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath (param "HOME")) (subpath (param "SOURCE_PARENT")))
(allow file-read-data (literal (param "SOURCE")) (literal (param "WAL")) (literal (param "SHM")))`

async function ordinary(path: string, optional = false): Promise<Stats | undefined> {
  try {
    const value = await lstat(path)
    if (!value.isFile() || value.isSymbolicLink() || await realpath(path) !== path) throw new Error('数据库或副文件经过链接，拒绝读取授权外的位置')
    return value
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
function sameFile(a: Stats | undefined, b: Stats | undefined) { return !a ? !b : Boolean(b && a.dev === b.dev && a.ino === b.ino) }
function object(fields: string[]) { return `json_object(${fields.flatMap(field => [`'${field}'`, field]).join(',')})` }

/** 只接受固定会话投影，不接收调用方 SQL，也不复制整库或读取设置／认证表。 */
export async function readSourceDatabase(path: string, source: 'newmax' | 'cindy', rowId?: string, input?: SourceReadCursor): Promise<DatabaseProjection> {
  const cursor = sourceReadCursorSchema.parse(input ?? {})
  if (process.platform !== 'darwin') throw new Error('此平台的无副作用数据库读取尚未验证')
  if (source !== 'newmax' && source !== 'cindy') throw new Error('数据库来源未支持')
  if (rowId !== undefined && (!rowId.trim() || rowId.length > 512)) throw new Error('数据库会话 ID 无效')
  const before = await ordinary(path)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const held = await handle.stat()
    if (!sameFile(before, held)) throw new Error('数据库文件身份已变化，请刷新')
    const header = Buffer.alloc(100)
    if ((await handle.read(header, 0, 100, 0)).bytesRead !== 100 || header.toString('ascii', 0, 16) !== 'SQLite format 3\0') throw new Error('数据库结构未支持：文件头无效')
    const wal = await ordinary(path + '-wal', true), shm = await ordinary(path + '-shm', true)
    if (await ordinary(path + '-journal', true)) throw new Error('来源正在使用事务日志，请等待事务结束后刷新；不会恢复或删除外部日志')
    // 无副文件的静态库才能使用 immutable；活跃 WAL 必须交给 SQLite 原生事务处理。
    const immutable = !wal && !shm
    const table = source === 'cindy' ? 'sessions' : 'conversations'
    const required = source === 'cindy' ? cindyRequiredTables
      : { [table]: conversationColumns, ...(rowId === undefined ? {} : { messages: messageColumns }) }
    const names = Object.keys(required).map(name => `'${name}'`).join(',')
    // 在同一事务中先验证普通表，再验证列；-bail 遇到校验错误即退出，后续查询不会准备或执行。
    // 不能只在 stdout 返回后拒绝视图，否则视图已可能读取非白名单表。虚拟表和 shadow 表也排除。
    const tableCheck = `(SELECT COUNT(*) FROM pragma_table_list WHERE schema='main' AND name IN (${names}) AND type='table')=${Object.keys(required).length}`
    const columnCheck = Object.entries(required).map(([name, columns]) =>
      `(SELECT COUNT(*) FROM pragma_table_info('${name}') WHERE name IN (${columns.map(column => `'${column}'`).join(',')}))=${columns.length}`).join(' AND ')
    const guard = (condition: string) => `SELECT json_object('kind','schema-guard','valid',CASE WHEN ${condition} THEN 1 ELSE json('PINEKIN_SCHEMA_MISMATCH') END);`
    const schema = `${guard(tableCheck)}\n${guard(columnCheck)}\nSELECT json_object('kind','schema','name',name,'type',type,'columns',(SELECT json_group_array(name) FROM pragma_table_info(sqlite_schema.name))) FROM sqlite_schema WHERE name IN (${names});`
    let query: string
    if (rowId === undefined) {
      query = source === 'cindy' ? cindyDirectoryQuery()
        : `SELECT json_object('kind','row','value',${object(conversationColumns)}) FROM ${table} ORDER BY id;`
    } else if (source === 'cindy') {
      query = cindySourceQuery(rowId, cursor)
    } else {
      // ID 只作为 UTF-8 十六进制字符串值，不可能成为 SQL 或 CLI 指令。
      const id = `CAST(X'${Buffer.from(rowId).toString('hex')}' AS TEXT)`
      const readable = `EXISTS(SELECT 1 FROM conversations WHERE id=${id} AND source='app' AND is_private=0 AND forked_from_id IS NULL)`
      const budget = `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(content AS BLOB)) + COALESCE(LENGTH(CAST(data AS BLOB)),0)),0) AS bytes FROM messages WHERE conversation_id=${id} AND ${readable}`
      const select = `SELECT row_number() OVER (ORDER BY seq,rowid)-1 AS position,seq,id,role,timestamp,
        CASE WHEN role='user' THEN COALESCE(json_extract(data,'$.displayContent'),content) ELSE content END AS display,
        CASE WHEN json_extract(data,'$.taskContinuationTurn')=1 OR json_extract(data,'$.goalMeta.type') IS NOT NULL THEN 1 ELSE 0 END AS internal,
        CASE WHEN json_extract(data,'$.id')=id AND json_extract(data,'$.role')=role AND json_extract(data,'$.content')=content AND json_extract(data,'$.timestamp')=timestamp THEN 1 ELSE 0 END AS consistent
        FROM messages WHERE conversation_id=${id} AND ${readable}`
      query = `SELECT json_object('kind','session','value',${object(conversationColumns)}) FROM conversations WHERE id=${id};
        SELECT json_object('kind','budget','value',json_object('count',count,'bytes',bytes)) FROM (${budget});
        ${textWindowQuery(select, cursor)}`
    }
    // sqlite3 的 -bail 只会中止 stdin 脚本；同一命令行 SQL 参数内出错仍会继续后面的语句。
    // 守卫各占一个完整输入行，保证失败后不会准备正文查询。
    const sql = `PRAGMA temp_store=MEMORY;\nPRAGMA query_only=ON;\nPRAGMA trusted_schema=OFF;\nBEGIN;\n${schema}\n${query}\nCOMMIT;\n`
    const uri = `${pathToFileURL(path).href}?mode=ro${immutable ? '&immutable=1' : ''}`
    let stdout: string
    try {
      const pending = execute('/usr/bin/sandbox-exec', [
        '-D', `HOME=${homedir()}`, '-D', `SOURCE_PARENT=${dirname(path)}`, '-D', `SOURCE=${path}`, '-D', `WAL=${path}-wal`, '-D', `SHM=${path}-shm`, '-p', profile,
        '/usr/bin/sqlite3', '-init', '/dev/null', '-batch', '-bail', '-readonly', '-noheader', '-list', '-cmd', '.timeout 2000', uri,
      ], { encoding: 'utf8', cwd: '/usr', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C' }, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })
      // 子进程提前拒绝时可能关闭 stdin；错误由 execFile 的退出状态与 stderr 统一报告。
      pending.child.stdin?.on('error', () => {})
      pending.child.stdin?.end(sql)
      stdout = (await pending).stdout
    } catch (error) {
      const reason = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean }
      if (reason.code === 'ENOENT') throw new Error('安全数据库读取组件不可用，未回退到可能写入来源的读法')
      if (reason.killed || reason.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('数据库读取超时或投影超过安全预算，请稍后重试；未返回截断结果')
      const detail = reason.stderr?.trim().slice(0, 500) || '来源暂时不可读，请稍后刷新'
      throw new Error(`${/no such (table|column)|malformed|not a database/i.test(detail) ? '数据库结构未支持' : '数据库只读访问失败'}：${detail}`)
    }
    const current = await ordinary(path), heldAfter = await handle.stat()
    if (!sameFile(before, current) || !sameFile(wal, await ordinary(path + '-wal', true)) || !sameFile(shm, await ordinary(path + '-shm', true)) ||
      immutable && (held.mtimeMs !== heldAfter.mtimeMs || held.ctimeMs !== heldAfter.ctimeMs || held.size !== heldAfter.size) || await ordinary(path + '-journal', true)) {
      throw new Error('数据库或副文件在读取期间变化，请刷新；未返回不完整快照')
    }
    const records = stdout.trim() ? stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : []
    for (const [name, columns] of Object.entries(required)) {
      const schema = records.find(row => row.kind === 'schema' && row.name === name)
      const actual = schema?.columns
      if (schema?.type !== 'table' || !Array.isArray(actual) || columns.some(column => !actual.includes(column))) throw new Error('数据库结构未支持：会话表或字段不匹配')
    }
    // 不用 SHM 的锁读标记做版本：只绑定 DB/WAL 身份、大小与修改时间，避免正常只读访问使游标失效。
    const stamp = (value: Stats | undefined) => value ? [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs] : null
    const walAfter = await ordinary(path + '-wal', true)
    if (JSON.stringify([stamp(before), stamp(wal)]) !== JSON.stringify([stamp(current), stamp(walAfter)])) throw new Error('数据库在读取期间变化，请刷新；未混合不同版本的片段')
    const snapshot = createHash('sha256').update(JSON.stringify([source, rowId, stamp(before), stamp(wal)])).digest('hex')
    return { snapshot, rows: records.filter(row => row.kind === 'row').map(row => row.value as DatabaseRow),
      session: records.find(row => row.kind === 'session')?.value as DatabaseRow | undefined,
      budget: records.find(row => row.kind === 'budget')?.value as DatabaseRow | undefined }
  } finally { await handle.close() }
}
