import { z } from 'zod'
import type { Message, ParsedArchive } from '../core/types'
import { MAX_BYTES, sessionSchema } from '../core/session'

export const CODEX_SOURCE_COMMIT = '34420d42648f627f766bd347532dcaad5475a68b'
export const CODEX_LIMITS = { lines: 20_000, lineBytes: 512 * 1024, messages: 10_000 }
const object = z.record(z.string(), z.unknown())
const timestamp = z.iso.datetime({ offset: true })
const recordSchema = z.object({
  timestamp,
  ordinal: z.number().int().nonnegative().nullable().optional(),
  type: z.enum(['session_meta', 'response_item', 'event_msg', 'compacted', 'turn_context',
    'world_state', 'token_usage_record', 'security_risk_score', 'retained_context', 'realtime_item',
    'inter_agent_communication', 'inter_agent_communication_metadata']),
  payload: object,
})
const metaSchema = z.object({
  id: z.uuid(), session_id: z.uuid().optional(), timestamp,
  cwd: z.string().min(1).max(4096), originator: z.string().min(1).max(200), cli_version: z.string().min(1).max(512),
  source: z.union([z.string().max(200), object]).optional(),
  history_mode: z.string().optional(), history_base: object.nullable().optional(),
  parent_thread_id: z.uuid().nullable().optional(), forked_from_id: z.uuid().nullable().optional(),
  subagent_history_start_ordinal: z.number().int().nonnegative().nullable().optional(),
})
const responseSchema = z.object({ type: z.string().min(1).max(100) })
const messageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant']),
  content: z.array(object).max(10_000), id: z.string().min(1).max(512).nullable().optional(),
  phase: z.string().max(100).nullable().optional(), status: z.string().max(100).nullable().optional(),
  encrypted_content: z.string().nullable().optional(),
})
const eventSchema = z.object({ type: z.string().min(1).max(100) })
const toolItems = new Set(['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'local_shell_call', 'web_search_call'])

function checked<T>(schema: z.ZodType<T>, value: unknown, line: number): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error(`Codex 第 ${line} 行字段无效或类型不支持；未导入。`)
  return result.data
}
function decodeLine(text: string, line: number): unknown {
  try { return JSON.parse(text) }
  catch { throw new Error(`Codex 第 ${line} 行 JSON 无效或截断；未导入。`) }
}

// 只检测第一个非空行；不按文件名猜测，不把普通 history.jsonl 当成 rollout。
export function isCodexRollout(text: string): boolean {
  const start = text.search(/\S/)
  if (start < 0) return false
  const newline = text.indexOf('\n', start)
  try {
    const first: unknown = JSON.parse(text.slice(start, newline < 0 ? text.length : newline))
    return !!first && typeof first === 'object' && 'type' in first && first.type === 'session_meta'
  } catch { return false }
}

export function parseCodex(text: string): ParsedArchive {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('文件过大，最大支持 5 MB')
  const warnings = new Set<string>([
    '仅固定源码结构的合成夹具验证，CLI 版本是输入声明；不是原生恢复，未验证真实 Codex 客户端。',
    '仅提取顶层 response_item.message；这是追加日志的文本投影，不保证等同当前有效分支或完整可恢复上下文。',
    '工作区路径、指令、权限、工具状态、消息 ID/时间/阶段及未映射字段保存在本地原件，不沿引用读取文件，不执行历史内容。',
    '标题由会话 ID 生成，不是来源客户端标题；原始 JSONL 不随文本包或交接导出。',
  ])
  const counts = { events: 0, tools: 0, reasoning: 0, responses: 0, context: 0, blocks: 0 }
  const messages: Message[] = []
  const ids = new Set<string>()
  let meta: z.infer<typeof metaSchema> | undefined
  let updatedAt = -Infinity, line = 0, offset = 0
  while (offset < text.length) {
    line += 1
    if (line > CODEX_LIMITS.lines) throw new Error('Codex 日志行数超过 20,000 行，未截断导入')
    const newline = text.indexOf('\n', offset)
    const end = newline < 0 ? text.length : newline
    const raw = text.slice(offset, end)
    offset = end + 1
    if (Buffer.byteLength(raw) > CODEX_LIMITS.lineBytes) throw new Error(`Codex 第 ${line} 行超过单行 512 KiB 预算`)
    if (!raw.trim()) continue
    const record = checked(recordSchema, decodeLine(raw, line), line)
    updatedAt = Math.max(updatedAt, Date.parse(record.timestamp))
    if (!meta) {
      if (record.type !== 'session_meta') throw new Error('Codex 首条记录必须是 session_meta')
      meta = checked(metaSchema, record.payload, line)
      if (meta.history_mode !== undefined && meta.history_mode !== 'legacy') throw new Error('Codex 分页或未知历史模式尚未支持，请选择单文件 legacy 日志')
      if (meta.history_base != null || meta.forked_from_id != null) throw new Error('Codex 继承其他历史的日志尚未支持，不会读取引用文件')
      if (meta.parent_thread_id != null || meta.subagent_history_start_ordinal != null ||
        (meta.session_id !== undefined && meta.session_id !== meta.id) ||
        (typeof meta.source === 'object' && 'subagent' in meta.source)) throw new Error('Codex 子会话历史边界尚未支持')
      updatedAt = Math.max(updatedAt, Date.parse(meta.timestamp))
      continue
    }
    if (record.type === 'session_meta') throw new Error(`Codex 第 ${line} 行重复 session_meta，不能混合多个会话`)
    if (record.type === 'response_item') {
      const response = checked(responseSchema, record.payload, line)
      if (response.type !== 'message') {
        if (toolItems.has(response.type)) counts.tools += 1
        else if (response.type === 'reasoning') counts.reasoning += 1
        else counts.responses += 1
        continue
      }
      const message = checked(messageSchema, record.payload, line)
      if (message.id != null) {
        if (ids.has(message.id)) throw new Error(`Codex 第 ${line} 行消息 ID 重复，无法确认是重放还是修订`)
        ids.add(message.id)
      }
      if (messages.length >= CODEX_LIMITS.messages) throw new Error('Codex 消息数量超过 10,000 条，未截断导入')
      const parts: string[] = []
      for (const block of message.content) {
        const kind = checked(responseSchema, block, line).type
        if (kind === 'input_text' || kind === 'output_text') {
          parts.push(checked(z.string().max(200_000), block.text, line))
        } else {
          parts.push('[未映射内容块，保留在原件中]'); counts.blocks += 1
        }
      }
      if (message.encrypted_content != null) {
        parts.push('[加密内容未解密，保留在原件中]')
        warnings.add('存在加密消息内容：仅显示已有明文与占位符，没有尝试解密。')
      }
      const content = parts.join('\n')
      if (content.length > 200_000) throw new Error(`Codex 第 ${line} 行合并正文超过 200,000 字符`)
      if (message.role === 'developer') warnings.add('developer 角色映射为系统历史；原始角色保存在原件，不构成当前用户授权。')
      if (message.phase != null) warnings.add('助手消息阶段（进展/部分回答/最终回答）未结构化映射，按日志顺序显示，不推断任务完成。')
      if (message.status != null && message.status !== 'completed') warnings.add('存在非 completed 的消息完成状态；不能把显示的文本视为完整答复。')
      messages.push({ role: message.role === 'developer' ? 'system' : message.role, content })
    } else if (record.type === 'event_msg') {
      const event = checked(eventSchema, record.payload, line)
      counts.events += 1
      if (event.type === 'thread_rolled_back') {
        checked(z.number().int().nonnegative(), record.payload.num_turns, line)
        warnings.add('日志包含回退：保留已写入消息，不计算当前有效分支；交接也会包含已撤销的历史，请先检查。')
      }
    } else if (record.type === 'compacted') {
      checked(z.string(), record.payload.message, line)
      warnings.add('日志包含上下文压缩：摘要和 replacement_history 不作为新消息重复导入；本档案不是压缩后的有效上下文。')
    } else {
      counts.context += 1
    }
  }
  if (!meta || messages.length === 0) throw new Error('Codex 日志没有可导入的顶层消息；不会用事件副本或压缩摘要伪造会话')
  if (counts.events) warnings.add(`事件记录未映射：${counts.events} 条。可能包含消息副本、状态及其他事件，避免重复导入正文。`)
  if (counts.tools) warnings.add(`工具调用或结果未映射：${counts.tools} 条。只保存在原件，不执行、不伪装为助手答复。`)
  if (counts.reasoning) warnings.add(`推理记录未映射：${counts.reasoning} 条。只保存在原件，不进入正文或交接。`)
  if (counts.responses) warnings.add(`未映射响应项：${counts.responses} 条。当前不能解释的类型保存在原件中。`)
  if (counts.context) warnings.add(`上下文、用量、Agent 间消息或其他状态记录未映射：${counts.context} 条，仅保存在原件中。`)
  if (counts.blocks) warnings.add(`未映射内容块：${counts.blocks} 个。图片、音频和未知结构仅显示占位符，不联网或读取本地引用。`)
  return { adapterId: 'codex-rollout', adapterVersion: '0.1.0', sourceName: 'Codex JSONL',
    sourceVersion: meta.cli_version, originalSessionId: meta.id, warnings: [...warnings],
    session: sessionSchema.parse({ id: meta.id, title: `Codex · ${meta.id.slice(0, 8)}`, source: 'codex',
      updatedAt: new Date(updatedAt).toISOString(), tags: ['Codex', '文本投影'], messages, demo: false }),
  }
}
