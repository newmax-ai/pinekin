import { z } from 'zod'
import { sourcePromptTitle } from '../core/source-presentation'
import { sourceUserText } from '../core/source-user-content'
import { SourceActivities } from './source-activity'
import { UnsupportedSourceError } from './source-origin'
import type { LogRecord } from './source-log-file'
import type { IndexedMessage, LogIndex, LogIndexer } from './source-log-index'

// 独立于 Claude JSONL：字段契约来自 QwenLM/qwen-code 62c86c5 的 ChatRecord。
const key = z.string().min(1).max(512)
export const qwenNodeSchema = z.object({ uuid: key, parentUuid: key.nullable(), sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  timestamp: z.iso.datetime({ offset: true }), cwd: z.string().max(4096), version: z.string().min(1).max(100),
  type: z.enum(['user', 'assistant', 'tool_result', 'system']), subtype: z.string().max(100).optional(),
  provenance: z.string().max(100).optional(), isSidechain: z.boolean().optional(), forkedFrom: z.unknown().optional(),
  message: z.object({ role: z.enum(['user', 'model']), parts: z.array(z.record(z.string(), z.unknown())) }).optional(),
  systemPayload: z.record(z.string(), z.unknown()).optional(),
})
export const qwenMetadataSubtypes = new Set(['custom_title', 'session_source', 'session_model', 'session_approval_mode', 'session_execution_engine',
  'ui_telemetry', 'at_command', 'attribution_snapshot', 'file_history_snapshot', 'user_text_elements', 'turn_result', 'turn_attempt',
  'session_artifact_event', 'session_artifact_snapshot', 'session_sources_snapshot', 'slash_command', 'omni_recall'])
export const qwenUnsupportedSubtypes = new Set(['rewind', 'chat_compression', 'parent_session', 'branch_checkpoint'])
type Node = { uuid: string; parent: string | null; type: string; time: number; text?: IndexedMessage; prompt?: string;
  calls: number; results: number; attachments: number; omitted: number }

function parse(record: LogRecord, line: number) {
  const result = qwenNodeSchema.safeParse(record)
  if (!result.success) throw new Error(`Qwen Code 第 ${line} 行字段无效或类型不支持`)
  return result.data
}
export function qwenRecordText(record: LogRecord, line: number): string {
  const row = parse(record, line)
  if (!row.message) return ''
  const content = row.message.parts.flatMap(part => {
    if (part.text !== undefined && typeof part.text !== 'string') throw new Error(`Qwen Code 第 ${line} 行 text 字段无效`)
    if (part.thought !== undefined && typeof part.thought !== 'boolean') throw new Error(`Qwen Code 第 ${line} 行 thought 字段无效`)
    return typeof part.text === 'string' && part.thought !== true ? [part.text] : []
  }).join('\n')
  return sourceUserText(content, 'qwen-code', row.type === 'assistant' ? 'assistant' : 'user')
}

