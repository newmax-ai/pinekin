import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { lstat, mkdir, open, opendir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setImmediate } from 'node:timers/promises'
import { z } from 'zod'
import { MAX_BYTES } from '../core/session'
import { connectionIdSchema, entryIdSchema, sourceQuerySchema, sourceSchema,
  type BrowsableSource, type SourceConnection, type SourceContent, type SourceEntry, type SourcePage, type SourceQuery } from '../core/sources'
import { parseArchive } from './imports'
import { parseNewMaxLocal } from './newmax-local'

const configSchema = z.strictObject({ version: z.literal(1), connections: z.array(z.strictObject({
  id: connectionIdSchema, source: sourceSchema, path: z.string().min(1).max(4096),
})).max(100) })
type SavedConnection = z.infer<typeof configSchema>['connections'][number]
type Entry = { summary: SourceEntry; path: string; rowId?: string }
type State = { saved: SavedConnection; view: SourceConnection; entries: Map<string, Entry>; generation: number; task?: Promise<void> }
const metadataBytes = 64 * 1024
const newmaxColumns = ['id', 'title', 'source', 'created_at', 'updated_at', 'forked_from_id', 'is_private', 'message_count']
function inside(root: string, path: string) {
  const part = relative(root, path)
  return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part))
}
function failure(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT') return '来源已移动或删除，请重新连接或刷新'
  if (code === 'EACCES' || code === 'EPERM') return '没有读取权限，请检查授权位置'
  return error instanceof Error ? error.message : '读取失败'
}
function date(value: unknown) {
  const result = new Date(typeof value === 'number' || typeof value === 'string' ? value : 0)
  return Number.isFinite(result.getTime()) ? result.toISOString() : new Date(0).toISOString()
}
function short(value: unknown, fallback: string, limit = 200) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : fallback
}
async function checkedPath(path: string, root: string) {
  const stat = await lstat(path)
  if (stat.isSymbolicLink()) throw new Error('不读取符号链接来源')
  if (await realpath(path) !== path || !inside(root, path)) throw new Error('来源已越出授权位置或经过符号链接')
  return stat
}
async function readBounded(path: string, root: string, max: number, preview = false) {
  const authorized = await checkedPath(path, root)
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('来源不是普通文件')
    if (before.dev !== authorized.dev || before.ino !== authorized.ino) throw new Error('文件身份在打开期间变化，拒绝读取授权外的文件')
    if (!preview && before.size > max) throw new Error('正文超过 5 MB 读取上限；会话仍保留在列表，不截断内容')
    const bytes = Buffer.alloc(Math.min(before.size, max) + (preview ? 0 : 1))
    let count = 0
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, null)
      if (!result.bytesRead) break
      count += result.bytesRead
    }
    const after = await handle.stat()
    if (!preview && (count > max || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)) throw new Error('来源仍在更新，请稍后重新读取；未返回不完整正文')
    const current = await checkedPath(path, root)
    if (before.dev !== current.dev || before.ino !== current.ino) throw new Error('文件身份已变化，请刷新来源')
    return bytes.subarray(0, count)
  } finally { await handle.close() }
}
function requireTable(db: DatabaseSync, table: string, columns: string[]) {
  if (db.prepare("SELECT type FROM sqlite_schema WHERE name = ?").get(table)?.type !== 'table') throw new Error('数据库结构未支持：缺少会话表')
  const actual = db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(row => row.name)
  if (columns.some(name => !actual.includes(name))) throw new Error('数据库结构未支持：会话字段不匹配')
}
function database(path: string) {
  // readOnly 仍可能初始化 WAL/SHM；使用固定句柄 + immutable，绝不以普通路径打开来源库。
  // /dev/fd 在本轮仅于 macOS 的 Node / Electron 验证；其他平台先明确拒绝，而非退回有副作用的读取。
  if (process.platform !== 'darwin') throw new Error('此平台的无副作用数据库读取尚未验证')
  const authorized = lstatSync(path)
  if (!authorized.isFile() || authorized.isSymbolicLink() || realpathSync(path) !== path) throw new Error('数据库来源不是授权普通文件')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let db: DatabaseSync | undefined
  try {
    const identity = fstatSync(fd)
    if (identity.dev !== authorized.dev || identity.ino !== authorized.ino) throw new Error('数据库文件身份已变化')
    const header = Buffer.alloc(100)
    if (readSync(fd, header, 0, header.length, 0) !== 100 || header.toString('ascii', 0, 16) !== 'SQLite format 3\0') throw new Error('数据库结构未支持：文件头无效')
    if (header[18] !== 1 || header[19] !== 1) throw new Error('WAL 数据库暂未支持无副作用直读；不会创建副文件，也不会忽略 WAL 内容')
    const verify = () => {
      if (['-wal', '-shm', '-journal'].some(suffix => existsSync(path + suffix))) throw new Error('来源存在 WAL／事务副文件，不能保证完整只读快照，请勿手动删除副文件')
      const current = lstatSync(path), held = fstatSync(fd)
      if (realpathSync(path) !== path || current.dev !== identity.dev || current.ino !== identity.ino ||
        held.mtimeMs !== identity.mtimeMs || held.ctimeMs !== identity.ctimeMs || held.size !== identity.size) throw new Error('数据库正在变化，请稍后刷新；未交付不完整快照')
    }
    verify()
    db = new DatabaseSync(`file:/dev/fd/${fd}?mode=ro&immutable=1`, { readOnly: true })
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN')
    return { db, close() { try { verify() } finally { try { db!.close() } finally { closeSync(fd) } } } }
  } catch (error) {
    try { db?.close() } finally { closeSync(fd) }
    throw error
  }
}

