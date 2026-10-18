import { z } from 'zod'
import { MAX_BYTES, sessionSchema } from '../core/session'
import type { Message, ParsedArchive } from '../core/types'
import type { SourcePresentation } from '../core/sources'
import { isBrowserTask, sourcePromptTitle } from '../core/source-presentation'
import { SourceActivities } from './source-activity'

const identifier = z.string().min(1).max(512)
const object = z.record(z.string(), z.unknown())
const nodeSchema = z.object({
  type: z.enum(['user', 'assistant', 'system', 'attachment', 'progress']), uuid: identifier,
  parentUuid: identifier.nullable(), sessionId: z.uuid(), timestamp: z.iso.datetime({ offset: true }),
  isSidechain: z.boolean(), isMeta: z.boolean().optional(), version: z.string().min(1).max(100).optional(),
  subtype: z.string().optional(), isCompactSummary: z.boolean().optional(),
  isVisibleInTranscriptOnly: z.boolean().optional(), logicalParentUuid: identifier.nullable().optional(),
  apiBlockIndex: z.number().int().nonnegative().optional(), message: z.unknown().optional(),
})
const messageSchema = z.object({ role: z.enum(['user', 'assistant']), id: identifier.optional(),
  content: z.union([z.string().max(200_000), z.array(object).max(10_000)]) })
const metadata = new Set(['file-history-snapshot', 'file-history-delta', 'queue-operation', 'summary', 'last-prompt',
  'ai-title', 'custom-title', 'agent-name', 'agent-color', 'mode', 'bridge-session', 'atis-latch', 'cost-state'])
type Node = z.infer<typeof nodeSchema>

function invalid(line: number, reason = '字段无效或类型不支持'): never {
  throw new Error(`Claude Code 第 ${line} 行${reason}；未导入。`)
}
function decode(raw: string, line: number): Record<string, unknown> {
  try {
    const result = object.safeParse(JSON.parse(raw.trim()))
    if (result.success) return result.data
  } catch { /* 不把原文或解析器片段带入错误。 */ }
  return invalid(line, ' JSON 无效、截断或不是对象')
}

// 允许原生日志以 file-history 等元数据开头；不按扩展名猜测 history.jsonl。
export function isClaudeCodeLog(text: string): boolean {
  let offset = 0
  for (let line = 1; line <= 64 && offset < text.length; line += 1) {
    const newline = text.indexOf('\n', offset), end = newline < 0 ? text.length : newline
    const raw = text.slice(offset, end); offset = end + 1
    if (!raw.trim()) continue
    try {
      const record = decode(raw, line)
      if (['user', 'assistant'].includes(String(record.type)) && typeof record.uuid === 'string' &&
        typeof record.sessionId === 'string' && record.message && typeof record.message === 'object') return true
      if (!metadata.has(String(record.type)) && !['system', 'attachment', 'progress'].includes(String(record.type))) return false
    } catch { return false }
  }
  return false
}