/** 全文件验证 UUID 图，只保留短标识、文本长度与行号，不缓存正文或沿引用读文件。 */
export function createQwenIndexer(): LogIndexer {
  const nodes = new Map<string, Node>()
  let id = '', title = '', last: Node | undefined, used = 0
  return {
    accept(record, line) {
      const row = parse(record, line)
      if (nodes.has(row.uuid)) throw new Error('Qwen Code UUID 重复，未猜测重放或修订')
      if (id && id !== row.sessionId) throw new Error('Qwen Code 混合多个会话')
      id = row.sessionId
      if (row.isSidechain || row.forkedFrom != null || row.subtype && (qwenUnsupportedSubtypes.has(row.subtype) || row.subtype.startsWith('managed_session_'))) {
        throw new UnsupportedSourceError('Qwen Code 分叉、子会话、回退、压缩或托管会话边界尚未支持')
      }
      if (row.type === 'system' && (!row.subtype || !qwenMetadataSubtypes.has(row.subtype))) throw new UnsupportedSourceError('Qwen Code 未知系统事件的历史语义尚未支持')
      const node: Node = { uuid: row.uuid, parent: row.parentUuid, type: row.type, time: Date.parse(row.timestamp), calls: 0, results: 0, attachments: 0, omitted: 0 }
      if (row.type === 'system') {
        node.omitted += 1
        if (row.subtype === 'custom_title') {
          const value = row.systemPayload?.customTitle
          if (typeof value !== 'string' || !value.trim()) throw new Error('Qwen Code 自定义标题无效')
          title = Array.from(value.trim()).slice(0, 200).join('')
        }
      } else {
        if (!row.message || row.message.role !== (row.type === 'assistant' ? 'model' : 'user')) throw new Error('Qwen Code 消息角色与内容结构不一致')
        const text = qwenRecordText(record, line)
        for (const part of row.message.parts) {
          if (part.functionCall) node.calls += 1
          else if (part.functionResponse) node.results += 1
          else if (part.inlineData || part.fileData) node.attachments += 1
          else if (part.thought === true || typeof part.text !== 'string') node.omitted += 1
        }
        // 通知、Agent 注入、定时任务与运行时提示不冒充真实用户输入。
        const visible = row.type === 'assistant' || row.type === 'user' && !row.subtype && (row.provenance === undefined || row.provenance === 'real_user')
        if (visible && text.trim()) {
          let length = 0; for (const _ of text) length += 1
          node.text = { role: row.type as 'user' | 'assistant', length, parts: [{ line, length }] }
          if (row.type === 'user') node.prompt = sourcePromptTitle(text, 'qwen-code')
        } else node.omitted += 1
        last = node
      }
      used += 256 + (row.uuid.length + (row.parentUuid?.length ?? 0) + (node.prompt?.length ?? 0)) * 2
      if (used > 32 * 1024 * 1024) throw new Error('Qwen Code 结构索引超过 32 MiB 工作预算；保留列表，可重试')
      nodes.set(row.uuid, node)
    },
    finish(): LogIndex {
      if (!last || !id) throw new Error('Qwen Code 没有可投影的问答记录')
      let roots = 0
      const validated = new Set<string>()
      for (const node of nodes.values()) {
        if (node.parent === null) roots += 1
        const visited = new Set<string>()
        let current: Node | undefined = node
        while (current && !validated.has(current.uuid)) {
          if (visited.has(current.uuid)) throw new Error('Qwen Code 父链循环')
          visited.add(current.uuid)
          if (current.parent === null) break
          current = nodes.get(current.parent)
          if (!current) throw new Error('Qwen Code 父链缺失，不读取外部历史引用')
        }
        for (const uuid of visited) validated.add(uuid)
      }
      if (roots !== 1) throw new Error('Qwen Code 不是完整单根父链')
      const chain: Node[] = []
      for (let node: Node | undefined = last; node; node = node.parent === null ? undefined : nodes.get(node.parent)) chain.push(node)
      chain.reverse()
      const selected = new Set(chain.map(node => node.uuid))
      if ([...nodes.values()].some(node => node.type !== 'system' && !selected.has(node.uuid))) throw new UnsupportedSourceError('Qwen Code 多分支会话尚未支持，不混合旁支问答')
      const activity = new SourceActivities(), messages: IndexedMessage[] = []
      let prompt = '', time = 0
      for (const node of chain) {
        time = Math.max(time, node.time)
        activity.presentation.toolCalls += node.calls; activity.presentation.toolResults += node.results
        activity.presentation.attachments += node.attachments; activity.presentation.omittedRecords += node.omitted
        if (node.text) messages.push(node.text)
        if (!prompt && node.prompt) prompt = node.prompt
      }
      if (!messages.length) throw new UnsupportedSourceError('Qwen Code 仅有工具或辅助记录，没有可显示的用户或助手文本')
      activity.presentation.textMessages = messages.length
      activity.presentation.activitiesTruncated = activity.presentation.toolCalls + activity.presentation.toolResults > 0
      return { messages, presentation: activity.presentation,
        session: { id, source: 'qwen-code', title: title || prompt || `Qwen Code · ${id.slice(0, 8)}`, updatedAt: new Date(time).toISOString(), tags: ['Qwen Code', '文本投影'], demo: false },
        warnings: ['Qwen Code 仅验证独立主会话的完整单根父链文本；不是原生恢复，不写入来源，也不保存正文副本。',
          '推理、工具参数与结果、附件及运行时注入不作为问答；工具仅计数，不执行历史命令，不沿文件路径或外部会话引用读取。',
          '分叉、子会话、回退、压缩及托管历史尚未支持；未知格式保留诊断。每次最多 100 条文本、每条 16,384 个 Unicode 码点。'] }
    },
  }
}
