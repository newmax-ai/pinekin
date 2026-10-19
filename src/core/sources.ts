import { z } from 'zod'
import type { Session, Source } from './types'

export const browsableSources = ['newmax', 'claude-code', 'codex', 'cindy', 'deepseek', 'workbuddy', 'qwen-code'] as const
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
export const sourceCheckSchema = z.strictObject({
  connectionIds: z.array(connectionIdSchema).max(100).optional(),
  selectedId: entryIdSchema.optional(), mode: z.enum(['automatic', 'manual']).default('automatic'),
})
export type SourceCheck = z.input<typeof sourceCheckSchema>
export interface SourceCheckResult {
  version: number; connections: SourceConnection[]; selected?: SourceEntry | null
}
export type ConnectionStatus = 'idle' | 'scanning' | 'ready' | 'partial' | 'cancelled' | 'error'
export interface SourceConnection {
  id: string; source: BrowsableSource; label: string
  status: ConnectionStatus; discovered: number; total: number | null
  issues: number; ignoredLinks: number; error?: string; refreshing?: boolean
}
export interface SourceEntry {
  id: string; connectionId: string; source: BrowsableSource; sourceSessionId?: string
  title: string; project: string; updatedAt: string; revision?: string; kind?: SourceRecordKind
  availability: 'unread' | 'readable' | 'unsupported' | 'unreadable'; reason?: string
}
export interface SourcePage {
  items: SourceEntry[]; total: number; offset: number; hasMore: boolean
  connections: SourceConnection[]; version?: number; snapshot?: string
}
/** snapshot 属于完整筛选结果，与 offset / limit 和其他来源无关；兼容旧测试桥的 version。 */
export function sameSourceSnapshot(left: SourcePage, right: SourcePage): boolean {
  return left.snapshot !== undefined && right.snapshot !== undefined ? left.snapshot === right.snapshot : left.version === right.version
}
export type SourceRecordKind = 'conversation' | 'browser-task' | 'subagent' | 'internal'
export interface SourcePresentation {
  kind: SourceRecordKind
  textMessages: number; toolCalls: number; toolResults: number; attachments: number; omittedRecords: number
  activities: { kind: 'call' | 'result'; name: string; content: string; truncated?: boolean }[]
  activitiesTruncated: boolean
}
export const sourceKindNames: Record<SourceRecordKind, string> = {
  conversation: '对话', 'browser-task': '浏览器任务', subagent: '子会话', internal: '辅助记录',
}
// 限制单次投影，不把整段会话的大小当作来源支持条件。字符偏移按 Unicode 码点计。
export const SOURCE_PAGE_MESSAGES = 100
export const SOURCE_TEXT_CHARS = 16_384
export const sourceReadCursorSchema = z.strictObject({
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  textOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - SOURCE_TEXT_CHARS).default(0),
  snapshot: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).refine(value => (!value.offset && !value.textOffset) || !!value.snapshot, '续读必须携带来源快照')
export type SourceReadCursor = z.infer<typeof sourceReadCursorSchema>
export interface SourceReadWindow {
  offset: number; textOffset: number; totalMessages: number; snapshot: string
  hasMore: boolean; next?: SourceReadCursor
}
export interface SourceContent { session: Session; warnings: string[]; revision?: string; presentation?: SourcePresentation; window?: SourceReadWindow }
/** notices 是正常状态提示，不进入错误警报或连接失败汇总；可选以兼容既有桥。 */
export interface SourceConnectResult { connections: SourceConnection[]; warnings: string[]; notices?: string[] }
export interface SourceBrowserAPI {
  connections(): Promise<SourceConnection[]>
  autoConnect(source: BrowsableSource): Promise<SourceConnectResult>
  connect(source: BrowsableSource): Promise<SourceConnection | null>
  refresh(id: string): Promise<void>
  check(query: SourceCheck): Promise<SourceCheckResult>
  cancel(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  page(query: SourceQuery): Promise<SourcePage>
  read(id: string, cursor?: SourceReadCursor): Promise<SourceContent>
}
export const sourceNames: Record<Source, string> = {
  newmax: 'NewMax', 'claude-code': 'Claude Code', codex: 'Codex', deepseek: 'DeepSeek Harness', cindy: 'Cindy', workbuddy: 'WorkBuddy', 'qwen-code': 'Qwen Code', other: '其他来源',
}
export const sourceLocations: Record<BrowsableSource, string> = {
  workbuddy: '默认查找 ~/.workbuddy/projects/<project>/*.jsonl，支持 WORKBUDDY_CONFIG_DIR 绝对目录覆盖；自定义选择 projects 或单项目目录。只读本地普通主会话和同名 .meta.json，不读取 workbuddy.db、凭据、云缓存或 subagents。依据官方 5.8.3 macOS arm64 包核对；其他版本、分叉、压缩与重复 ID 追加块未验证，不支持原生恢复。',
  'qwen-code': '默认查找 ~/.qwen/projects/<project>/chats/*.jsonl；支持本进程继承的 QWEN_RUNTIME_DIR / QWEN_HOME 绝对目录覆盖。自定义位置选择 projects、单项目或 chats 目录。仅独立主会话的单根父链文本，分叉、子会话、回退、压缩与托管历史未支持；不读取凭据或工具输出文件。',
  newmax: '默认查找 ~/.newmax/newmax.db，支持本进程继承的 NEWMAX_USER_DATA_DIR 绝对目录覆盖。自定义位置请选择 newmax.db；仅查询会话与选定消息。macOS 使用禁止写入的独立只读进程读取已提交 WAL；不会复制整库、checkpoint 或删除副文件。',
  'claude-code': '选择 Claude Code 的 projects 目录或一个项目日志目录。日志格式不等于客户端归属：明确由通用 Claude Agent SDK 创建的执行日志会排除，NewMax 主会话从 NewMax 数据库读取；可验证的客户端日志与子会话按各自边界展示。',
  codex: '选择 Codex 的 sessions 或 archived_sessions 目录；可分别连接多个位置。',
  deepseek: '选择 DeepSeek Harness 会话日志目录，不支持 DeepSeek 网页聊天。',
  cindy: '自动查找 Cindy / CindyGlobal 的账号会话数据库，也可指定 cindy-*.db。macOS 在禁止写入的独立进程中读取已提交 WAL；经字段与协作边界校验后可读普通桌面会话的当前问答，分叉、协作、远程会话仍未支持。不复制整库、读取凭据或删除副文件。',
}
