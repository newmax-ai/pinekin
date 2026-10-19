import { z } from 'zod'
import type { Message, Session } from '../core/types'
import type { SourcePresentation } from '../core/sources'
import { isBrowserTask, sourcePromptTitle } from '../core/source-presentation'
import { claudeSourceSchemas, claudeAuxiliaryReason, isClaudeAuxiliaryLog } from './claude-code'
import { codexSourceSchemas, isCodexSubagent } from './codex'
import { deepseekSourceSchemas } from './deepseek'
import { codexUserText } from './source-conversation'
import { ClaudeLogOrigin, sdkOriginReason, UnsupportedSourceError } from './source-origin'
import { SourceActivities } from './source-activity'
import type { LogRecord } from './source-log-file'

export type LogSource = 'claude-code' | 'codex' | 'deepseek'
export interface TextRef { line: number; length: number }
export interface IndexedMessage { role: Message['role']; length: number; parts: TextRef[] }
export interface ToolEvent { kind: 'call' | 'result'; id?: string; name?: string; content: string }
export interface LogIndex {
  messages: IndexedMessage[]; session: Omit<Session, 'messages'>; warnings: string[]; presentation?: SourcePresentation
  // Claude 工具活动只有完整父链确定后才取预览，避免离链工具混入。
  tools?: Map<number, number>
}
export interface LogIndexer { accept(record: LogRecord, line: number): void; finish(): LogIndex }
class Budget {
  private used = 0
  add(characters = 0) {
    this.used += 192 + characters * 2
    if (this.used > 32 * 1024 * 1024) throw new Error('日志结构索引超过 32 MiB 工作预算；会话仍保留，不把资源限制当成不支持')
  }
}
function checked<T>(schema: z.ZodType<T>, value: unknown, source: string, line: number): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error(`${source} 第 ${line} 行字段无效或类型不支持`)
  return result.data
}
function object(value: unknown): LogRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as LogRecord : {} }
export function codePoints(text: string) { let count = 0; for (const _ of text) count += 1; return count }
export function sliceCodePoints(text: string, start: number, length: number) {
  let index = 0, begin = 0, end = 0, position = 0
  for (const char of text) {
    if (index === start) begin = position
    if (index >= start + length) break
    position += char.length; index += 1; end = position
  }
  return start >= index ? '' : text.slice(begin, end)
}
function textBlocks(blocks: LogRecord[], kinds: string[], source: string, line: number, placeholders = false) {
  return blocks.map(block => {
    if (typeof block.type !== 'string') throw new Error(`${source} 第 ${line} 行内容块缺少类型`)
    if (kinds.includes(block.type)) return checked(z.string(), block.text, source, line)
    return placeholders ? '[未映射内容块，保留在原件中]' : ''
  }).filter((text, index) => text !== '' || kinds.includes(String(blocks[index].type))).join('\n')
}
export function recordText(source: LogSource, record: LogRecord, line: number): string {
  if (source === 'claude-code') {
    const message = checked(claudeSourceSchemas.message, record.message, 'Claude Code', line)
    return typeof message.content === 'string' ? message.content : textBlocks(message.content, ['text'], 'Claude Code', line)
  }
  if (source === 'codex') {
    const message = checked(codexSourceSchemas.message, record.payload, 'Codex', line)
    const content = textBlocks(message.content, ['input_text', 'output_text'], 'Codex', line, true) + (message.encrypted_content != null ? '\n[加密内容未解密，保留在原件中]' : '')
    return message.role === 'user' ? codexUserText(content) : content
  }
  const data = object(record.data)
  const message = checked(deepseekSourceSchemas.message, record.type === 'user/message' ? data : data.message, 'DeepSeek', line)
  return textBlocks(message.content, ['text'], 'DeepSeek', line)
}
function descriptor(line: number, text: string, role: Message['role']): IndexedMessage {
  const length = codePoints(text)
  return { role, length, parts: [{ line, length }] }
}
function session(source: LogSource, id: string, title: string, updatedAt: number): Omit<Session, 'messages'> {
  const tags = source === 'claude-code' ? ['Claude Code', '末条消息父链', '文本投影'] : source === 'codex' ? ['Codex', '文本投影'] : ['DeepSeek Harness', '文本投影']
  return { id: source === 'deepseek' ? 'deepseek-preview' : id, title, source, updatedAt: new Date(updatedAt).toISOString(), tags, demo: false }
}
const commonWarnings = [
  '来源日志按流式完整校验，正文只返回当前片段；不是完整备份或原生恢复，不写入来源、不落盘保存正文。',
  '工具、附件、推理和运行状态不作为文字答复；不执行历史指令，不沿路径或外部历史引用读取文件。',
  '每次最多 100 条文本、每条 16,384 个 Unicode 码点；上一段／下一段从原件重读，来源变化时拒绝混合版本。',
]

