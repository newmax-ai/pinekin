import { z } from 'zod'
import { MAX_BYTES, sessionSchema } from '../core/session'
import type { Message, ParsedArchive } from '../core/types'
import { sourcePromptTitle } from '../core/source-presentation'

const timestamp = z.number().int().min(0).max(8_640_000_000_000_000)
const identifier = z.string().min(1).max(512)
const headerSchema = z.strictObject({
  type: z.literal('session'), version: z.literal(4), id: identifier, createdAt: timestamp,
  cwd: z.string().max(4096).optional(), isSeeded: z.literal(false), delegationDepth: z.literal(0),
  agentPreset: z.string().max(512).optional(),
})
const eventSchema = z.object({ type: z.string().min(1).max(200), seq: z.number().int().min(0), time: timestamp,
  data: z.record(z.string(), z.unknown()), surfaceOp: z.literal('append').optional() })
const messageSchema = z.object({ id: identifier, role: z.enum(['user', 'assistant']),
  content: z.array(z.object({ type: z.string().max(100), text: z.string().max(200_000).optional() })).max(10_000) })

export function isDeepSeekLog(text: string): boolean {
  try { return JSON.parse(text.split('\n').find(line => line.trim()) ?? '{}')?.type === 'session' }
  catch { return false }
}

export function deepseekFirstPrompt(record: Record<string, unknown>): string {
  const data = record.data as { role?: unknown; source?: { kind?: unknown }; content?: unknown } | undefined
  if (record.type !== 'user/message' || data?.role !== 'user' || data.source?.kind !== 'user' || !Array.isArray(data.content)) return ''
  return sourcePromptTitle(data.content.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n'), 'deepseek')
}

// 仅接收完整的 v4 独立主会话；不重放来源运行时、不沿任何路径加载文件。
export function parseDeepSeek(text: string, sourceView = false): ParsedArchive {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('DeepSeek 日志超过 5 MB')
  const lines = text.split('\n').filter(line => line.trim())
  if (lines.length > 50_000) throw new Error('DeepSeek 日志记录数超限')
  const header = headerSchema.parse(JSON.parse(lines[0] ?? '{}'))
  const warnings = new Set<string>([
    '仅支持 DeepSeek Harness session-v4 独立主会话文本归档；不是 DeepSeek 网页聊天导出，也不是原生恢复。',
    '只投影用户输入和助手文本块；系统提示、运行时注入、推理、工具调用及结果、流式副本和权限状态不进入正文。',
    '原始日志仅保存在本机，不随文本交接导出；不执行历史命令、不访问附件或外部引用。',
  ])
  const messages: Message[] = []
  const ids = new Set<string>()
  let title = ''
  let updatedAt = header.createdAt
  for (let i = 1; i < lines.length; i++) {
    const event = eventSchema.parse(JSON.parse(lines[i]))
    if (event.seq !== i - 1) throw new Error('DeepSeek 日志序号不连续，不能作为完整独立会话导入')
    updatedAt = Math.max(updatedAt, event.time)
    if (event.type === 'session/title') {
      title = z.string().trim().min(1).max(200).parse(event.data.title)
      continue
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    if (event.surfaceOp !== 'append') throw new Error('DeepSeek 消息缺少已支持的 append 表面操作')
    if (event.type === 'user/message') {
      const source = z.object({ kind: z.string().min(1).max(100) }).parse(event.data.source)
      if (source.kind !== 'user') {
        warnings.add('非用户主动输入的 user/message（运行时上下文、技能目录或其他来源）不进入正文。')
        continue
      }
    }
    const message = messageSchema.parse(event.type === 'user/message' ? event.data : event.data.message)
    if (message.role !== (event.type === 'user/message' ? 'user' : 'assistant') || ids.has(message.id)) throw new Error('DeepSeek 消息角色或唯一 ID 无效')
    ids.add(message.id)
    const content = message.content.filter(block => {
      if (block.type === 'text') {
        if (block.text === undefined) throw new Error('DeepSeek 文本块缺少文本')
        return true
      }
      warnings.add('存在未映射的推理、工具或多模态内容块，仅保留在原件中。')
      return false
    }).map(block => block.text).join('\n')
    if (content.trim()) messages.push({ role: message.role, content })
  }
  if (!messages.length) throw new Error('DeepSeek 日志没有可归档的用户或助手文本')
  return { adapterId: 'deepseek-harness-v4', adapterVersion: '0.1.0', sourceName: 'DeepSeek Harness',
    originalSessionId: header.id, sourceVersion: 'session-v4', warnings: [...warnings],
    session: sessionSchema.parse({ id: 'deepseek-preview', title: title || (sourceView ? sourcePromptTitle(messages.find(m => m.role === 'user')?.content ?? '', 'deepseek') : (messages.find(m => m.role === 'user')?.content ?? '').slice(0, 100)) || 'DeepSeek Harness 会话',
      source: 'deepseek', updatedAt: new Date(updatedAt).toISOString(), tags: ['DeepSeek Harness', '文本投影'], messages, demo: false }) }
}
