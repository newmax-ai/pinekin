import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join, isAbsolute } from 'node:path'
import { z } from 'zod'
import type { CodexProjectList, CodexProjectPreview, CodexSetupMode, NativeTargetPreview, NativeTransferResult } from '../core/source-actions'
import type { SourceTransfer } from './source-transfer'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const digest = (messages: SourceTransfer['messages']) => hash(messages.map(({ role, content }) => ({ role, content })))
const TTL = 300_000, MAX_WIRE = 64 * 1024 * 1024
const descriptorSchema = z.strictObject({ protocol: z.literal('newmax.native-transfer'), version: z.literal(1), appVersion: z.string().min(1).max(80),
  dataPath: z.string().max(4096), socketPath: z.string().max(4096), token: z.string().regex(/^[a-f0-9]{64}$/), instanceId: z.uuid() })
type Endpoint = z.infer<typeof descriptorSchema>
const configSchema = z.strictObject({ version: z.literal(1), dataPath: z.string().max(4096) })
const readSchema = z.object({ receipt: z.uuid(), conversationId: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  messageCount: z.number().int().positive().max(100_000), workspaceId: z.string().min(1).max(512) })
const previewSchema = readSchema.extend({ token: z.uuid() })
const recordSchema = z.object({ requestId: z.uuid(), dataPath: z.string().max(4096), key: z.string().regex(/^[a-f0-9]{64}$/) })
type Record = z.infer<typeof recordSchema>
type Project = { entryId: string; endpoint: Endpoint; serverToken: string; path: string; name: string; expires: number }
async function optionalJson(path: string): Promise<unknown | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { if ((await file.stat()).size > 1024 * 1024) throw new Error('接续配置超过大小上限'); return JSON.parse(await file.readFile('utf8')) }
    finally { await file.close() }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
async function save(path: string, value: unknown) {
  const directory = join(path, '..'); await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temporary, path)
}
/** 只连接同用户私有 Unix socket，不支持 TCP、任意 URL、命令或数据库写入。 */
async function endpointAt(root: string): Promise<Endpoint> {
  if (process.platform === 'win32') throw new Error('当前平台尚未支持 NewMax 正式接续协议')
  const canonical = await realpath(root), path = join(canonical, 'native-transfer.json')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 16 * 1024 || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) throw new Error('NewMax 端点文件权限不安全')
    const parsed = descriptorSchema.safeParse(JSON.parse(await file.readFile('utf8')))
    if (!parsed.success) throw new Error('NewMax 端点协议或版本不支持，请更新目标 App')
    const endpoint = parsed.data
    if (endpoint.dataPath !== canonical || !isAbsolute(endpoint.socketPath)) throw new Error('NewMax 端点与所选数据位置不一致')
    const socket = await lstat(endpoint.socketPath), parent = await lstat(join(endpoint.socketPath, '..'))
    if (!socket.isSocket() || socket.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink()
      || (socket.mode & 0o077) !== 0 || (parent.mode & 0o077) !== 0
      || process.getuid && (socket.uid !== process.getuid() || parent.uid !== process.getuid())) throw new Error('NewMax 本机端点权限不安全')
    return endpoint
  } finally { await file.close() }
}
export async function requestNewMax(endpoint: Endpoint, body: unknown): Promise<unknown> {
  const wire = JSON.stringify({ token: endpoint.token, instanceId: endpoint.instanceId, body }) + '\n'
  if (Buffer.byteLength(wire) > MAX_WIRE) throw new Error('NewMax 接续请求超过传输上限，未截断或提交')
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint.socketPath); let bytes = 0; const chunks: Buffer[] = []
    socket.setTimeout(180_000, () => socket.destroy(new Error('NewMax 正式接口超时；重试会核对原回执，不会重复创建')))
    socket.on('connect', () => socket.write(wire))
    socket.on('error', reject)
    socket.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) { socket.destroy(new Error('NewMax 正式接口响应超过大小上限')); return }
      chunks.push(chunk)
    })
    socket.on('end', () => {
      try {
        const response = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), result: z.unknown() }), z.object({ ok: z.literal(false), error: z.string().max(4096) })])
          .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        if (!response.ok) throw new Error(response.error)
        resolve(response.result)
      } catch (error) { reject(error) }
    })
  })
}
async function probe(root: string) {
  const endpoint = await endpointAt(root)
  const result = z.object({ protocol: z.literal('newmax.native-transfer'), version: z.literal(1), appVersion: z.string(), dataPath: z.string(),
    historyMode: z.literal('text-history'), runtimeResume: z.literal(false), arbitraryDirectories: z.literal(false), features: z.array(z.string()) })
    .parse(await requestNewMax(endpoint, { action: 'capabilities' }))
  if (result.dataPath !== endpoint.dataPath || result.appVersion !== endpoint.appVersion
    || ['preview', 'backup', 'commit', 'read', 'rollback', 'open', 'workspaces'].some(feature => !result.features.includes(feature))) throw new Error('NewMax 正式接口缺少所需能力或身份不一致')
  return endpoint
}
function sameEndpoint(left: Endpoint, right: Endpoint) {
  if (left.instanceId !== right.instanceId || left.dataPath !== right.dataPath || left.socketPath !== right.socketPath || left.token !== right.token) throw new Error('NewMax 运行实例已变化，请重新选择并预演')
}

