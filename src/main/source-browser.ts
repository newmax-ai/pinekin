import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, opendir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readSourceDatabase } from './source-sqlite'
import { setImmediate } from 'node:timers/promises'
import { z } from 'zod'
import { MAX_BYTES } from '../core/session'
import { isBrowserTask, sourcePromptTitle } from '../core/source-presentation'
import { connectionIdSchema, entryIdSchema, sourceCheckSchema, sourceQuerySchema, sourceSchema,
  type BrowsableSource, type SourceCheck, type SourceCheckResult, type SourceConnection, type SourceContent, type SourceEntry, type SourcePage, type SourceQuery } from '../core/sources'
import { parseSourceArchive, type SourceArchive } from './source-reader'
import { parseNewMaxLocal } from './newmax-local'
import { codexFirstPrompt, sourceTitle as titleText } from './source-conversation'

const configSchema = z.strictObject({ version: z.literal(1), connections: z.array(z.strictObject({
  id: connectionIdSchema, source: sourceSchema, path: z.string().min(1).max(4096),
})).max(100) })
type SavedConnection = z.infer<typeof configSchema>['connections'][number]
type Entry = { summary: SourceEntry; path: string; rowId?: string }
type State = { saved: SavedConnection; view: SourceConnection; entries: Map<string, Entry>; generation: number; task?: Promise<void>
  initialized?: boolean; databaseStamp?: string; nextCheck?: number; failures?: number }
const metadataBytes = 64 * 1024
function revision(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function fileRevision(stat: Stats) { return revision([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]) }
function sameEntries(left: Map<string, Entry>, right: Map<string, Entry>) {
  return left.size === right.size && [...right].every(([id, entry]) => JSON.stringify(left.get(id)?.summary) === JSON.stringify(entry.summary))
}
async function databaseStamp(path: string) {
  const stamps = []
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      const stat = await checkedPath(path + suffix, path + suffix)
      if (!stat.isFile()) throw new Error('数据库或副文件不是普通文件')
      stamps.push(fileRevision(stat))
    } catch (error) {
      if (suffix && (error as NodeJS.ErrnoException).code === 'ENOENT') stamps.push(null)
      else throw error
    }
  }
  return revision(stamps)
}
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
async function readBounded(path: string, root: string, max: number, preview = false, fromEnd = false, onRead?: (revision: string) => void) {
  const authorized = await checkedPath(path, root)
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('来源不是普通文件')
    if (before.dev !== authorized.dev || before.ino !== authorized.ino) throw new Error('文件身份在打开期间变化，拒绝读取授权外的文件')
    if (!preview && before.size > max) throw new Error('正文超过 5 MB 读取上限；会话仍保留在列表，不截断内容')
    const position = fromEnd ? Math.max(0, before.size - max) : 0
    const bytes = Buffer.alloc(Math.min(before.size, max) + (preview ? 0 : 1))
    let count = 0
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, position + count)
      if (!result.bytesRead) break
      count += result.bytesRead
    }
    const after = await handle.stat()
    if (!preview && (count > max || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)) throw new Error('来源仍在更新，请稍后重新读取；未返回不完整正文')
    const current = await checkedPath(path, root)
    if (before.dev !== current.dev || before.ino !== current.ino) throw new Error('文件身份已变化，请刷新来源')
    onRead?.(fileRevision(before))
    const result = bytes.subarray(0, count)
    // 预览窗口只交付完整记录，不能把跨窗口残片误认为独立 JSON。
    if (preview && position > 0) return result.subarray(result.indexOf(10) < 0 ? count : result.indexOf(10) + 1)
    if (preview && count < before.size) return result.subarray(0, result.lastIndexOf(10) + 1)
    return result
  } finally { await handle.close() }
}
function firstPrompt(value: Record<string, unknown>): string {
  if (value.type !== 'user' || value.isMeta || value.isCompactSummary || value.isVisibleInTranscriptOnly) return ''
  const message = value.message as Record<string, unknown> | undefined
  if (!message || message.role !== 'user') return ''
  const content = message.content
  const blocks = Array.isArray(content) ? content : []
  if (blocks.some(block => block?.type === 'tool_result')) return ''
  const texts = typeof content === 'string' ? [content] : blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text as string)
  for (const raw of texts) {
    const text = raw.trim().replace(/^(?:\s*<(system-reminder|ide_opened_file|ide_selection|local-command-caveat)>[\s\S]*?<\/\1>\s*)+/, '').trim()
    if (!text || /^(?:<(?:local-command-stdout|session-start-hook|tick|goal)>|\[Request interrupted by user[^\]]*\])/.test(text) || text.includes('<command-name>')) continue
    return sourcePromptTitle(text, 'claude-code')
  }
  return ''
}

