import { entryIdSchema, sourceNames, type SourceEntry } from '../core/sources'
import type { SourceActionAvailability, SourceActionCapabilities } from '../core/source-actions'

interface Dependencies {
  getEntry(id: string): Promise<SourceEntry>
  handler(url: string): Promise<string>
  openExternal(url: string): Promise<void>
  targets?(): Promise<SourceActionCapabilities['targets']>
}
function originalRoute(entry: SourceEntry): { url?: string; state: SourceActionAvailability } {
  const app = sourceNames[entry.source]
  const unavailable = (reason: string) => ({ state: { app, available: false, reason } })
  if (entry.source !== 'newmax' && entry.source !== 'codex') return unavailable('此来源的原会话打开方式尚未验证。')
  if (entry.availability === 'unsupported' || entry.kind && entry.kind !== 'conversation') return unavailable('此记录不是可定位的普通主会话。')
  const validId = entry.source === 'codex' ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i : /^[a-zA-Z0-9_-]{1,128}$/
  if (!entry.sourceSessionId || !validId.test(entry.sourceSessionId)) return unavailable('缺少可验证的原会话标识，不能猜测打开位置。')
  const url = entry.source === 'codex' ? `codex://threads/${entry.sourceSessionId}` : `newmax://open?conversation=${encodeURIComponent(entry.sourceSessionId)}`
  return { url, state: { app, available: true } }
}

/** 固定协议和固定路由；renderer 只能提供已授权目录中的 opaque ID。 */
export class SourceActions {
  private opening = new Set<string>()
  constructor(private readonly deps: Dependencies) {}
  private async inspectOriginal(entry: SourceEntry) {
    const route = originalRoute(entry)
    if (!route.url) return route
    try {
      const handler = await this.deps.handler(route.url)
      const expected = entry.source === 'codex' ? /^codex$/i : /^newmax(?:\s+ai)?$/i
      if (!expected.test(handler.trim())) return { state: { ...route.state, available: false, reason: `未找到已关联此协议的 ${route.state.app} 客户端。` } }
      return route
    } catch {
      return { state: { ...route.state, available: false, reason: `无法检查 ${route.state.app} 打开方式，请稍后重试。` } }
    }
  }
  async inspect(rawId: string): Promise<SourceActionCapabilities> {
    const entry = await this.deps.getEntry(entryIdSchema.parse(rawId))
    const { state } = await this.inspectOriginal(entry)
    return { original: state, targets: await this.deps.targets?.() ?? [] }
  }
  async openOriginal(rawId: string, assertAllowed = () => {}): Promise<{ status: 'requested'; app: string }> {
    const id = entryIdSchema.parse(rawId)
    if (this.opening.has(id)) throw new Error('正在打开此会话，请稍候。')
    this.opening.add(id)
    try {
      assertAllowed()
      const entry = await this.deps.getEntry(id)
      const route = await this.inspectOriginal(entry)
      if (!route.state.available || !route.url) throw new Error(route.state.reason)
      // OS 协议检查之后再确认授权和元数据；不沿正文中的路径或链接导航。
      const current = originalRoute(await this.deps.getEntry(id))
      if (current.url !== route.url) throw new Error('来源会话已变化，请重新选择。')
      assertAllowed()
      await this.deps.openExternal(route.url)
      // OS 受理不等于目标已展示该会话，禁止报“已恢复”或“接续成功”。
      return { status: 'requested', app: route.state.app }
    } finally { this.opening.delete(id) }
  }
}
