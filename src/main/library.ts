import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { demoSessions } from '../core/demo'
import { parseBundle, sessionSchema } from '../core/session'
import type { Session } from '../core/types'

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
  async list(): Promise<Session[]> {
    return [...await this.read(), ...demoSessions]
  }
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