/** 只持久化用户选择的位置；元数据索引和正文均不写入 Pinekin 档案库。 */
export class SourceBrowser {
  private states = new Map<string, State>()
  private loaded?: Promise<void>
  private mutations: Promise<unknown> = Promise.resolve()
  constructor(private readonly dataDirectory: string) {}
  private load() {
    return this.loaded ??= (async () => {
      let text: string
      try { text = await readFile(join(this.dataDirectory, 'connections.json'), 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      try {
        const config = configSchema.parse(JSON.parse(text))
        if (new Set(config.connections.map(item => item.id)).size !== config.connections.length) throw new Error('重复连接')
        for (const saved of config.connections) {
          if (!isAbsolute(saved.path) || resolve(saved.path) !== saved.path) throw new Error('无效路径')
          this.states.set(saved.id, this.createState(saved))
        }
      } catch { this.states.clear(); throw new Error('连接配置损坏；已停止读取，不覆盖现有文件') }
    })()
  }
  private createState(saved: SavedConnection): State {
    return { saved, generation: 0, entries: new Map(), view: { id: saved.id, source: saved.source, label: basename(saved.path),
      status: 'idle', discovered: 0, total: null, issues: 0, ignoredLinks: 0 } }
  }
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(action)
    this.mutations = next.catch(() => {})
    return next
  }
  private async save(connections: SavedConnection[]) {
    configSchema.parse({ version: 1, connections })
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 })
    const temporary = join(this.dataDirectory, `connections-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, connections }), { mode: 0o600, flag: 'wx' })
      await rename(temporary, join(this.dataDirectory, 'connections.json'))
    } finally { await rm(temporary, { force: true }) }
  }
  async connections(): Promise<SourceConnection[]> {
    await this.load()
    return [...this.states.values()].map(state => ({ ...state.view }))
  }
  async connect(rawSource: BrowsableSource, input: string): Promise<SourceConnection> {
    const source = sourceSchema.parse(rawSource)
    return this.mutate(async () => {
      await this.load()
      const selected = resolve(input)
      if ((await lstat(selected)).isSymbolicLink()) throw new Error('不读取符号链接来源')
      // 文件对话框选择的根规范化一次（macOS 的 /var 等系统路径本身可以是别名）。
      const path = await realpath(selected), stat = await checkedPath(path, path)
      const sqlite = source === 'newmax' || source === 'cindy'
      if (sqlite ? !stat.isFile() : !stat.isDirectory()) throw new Error(sqlite ? '请选择会话数据库普通文件' : '请选择会话日志目录')
      const previous = [...this.states.values()].find(state => state.saved.source === source && state.saved.path === path)
      if (previous) return { ...previous.view }
      const saved: SavedConnection = { id: randomUUID(), source, path }, state = this.createState(saved)
      await this.save([...this.states.values()].map(item => item.saved).concat(saved))
      this.states.set(saved.id, state)
      this.start(state)
      return { ...state.view }
    })
  }
  private async state(id: string) {
    connectionIdSchema.parse(id); await this.load()
    const state = this.states.get(id)
    if (!state) throw new Error('来源连接不存在或已断开')
    return state
  }
  async refresh(id: string) { this.start(await this.state(id)) }
  async cancel(id: string) {
    const state = await this.state(id)
    if (state.view.status !== 'scanning') return
    state.generation += 1; state.view.status = 'cancelled'; state.view.total = null
  }
  async disconnect(id: string) {
    return this.mutate(async () => {
      const state = await this.state(id)
      await this.save([...this.states.values()].filter(item => item !== state).map(item => item.saved))
      state.generation += 1; state.entries.clear(); this.states.delete(id)
    })
  }
  async waitForScan(id: string) { await (await this.state(id)).task }
  private start(state: State) {
    const generation = ++state.generation
    state.entries.clear()
    Object.assign(state.view, { status: 'scanning', total: null, discovered: 0, issues: 0, ignoredLinks: 0, error: undefined })
    const active = () => state.generation === generation && this.states.get(state.saved.id) === state
    state.task = (async () => {
      try {
        await setImmediate()
        if (!active()) return
        await checkedPath(state.saved.path, state.saved.path)
        if (state.saved.source === 'newmax' || state.saved.source === 'cindy') await this.scanDatabase(state, active)
        else await this.scanLogs(state, active)
        if (!active()) return
        state.view.status = state.view.issues ? 'partial' : 'ready'
        state.view.total = state.view.issues ? null : state.entries.size
      } catch (error) {
        if (!active()) return
        state.view.status = 'error'; state.view.total = null; state.view.error = failure(error)
      }
    })()
  }
  private add(state: State, key: string, details: Omit<SourceEntry, 'id' | 'source' | 'connectionId'>, path: string, rowId?: string) {
    const id = createHash('sha256').update(state.saved.id).update('\0').update(key).digest('hex')
    state.entries.set(id, { path, rowId, summary: { ...details, id, connectionId: state.saved.id, source: state.saved.source } })
    state.view.discovered = state.entries.size
  }
  private async scanLogs(state: State, active: () => boolean) {
    const root = state.saved.path, queue = [root]
    while (queue.length && active()) {
      const directory = queue.shift()!
      try {
        await checkedPath(directory, root)
        for await (const entry of await opendir(directory)) {
          if (!active()) return
          const path = join(directory, entry.name)
          if (entry.isSymbolicLink()) { state.view.ignoredLinks += 1; continue }
          if (entry.isDirectory()) { queue.push(path); continue }
          if (!entry.isFile() || !/\.jsonl(?:\.(?:zst|zstd))?$/.test(entry.name)) continue
          const project = relative(root, dirname(path)) || '.'
          const details: Omit<SourceEntry, 'id' | 'source' | 'connectionId'> = { title: entry.name, project, updatedAt: date(0), availability: 'unread' }
          try {
            const stat = await checkedPath(path, root)
            details.updatedAt = date(stat.mtimeMs)
            if (stat.size > MAX_BYTES) { details.availability = 'unsupported'; details.reason = '正文超过 5 MB 读取上限，仍可查找此会话' }
            else if (project.split(sep).includes('subagents')) { details.availability = 'unsupported'; details.reason = '已发现子会话；子会话正文与继承上下文尚未支持' }
            else if (entry.name.endsWith('.jsonl')) this.readMetadata(await readBounded(path, root, metadataBytes, true), details)
          } catch (error) { details.availability = 'unreadable'; details.reason = failure(error) }
          if (!active()) return
          this.add(state, relative(root, path), details, path)
        }
      } catch (error) {
        if (!active()) return
        if (directory === root) throw error
        state.view.issues += 1; state.view.error = '部分子目录不可访问；已发现数不代表完整总数'
      }
    }
  }
  private readMetadata(bytes: Buffer, details: Omit<SourceEntry, 'id' | 'source' | 'connectionId'>) {
    // 只读前 64 KiB 的显式标题/会话头；不把用户正文片段偷偷缓存成标题。
    for (const line of bytes.toString('utf8').split('\n')) {
      let value: Record<string, unknown>
      try { value = JSON.parse(line) } catch { continue }
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      if (typeof value.sessionId === 'string') details.sourceSessionId = value.sessionId.slice(0, 512)
      if (value.type === 'session' && typeof value.id === 'string') details.sourceSessionId = value.id.slice(0, 512)
      const payload = value.payload as Record<string, unknown> | undefined
      if (value.type === 'session_meta' && payload && typeof payload.id === 'string') details.sourceSessionId = payload.id.slice(0, 512)
      if (value.type === 'custom-title') details.title = short(value.customTitle, details.title)
      const data = value.data as Record<string, unknown> | undefined
      if (value.type === 'session/title' && data) details.title = short(data.title, details.title)
    }
  }
  private async scanDatabase(state: State, active: () => boolean) {
    const { db, close } = database(state.saved.path)
    try {
      const cindy = state.saved.source === 'cindy'
      const table = cindy ? 'sessions' : 'conversations'
      requireTable(db, table, cindy ? ['id', 'title', 'updated_at'] : newmaxColumns)
      // 分批让出事件循环，不在 LIMIT 之后停止，也不加载任何消息正文。
      const statement = db.prepare(cindy ? 'SELECT id, title, updated_at FROM sessions ORDER BY id LIMIT 200 OFFSET ?' :
        'SELECT id, title, updated_at, source, forked_from_id, is_private, message_count FROM conversations ORDER BY id LIMIT 200 OFFSET ?')
      for (let offset = 0; active(); offset += 200) {
        const rows = statement.all(offset)
        for (const row of rows) {
          if (typeof row.id !== 'string' || !row.id.trim() || row.id.length > 512) throw new Error('数据库会话 ID 无效，目录统计不完整')
          const rowId = row.id
          const id = createHash('sha256').update(state.saved.id).update('\0').update(rowId).digest('hex')
          if (state.entries.has(id)) throw new Error('数据库会话 ID 重复，拒绝覆盖目录条目；统计不完整')
          const reason = cindy ? 'Cindy 正文直读与协同边界尚未验证，仅提供会话目录' : row.is_private ? '隐私会话正文暂未支持' :
            row.forked_from_id != null ? '分叉会话正文暂未支持' : row.source !== 'app' ? '非普通 App 会话正文暂未支持' : Number(row.message_count) === 0 ? '此会话没有当前消息' : undefined
          this.add(state, rowId, { sourceSessionId: rowId, title: short(row.title, rowId), project: '', updatedAt: date(row.updated_at),
            availability: reason ? 'unsupported' : 'unread', reason }, state.saved.path, rowId)
        }
        if (rows.length < 200) break
        await setImmediate()
      }
    } finally { close() }
  }
  async page(input: SourceQuery): Promise<SourcePage> {
    const query = sourceQuerySchema.parse(input)
    await this.load()
    const search = query.query.trim().toLocaleLowerCase()
    const entries = [...this.states.values()].filter(state => (!query.connectionId || state.saved.id === query.connectionId) && (!query.source || state.saved.source === query.source))
      .flatMap(state => [...state.entries.values()].map(entry => entry.summary))
      .filter(entry => [entry.title, entry.project, entry.sourceSessionId ?? ''].join('\n').toLocaleLowerCase().includes(search))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    return { items: entries.slice(query.offset, query.offset + query.limit).map(entry => ({ ...entry })), total: entries.length,
      offset: query.offset, hasMore: query.offset + query.limit < entries.length, connections: await this.connections() }
  }
  async read(rawId: string): Promise<SourceContent> {
    const id = entryIdSchema.parse(rawId)
    await this.load()
    const state = [...this.states.values()].find(item => item.entries.has(id)), entry = state?.entries.get(id)
    if (!state || !entry) throw new Error('会话不存在、已断开或正在刷新，请重新选择')
    if (entry.summary.availability === 'unsupported') throw new Error(entry.summary.reason)
    const generation = state.generation
    try {
      await checkedPath(state.saved.path, state.saved.path)
      const parsed = state.saved.source === 'newmax' ? this.readNewMax(entry) : await parseArchive(await readBounded(entry.path, state.saved.path, MAX_BYTES))
      if (this.states.get(state.saved.id) !== state || generation !== state.generation) throw new Error('来源已刷新或断开，旧的正文请求已取消')
      if (parsed.session.source !== state.saved.source) throw new Error('文件内容与选择的来源不匹配')
      entry.summary.availability = 'readable'; delete entry.summary.reason
      return { session: { ...parsed.session, id, archive: undefined }, warnings: [
        '正文直接读取来源，仅在当前窗口内存中展示；没有导入、备份或复制原件。以下解析说明中的原件均指来源自身文件。',
        ...(state.saved.source === 'newmax' ? ['仅核对与既有 NewMax 1.1.22 白名单读取契约相容的数据库结构；未探测安装版本，不支持写入或原生恢复。'] : []),
        ...parsed.warnings,
      ] }
    } catch (error) {
      if (generation === state.generation && this.states.get(state.saved.id) === state) {
        entry.summary.availability = 'unreadable'; entry.summary.reason = failure(error)
      }
      throw new Error(failure(error))
    }
  }
  private readNewMax(entry: Entry) {
    const { db, close } = database(entry.path)
    try {
      requireTable(db, 'conversations', newmaxColumns)
      requireTable(db, 'messages', ['seq', 'id', 'conversation_id', 'role', 'content', 'timestamp', 'data'])
      const row = db.prepare('SELECT id, title, source, created_at, updated_at, forked_from_id, is_private, message_count FROM conversations WHERE id = ?').get(entry.rowId!)
      if (!row) throw new Error('来源会话已删除，请刷新')
      if (row.source !== 'app' || row.is_private || row.forked_from_id != null) throw new Error('会话已变为隐私、分叉或非普通会话，请刷新')
      const budget = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(content AS BLOB)) + LENGTH(CAST(data AS BLOB))),0) AS bytes FROM messages WHERE conversation_id = ?').get(entry.rowId!)!
      if (Number(budget.count) > 10_000 || Number(budget.bytes) > MAX_BYTES) throw new Error('正文超过读取预算，仍保留会话目录，不截断内容')
      const messages = db.prepare(`SELECT seq, id, role, content, timestamp,
        json_extract(data, '$.displayContent') AS displayContent,
        CASE WHEN json_extract(data, '$.taskContinuationTurn') = 1 OR json_extract(data, '$.goalMeta.type') IS NOT NULL THEN 1 ELSE 0 END AS internal,
        CASE WHEN json_extract(data, '$.id') = id AND json_extract(data, '$.role') = role AND json_extract(data, '$.content') = content
          AND json_extract(data, '$.timestamp') = timestamp THEN 1 ELSE 0 END AS consistent
        FROM messages WHERE conversation_id = ? ORDER BY seq ASC`).all(entry.rowId!)
      if (messages.some(message => message.consistent !== 1)) throw new Error('来源消息列不一致，拒绝不完整投影')
      return parseNewMaxLocal({ format: 'pinekin.newmax-local-snapshot', version: 1, sourceVersion: '1.1.22',
        session: { id: row.id, title: row.title, source: row.source, createdAt: row.created_at, updatedAt: row.updated_at,
          forkedFromConversationId: row.forked_from_id, isPrivate: false, messageCount: row.message_count },
        messages: messages.map(message => ({ seq: message.seq, id: message.id, role: message.role, content: message.content, timestamp: message.timestamp,
          internal: message.internal === 1, ...(message.displayContent != null ? { displayContent: message.displayContent } : {}) })) })
    } finally { close() }
  }
}
