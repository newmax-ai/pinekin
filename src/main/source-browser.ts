import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, opendir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readSourceDatabase } from './source-sqlite'
import { sourceReadWindow } from './source-read-window'
import { sourceReadCursorSchema, type SourceReadCursor, type SourceReadWindow } from '../core/sources'
import { setImmediate } from 'node:timers/promises'
import { z } from 'zod'
import { MAX_BYTES } from '../core/session'
import { isBrowserTask, sourcePromptTitle } from '../core/source-presentation'
import { connectionIdSchema, entryIdSchema, sourceCheckSchema, sourceQuerySchema, sourceSchema,
  type BrowsableSource, type SourceCheck, type SourceCheckResult, type SourceConnection, type SourceContent, type SourceEntry, type SourcePage, type SourceQuery } from '../core/sources'
import type { SourceArchive } from './source-reader'
import { readSourceLog } from './source-log-reader'
import { inspectLogSupport } from './source-log-inspect'
import { readWorkbuddyMetadata, workbuddyRevision } from './workbuddy-metadata'
import { parseNewMaxLocal } from './newmax-local'
import { codexFirstPrompt, sourceTitle as titleText } from './source-conversation'
import { codexUnsupportedReason, isCodexSubagent } from './codex'
import { claudeAuxiliaryReason, isClaudeAuxiliaryLog } from './claude-code'
import { deepseekFirstPrompt } from './deepseek'
import { parseCindyLocal } from './cindy-local'
import { CINDY_SOURCE_SCHEMA } from './cindy-source-query'
import { ClaudeLogOrigin, sdkOriginReason, UnsupportedSourceError as UnsupportedContent } from './source-origin'

