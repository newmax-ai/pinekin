import { z } from 'zod'
import { sessionSchema } from '../core/session'
import type { Message, ParsedArchive } from '../core/types'

const timestamp = z.number().int().min(0).max(8_640_000_000_000_000)
const identifier = z.string().min(1).max(512)
const snapshotSchema = z.strictObject({
  format: z.literal('pinekin.newmax-local-snapshot'), version: z.literal(1), sourceVersion: z.literal('1.1.22'),
  session: z.strictObject({ id: identifier, title: z.string().trim().min(1).max(200), source: z.literal('app'),
    createdAt: timestamp, updatedAt: timestamp, forkedFromConversationId: z.null(), isPrivate: z.literal(false),
    messageCount: z.number().int().min(1).max(10_000) }),
  messages: z.array(z.strictObject({ seq: z.number().int().nonnegative(), id: identifier, role: z.enum(['user', 'assistant']),
    content: z.string().max(200_000), displayContent: z.string().max(200_000).optional(), timestamp, internal: z.boolean() })).max(10_000),
})

export function parseNewMaxLocal(input: unknown, sourceWindow = false): ParsedArchive {
  const schema = sourceWindow ? snapshotSchema.extend({ session: snapshotSchema.shape.session.extend({ messageCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }) }) : snapshotSchema
  const result = schema.safeParse(input)
  if (!result.success) throw new Error('NewMax 快照字段或版本不支持；仅接受 1.1.22 普通非隐私、非分叉主会话的白名单快照。')
  const snapshot = result.data
  if ((!sourceWindow && snapshot.session.messageCount !== snapshot.messages.length) || snapshot.session.updatedAt < snapshot.session.createdAt) {
    throw new Error('NewMax 快照消息数或会话时间不一致，不能将片段当成完整快照')
  }
  const warnings = new Set<string>([
    '这是 Pinekin 从授权 NewMax 数据库生成的只读字段白名单快照，不是官方导出包，也不是原生恢复。',
    '按 SQLite 当前消息行 seq 顺序投影；只映射当前 content 和用户 displayContent，不包含历史回答变体、推理、工具、子代理或运行状态。',
    '不读取配置、认证、账户表或附件文件；原始数据库不复制，快照不能当作完整备份。',
    '用户展示文本优先于展开后的提示词；内部任务/Goal 续轮和空白占位不进入正文。其他未标记的自动内容仍可能保留，请交接前检查。',
    '附件、多模态、工作区和权限不迁移；不沿路径读取、不联网、不执行历史指令，快照原件不随交接导出。',
  ])
  const messages: Message[] = []
  const ids = new Set<string>()
  let previousSeq = -1
  let updatedAt = snapshot.session.updatedAt
  for (const message of snapshot.messages) {
    if (ids.has(message.id) || message.seq <= previousSeq) throw new Error('NewMax 快照消息 ID 重复或 seq 顺序无效')
    ids.add(message.id); previousSeq = message.seq
    updatedAt = Math.max(updatedAt, message.timestamp)
    if (message.internal) continue
    const content = message.role === 'user' ? message.displayContent ?? message.content : message.content
    if (content.trim()) messages.push({ role: message.role, content })
  }
  if (!messages.length && !sourceWindow) throw new Error('NewMax 快照没有可归档的当前用户或助手文本')
  if (sourceWindow) warnings.add('这是来源阅读的有界片段，不是完整快照；长消息和后续消息可继续按段读取。')
  return { adapterId: 'newmax-local-snapshot', adapterVersion: '0.1.0', sourceName: 'NewMax · 本地快照',
    sourceVersion: snapshot.sourceVersion, originalSessionId: snapshot.session.id, warnings: [...warnings],
    session: sessionSchema.parse({ id: 'newmax-local-preview', title: snapshot.session.title, source: 'newmax',
      updatedAt: new Date(updatedAt).toISOString(), tags: ['NewMax', '本地快照', '文本投影'], messages, demo: false }) }
}
