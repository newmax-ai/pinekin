import { z } from 'zod'
import { sessionSchema } from '../core/session'
import type { Message, ParsedArchive } from '../core/types'

const timestamp = z.number().int().min(0).max(8_640_000_000_000_000)
const identifier = z.string().min(1).max(512)
const snapshotSchema = z.strictObject({
  format: z.literal('pinekin.cindy-local-snapshot'), version: z.literal(1), sourceVersion: z.enum(['0.1.97', '0.1.110-schema']),
  session: z.strictObject({ id: identifier, title: z.string().trim().min(1).max(200), source: z.literal('desktop'),
    status: z.enum(['active', 'archived']), createdAt: timestamp, updatedAt: timestamp,
    parentSessionId: z.null(), remoteHostId: z.null(), orcaRole: z.null(), clearedAt: timestamp.nullable() }),
  messages: z.array(z.strictObject({ id: identifier, role: z.enum(['system', 'user', 'assistant', 'thinking', 'tool_use', 'tool_result', 'agent_switch']),
    content: z.string().max(200_000), createdAt: timestamp, rewindAt: timestamp.nullable() })).max(10_000),
})

export function parseCindyLocal(input: unknown, sourceWindow = false): ParsedArchive {
  const snapshot = snapshotSchema.parse(input)
  const warnings = new Set<string>([
    '这是 Pinekin 从授权 Cindy 数据库生成的只读会话快照，不是 Cindy 官方分享包，也不支持原生恢复。',
    '快照仅保留选定会话字段与消息，不含数据库配置、认证表、底层 harness 日志或附件文件。',
    '按 Cindy 桌面 created_at + rowid 顺序投影；清空、回退消息及推理、工具、引擎切换仅保存在快照中，不进入正文。',
    '附件与多模态内容未映射，不沿路径读取或联网下载；文本交接不携带原始快照。',
  ])
  const messages: Message[] = []
  const ids = new Set<string>()
  let previousTime = -1
  for (const message of snapshot.messages) {
    if (ids.has(message.id) || message.createdAt < previousTime) throw new Error('Cindy 快照消息重复或顺序无效')
    ids.add(message.id); previousTime = message.createdAt
    if (message.rewindAt !== null || (snapshot.session.clearedAt !== null && message.createdAt <= snapshot.session.clearedAt)) continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    let content = message.content
    if (message.role === 'user' && !sourceWindow) {
      let value: unknown
      try { value = JSON.parse(content) } catch { value = undefined }
      if (typeof value === 'string') content = value
      else if (value !== undefined) {
        if (value && typeof value === 'object' && !Array.isArray(value) && 'text' in value && typeof value.text === 'string') content = value.text
        else { warnings.add('存在未映射的用户内容对象，仅保存在快照中。'); continue }
      }
    }
    if (content.trim()) messages.push({ role: message.role, content })
  }
  if (!messages.length && !sourceWindow) throw new Error('Cindy 快照没有可归档的当前用户或助手文本')
  if (sourceWindow) warnings.add('这是来源阅读的有界片段，不是完整快照；用户展示文本在切片前提取，后续内容可按段读取。')
  return { adapterId: 'cindy-local-snapshot', adapterVersion: '0.1.0', sourceName: 'Cindy · 本地快照', sourceVersion: snapshot.sourceVersion,
    originalSessionId: snapshot.session.id, warnings: [...warnings],
    session: sessionSchema.parse({ id: 'cindy-local-preview', title: snapshot.session.title, source: 'cindy',
      updatedAt: new Date(snapshot.session.updatedAt).toISOString(), tags: ['Cindy', '本地快照', '文本投影'], messages, demo: false }) }
}
