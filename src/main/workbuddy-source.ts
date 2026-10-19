import { z } from 'zod'
import { sourcePromptTitle } from '../core/source-presentation'
import { sourceUserText } from '../core/source-user-content'
import { SourceActivities } from './source-activity'
import { UnsupportedSourceError } from './source-origin'
import { workbuddyMetaSubset, type WorkbuddyMetadata } from './workbuddy-metadata'
import type { LogRecord } from './source-log-file'
import type { IndexedMessage, LogIndex, LogIndexer } from './source-log-index'

// 来自官方 WorkBuddy 5.8.3 分发包，不能用 Claude parentUuid 或独立 CodeBuddy 目录替代。
const key = z.string().min(1).max(512)
// 标题等辅助记录可以不带 ID；正文节点在进入父链前另行要求 ID。
const schema = z.object({ id: key.optional(), type: z.string().min(1).max(100), parentId: key.nullable().optional(), logicalParentId: key.nullable().optional(),
  timestamp: z.union([z.number().finite(), z.iso.datetime({ offset: true })]).optional(), sessionId: key.optional(),
  role: z.enum(['user', 'assistant', 'system', 'developer']).optional(), content: z.array(z.record(z.string(), z.unknown())).optional(),
  providerData: z.record(z.string(), z.unknown()).optional(), meta: z.record(z.string(), z.unknown()).optional(),
  customTitle: z.string().optional(), aiTitle: z.string().optional(), topic: z.string().optional(), callId: key.optional(),
})
const customTypes = new Set(['custom-title', 'ai-title', 'file-history-snapshot', 'summary', 'topic', 'goal-result', 'goal-progress', 'turn-metrics', 'acp-terminal-state', 'model-usage', 'credit-usage'])
const bodyTypes = new Set(['message', 'function_call', 'function_call_output', 'function_call_result', 'reasoning'])
export interface WorkbuddyContext { fileId?: string; meta?: WorkbuddyMetadata }
type Node = { id: string; parent?: string | null; line: number; time: number; messages: IndexedMessage[]; prompt?: string;
  assistant: boolean; providerMessageId?: string; callIds: Set<string>;
  calls: number; results: number; attachments: number; omitted: number }
