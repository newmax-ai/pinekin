import { z } from 'zod'
import type { Session, Source } from './types'

export const browsableSources = ['newmax', 'claude-code', 'codex', 'deepseek', 'cindy'] as const
export type BrowsableSource = typeof browsableSources[number]
export const sourceSchema = z.enum(browsableSources)
export const connectionIdSchema = z.uuid()
export const entryIdSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const sourceQuerySchema = z.strictObject({
  connectionId: connectionIdSchema.optional(), source: sourceSchema.optional(),
  query: z.string().max(200).default(''), offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(50),
})
export type SourceQuery = z.input<typeof sourceQuerySchema>
export type ConnectionStatus = 'idle' | 'scanning' | 'ready' | 'partial' | 'cancelled' | 'error'
export interface SourceConnection {
  id: string; source: BrowsableSource; label: string
  status: ConnectionStatus; discovered: number; total: number | null
  issues: number; ignoredLinks: number; error?: string
}
export interface SourceEntry {
  id: string; connectionId: string; source: BrowsableSource; sourceSessionId?: string
  title: string; project: string; updatedAt: string
  availability: 'unread' | 'readable' | 'unsupported' | 'unreadable'; reason?: string
}
export interface SourcePage {
  items: SourceEntry[]; total: number; offset: number; hasMore: boolean
  connections: SourceConnection[]
}
export interface SourceContent { session: Session; warnings: string[] }
export interface SourceConnectResult { connections: SourceConnection[]; warnings: string[] }
export interface SourceBrowserAPI {
  connections(): Promise<SourceConnection[]>
  autoConnect(source: BrowsableSource): Promise<SourceConnectResult>
  connect(source: BrowsableSource): Promise<SourceConnection | null>
  refresh(id: string): Promise<void>
  cancel(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  page(query: SourceQuery): Promise<SourcePage>
  read(id: string): Promise<SourceContent>
}
export const sourceNames: Record<Source, string> = {
  newmax: 'NewMax', 'claude-code': 'Claude Code', codex: 'Codex', deepseek: 'DeepSeek Harness', cindy: 'Cindy', other: '其他来源',
}
export const sourceLocations: Record<BrowsableSource, string> = {
  newmax: '选择 NewMax 会话 SQLite 数据库；只查询 conversations / messages。目前仅支持 macOS 非 WAL、无事务副文件的库；WAL 会明确拒绝，避免只读连接仍写副文件。不要手动删除副文件。',
  'claude-code': '选择 Claude Code 的 projects 目录或一个项目日志目录，包含其下的 JSONL 与子会话。',
  codex: '选择 Codex 的 sessions 或 archived_sessions 目录；可分别连接多个位置。',
  deepseek: '选择 DeepSeek Harness 会话日志目录，不支持 DeepSeek 网页聊天。',
  cindy: '选择 Cindy 会话 SQLite 数据库。目前仅支持 macOS 非 WAL、无事务副文件的库，只提供列表，正文直读尚未验证。不要手动删除副文件。',
}
