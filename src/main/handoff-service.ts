import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { entryIdSchema } from '../core/sources'
import { buildHandoff, handoffActionSchema, type HandoffDelivery, type HandoffInput, type PreparedHandoff } from '../core/handoff'

interface Dependencies {
  getEntry(id: string): Promise<unknown>
  transfer(id: string, assertAllowed: () => void): Promise<HandoffInput>
  copyFile(text: string, assertAllowed: () => Promise<void>): Promise<void>
  save(text: string, assertAllowed: () => Promise<void>): Promise<boolean>
  now?(): number
}
interface Draft { id: string; text: string; created: number }
const lifetime = 5 * 60_000

/** 令牌只暂存内存；复制成功的文件由文件存储管理，不随令牌释放而失效。 */
export class HandoffService {
  private drafts = new Map<string, Draft>()
  private generation = 0
  private preparing = false
  private delivering = false
  constructor(private readonly deps: Dependencies) {}
  private now() { return (this.deps.now ?? Date.now)() }
  clear() { this.generation++; this.drafts.clear() }
  discard(rawToken: unknown) { this.drafts.delete(z.uuid().parse(rawToken)) }
  private prune() {
    for (const [token, draft] of this.drafts) if (this.now() - draft.created >= lifetime) this.drafts.delete(token)
  }
  private async authorized(id: string, guard: () => void) {
    guard()
    await this.deps.getEntry(id)
    guard()
  }
  async prepare(rawId: unknown, assertAllowed = () => {}): Promise<PreparedHandoff> {
    const id = entryIdSchema.parse(rawId)
    if (this.preparing || this.delivering) throw new Error('正在准备或交付接续文件，请稍候。')
    this.preparing = true
    const generation = this.generation
    const guard = () => { assertAllowed(); if (generation !== this.generation) throw new Error('页面已变化，请重试。') }
    try {
      this.prune()
      await this.authorized(id, guard)
      const input = await this.deps.transfer(id, guard)
      await this.authorized(id, guard)
      const created = this.now()
      const result = buildHandoff(input, { entryId: id, createdAt: new Date(created).toISOString() })
      const token = randomUUID()
      this.drafts.clear()
      this.drafts.set(token, { id, text: result.text, created })
      return { token }
    } finally { this.preparing = false }
  }
  private draft(token: string) {
    this.prune()
    const draft = this.drafts.get(token)
    if (!draft) throw new Error('接续文件已失效或过期，请重试。')
    return draft
  }
  async deliver(rawToken: unknown, rawAction: unknown, assertAllowed = () => {}): Promise<HandoffDelivery> {
    const token = z.uuid().parse(rawToken), action = handoffActionSchema.parse(rawAction)
    if (this.delivering || this.preparing) throw new Error('正在准备或交付接续文件，请稍候。')
    const draft = this.draft(token)
    this.delivering = true
    const guard = () => { assertAllowed(); this.draft(token) }
    const authorized = async () => { await this.authorized(draft.id, guard); guard() }
    try {
      await authorized()
      if (action === 'export') {
        const saved = await this.deps.save(draft.text, authorized)
        return { status: saved ? 'exported' : 'cancelled' }
      }
      await this.deps.copyFile(draft.text, authorized)
      return { status: 'file-copied' }
    } finally { this.delivering = false }
  }
}