function parse(record: LogRecord, line: number) {
  const result = schema.safeParse(record)
  if (!result.success) throw new Error(`WorkBuddy 第 ${line} 行字段无效或类型不支持`)
  return result.data
}
function assertOrdinary(meta: WorkbuddyMetadata) {
  if (meta.isForkedCompactionSession || meta.forkedFrom != null || meta.forkedAt != null) throw new UnsupportedSourceError('WorkBuddy 分叉或压缩会话尚未支持，不拼接其他历史')
}
export function workbuddyRecordText(record: LogRecord, line: number): string {
  const row = parse(record, line)
  if (row.type !== 'message') return ''
  if (!row.content) throw new Error(`WorkBuddy 第 ${line} 行缺少消息内容数组`)
  const content = row.content.flatMap(block => {
    if (typeof block.type !== 'string') throw new Error(`WorkBuddy 第 ${line} 行内容块缺少类型`)
    if (!['input_text', 'output_text'].includes(block.type)) return []
    if (typeof block.text !== 'string') throw new Error(`WorkBuddy 第 ${line} 行文本块字段无效`)
    return [block.text]
  }).join('\n')
  return row.role === 'user' ? sourceUserText(content, 'workbuddy', 'user') : content
}
/** 同一助手消息的相邻文本／工具块共享节点 ID；不将重放或冲突 ID 静默去重。 */
export function createWorkbuddyIndexer(context: WorkbuddyContext = {}): LogIndexer {
  assertOrdinary(context.meta ?? {})
  const ids = new Set<string>(), nodes: Node[] = []
  let custom = '', generated = '', topic = '', runtimeId = '', used = 0
  const duplicateError = () => new Error('WorkBuddy 重复 ID 的节点不相邻、父节点或消息身份冲突，或存在重复工具调用；未猜测去重')
  return {
    accept(record, line) {
      const row = parse(record, line), data = row.providerData ?? {}
      const duplicate = row.id !== undefined && ids.has(row.id)
      used += 256 + ((row.id?.length ?? 0) + (row.parentId?.length ?? 0) + (row.callId?.length ?? 0) + (typeof data.messageId === 'string' ? data.messageId.length : 0)) * 2
      if (used > 32 * 1024 * 1024) throw new Error('WorkBuddy 结构索引超过 32 MiB 工作预算；保留列表，可重试')
      if (row.sessionId) {
        if (runtimeId && runtimeId !== row.sessionId) throw new Error('WorkBuddy 混合多个会话 ID')
        runtimeId = row.sessionId
        if (context.fileId && row.sessionId !== context.fileId) throw new UnsupportedSourceError('WorkBuddy 文件 ID 与运行时会话 ID 不同，子会话或外部历史尚未支持')
      }
      if (row.logicalParentId != null || row.type === 'resend-fork-notice' || data.contentFilterNotice || data.isCompactInternal || data.agent === 'compact') throw new UnsupportedSourceError('WorkBuddy 逻辑父链、压缩、重发回退或内容过滤分支尚未支持')
      if (row.type === 'session-meta' || customTypes.has(row.type)) {
        if (duplicate) throw duplicateError()
        if (row.id !== undefined) ids.add(row.id)
        if (row.type === 'session-meta') {
          if (!row.meta) throw new Error('WorkBuddy session-meta 缺少元数据对象')
          assertOrdinary(workbuddyMetaSubset(row.meta))
          return
        }
        const title = row.type === 'custom-title' ? row.customTitle : row.type === 'ai-title' ? row.aiTitle : row.type === 'topic' ? row.topic : undefined
        if (title?.trim()) {
          const short = Array.from(title.trim()).slice(0, 200).join('')
          if (row.type === 'custom-title') custom = short
          else if (row.type === 'ai-title' && !/^New (?:Chat|Session)$/i.test(short)) generated = short
          else if (row.type === 'topic' && !/^New (?:Chat|Session)$/i.test(short)) topic = short
        }
        return
      }
      if (!bodyTypes.has(row.type)) throw new Error(`WorkBuddy 第 ${line} 行类型 ${row.type} 尚未支持`)
      if (!row.id) throw new Error(`WorkBuddy 第 ${line} 行正文节点缺少记录 ID；不猜测父链或生成替代 ID`)
      const time = typeof row.timestamp === 'number' ? row.timestamp : Date.parse(row.timestamp ?? '')
      if (!Number.isFinite(time) || !Number.isFinite(new Date(time).getTime())) throw new Error('WorkBuddy 消息时间无效')
      const node: Node = { id: row.id, parent: row.parentId, line, time, messages: [], calls: 0, results: 0, attachments: 0, omitted: 0,
        assistant: row.type === 'message' && row.role === 'assistant' || row.type === 'function_call' && !!row.callId || row.type === 'reasoning',
        providerMessageId: typeof data.messageId === 'string' ? key.parse(data.messageId) : undefined,
        callIds: new Set(row.type === 'function_call' && row.callId ? [row.callId] : []) }
      if (row.type === 'message') {
        if (!row.role) throw new Error('WorkBuddy 消息缺少角色')
        const text = workbuddyRecordText(record, line)
        const teammate = data.teammateMessage
        const injected = !!data.isMeta || row.role === 'user' && (!!data.skipRun || !!teammate && typeof teammate === 'object' && typeof (teammate as LogRecord).from === 'string')
        if ((row.role === 'user' || row.role === 'assistant') && !injected && text.trim()) {
          let length = 0; for (const _ of text) length += 1
          node.messages.push({ role: row.role, length, parts: [{ line, length }] })
          if (row.role === 'user') node.prompt = sourcePromptTitle(text, 'workbuddy')
        } else node.omitted += 1
        node.attachments = row.content!.filter(block => ['input_image', 'image', 'input_file', 'file', 'audio'].includes(String(block.type))).length
      } else if (row.type === 'function_call') node.calls += 1
      else if (row.type === 'function_call_output' || row.type === 'function_call_result') node.results += 1
      else node.omitted += 1
      if (duplicate) {
        const previous = nodes.at(-1)
        if (!previous || previous.id !== row.id || !previous.assistant || !node.assistant ||
          (previous.parent ?? null) !== (node.parent ?? null) ||
          previous.providerMessageId !== node.providerMessageId || [...node.callIds].some(id => previous.callIds.has(id))) throw duplicateError()
        // 官方保留组内各块的原始顺序，不把同 ID 文本覆盖或拼成快照。
        previous.messages.push(...node.messages)
        previous.calls += node.calls; previous.attachments += node.attachments; previous.omitted += node.omitted
        previous.time = Math.max(previous.time, node.time)
        for (const id of node.callIds) previous.callIds.add(id)
      } else {
        ids.add(row.id)
        nodes.push(node)
      }
    },
    finish(): LogIndex {
      if (!nodes.length) throw new UnsupportedSourceError('WorkBuddy 只有辅助记录，没有可显示的普通会话')
      // 官方旧日志可没有 parentId；若出现父链，则不允许缺失节点或多个有效分支。
      if (nodes.some(node => node.parent != null)) {
        for (let index = 0; index < nodes.length; index++) {
          const expected = index ? nodes[index - 1].id : undefined
          if (nodes[index].parent != null ? nodes[index].parent !== expected : index !== 0) throw new Error('WorkBuddy 父链缺失、循环或多分支；暂不猜测重排或有效分支')
        }
      }
      const messages = nodes.flatMap(node => node.messages), activity = new SourceActivities()
      if (!messages.length) throw new UnsupportedSourceError('WorkBuddy 只有工具或注入内容，没有可显示的用户或助手文本')
      for (const node of nodes) {
        activity.presentation.toolCalls += node.calls; activity.presentation.toolResults += node.results
        activity.presentation.attachments += node.attachments; activity.presentation.omittedRecords += node.omitted
      }
      activity.presentation.textMessages = messages.length
      activity.presentation.activitiesTruncated = activity.presentation.toolCalls + activity.presentation.toolResults > 0
      const title = custom || generated || topic || nodes.find(node => node.prompt)?.prompt || `WorkBuddy · ${(runtimeId || context.fileId || '会话').slice(0, 16)}`
      return { messages, presentation: activity.presentation,
        session: { id: 'workbuddy-preview', source: 'workbuddy', title, updatedAt: new Date(nodes.reduce((latest, node) => Math.max(latest, node.time), 0)).toISOString(), tags: ['WorkBuddy', '文本投影'], demo: false },
        warnings: ['按官方 WorkBuddy 5.8.3 macOS arm64 分发包中的字段契约核对；未探测本机安装版本，不代表跨版本或真实会话验收。',
          '仅普通主会话文本阅读，不是原生恢复；支持相邻同 ID 的助手文本、工具与推理块，分叉、压缩、逻辑父链、重发回退、子会话与非相邻重复 ID 尚未支持。',
          '正文按有界窗口读取，推理、工具参数与结果、附件和内部注入不作为问答；不执行历史命令，不读取引用文件、不复制数据库或保存正文副本。'] }
    },
  }
}