/** 只持久化用户选择的位置；元数据索引和正文均不写入 Pinekin 档案库。 */
export class SourceBrowser {
  private states = new Map<string, State>()
  private loaded?: Promise<void>
  private version = 0
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
  /** 应用启动时只恢复已保存的授权位置，不发现新 App，也不重复扫描已有运行状态。 */
  async restoreConnections(): Promise<void> {
    await this.load()
    for (const state of this.states.values()) {
      if (state.view.status === 'idle') this.start(state)
    }
  }
  async connections(): Promise<SourceConnection[]> {
    await this.load()
    return [...this.states.values()].map(state => ({ ...state.view }))
  }
  async connect(rawSource: BrowsableSource, input: string, { requireCanonicalPath = false }: { requireCanonicalPath?: boolean } = {}): Promise<SourceConnection> {
    const source = sourceSchema.parse(rawSource)
    return this.mutate(async () => {
      await this.load()
      const selected = resolve(input)
      if ((await lstat(selected)).isSymbolicLink()) throw new Error('不读取符号链接来源')
      // 文件对话框选择的根规范化一次；自动定位已经校验的真实路径不得再次跟随被替换的父目录。
      const path = await realpath(selected)
      if (requireCanonicalPath && path !== selected) throw new Error('会话位置在连接期间变化，拒绝读取新的目标')
      const stat = await checkedPath(path, path)
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
  /** 自动检查仅遍历已有授权；串行处理连接，单连接扫描合并，失败指数退避。 */
  async check(input: SourceCheck): Promise<SourceCheckResult> {
    const query = sourceCheckSchema.parse(input)
    await this.load()
    const ids = query.connectionIds ? new Set(query.connectionIds) : undefined
    for (const state of this.states.values()) {
      if (ids && !ids.has(state.saved.id)) continue
      if (query.mode === 'automatic' && (state.view.status === 'cancelled' || Date.now() < (state.nextCheck ?? 0))) continue
      this.start(state)
      await state.task
    }
    const selected = query.selectedId ? [...this.states.values()].map(state => state.entries.get(query.selectedId!)).find(Boolean)?.summary : undefined
    return { version: this.version, connections: await this.connections(), ...(query.selectedId ? { selected: selected ? { ...selected } : null } : {}) }
  }
  async cancel(id: string) {
    const state = await this.state(id)
    if (state.view.status !== 'scanning' && !state.view.refreshing) return
    state.generation += 1; state.view.status = 'cancelled'; state.view.total = null; state.view.refreshing = false
  }
  async disconnect(id: string) {
    return this.mutate(async () => {
      const state = await this.state(id)
      await this.save([...this.states.values()].filter(item => item !== state).map(item => item.saved))
      state.generation += 1; state.entries.clear(); this.states.delete(id); this.version += 1
    })
  }
  async waitForScan(id: string) { await (await this.state(id)).task }
  private start(state: State) {
    if (state.view.refreshing || state.view.status === 'scanning') return
    const generation = ++state.generation, previous = state.entries
    const draft: State = { ...state, entries: new Map(), view: { ...state.view, status: 'scanning', total: null, discovered: 0, issues: 0, ignoredLinks: 0, error: undefined } }
    // 首次发现渐进展示；后续扫描只在独立草稿中进行，失败不销毁上次目录。
    if (!state.initialized) { state.entries = draft.entries; state.view = draft.view }
    state.view.refreshing = true
    const active = () => state.generation === generation && this.states.get(state.saved.id) === state
    state.task = (async () => {
      try {
        await setImmediate()
        if (!active()) return
        await checkedPath(state.saved.path, state.saved.path)
        if (state.saved.source === 'newmax' || state.saved.source === 'cindy') {
          const stamp = await databaseStamp(state.saved.path)
          if (state.initialized && state.databaseStamp === stamp) draft.entries = new Map(previous)
          else {
            await this.scanDatabase(draft, active, previous)
            // 写入中的 WAL 快照允许读，但不能将前后的文件属性当成同一个缓存版本。
            draft.databaseStamp = stamp === await databaseStamp(state.saved.path) ? stamp : undefined
          }
        } else await this.scanLogs(draft, active, previous)
        if (!active()) return
        if (draft.view.issues) for (const [id, entry] of previous) if (!draft.entries.has(id)) draft.entries.set(id, entry)
        if (!sameEntries(previous, draft.entries)) this.version += 1
        state.entries = draft.entries; state.databaseStamp = draft.databaseStamp; state.initialized = true
        state.view = { ...draft.view, status: draft.view.issues ? 'partial' : 'ready', refreshing: false,
          discovered: state.entries.size, total: draft.view.issues ? null : state.entries.size }
        state.failures = draft.view.issues ? (state.failures ?? 0) + 1 : 0
      } catch (error) {
        if (!active()) return
        if (state.initialized) state.entries = previous
        state.view.status = 'error'; state.view.error = failure(error); state.view.refreshing = false
        state.failures = (state.failures ?? 0) + 1
      } finally {
        if (active()) state.nextCheck = Date.now() + (state.failures ? Math.min(300_000, 30_000 * 2 ** Math.min(state.failures - 1, 4)) : 15_000)
      }
    })()
  }
  private add(state: State, key: string, details: Omit<SourceEntry, 'id' | 'source' | 'connectionId'>, path: string, rowId?: string) {
    const id = createHash('sha256').update(state.saved.id).update('\0').update(key).digest('hex')
    state.entries.set(id, { path, rowId, summary: { ...details, id, connectionId: state.saved.id, source: state.saved.source } })
    state.view.discovered = state.entries.size
  }
  private async scanLogs(state: State, active: () => boolean, previous: Map<string, Entry>) {
    const cached = new Map([...previous.values()].map(entry => [entry.path, entry]))
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
            details.revision = fileRevision(stat)
            const old = cached.get(path)
            if (old?.summary.revision === details.revision && old.summary.availability !== 'unreadable') {
              if (!active()) return
              state.entries.set(old.summary.id, { ...old, summary: { ...old.summary } }); state.view.discovered = state.entries.size
              continue
            }
            details.updatedAt = date(stat.mtimeMs)
            if (stat.size > MAX_BYTES) { details.availability = 'unsupported'; details.reason = '正文超过 5 MB 读取上限，仍可查找此会话' }
            else if (project.split(sep).includes('subagents')) { details.kind = 'subagent'; details.availability = 'unsupported'; details.reason = '已发现子会话；子会话正文与继承上下文尚未支持' }
            const promptTitle = state.saved.source === 'claude-code' || state.saved.source === 'codex'
            if (entry.name.endsWith('.jsonl') && (promptTitle || details.availability === 'unread')) {
              const head = await readBounded(path, root, metadataBytes, true)
              const tail = state.saved.source === 'claude-code' && stat.size > metadataBytes
                ? await readBounded(path, root, metadataBytes, true, true) : undefined
              this.readMetadata(head, details, state.saved.source, tail)
              // 只有整个小文件均为已知辅助元数据时才分类；预览残片或未知格式不能据此隐藏。
              if (state.saved.source === 'claude-code' && stat.size <= metadataBytes) {
                const records = head.toString('utf8').split('\n').filter(line => line.trim()).map(line => { try { return JSON.parse(line) } catch { return null } })
                if (records.length && records.every(record => record && ['file-history-snapshot', 'file-history-delta', 'queue-operation'].includes(record.type))) {
                  details.kind = 'internal'; details.availability = 'unsupported'; details.reason = '此文件仅含辅助运行记录，没有用户或助手对话；仍保留原文件入口'
                }
              }
              // 仅标题缺失时扩展连续头部，涵盖跨 64 KiB 的快照／前置上下文；不扫描整份日志。
              if (promptTitle && details.title === entry.name && stat.size > metadataBytes) {
                const extended = await readBounded(path, root, 1024 * 1024, true)
                this.readMetadata(extended, details, state.saved.source, tail)
              }
            }
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
  private readMetadata(head: Buffer, details: Omit<SourceEntry, 'id' | 'source' | 'connectionId'>, source: BrowsableSource, tail?: Buffer) {
    // Claude 标题按优先级选择；首问只从头部获取，不把尾部续问冒充首问。
    let custom = '', generated = '', summary = '', prompt = ''
    for (const [index, bytes] of [head, ...(tail ? [tail] : [])].entries()) for (const line of bytes.toString('utf8').split('\n')) {
      let value: Record<string, unknown>
      try { value = JSON.parse(line) } catch { continue }
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      if (typeof value.sessionId === 'string') details.sourceSessionId = value.sessionId.slice(0, 512)
      if (value.type === 'session' && typeof value.id === 'string') details.sourceSessionId = value.id.slice(0, 512)
      const payload = value.payload as Record<string, unknown> | undefined
      if (value.type === 'session_meta' && payload && typeof payload.id === 'string') details.sourceSessionId = payload.id.slice(0, 512)
      if (source === 'claude-code') {
        if (value.isSidechain === true) {
          details.kind = 'subagent'; details.availability = 'unsupported'; details.reason = '已发现子会话；子会话正文与继承上下文尚未支持'
        }
        if (value.type === 'custom-title') custom = titleText(value.customTitle) || custom
        if (value.type === 'ai-title') generated = titleText(value.aiTitle) || generated
        if (value.type === 'summary') summary = titleText(value.summary) || summary
        if (index === 0 && !prompt) {
          prompt = firstPrompt(value)
          if (prompt && details.kind !== 'subagent') {
            const message = value.message as Record<string, unknown>
            const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
              ? message.content.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n') : ''
            details.kind = isBrowserTask(text) ? 'browser-task' : 'conversation'
          }
        }
      } else if (source === 'codex') {
        if (value.type === 'session_meta' && payload && (payload.parent_thread_id != null || payload.subagent_history_start_ordinal != null || (payload.source && typeof payload.source === 'object' && 'subagent' in payload.source))) {
          details.kind = 'subagent'; details.availability = 'unsupported'; details.reason = '已发现 Codex 子会话；继承上下文边界尚未支持'
        }
        if (index === 0 && !prompt) prompt = codexFirstPrompt(value)
      } else if (value.type === 'custom-title') details.title = short(value.customTitle, details.title)
      const data = value.data as Record<string, unknown> | undefined
      if (value.type === 'session/title' && data) details.title = short(data.title, details.title)
    }
    if (source === 'claude-code') details.title = custom || generated || summary || prompt || details.title
    if (source === 'codex') details.title = prompt || details.title
  }
  private async scanDatabase(state: State, active: () => boolean, previous: Map<string, Entry>) {
    const cindy = state.saved.source === 'cindy'
    const { rows } = await readSourceDatabase(state.saved.path, cindy ? 'cindy' : 'newmax')
    // SQLite 在独立只读事务中取得一致投影；分批入索引，不读取消息正文。
    for (let offset = 0; offset < rows.length && active(); offset += 200) {
      for (const row of rows.slice(offset, offset + 200)) {
        if (typeof row.id !== 'string' || !row.id.trim() || row.id.length > 512) throw new Error('数据库会话 ID 无效，目录统计不完整')
        const rowId = row.id
        const id = createHash('sha256').update(state.saved.id).update('\0').update(rowId).digest('hex')
        if (state.entries.has(id)) throw new Error('数据库会话 ID 重复，拒绝覆盖目录条目；统计不完整')
        const reason = cindy ? 'Cindy 正文直读与协同边界尚未验证，仅提供会话目录' : row.is_private ? '隐私会话正文暂未支持' :
          row.forked_from_id != null ? '分叉会话正文暂未支持' : row.source !== 'app' ? '非普通 App 会话正文暂未支持' : Number(row.message_count) === 0 ? '此会话没有当前消息' : undefined
        const old = previous.get(id), rowRevision = revision(row)
        if (old?.summary.revision === rowRevision) { state.entries.set(id, { ...old, summary: { ...old.summary } }); state.view.discovered = state.entries.size }
        else this.add(state, rowId, { sourceSessionId: rowId, title: short(row.title, rowId), project: '', updatedAt: date(row.updated_at), revision: rowRevision,
          availability: reason ? 'unsupported' : 'unread', reason }, state.saved.path, rowId)
      }
      await setImmediate()
    }
  }
  async page(input: SourceQuery): Promise<SourcePage> {
    const query = sourceQuerySchema.parse(input)
    await this.load()
    const search = query.query.trim().toLocaleLowerCase()
    const entries = [...this.states.values()].filter(state => (!query.connectionId || state.saved.id === query.connectionId) && (!query.source || state.saved.source === query.source))
      .flatMap(state => [...state.entries.values()])
      .filter(({ summary: entry, path, rowId }) => [entry.title, entry.project, entry.sourceSessionId ?? '', rowId === undefined ? basename(path) : ''].join('\n').toLocaleLowerCase().includes(search))
      .map(entry => entry.summary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    // 覆盖整个筛选结果（包括未加载页），不把正文读取产生的已读状态当作来源更新。
    // 只散列已有内存元数据，不触发文件读取或正文查询；与本页保持同一同步快照。
    const snapshot = createHash('sha256')
    for (const entry of entries) snapshot.update(JSON.stringify([entry.id, entry.revision, entry.title, entry.project, entry.updatedAt, entry.kind]))
    return { items: entries.slice(query.offset, query.offset + query.limit).map(entry => ({ ...entry })), total: entries.length,
      offset: query.offset, hasMore: query.offset + query.limit < entries.length,
      connections: [...this.states.values()].map(state => ({ ...state.view })), version: this.version, snapshot: snapshot.digest('hex') }
  }
  async read(rawId: string): Promise<SourceContent> {
    const id = entryIdSchema.parse(rawId)
    await this.load()
    const state = [...this.states.values()].find(item => item.entries.has(id)), entry = state?.entries.get(id)
    if (!state || !entry) throw new Error('会话不存在、已断开或正在刷新，请重新选择')
    if (entry.summary.availability === 'unsupported') throw new Error(entry.summary.reason)
    try {
      await checkedPath(state.saved.path, state.saved.path)
      let contentRevision: string | undefined
      const parsed: SourceArchive = state.saved.source === 'newmax'
        ? await this.readNewMax(entry, value => { contentRevision = value })
        : await parseSourceArchive(await readBounded(entry.path, state.saved.path, MAX_BYTES, false, false, value => { contentRevision = value }))
      // 后台目录检查不取消正在阅读的正文；撤销授权或删除条目仍立即失效。
      if (this.states.get(state.saved.id) !== state || !state.entries.has(id)) throw new Error('来源已删除或断开，旧的正文请求已取消')
      if (parsed.session.source !== state.saved.source) throw new Error('文件内容与选择的来源不匹配')
      entry.summary.availability = 'readable'; delete entry.summary.reason
      const title = (state.saved.source === 'claude-code' || state.saved.source === 'codex') && entry.summary.title !== basename(entry.path) ? entry.summary.title : parsed.session.title
      // 按需正文成功后补齐预览预算之外的标题，仅更新内存，不保存正文或重扫来源。
      entry.summary.title = title
      return { revision: contentRevision, ...(parsed.presentation ? { presentation: parsed.presentation } : {}), session: { ...parsed.session, title, id, archive: undefined }, warnings: [
        '正文直接读取来源，仅在当前窗口内存中展示；没有导入、备份或复制原件。以下解析说明中的原件均指来源自身文件。',
        ...(state.saved.source === 'newmax' ? ['仅核对与既有 NewMax 1.1.22 白名单读取契约相容的数据库结构；未探测安装版本，不支持写入或原生恢复。'] : []),
        ...parsed.warnings,
      ] }
    } catch (error) {
      if (this.states.get(state.saved.id) === state && state.entries.get(id) === entry) {
        entry.summary.availability = 'unreadable'; entry.summary.reason = failure(error)
      }
      throw new Error(failure(error))
    }
  }
  private async readNewMax(entry: Entry, onRead: (revision: string) => void) {
    const { session: row, budget, rows: messages } = await readSourceDatabase(entry.path, 'newmax', entry.rowId!)
    if (!row) throw new Error('来源会话已删除，请刷新')
    onRead(revision(row))
    if (row.source !== 'app' || row.is_private || row.forked_from_id != null) throw new Error('会话已变为隐私、分叉或非普通会话，请刷新')
    if (!budget || Number(budget.count) > 10_000 || Number(budget.bytes) > MAX_BYTES) throw new Error('正文超过读取预算，仍保留会话目录，不截断内容')
    if (messages.some(message => message.consistent !== 1)) throw new Error('来源消息列不一致，拒绝不完整投影')
    return parseNewMaxLocal({ format: 'pinekin.newmax-local-snapshot', version: 1, sourceVersion: '1.1.22',
      session: { id: row.id, title: row.title, source: row.source, createdAt: row.created_at, updatedAt: row.updated_at,
        forkedFromConversationId: row.forked_from_id, isPrivate: false, messageCount: row.message_count },
      messages: messages.map(message => ({ seq: message.seq, id: message.id, role: message.role, content: message.content, timestamp: message.timestamp,
        internal: message.internal === 1, ...(message.displayContent != null ? { displayContent: message.displayContent } : {}) })) })
  }
}
