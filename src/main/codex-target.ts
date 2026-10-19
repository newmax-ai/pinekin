import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { entryIdSchema } from '../core/sources'
import type { CodexTransferResult } from '../core/source-actions'
import { buildCodexRollout, verifyCodexThread } from './codex-target-format'
import { codexVersion, readCodexThread } from './codex-target-runtime'
import { checkCodexProject, type CodexProject } from './codex-project'
import type { SourceTransfer } from './source-transfer'

const configSchema = z.strictObject({ binary: z.string().min(1).max(4096), home: z.string().min(1).max(4096) })
const receiptSchema = z.strictObject({ id: z.uuid(), threadId: z.uuid(), path: z.string().max(4096), home: z.string().max(4096),
  digest: z.string().regex(/^[a-f0-9]{64}$/), version: z.string(), messageCount: z.number().int().positive(), state: z.enum(['prepared', 'created', 'rolled-back']) })
type Receipt = z.infer<typeof receiptSchema>
interface Dependencies {
  version(binary: string, root: string): Promise<string>
  verify(binary: string, root: string, id: string, transfer: SourceTransfer, cwd?: string): Promise<void>
  handler(url: string): Promise<string>
  openExternal(url: string): Promise<void>
  applicationBinary?(): Promise<string>
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function within(root: string, path: string) { const part = relative(root, path); return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part) }
async function ordinary(path: string, directory: boolean) {
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || await realpath(path) !== path) throw new Error('目标位置包含符号链接或已越出授权位置。')
  return stat
}
async function bounded(path: string) {
  const before = await ordinary(path, false)
  if (before.size > 96 * 1024 * 1024) throw new Error('目标文件超过核验上限，不自动修改。')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (stat.ino !== before.ino || stat.dev !== before.dev) throw new Error('目标文件已变化。')
    const text = await file.readFile('utf8'), after = await file.stat()
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error('目标文件正在变化，请稍后重试。')
    return text
  } finally { await file.close() }
}
async function optionalJson(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await bounded(path)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
async function save(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
  try { await rename(temporary, path) } finally { await rm(temporary, { force: true }) }
}
async function ensureDirectories(root: string, parts: string[]) {
  await ordinary(root, true)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    try { await mkdir(current, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await ordinary(current, true)
  }
  return current
}

/** 目标目录只在用户通过本机选择器授权后使用；永不修改目标数据库或旧会话。 */
export class CodexTarget {
  private busy = false
  private readonly store: string
  constructor(private readonly data: string, private readonly deps: Dependencies) { this.store = join(data, 'codex-transfers') }
  static create(data: string, system: Pick<Dependencies, 'handler' | 'openExternal' | 'applicationBinary'>) {
    return new CodexTarget(data, { ...system, version: codexVersion,
      verify: async (binary, root, id, transfer, cwd) => { verifyCodexThread(await readCodexThread(binary, root, id), id, transfer.messages, cwd) } })
  }
  private async checkApplication(binary: string) {
    if (this.deps.applicationBinary && await this.deps.applicationBinary() !== binary) throw new Error('验证程序与系统关联的 Codex 不是同一个版本位置，请重新选择当前关联的 Codex.app。')
  }
  private async init() {
    await mkdir(this.data, { recursive: true, mode: 0o700 })
    await ensureDirectories(this.data, ['codex-transfers', 'index'])
  }
  async configured() { return !!configSchema.safeParse(await optionalJson(join(this.data, 'codex-target.json'))).success }
  async configuration() {
    const value = await optionalJson(join(this.data, 'codex-target.json'))
    return value === undefined ? undefined : configSchema.parse(value)
  }
  async configure(binary: string, home: string, assertAllowed = () => {}) {
    if (this.busy) throw new Error('正在处理接续，请稍候再更换目标。')
    this.busy = true
    try {
      const config = configSchema.parse({ binary, home })
      await ordinary(config.binary, false); await ordinary(config.home, true)
      await this.checkApplication(config.binary)
      if (home === this.data || within(home, this.data) || within(this.data, home)) throw new Error('目标位置不能与 Pinekin 数据目录重叠。')
      await this.init()
      const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-codex-probe-')))
      try { await this.deps.version(binary, root) } finally { await rm(root, { recursive: true, force: true }) }
      assertAllowed()
      await save(join(this.data, 'codex-target.json'), config)
    } finally { this.busy = false }
  }
  private async requestOpen(receipt: Receipt, status: 'created' | 'existing'): Promise<CodexTransferResult> {
    const result = { status, receipt: receipt.id, threadId: receipt.threadId, app: 'Codex' as const, messageCount: receipt.messageCount }
    try { await this.deps.openExternal(`codex://threads/${receipt.threadId}`); return { ...result, opened: true } }
    catch (error) { return { ...result, opened: false, error: error instanceof Error ? error.message : '系统未能打开 Codex' } }
  }
  async continue(rawId: string, transfer: SourceTransfer, assertAllowed: () => void | Promise<void> = () => {}, project?: CodexProject): Promise<CodexTransferResult> {
    entryIdSchema.parse(rawId)
    if (this.busy) throw new Error('正在创建接续会话，请稍候。')
    this.busy = true
    let scratch: string | undefined
    const validate = async () => { await assertAllowed(); if (project) await checkCodexProject(project) }
    try {
      await validate()
      const config = configSchema.parse(await optionalJson(join(this.data, 'codex-target.json')))
      await ordinary(config.home, true)
      const binaryStamp = await ordinary(config.binary, false)
      await this.checkApplication(config.binary)
      if (!/^codex$/i.test((await this.deps.handler('codex://')).trim())) throw new Error('未找到 Codex 的系统打开协议，请先安装并打开一次 Codex。')
      await this.init()
      // 独立会话沿用旧索引；项目路径与目录身份纳入去重，不能把会话打开到另一个项目。
      const key = hash(JSON.stringify([rawId, transfer.snapshot, transfer.messages, config.home, ...(project ? [project.path, project.dev, project.ino] : [])]))
      const indexPath = join(this.store, 'index', key + '.json')
      const indexed = await optionalJson(indexPath)
      if (indexed !== undefined) {
        const previousId = z.uuid().parse(indexed)
        const receipt = receiptSchema.parse(await optionalJson(join(this.store, previousId, 'receipt.json')))
        if (receipt.state !== 'rolled-back') {
          this.checkReceipt(receipt, config.home)
          try {
            const text = await bounded(receipt.path), meta = JSON.parse(text.slice(0, text.indexOf('\n')))
            if (meta.type !== 'session_meta' || meta.payload?.id !== receipt.threadId) throw new Error('目标会话身份已变化，不能覆盖或自动打开。')
            if (project && meta.payload.cwd !== project.path) throw new Error('目标会话的工作目录已变化，不能自动打开到其他项目。')
            if (receipt.state === 'prepared' && hash(text) !== receipt.digest) throw new Error('上次创建未完成且目标已变化，请人工检查。')
            await validate()
            return await this.requestOpen(receipt, 'existing')
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
      }
      scratch = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-codex-transfer-')))
      const version = await this.deps.version(config.binary, scratch)
      const id = randomUUID(), threadId = randomUUID(), timestamp = new Date().toISOString()
      const parts = ['sessions', ...timestamp.slice(0, 10).split('-')]
      const filename = `rollout-${timestamp.slice(0, 19).replace(/:/g, '-')}-${threadId}.jsonl`
      const transaction = await ensureDirectories(this.store, [id])
      // 只有用户明确选择项目才设置该目录；否则使用独立空目录，不继承来源工作区或指令。
      const workspace = project?.path ?? await ensureDirectories(transaction, ['workspace'])
      const text = buildCodexRollout({ id: threadId, title: transfer.title, cwd: workspace, timestamp, version, messages: transfer.messages })
      await writeFile(join(transaction, 'backup.jsonl'), text, { flag: 'wx', mode: 0o600 })
      const staged = join(scratch, 'codex', ...parts)
      await mkdir(staged, { recursive: true, mode: 0o700 })
      await writeFile(join(staged, filename), text, { flag: 'wx', mode: 0o600 })
      // 项目模式额外核对目标实际回读的 cwd；沙箱不授予项目文件访问，也不读取真实配置或凭据。
      await this.deps.verify(config.binary, scratch, threadId, transfer, project?.path)
      await this.checkApplication(config.binary)
      const currentBinary = await ordinary(config.binary, false)
      if (currentBinary.ino !== binaryStamp.ino || currentBinary.dev !== binaryStamp.dev || currentBinary.mtimeMs !== binaryStamp.mtimeMs || currentBinary.ctimeMs !== binaryStamp.ctimeMs) throw new Error('Codex 程序已更新，请重新接续以验证新版本。')
      await validate()
      const directory = await ensureDirectories(config.home, parts), destination = join(directory, filename)
      const receipt: Receipt = { id, threadId, home: config.home, path: destination, digest: hash(text), version, messageCount: transfer.messages.length, state: 'prepared' }
      await save(join(transaction, 'receipt.json'), receipt)
      await save(indexPath, id)
      const temporary = join(directory, `.pinekin-${id}.part`)
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() }
      let published = false
      try {
        await validate(); await ordinary(directory, true)
        await link(temporary, destination); published = true
        if (hash(await bounded(destination)) !== receipt.digest) throw new Error('目标写入后核验不一致。')
        await validate()
        receipt.state = 'created'; await save(join(transaction, 'receipt.json'), receipt)
      } catch (error) {
        if (published && hash(await bounded(destination)) === receipt.digest) await unlink(destination)
        throw error
      } finally { await rm(temporary, { force: true }) }
      return await this.requestOpen(receipt, 'created')
    } finally {
      this.busy = false
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {})
    }
  }
  private checkReceipt(receipt: Receipt, home: string) {
    if (receipt.home !== home || !within(join(home, 'sessions'), receipt.path) || !receipt.path.endsWith(`-${receipt.threadId}.jsonl`)) throw new Error('接续记录与当前授权目标不一致。')
  }
  async rollback(rawId: string, assertAllowed = () => {}) {
    const id = z.uuid().parse(rawId)
    if (this.busy) throw new Error('正在处理接续，请稍候。')
    this.busy = true
    try {
      assertAllowed()
      const config = configSchema.parse(await optionalJson(join(this.data, 'codex-target.json')))
      const path = join(this.store, id, 'receipt.json'), receipt = receiptSchema.parse(await optionalJson(path))
      this.checkReceipt(receipt, config.home)
      if (receipt.state === 'rolled-back') return
      await ordinary(config.home, true)
      if (hash(await bounded(receipt.path)) !== receipt.digest) throw new Error('目标会话已变化，可能已继续对话；为保留新内容，不自动撤销。')
      assertAllowed()
      await unlink(receipt.path)
      receipt.state = 'rolled-back'; await save(path, receipt)
    } finally { this.busy = false }
  }
}