const configSchema = z.strictObject({ version: z.literal(1), connections: z.array(z.strictObject({
  id: connectionIdSchema, source: sourceSchema, path: z.string().min(1).max(4096),
})).max(100) })
type SavedConnection = z.infer<typeof configSchema>['connections'][number]
type Entry = { summary: SourceEntry; path: string; rowId?: string }
const visibleEntry = (entry: Entry) => entry.summary.availability !== 'unsupported'
const visibleCount = (entries: Map<string, Entry>) => [...entries.values()].filter(visibleEntry).length
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
  private assertLocation(saved: Pick<SavedConnection, 'source' | 'path'>) {
    if (saved.source === 'workbuddy' && (basename(saved.path) === 'cloud' || saved.path.split(sep).some((part, index, parts) => part === 'cloud' && parts[index - 1] === 'projects'))) throw new Error('WorkBuddy 云会话缓存尚未支持；请选择本地 projects 或普通项目目录')
  }
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
      this.assertLocation({ source, path: selected })
      if ((await lstat(selected)).isSymbolicLink()) throw new Error('不读取符号链接来源')
      // 文件对话框选择的根规范化一次；自动定位已经校验的真实路径不得再次跟随被替换的父目录。
      const path = await realpath(selected)
      if (requireCanonicalPath && path !== selected) throw new Error('会话位置在连接期间变化，拒绝读取新的目标')
      this.assertLocation({ source, path })
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
        this.assertLocation(state.saved)
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
        const count = visibleCount(state.entries)
        state.view = { ...draft.view, status: draft.view.issues ? 'partial' : 'ready', refreshing: false,
          discovered: count, total: draft.view.issues ? null : count }
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
    const previous = state.entries.get(id)
    state.view.discovered += Number(details.availability !== 'unsupported') - Number(previous !== undefined && visibleEntry(previous))
    state.entries.set(id, { path, rowId, summary: { ...details, id, connectionId: state.saved.id, source: state.saved.source } })
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
          if (entry.isDirectory()) {
            // Qwen 项目根还包含工具输出与工作流；只进入固定 chats 层，不递归读取其他数据。
            if (state.saved.source === 'workbuddy') {
              if (directory === root && basename(root) === 'projects' && entry.name !== 'cloud') queue.push(path)
            } else if (state.saved.source !== 'qwen-code' || basename(directory) !== 'chats' && (entry.name === 'chats' || directory === root && basename(root) === 'projects')) queue.push(path)
            continue
          }
          if (!entry.isFile() || !/\.jsonl(?:\.(?:zst|zstd))?$/.test(entry.name)) continue
          if (state.saved.source === 'qwen-code' && (basename(directory) !== 'chats' || !entry.name.endsWith('.jsonl'))) continue
          if (state.saved.source === 'workbuddy' && (!entry.name.endsWith('.jsonl') || directory === root && basename(root) === 'projects')) continue
          const project = relative(root, dirname(path)) || '.'
          const details: Omit<SourceEntry, 'id' | 'source' | 'connectionId'> = { title: entry.name, project, updatedAt: date(0), availability: 'unread' }
          try {
            const stat = await checkedPath(path, root)
            details.revision = fileRevision(stat)
            if (state.saved.source === 'workbuddy') details.revision = workbuddyRevision(details.revision, (await readWorkbuddyMetadata(path, root, active)).revision)
            const old = cached.get(path)
            if (old?.summary.revision === details.revision && old.summary.availability !== 'unreadable') {
              if (!active()) return
              state.entries.set(old.summary.id, { ...old, summary: { ...old.summary } }); state.view.discovered += Number(visibleEntry(old))
              continue
            }
            details.updatedAt = date(stat.mtimeMs)
            if (state.saved.source === 'qwen-code' || state.saved.source === 'workbuddy') {
              const support = await inspectLogSupport(path, root, state.saved.source, details.revision, active)
              details.title = support.title; details.sourceSessionId = support.sourceSessionId; details.kind = support.kind
            }
            if (state.saved.source === 'claude-code' && !entry.name.endsWith('.jsonl')) {
              details.availability = 'unsupported'; details.reason = 'Claude 压缩日志尚未支持；不将其列作可阅读会话'
            }
            if (project.split(sep).includes('subagents')) details.kind = 'subagent'
            const promptTitle = ['claude-code', 'codex', 'deepseek'].includes(state.saved.source)
            if ((state.saved.source === 'deepseek' || state.saved.source === 'codex') && /\.jsonl\.(?:zst|zstd)$/.test(entry.name)) {
              // 流式检查完整压缩流，只保留元数据；总展开量不再决定会话可见性。
              const support = await inspectLogSupport(path, root, state.saved.source, details.revision, active)
              if (support.title) details.title = support.title
              if (support.sourceSessionId) details.sourceSessionId = support.sourceSessionId
              if (support.kind) details.kind = support.kind
              if (support.reason) { details.availability = 'unsupported'; details.reason = support.reason }
            }
            if (state.saved.source !== 'qwen-code' && state.saved.source !== 'workbuddy' && entry.name.endsWith('.jsonl') && (promptTitle || details.availability === 'unread')) {
              const head = await readBounded(path, root, metadataBytes, true)
              const tail = (state.saved.source === 'claude-code' || state.saved.source === 'deepseek') && stat.size > metadataBytes
                ? await readBounded(path, root, metadataBytes, true, true) : undefined
              let origin = this.readMetadata(head, details, state.saved.source, tail, stat.size <= metadataBytes)
              // 标题或 Claude 客户端来源缺失时扩展连续头部；不能因先找到标题就漏掉长 SDK 首条记录。
              const needsOrigin = state.saved.source === 'claude-code' && details.availability !== 'unsupported' && origin === undefined
              if (promptTitle && (details.title === entry.name || needsOrigin) && stat.size > metadataBytes) {
                const extended = await readBounded(path, root, 1024 * 1024, true)
                origin = this.readMetadata(extended, details, state.saved.source, tail, stat.size <= 1024 * 1024)
              }
              // 大日志或预览无法确定归属时，流式完成能力检查；不聚合正文，不恢复整文件大小过滤。
              if (state.saved.source === 'claude-code' && details.availability !== 'unsupported' &&
                (stat.size > MAX_BYTES || origin === undefined && stat.size > 1024 * 1024)) {
                const support = await inspectLogSupport(path, root, state.saved.source, details.revision, active)
                if (support.kind) details.kind = support.kind
                if (support.reason) { details.availability = 'unsupported'; details.reason = support.reason }
              }
            }
          } catch (error) { details.availability = error instanceof UnsupportedContent ? 'unsupported' : 'unreadable'; details.reason = failure(error) }
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
  private readMetadata(head: Buffer, details: Omit<SourceEntry, 'id' | 'source' | 'connectionId'>, source: BrowsableSource, tail?: Buffer, completeHead = false) {
    // Claude 标题按优先级选择；首问和原始客户端来源只从连续头部获取，不能用尾部续聊入口覆盖。
    const origin = new ClaudeLogOrigin()
    if (source === 'claude-code' && completeHead && isClaudeAuxiliaryLog(head.toString('utf8'))) {
      details.kind = 'internal'; details.availability = 'unsupported'; details.reason = claudeAuxiliaryReason
    }
    let custom = '', generated = '', summary = '', prompt = ''
    for (const [index, bytes] of [head, ...(tail ? [tail] : [])].entries()) for (const line of bytes.toString('utf8').split('\n')) {
      let value: Record<string, unknown>
      try { value = JSON.parse(line.trim()) } catch { continue }
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      if (typeof value.sessionId === 'string') details.sourceSessionId = value.sessionId.slice(0, 512)
      if (value.type === 'session' && typeof value.id === 'string') details.sourceSessionId = value.id.slice(0, 512)
      const payload = value.payload as Record<string, unknown> | undefined
      if (value.type === 'session_meta' && payload && typeof payload.id === 'string') details.sourceSessionId = payload.id.slice(0, 512)
      if (source === 'claude-code') {
        if (index === 0) origin.observe(value)
        if (value.isCompactSummary || value.isVisibleInTranscriptOnly || value.logicalParentUuid != null || value.subtype === 'compact_boundary') {
          details.availability = 'unsupported'; details.reason = 'Claude 压缩或逻辑父链边界尚未支持'
        }
        if (value.isSidechain === true) details.kind = 'subagent'
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
        if (value.type === 'session_meta' && payload) {
          if (isCodexSubagent(payload)) details.kind = 'subagent'
          const reason = codexUnsupportedReason(payload)
          if (reason) { details.availability = 'unsupported'; details.reason = reason }
        }
        if (index === 0 && !prompt) prompt = codexFirstPrompt(value)
      } else if (source === 'deepseek') {
        if (value.type === 'session' && (value.version !== 4 || value.isSeeded !== false || value.delegationDepth !== 0)) {
          details.availability = 'unsupported'; details.reason = '仅支持 DeepSeek v4 独立主会话'
        }
        if (index === 0 && !prompt) prompt = deepseekFirstPrompt(value)
      } else if (value.type === 'custom-title') details.title = short(value.customTitle, details.title)
      const data = value.data as Record<string, unknown> | undefined
      if (source === 'deepseek' && value.type === 'session/title' && data) custom = titleText(data.title) || custom
    }
    if (source === 'claude-code') details.title = custom || generated || summary || prompt || details.title
    if (source === 'codex') details.title = prompt || details.title
    if (source === 'deepseek') details.title = custom || prompt || details.title
    if (source === 'claude-code' && origin.value(completeHead) === 'sdk') {
      details.availability = 'unsupported'; details.reason = sdkOriginReason
    }
    return origin.value(completeHead)
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
        const reason = cindy ? (row.readable === 1 ? undefined : '非普通桌面会话，或涉及分叉、协作、远程、隐藏及非活动边界，正文未支持') : row.is_private ? '隐私会话正文暂未支持' :
          row.forked_from_id != null ? '分叉会话正文暂未支持' : row.source !== 'app' ? '非普通 App 会话正文暂未支持' : Number(row.message_count) === 0 ? '此会话没有当前消息' : undefined
        const old = previous.get(id), rowRevision = revision(row)
        if (old?.summary.revision === rowRevision) { state.entries.set(id, { ...old, summary: { ...old.summary } }); state.view.discovered += Number(visibleEntry(old)) }
        else this.add(state, rowId, { sourceSessionId: rowId, title: short(row.title, rowId), project: '', updatedAt: date(row.updated_at), revision: rowRevision,
          availability: reason ? 'unsupported' : 'unread', reason }, state.saved.path, rowId)
      }
      await setImmediate()
    }
  }
  async getEntry(rawId: string): Promise<SourceEntry> {
    const id = entryIdSchema.parse(rawId)
    await this.load()
    for (const state of this.states.values()) {
      const entry = state.entries.get(id)
      if (entry && visibleEntry(entry)) return { ...entry.summary }
    }
    throw new Error('来源会话不存在、已过滤或已断开，请重新选择。')
  }
  /** 目标接续专用：读取完整文本且保留长消息内的空白，不复用 renderer 当前片段。 */
  async transfer(rawId: string, assertAllowed = () => {}) {
    const { collectSourceTransfer } = await import('./source-transfer')
    const id = entryIdSchema.parse(rawId)
    const original = await this.getEntry(id)
    if (original.kind && original.kind !== 'conversation') throw new Error('仅支持普通主会话的文本接续。')
    return collectSourceTransfer(async cursor => {
      const content = await this.read(id, cursor)
      const window = content.window
      if (!window) throw new Error('来源未提供完整读取边界。')
      let fragments: { position: number; role: 'user' | 'assistant'; content: string }[]
      if (original.source === 'newmax' || original.source === 'cindy') {
        const state = this.states.get(original.connectionId), entry = state?.entries.get(id)
        if (!state || !entry) throw new Error('来源已断开。')
        const projection = await readSourceDatabase(entry.path, original.source, entry.rowId!, { ...cursor, snapshot: window.snapshot })
        const raw = sourceReadWindow(projection, { ...cursor, snapshot: window.snapshot })
        fragments = raw.messages.filter(row => row.internal !== 1).map(row => ({ position: Number(row.position),
          role: z.enum(['user', 'assistant']).parse(row.role), content: z.string().parse(row.content) }))
      } else {
        fragments = content.session.messages.map((message, index) => ({ position: cursor.offset + index,
          role: z.enum(['user', 'assistant']).parse(message.role), content: message.content }))
      }
      await this.getEntry(id)
      return { title: content.session.title, source: original.source, snapshot: window.snapshot, totalMessages: window.totalMessages,
        offset: window.offset, textOffset: window.textOffset, fragments, next: window.next }
    }, assertAllowed)
  }
  async page(input: SourceQuery): Promise<SourcePage> {
    const query = sourceQuerySchema.parse(input)
    await this.load()
    const search = query.query.trim().toLocaleLowerCase()
    const entries = [...this.states.values()].filter(state => (!query.connectionId || state.saved.id === query.connectionId) && (!query.source || state.saved.source === query.source))
      .flatMap(state => [...state.entries.values()]).filter(visibleEntry)
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
  async read(rawId: string, input?: SourceReadCursor): Promise<SourceContent> {
    const id = entryIdSchema.parse(rawId)
    const cursor = sourceReadCursorSchema.parse(input ?? {})
    await this.load()
    const state = [...this.states.values()].find(item => item.entries.has(id)), entry = state?.entries.get(id)
    if (!state || !entry) throw new Error('会话不存在、已断开或正在刷新，请重新选择')
    if (entry.summary.availability === 'unsupported') throw new Error(entry.summary.reason)
    try {
      await checkedPath(state.saved.path, state.saved.path)
      let contentRevision: string | undefined
      const parsed: SourceArchive & { window?: SourceReadWindow; resolvedTitle?: string } = state.saved.source === 'newmax'
        ? await this.readNewMax(entry, cursor, value => { contentRevision = value })
        : state.saved.source === 'cindy' ? await this.readCindy(entry, cursor, value => { contentRevision = value })
        : await readSourceLog(entry.path, state.saved.path, state.saved.source, cursor,
          () => this.states.get(state.saved.id) === state && state.entries.has(id)).then(value => { contentRevision = value.revision; return value })
      // 后台目录检查不取消正在阅读的正文；撤销授权或删除条目仍立即失效。
      if (this.states.get(state.saved.id) !== state || !state.entries.has(id)) throw new Error('来源已删除或断开，旧的正文请求已取消')
      if (parsed.session.source !== state.saved.source) throw new Error('文件内容与选择的来源不匹配')
      entry.summary.availability = 'readable'; delete entry.summary.reason
      const title = state.saved.source === 'claude-code' || state.saved.source === 'codex'
        ? entry.summary.title !== basename(entry.path) ? entry.summary.title : parsed.resolvedTitle || entry.summary.title
        : parsed.session.title
      // 只用真实首问补齐文件名，不让内部 ID 兜底回写；已有标题和原始文件不变。
      entry.summary.title = title
      return { revision: contentRevision, ...(parsed.presentation ? { presentation: parsed.presentation } : {}), ...(parsed.window ? { window: parsed.window } : {}), session: { ...parsed.session, title, id, archive: undefined }, warnings: [
        '正文直接读取来源，仅在当前窗口内存中展示；没有导入、备份或复制原件。以下解析说明中的原件均指来源自身文件。',
        ...(state.saved.source === 'newmax' ? ['仅核对与既有 NewMax 1.1.22 白名单读取契约相容的数据库结构；未探测安装版本，不支持写入或原生恢复。'] : []),
        ...parsed.warnings,
      ] }
    } catch (error) {
      if (this.states.get(state.saved.id) === state && state.entries.get(id) === entry) {
        entry.summary.availability = error instanceof UnsupportedContent ? 'unsupported' : 'unreadable'; entry.summary.reason = failure(error)
        if (error instanceof UnsupportedContent) {
          state.view.discovered = visibleCount(state.entries)
          if (state.view.status === 'ready') state.view.total = state.view.discovered
          this.version += 1
        }
      }
      throw new Error(failure(error))
    }
  }
  private async readCindy(entry: Entry, cursor: SourceReadCursor, onRead: (revision: string) => void) {
    const projection = await readSourceDatabase(entry.path, 'cindy', entry.rowId!, cursor)
    const row = projection.session
    if (!row) throw new Error('来源会话已删除，请刷新')
    if (row.readable !== 1) throw new UnsupportedContent('仅支持普通桌面会话；当前会话涉及分叉、协作、远程、隐藏或非活动边界，未读取正文')
    const { messages, window } = sourceReadWindow(projection, cursor)
    if (!window.totalMessages) throw new Error('来源没有可显示的当前用户或助手文本')
    onRead(revision({ id: row.id, title: row.title, updated_at: row.updated_at, readable: row.readable }))
    const parsed = parseCindyLocal({ format: 'pinekin.cindy-local-snapshot', version: 1, sourceVersion: CINDY_SOURCE_SCHEMA,
      session: { id: row.id, title: row.title, source: row.source, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
        parentSessionId: row.parent_session_id, remoteHostId: row.remote_host_id, orcaRole: row.orca_role, clearedAt: row.cleared_at },
      messages: messages.map(message => ({ id: message.id, role: message.role, content: message.content, createdAt: message.created_at, rewindAt: message.rewind_at })) }, true)
    return { ...parsed, window, sourceName: 'Cindy · 来源直读', session: { ...parsed.session, tags: ['Cindy', '来源直读', '文本投影'] }, warnings: [
      '依据已核对的 Cindy 0.1.110 字段结构检查，未根据数据库声称当前客户端版本；不写入或原生恢复。',
      '仅在同一只读事务中投影选定普通桌面会话的当前用户与助手文本；清空前、已回退、推理和工具记录不读取到正文。',
      '按 created_at + rowid 保持同时间消息的原始顺序；用户对象在切片前只提取 text，不访问图片、附件、配置或凭据。',
      '当前为有界阅读片段，长消息与后续消息可继续按段读取；原始消息数包含空白或未映射的用户内容。',
      '未落盘保存快照，也未复制数据库；分叉、协作和远程会话仍不支持。',
    ] }
  }
  private async readNewMax(entry: Entry, cursor: SourceReadCursor, onRead: (revision: string) => void) {
    const projection = await readSourceDatabase(entry.path, 'newmax', entry.rowId!, cursor)
    const row = projection.session
    if (!row) throw new Error('来源会话已删除，请刷新')
    onRead(revision(row))
    if (row.source !== 'app' || row.is_private || row.forked_from_id != null) throw new UnsupportedContent('会话已变为隐私、分叉或非普通会话，请刷新')
    const { messages, window } = sourceReadWindow(projection, cursor)
    if (Number(row.message_count) !== window.totalMessages) throw new Error('来源消息数不一致，请刷新')
    if (messages.some(message => message.consistent !== 1)) throw new Error('来源消息列不一致，拒绝不完整投影')
    const parsed = parseNewMaxLocal({ format: 'pinekin.newmax-local-snapshot', version: 1, sourceVersion: '1.1.22',
      session: { id: row.id, title: row.title, source: row.source, createdAt: row.created_at, updatedAt: row.updated_at,
        forkedFromConversationId: row.forked_from_id, isPrivate: false, messageCount: row.message_count },
      messages: messages.map(message => ({ seq: message.seq, id: message.id, role: message.role, content: message.content, timestamp: message.timestamp,
        internal: message.internal === 1 })) }, true)
    return { ...parsed, window }
  }
}
