import { readFile, writeFile, rename, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { parseBundle, sessionSchema } from '../core/session'
import type { ImportResult, ParsedArchive, Session } from '../core/types'

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const recordSchema = z.strictObject({ version: z.literal(1), session: sessionSchema })
export class Library {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly directory: string) {}
  private async read(): Promise<Session[]> {
    try {
      return z.array(sessionSchema).parse(JSON.parse(await readFile(join(this.directory, 'library.json'), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('本地档案无法读取，请保留 library.json 并检查文件；未覆盖原文件。', { cause: error })
    }
  }
  private async readImports(): Promise<Session[]> {
    const root = join(this.directory, 'imports')
    let entries
    try { entries = await readdir(root, { withFileTypes: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    try {
      const sessions: Session[] = []
      for (const entry of entries) {
        // 临时目录不是已提交档案；不遍历非散列名称或符号链接。
        if (!/^[a-f0-9]{64}$/.test(entry.name)) continue
        if (!entry.isDirectory()) throw new Error('归档目录无效')
        const { session } = recordSchema.parse(JSON.parse(await readFile(join(root, entry.name, 'record.json'), 'utf8')))
        if (session.demo || session.archive?.sha256 !== entry.name) throw new Error('归档来源不一致')
        sessions.push(session)
      }
      return sessions.sort((a, b) => b.archive!.importedAt.localeCompare(a.archive!.importedAt))
    } catch (error) {
      throw new Error('本地导入档案无法读取，请保留 imports 目录；未覆盖原文件。', { cause: error })
    }
  }
  async list(): Promise<Session[]> {
    // 兼容旧记录的 demo 字段，但不展示演示档案，也不改写用户原库。
    return [...await this.readImports(), ...await this.read()].filter(session => !session.demo)
  }
  async findImport(sha256: string): Promise<Session | undefined> {
    digestSchema.parse(sha256)
    await this.read()
    const session = (await this.readImports()).find(item => item.archive!.sha256 === sha256)
    if (session) {
      const bytes = await readFile(join(this.directory, 'imports', sha256, 'original.bin'))
      if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('归档原件校验失败，未覆盖已有档案')
    }
    return session
  }
  async importArchive(bytes: Buffer, parsed: ParsedArchive, sha256: string): Promise<ImportResult> {
    digestSchema.parse(sha256)
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('导入快照校验失败')
    const task = this.queue.then(async () => {
      const duplicate = await this.findImport(sha256)
      if (duplicate) return { session: duplicate, duplicate: true }
      const session = sessionSchema.parse({ ...parsed.session, id: randomUUID(), demo: false,
        archive: { adapterId: parsed.adapterId, adapterVersion: parsed.adapterVersion, sha256,
          importedAt: new Date().toISOString(), originalSessionId: parsed.originalSessionId === undefined ? parsed.session.id : parsed.originalSessionId,
          sourceVersion: parsed.sourceVersion, fidelity: 'text-only', warnings: parsed.warnings } })
      const root = join(this.directory, 'imports')
      await mkdir(root, { recursive: true, mode: 0o700 })
      const staging = join(root, `.pending-${randomUUID()}`)
      await mkdir(staging, { mode: 0o700 })
      try {
        await writeFile(join(staging, 'original.bin'), bytes, { mode: 0o600, flag: 'wx' })
        await writeFile(join(staging, 'record.json'), JSON.stringify({ version: 1, session }), { mode: 0o600, flag: 'wx' })
        await rename(staging, join(root, sha256))
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      return { session, duplicate: false }
    })
    this.queue = task.catch(() => undefined)
    return task
  }
  // 保留旧的内部入口；桌面新导入统一使用预览与确认流程。
  async importText(text: string): Promise<Session> {
    const source = parseBundle(text).session
    const task = this.queue.then(async () => {
      const sessions = await this.read()
      const imported = { ...source, id: randomUUID(), demo: false }
      await mkdir(this.directory, { recursive: true })
      const temporary = join(this.directory, 'library.json.tmp')
      await writeFile(temporary, JSON.stringify([imported, ...sessions], null, 2), { mode: 0o600 })
      await rename(temporary, join(this.directory, 'library.json'))
      return imported
    })
    this.queue = task.catch(() => undefined)
    return task
  }
}