export function createLogIndexer(source: LogSource): LogIndexer {
  if (source === 'claude-code') return claudeIndexer()
  const budget = new Budget(), ids = new Set<string>(), messages: IndexedMessage[] = []
  const warnings = new Set(commonWarnings), activity = new SourceActivities()
  let id = '', title = '', updatedAt = 0, firstPrompt = '', expectedOrdinal: number | undefined, nextSeq = 0, rawMessages = 0, omittedContext = 0
  function remember(messageId: string | null | undefined) {
    if (messageId == null) return
    if (ids.has(messageId)) throw new Error(`${source} 消息 ID 重复，未猜测重放或修订`)
    budget.add(messageId.length); ids.add(messageId)
  }
  return {
    accept(record, line) {
      if (source === 'codex') {
        const row = checked(codexSourceSchemas.record, record, 'Codex', line)
        if (expectedOrdinal !== undefined) {
          if (row.ordinal !== expectedOrdinal++) throw new Error('Codex 分页序号缺失或不连续，不能将缺少前缀的文件当完整日志')
        }
        updatedAt = Math.max(updatedAt, Date.parse(row.timestamp))
        if (!id) {
          if (row.type !== 'session_meta') throw new Error('Codex 首条记录必须是 session_meta')
          const meta = checked(codexSourceSchemas.meta, row.payload, 'Codex', line)
          if (meta.history_mode !== undefined && !['legacy', 'paginated'].includes(meta.history_mode) || meta.history_base != null || meta.forked_from_id != null) throw new UnsupportedSourceError('Codex 跨文件继承或未知历史模式尚未支持')
          if (meta.session_id !== undefined && meta.session_id !== meta.id) throw new Error('Codex 子会话 ID 与当前文件不一致')
          if (meta.history_mode === 'paginated') {
            if (row.ordinal !== 0) throw new Error('Codex 分页日志必须从序号 0 开始')
            expectedOrdinal = 1
          }
          id = meta.id; updatedAt = Math.max(updatedAt, Date.parse(meta.timestamp))
          if (isCodexSubagent(meta)) { activity.presentation.kind = 'subagent'; warnings.add('子会话只显示当前文件内容；继承上下文可能缺失，不读取父会话。') }
          activity.presentation.omittedRecords += 1
          return
        }
        if (row.type === 'session_meta') throw new Error('Codex 重复 session_meta，不能混合会话')
        if (row.type === 'response_item') {
          const response = checked(codexSourceSchemas.response, row.payload, 'Codex', line)
          if (response.type !== 'message') {
            if (['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call'].includes(response.type)) activity.add('call', row.payload.call_id ?? row.payload.id, row.payload.name ?? response.type, row.payload.arguments ?? row.payload.input ?? row.payload.action)
            else if (['function_call_output', 'custom_tool_call_output'].includes(response.type)) {
              const output = row.payload.output
              activity.add('result', row.payload.call_id, undefined, typeof output === 'string' ? output : Array.isArray(output) ? output.flatMap(block => object(block).type === 'input_text' && typeof object(block).text === 'string' ? [object(block).text as string] : []).join('\n') : '')
            } else activity.presentation.omittedRecords += 1
            return
          }
          const message = checked(codexSourceSchemas.message, row.payload, 'Codex', line)
          remember(message.id); rawMessages += 1
          // 即使来源视图省略系统消息，仍验证其结构，不用省略规则隐藏损坏记录。
          const content = recordText(source, record, line)
          for (const block of message.content) if (!['input_text', 'output_text'].includes(String(block.type))) activity.presentation.attachments += 1
          if (message.encrypted_content != null) warnings.add('存在加密内容，仅显示明文和占位符，不尝试解密。')
          if (message.phase != null || message.status != null && message.status !== 'completed') warnings.add('消息阶段或完成状态只作原记录说明，不把部分回答当作任务完成。')
          if (message.role === 'system' || message.role === 'developer') { omittedContext += 1; return }
          if (message.role === 'user' && !content.trim()) { omittedContext += 1; return }
          budget.add(); messages.push(descriptor(line, content, message.role))
          if (!firstPrompt && message.role === 'user') firstPrompt = sourcePromptTitle(content, source)
        } else {
          activity.presentation.omittedRecords += 1
          if (row.type === 'event_msg') {
            const event = checked(codexSourceSchemas.event, row.payload, 'Codex', line)
            if (event.type === 'thread_rolled_back') { checked(z.number().int().nonnegative(), row.payload.num_turns, 'Codex', line); warnings.add('日志包含回退，仍按追加日志展示，不保证是当前有效分支。') }
          }
          if (row.type === 'compacted') { checked(z.string(), row.payload.message, 'Codex', line); warnings.add('压缩摘要与 replacement_history 不作为新消息，不表示压缩后的完整上下文。') }
        }
      } else {
        if (!id) {
          const header = checked(deepseekSourceSchemas.header, record, 'DeepSeek', line)
          id = header.id; updatedAt = header.createdAt
          return
        }
        const event = checked(deepseekSourceSchemas.event, record, 'DeepSeek', line)
        if (event.seq !== nextSeq++) throw new Error('DeepSeek 日志序号不连续')
        updatedAt = Math.max(updatedAt, event.time)
        if (event.type === 'session/title') { title = checked(z.string().trim().min(1).max(200), event.data.title, 'DeepSeek', line); return }
        if (event.type !== 'user/message' && event.type !== 'assistant/message') return
        if (event.surfaceOp !== 'append') throw new Error('DeepSeek 消息缺少 append 操作')
        if (event.type === 'user/message') {
          const origin = checked(z.object({ kind: z.string().min(1).max(100) }), event.data.source, 'DeepSeek', line)
          if (origin.kind !== 'user') { warnings.add('运行时注入或非用户主动输入的消息不进入正文。'); return }
        }
        const message = checked(deepseekSourceSchemas.message, event.type === 'user/message' ? event.data : event.data.message, 'DeepSeek', line)
        if (message.role !== (event.type === 'user/message' ? 'user' : 'assistant')) throw new Error('DeepSeek 消息角色不一致')
        remember(message.id)
        const content = recordText(source, record, line)
        if (message.content.some(block => block.type !== 'text')) warnings.add('推理、工具和多模态块未作为问答展示，仍保留在原件。')
        if (content.trim()) {
          budget.add(); messages.push(descriptor(line, content, message.role))
          if (!firstPrompt && message.role === 'user') firstPrompt = sourcePromptTitle(content, source)
        }
      }
    },
    finish() {
      if (!id || (source === 'codex' ? !rawMessages : !messages.length)) throw new Error(`${source} 日志没有可投影的用户或助手文本`)
      activity.presentation.textMessages = messages.length
      if (source === 'codex') {
        warnings.add(`来源阅读视图省略系统／开发者与纯注入上下文：${omittedContext} 条。原记录仍在来源文件，档案导入规则未改变。`)
        if (!messages.length) warnings.add('排除上下文后没有可显示的用户或助手消息；不使用工具、事件副本或压缩摘要伪造问答。')
      }
      return { messages, warnings: [...warnings], session: session(source, id, title || firstPrompt || `${source} · ${id.slice(0, 8)}`, updatedAt),
        ...(source === 'codex' ? { presentation: activity.presentation } : {}) }
    },
  }
}