export class NewMaxTarget {
  private readonly candidates = new Map<string, { endpoint: Endpoint; expires: number }>()
  private readonly projects = new Map<string, Project>()
  private working = false
  constructor(private readonly options: { storePath: string; defaultDataPath: string; chooseDirectory(): Promise<string | null>; now?: () => number }) {}
  private now() { return this.options.now?.() ?? Date.now() }
  private get configPath() { return join(this.options.storePath, 'newmax-target.json') }
  private async configuration() { const raw = await optionalJson(this.configPath); return raw === undefined ? undefined : configSchema.parse(raw) }
  async configured() {
    const config = await this.configuration(); if (!config) return false
    try { await probe(config.dataPath); return true } catch { return false }
  }
  private async selected() {
    const config = await this.configuration()
    if (!config) throw new Error('请先确认 NewMax 接续目标位置')
    return probe(config.dataPath)
  }
  async inspect(mode: CodexSetupMode, assertAllowed = () => {}): Promise<NativeTargetPreview | null> {
    assertAllowed()
    if (mode === 'application') throw new Error('NewMax 接续只使用正式本机接口，请选择目标数据目录')
    const saved = await this.configuration(); assertAllowed()
    const chosen = mode === 'directory' ? await this.options.chooseDirectory() : saved?.dataPath ?? this.options.defaultDataPath
    assertAllowed(); if (!chosen) return null
    const base: NativeTargetPreview = { app: 'NewMax', dataPath: chosen, configured: false, canChooseApplication: false,
      locationSource: mode === 'directory' ? 'custom' : saved ? 'saved' : 'default' }
    let endpoint: Endpoint
    try { endpoint = await probe(chosen) }
    catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) return { ...base,
        reason: '该位置没有已就绪的 NewMax 正式接续接口。请使用支持此协议的版本，并确认数据目录。' }
      throw error
    }
    assertAllowed()
    for (const [id, candidate] of this.candidates) if (candidate.expires < this.now()) this.candidates.delete(id)
    if (this.candidates.size >= 32) this.candidates.clear()
    const token = randomUUID(); this.candidates.set(token, { endpoint, expires: this.now() + TTL })
    return { ...base, dataPath: endpoint.dataPath, configured: saved?.dataPath === endpoint.dataPath, token }
  }
  async configure(token: string, assertAllowed = () => {}) {
    assertAllowed(); const candidate = this.candidates.get(z.uuid().parse(token))
    if (!candidate || candidate.expires < this.now()) throw new Error('NewMax 目标选择已过期')
    const current = await probe(candidate.endpoint.dataPath); assertAllowed(); sameEndpoint(candidate.endpoint, current)
    await save(this.configPath, { version: 1, dataPath: current.dataPath }); assertAllowed()
    return true
  }
  async listProjects(entryId: string, assertAllowed = () => {}): Promise<CodexProjectList> {
    assertAllowed()
    const root = (await this.configuration())?.dataPath ?? this.options.defaultDataPath
    const endpoint = await probe(root); assertAllowed()
    const result = z.object({ projects: z.array(z.strictObject({ token: z.uuid(), name: z.string().max(512), path: z.string().max(4096) })).max(1000) })
      .parse(await requestNewMax(endpoint, { action: 'workspaces' })); assertAllowed()
    for (const [id, project] of this.projects) if (project.expires < this.now() || project.entryId === entryId) this.projects.delete(id)
    if (this.projects.size + result.projects.length > 2000) this.projects.clear()
    return { projects: result.projects.map(project => {
      const id = randomUUID(); this.projects.set(id, { entryId, endpoint, serverToken: project.token, path: project.path, name: project.name, expires: this.now() + TTL })
      return { id, name: project.name, path: project.path }
    }), warning: '仅列出 NewMax 已有工作区；不新建目录，不导入工具执行状态。' }
  }
  async chooseProject(entryId: string, id: string | undefined, assertAllowed = () => {}): Promise<CodexProjectPreview | null> {
    assertAllowed()
    if (!id) throw new Error('请在 NewMax 中创建工作区后，选择已有工作区')
    const project = this.projects.get(z.uuid().parse(id))
    if (!project || project.entryId !== entryId || project.expires < this.now()) throw new Error('NewMax 工作区选择已过期')
    const endpoint = await probe(project.endpoint.dataPath); assertAllowed(); sameEndpoint(project.endpoint, endpoint)
    return { token: id, name: project.name, path: project.path }
  }
  async continue(entryId: string, transfer: SourceTransfer, assertSource: () => Promise<void>, projectToken?: string, assertAllowed = () => {}): Promise<NativeTransferResult> {
    if (this.working) throw new Error('已有 NewMax 接续正在处理，请稍候')
    this.working = true
    try {
      assertAllowed(); const endpoint = await this.selected(); assertAllowed(); await assertSource()
      const project = projectToken ? this.projects.get(z.uuid().parse(projectToken)) : undefined
      if (projectToken && (!project || project.entryId !== entryId || project.expires < this.now())) throw new Error('NewMax 工作区选择已过期或不属于当前会话')
      if (project) sameEndpoint(project.endpoint, endpoint)
      const messages = transfer.messages.map(({ role, content }) => ({ role, content }))
      if (!messages.length || messages.length > 100_000 || messages.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0) > 32 * 1024 * 1024) throw new Error('会话超过 NewMax 接续上限，未截断或提交')
      const key = hash({ entryId, source: transfer.source, snapshot: transfer.snapshot, title: transfer.title, messages,
        dataPath: endpoint.dataPath, destination: project ? { path: project.path, name: project.name } : 'standalone' })
      const indexPath = join(this.options.storePath, 'newmax-transfers', `${key}.json`)
      const previous = await optionalJson(indexPath)
      const record: Record = previous ? recordSchema.parse(previous) : { key, requestId: randomUUID(), dataPath: endpoint.dataPath }
      if (record.key !== key || record.dataPath !== endpoint.dataPath) throw new Error('NewMax 接续回执配置冲突')
      // 提交前持久化幂等身份；断线或超时后的重试仍提交相同请求 ID。
      assertAllowed(); await save(indexPath, record)
      const plan = previewSchema.parse(await requestNewMax(endpoint, { action: 'preview', transfer: {
        requestId: record.requestId, source: transfer.source, sourceEntryId: entryId, title: transfer.title, messages,
        destination: project ? { kind: 'workspace', token: project.serverToken } : { kind: 'standalone' },
      } })); assertAllowed()
      const check = (result: z.infer<typeof readSchema>) => {
        if (result.receipt !== record.requestId || result.digest !== digest(messages) || result.messageCount !== messages.length
          || result.conversationId !== plan.conversationId || result.workspaceId !== plan.workspaceId) throw new Error('NewMax 预演或持久化回读与来源不一致')
      }
      check(plan)
      await assertSource(); assertAllowed(); sameEndpoint(endpoint, await this.selected()); assertAllowed()
      const committed = readSchema.extend({ status: z.enum(['created', 'existing']) }).parse(await requestNewMax(endpoint, { action: 'commit', token: plan.token })); assertAllowed(); check(committed)
      await save(join(this.options.storePath, 'newmax-transfer-receipts', `${record.requestId}.json`), record)
      const read = readSchema.parse(await requestNewMax(endpoint, { action: 'read', receipt: record.requestId })); check(read)
      await assertSource(); assertAllowed(); sameEndpoint(endpoint, await this.selected()); assertAllowed()
      let opened: { opened: boolean; error?: string }
      try { opened = z.object({ opened: z.boolean(), error: z.string().max(4096).optional() }).parse(await requestNewMax(endpoint, { action: 'open', receipt: record.requestId })); assertAllowed() }
      catch (error) { opened = { opened: false, error: error instanceof Error ? error.message : '目标打开失败' } }
      return { app: 'NewMax', status: committed.status, receipt: record.requestId, threadId: committed.conversationId, messageCount: committed.messageCount, ...opened }
    } finally { this.working = false }
  }
  async rollback(receipt: string, assertAllowed = () => {}) {
    assertAllowed()
    const raw = await optionalJson(join(this.options.storePath, 'newmax-transfer-receipts', `${z.uuid().parse(receipt)}.json`))
    if (!raw) throw new Error('未找到本机 NewMax 接续回执')
    const record = recordSchema.parse(raw), endpoint = await this.selected(); assertAllowed()
    if (record.requestId !== receipt || endpoint.dataPath !== record.dataPath) throw new Error('回执不属于当前 NewMax 目标')
    const result = z.object({ rolledBack: z.literal(true) }).parse(await requestNewMax(endpoint, { action: 'rollback', receipt })); assertAllowed()
    return result
  }
}