export function parseClaudeCode(text: string, sourceView = false): ParsedArchive & { presentation?: SourcePresentation } {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Claude Code 文件过大，最大支持 5 MB')
  const activity = sourceView ? new SourceActivities() : undefined
  const nodes = new Map<string, Node>()
  const versions = new Set<string>()
  const warnings = new Set<string>([
    '这是 Claude Code JSONL 的末条用户/助手消息父链（latest-message）文本投影，不是原生活动链或原生恢复。',
    '混合事件先构建完整 UUID 图，再沿末条消息的单父链投影；其他分支和链外内容仅保存在原件，不补拼同 ID 的离链块。',
    '只显示用户文本和助手 text 块；推理、工具调用/结果、附件、isMeta 注入和运行状态不进入正文或交接。',
    '助手多记录按追加块顺序合并，不将相同 message.id 覆盖成最后一块；档案导入标题由首条用户文本生成，来源直读可优先使用来源列表提取的标题。',
    '版本字段只作为输入声明；不沿路径或引用读取文件，不执行历史指令，原始 JSONL 不随文本包或交接导出。',
  ])
  let last: Node | undefined
  let sessionId: string | undefined
  let updatedAt = -Infinity, offset = 0
  for (let line = 1; offset < text.length; line += 1) {
    if (line > 20_000) throw new Error('Claude Code 日志行数超过 20,000 行，未截断导入')
    const newline = text.indexOf('\n', offset), end = newline < 0 ? text.length : newline
    const raw = text.slice(offset, end); offset = end + 1
    if (Buffer.byteLength(raw) > 512 * 1024) invalid(line, '超过单行 512 KiB 预算')
    if (!raw.trim()) continue
    const record = decode(raw, line)
    if (metadata.has(String(record.type))) {
      if (record.type === 'summary') warnings.add('日志含 summary 元数据；不把摘要当用户消息，也不从其 leafUuid 推断活动链。')
      continue
    }
    const checked = nodeSchema.safeParse(record)
    if (!checked.success) invalid(line)
    const node = checked.data
    if (node.isSidechain || node.isCompactSummary || node.isVisibleInTranscriptOnly || node.logicalParentUuid != null || node.subtype === 'compact_boundary') {
      invalid(line, '存在未支持的子会话、压缩或逻辑父链边界')
    }
    if (nodes.has(node.uuid)) invalid(line, ' UUID 重复，不能猜测快照或重放')
    if (sessionId && node.sessionId !== sessionId) invalid(line, '混合多个会话')
    sessionId = node.sessionId
    nodes.set(node.uuid, node)
    if (node.version) versions.add(node.version)
    if (versions.size > 4) invalid(line, '版本声明过多')
    if (node.type === 'user' || node.type === 'assistant') last = node
  }
  if (!last || !sessionId) throw new Error('Claude Code 日志没有可投影的用户或助手消息')

  // 检查全图而不只检查选中链，防止把缺失前缀或坏的兄弟分支静默当成完整日志。
  const validated = new Set<string>()
  let roots = 0
  for (const node of nodes.values()) {
    if (node.parentUuid === null) roots += 1
    const path = new Set<string>()
    let current: Node | undefined = node
    while (current && !validated.has(current.uuid)) {
      if (path.has(current.uuid)) throw new Error('Claude Code 父链存在循环，未导入')
      path.add(current.uuid)
      if (current.parentUuid === null) break
      const parent: Node | undefined = nodes.get(current.parentUuid)
      if (!parent) throw new Error('Claude Code 父链缺失或引用外部历史，未读取引用文件')
      current = parent
    }
    for (const id of path) validated.add(id)
  }
  if (roots !== 1) throw new Error('Claude Code 日志不是单根会话，未推断多根或压缩后的历史关系')
  const chain: Node[] = []
  for (let node: Node | undefined = last; node; node = node.parentUuid === null ? undefined : nodes.get(node.parentUuid)) chain.push(node)
  chain.reverse()
  if (chain.length < nodes.size) warnings.add(`单链未包含全部分支或尾部状态：${nodes.size - chain.length} 个链外节点仅保留在原件；本档案不是完整对话或全部有效历史。`)

  const messages: Message[] = []
  const assistantIndices = new Map<string, number | undefined>()
  let previousAssistantId: string | undefined
  let previousOutputId: string | undefined
  for (const node of chain) {
    updatedAt = Math.max(updatedAt, Date.parse(node.timestamp))
    if (node.type !== 'user' && node.type !== 'assistant') {
      if (activity) {
        if (node.type === 'attachment') activity.presentation.attachments += 1
        else activity.presentation.omittedRecords += 1
      }
      continue
    }
    const result = messageSchema.safeParse(node.message)
    if (!result.success || result.data.role !== node.type) throw new Error('Claude Code 消息字段或角色不一致，未导入')
    const message = result.data
    if (node.isMeta) { if (activity) activity.presentation.omittedRecords += 1; continue }
    if (node.type === 'assistant') {
      if (!message.id || typeof message.content === 'string') throw new Error('Claude Code 助手消息 ID 或内容块结构不支持')
      if (assistantIndices.has(message.id)) {
        const previous = assistantIndices.get(message.id)
        const legacy = sourceView && previous === undefined && node.apiBlockIndex === undefined && previousAssistantId === message.id
        if (legacy) warnings.add('旧版助手记录缺少追加块索引：按父链保留独立文本片段，不推断快照、不去重或增量合并。')
        else if (previous === undefined || node.apiBlockIndex === undefined || node.apiBlockIndex <= previous || previousAssistantId !== message.id) {
          throw new Error('Claude Code 助手重复消息的追加块索引缺失、重放或顺序不明，未猜测合并')
        }
      }
      assistantIndices.set(message.id, node.apiBlockIndex)
      previousAssistantId = message.id
    } else previousAssistantId = undefined
    const parts: string[] = []
    if (typeof message.content === 'string') parts.push(message.content)
    else for (const block of message.content) {
      if (typeof block.type !== 'string') throw new Error('Claude Code 内容块缺少类型')
      activity?.claudeBlock(block)
      if (block.type === 'text') {
        const result = z.string().max(200_000).safeParse(block.text)
        if (!result.success) throw new Error('Claude Code 文本块无效或超过 200,000 字符')
        parts.push(result.data)
      }
    }
    const content = parts.join('\n')
    if (content.length > 200_000) throw new Error('Claude Code 合并正文超过 200,000 字符')
    if (!content.trim()) { if (node.type === 'user') previousOutputId = undefined; continue }
    if (activity && node.type === 'user' && isBrowserTask(content)) activity.presentation.kind = 'browser-task'
    const lastOutput = messages[messages.length - 1]
    if (node.type === 'assistant' && lastOutput?.role === 'assistant' && previousOutputId === message.id && (!sourceView || node.apiBlockIndex !== undefined)) {
      lastOutput.content += '\n' + content
      if (lastOutput.content.length > 200_000) throw new Error('Claude Code 合并正文超过 200,000 字符')
    } else {
      if (messages.length >= 10_000) throw new Error('Claude Code 消息数量超过 10,000 条，未截断导入')
      messages.push({ role: node.type, content })
    }
    previousOutputId = node.type === 'assistant' ? message.id : undefined
  }
  if (!messages.length && !(activity && (activity.presentation.toolCalls || activity.presentation.toolResults || activity.presentation.attachments))) throw new Error('Claude Code 父链没有可归档的用户或助手文本')
  const firstUser = messages.find(message => message.role === 'user')?.content ?? ''
  const title = (sourceView ? sourcePromptTitle(firstUser, 'claude-code') : firstUser.trim().slice(0, 80)) || sessionId.slice(0, 8)
  if (activity) {
    activity.presentation.textMessages = messages.length
    warnings.add('来源阅读额外展示选中父链的工具活动预览；工具与附件不计为文字消息，不执行、不进入文本交接。预览最多 100 条，每条最多 1,024 字符，完整内容保留在原件。')
  }
  return { adapterId: 'claude-code-jsonl', adapterVersion: '0.1.0', sourceName: 'Claude Code JSONL',
    sourceVersion: versions.size ? [...versions].join(', ') : undefined, originalSessionId: sessionId, warnings: [...warnings],
    ...(activity ? { presentation: activity.presentation } : {}),
    session: sessionSchema.parse({ id: sessionId, title: sourceView ? title : `Claude Code · ${title}`, source: 'claude-code',
      updatedAt: new Date(updatedAt).toISOString(), tags: ['Claude Code', '末条消息父链', '文本投影'], messages, demo: false }) }
}