type ClaudeNode = Pick<z.infer<typeof claudeSourceSchemas.node>, 'uuid' | 'parentUuid' | 'type' | 'isSidechain' | 'isMeta' | 'apiBlockIndex'> & {
  time: number; line: number; text?: IndexedMessage; messageId?: string; messageValid: boolean; browserTask: boolean
  counts: { calls: number; results: number; attachments: number; omitted: number }
}
function claudeIndexer(): LogIndexer {
  const budget = new Budget(), origin = new ClaudeLogOrigin(), nodes = new Map<string, ClaudeNode>(), versions = new Set<string>()
  const warnings = new Set(commonWarnings)
  let last: ClaudeNode | undefined, id = '', hasRecord = false, hasJournal = false
  return {
    accept(record, line) {
      hasRecord = true; origin.observe(record)
      if (claudeSourceSchemas.metadata.has(String(record.type))) return
      if (!('message' in record) && !('uuid' in record) && !('sessionId' in record) && isClaudeAuxiliaryLog(JSON.stringify(record))) { hasJournal = true; return }
      const parsed = checked(claudeSourceSchemas.node, record, 'Claude Code', line)
      const { message: rawMessage, ...header } = parsed
      if (header.isCompactSummary || header.isVisibleInTranscriptOnly || header.logicalParentUuid != null || header.subtype === 'compact_boundary') throw new UnsupportedSourceError('Claude 压缩或逻辑父链边界尚未支持')
      if (nodes.has(header.uuid)) throw new Error('Claude UUID 重复，不能猜测快照或重放')
      if (id && id !== header.sessionId) throw new Error('Claude 混合多个会话')
      id = header.sessionId
      if (header.version) versions.add(header.version)
      if (versions.size > 4) throw new Error('Claude 版本声明过多')
      // 不能把 message、subtype 或其他大字段留在结构索引中，只保存父链所需的短 ID 与标量。
      const node: ClaudeNode = { uuid: header.uuid, parentUuid: header.parentUuid, type: header.type, isSidechain: header.isSidechain,
        isMeta: header.isMeta, apiBlockIndex: header.apiBlockIndex, time: Date.parse(header.timestamp), line,
        counts: { calls: 0, results: 0, attachments: 0, omitted: 0 }, messageValid: true, browserTask: false }
      if (header.type === 'user' || header.type === 'assistant') {
        const message = claudeSourceSchemas.message.safeParse(rawMessage)
        node.messageValid = message.success && message.data.role === header.type
        if (message.success) {
          node.messageId = message.data.id
          if (header.type === 'assistant' && !header.isMeta && (!message.data.id || typeof message.data.content === 'string')) node.messageValid = false
          if (!header.isMeta) {
            let text = ''
            try { text = recordText('claude-code', record, line) } catch { node.messageValid = false }
            if (text.trim()) node.text = descriptor(line, text, header.type)
            node.browserTask = header.type === 'user' && isBrowserTask(text)
            if (Array.isArray(message.data.content)) for (const block of message.data.content) {
              if (block.type === 'tool_use') node.counts.calls += 1
              else if (block.type === 'tool_result') node.counts.results += 1
              else if (['image', 'document', 'audio'].includes(String(block.type))) node.counts.attachments += 1
              else if (block.type !== 'text') node.counts.omitted += 1
            }
          } else node.counts.omitted += 1
        }
        last = node
      } else if (header.type === 'attachment') node.counts.attachments += 1
      else node.counts.omitted += 1
      budget.add(header.uuid.length + (header.parentUuid?.length ?? 0) + (node.messageId?.length ?? 0) + 100)
      nodes.set(header.uuid, node)
    },
    finish() {
      if (origin.value(true) === 'sdk') throw new UnsupportedSourceError(sdkOriginReason)
      if (!nodes.size && hasRecord) throw new UnsupportedSourceError(claudeAuxiliaryReason)
      if (hasJournal) throw new Error('Claude 日志混合任务流水与会话节点，未猜测会话结构')
      if (!last || !id) throw new Error('Claude 日志没有可投影的用户或助手消息')
      const validated = new Set<string>()
      let roots = 0
      for (const node of nodes.values()) {
        if (node.parentUuid === null) roots += 1
        const visited = new Set<string>()
        let current: ClaudeNode | undefined = node
        while (current && !validated.has(current.uuid)) {
          if (visited.has(current.uuid)) throw new Error('Claude 父链存在循环')
          visited.add(current.uuid)
          if (current.parentUuid === null) break
          const parent: ClaudeNode | undefined = nodes.get(current.parentUuid)
          if (!parent) throw new Error('Claude 父链缺失或引用外部历史；不读取引用文件')
          current = parent
        }
        for (const uuid of visited) validated.add(uuid)
      }
      if (roots !== 1) throw new Error('Claude 日志不是单根父链')
      const chain: ClaudeNode[] = []
      for (let node: ClaudeNode | undefined = last; node; node = node.parentUuid === null ? undefined : nodes.get(node.parentUuid)) chain.push(node)
      chain.reverse()
      if (chain.length !== nodes.size) warnings.add(`当前父链之外的 ${nodes.size - chain.length} 个节点未加入正文或工具活动。`)
      const messages: IndexedMessage[] = [], assistantIndices = new Map<string, number | undefined>(), activity = new SourceActivities(), tools = new Map<number, number>()
      let previousAssistant: string | undefined, previousOutput: string | undefined, remainingTools = 100, updatedAt = 0
      for (const node of chain) {
        updatedAt = Math.max(updatedAt, node.time)
        if (node.isSidechain) {
          activity.presentation.kind = 'subagent'
          warnings.add('子会话仅展示当前文件内可验证的单父链；不读取父会话或继承上下文，不拼接主对话。')
        }
        if (node.browserTask) activity.presentation.kind = 'browser-task'
        activity.presentation.toolCalls += node.counts.calls; activity.presentation.toolResults += node.counts.results
        activity.presentation.attachments += node.counts.attachments; activity.presentation.omittedRecords += node.counts.omitted
        const take = Math.min(remainingTools, node.counts.calls + node.counts.results)
        if (take) { tools.set(node.line, take); remainingTools -= take }
        if (node.type !== 'user' && node.type !== 'assistant') continue
        if (!node.messageValid) throw new Error('Claude 消息字段、角色、助手 ID 或内容块结构无效')
        if (node.isMeta) continue
        if (node.type === 'assistant') {
          if (assistantIndices.has(node.messageId!)) {
            const previous = assistantIndices.get(node.messageId!)
            if (previous === undefined && node.apiBlockIndex === undefined && previousAssistant === node.messageId) warnings.add('旧版助手缺少追加块索引，保留独立文本片段，不猜测合并或去重。')
            else if (previous === undefined || node.apiBlockIndex === undefined || node.apiBlockIndex <= previous || previousAssistant !== node.messageId) throw new Error('Claude 助手重复消息的追加块索引缺失、重放或顺序不明')
          }
          assistantIndices.set(node.messageId!, node.apiBlockIndex); previousAssistant = node.messageId
        } else previousAssistant = undefined
        if (!node.text) { if (node.type === 'user') previousOutput = undefined; continue }
        const tail = messages.at(-1)
        if (node.type === 'assistant' && tail?.role === 'assistant' && previousOutput === node.messageId && node.apiBlockIndex !== undefined) {
          tail.length += 1 + node.text.length; tail.parts.push(...node.text.parts)
        } else messages.push({ ...node.text, parts: [...node.text.parts] })
        previousOutput = node.type === 'assistant' ? node.messageId : undefined
      }
      if (!messages.length && !activity.presentation.toolCalls && !activity.presentation.toolResults && !activity.presentation.attachments) throw new Error('Claude 父链没有可显示的用户或助手文本')
      activity.presentation.textMessages = messages.length
      activity.presentation.activitiesTruncated = activity.presentation.toolCalls + activity.presentation.toolResults > 100
      warnings.add('Claude 仍校验完整 UUID 图和末条消息单父链；不混合兄弟分支、离链块或外部历史。')
      return { messages, tools, presentation: activity.presentation, warnings: [...warnings], session: session('claude-code', id, id.slice(0, 8), updatedAt) }
    },
  }
}

/** 只保留最多 count 个工具预览；参数和结果在这里就裁到 1025 字符，避免保留完整大记录。 */
export function claudeToolEvents(record: LogRecord, count: number): ToolEvent[] {
  const blocks = object(record.message).content
  if (!Array.isArray(blocks)) return []
  const events: ToolEvent[] = []
  for (const value of blocks) {
    const block = object(value)
    if (!['tool_use', 'tool_result'].includes(String(block.type))) continue
    const kind = block.type === 'tool_use' ? 'call' : 'result'
    const raw = kind === 'call' ? block.input : typeof block.content === 'string' ? block.content : Array.isArray(block.content)
      ? block.content.flatMap(part => object(part).type === 'text' && typeof object(part).text === 'string' ? [object(part).text as string] : []).join('\n') : ''
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
    const id = kind === 'call' ? block.id : block.tool_use_id
    events.push({ kind, ...(typeof id === 'string' && id.length <= 512 ? { id } : {}), ...(typeof block.name === 'string' ? { name: block.name.slice(0, 100) } : {}), content: text.slice(0, 1025) })
    if (events.length >= count) break
  }
  return events
}
