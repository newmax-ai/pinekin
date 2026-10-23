import { basename } from 'node:path'
import { codexSourceSchemas, codexUnsupportedReason, isCodexSubagent } from '../main/codex'
import { codexUserText } from '../main/source-conversation'
import { withSourceLog, type LogRecord } from '../main/source-log-file'
import { sourcePromptTitle } from '../core/source-presentation'
import { PinekinUnsupportedError, TranscriptBuilder, stringify } from './blocks'
import { aborted, fileRevision, readFirstRecord, walkLogs, workingDirectory } from './files'
import type { ReadOptions, SessionRef, Transcript, TranscriptBlock } from './types'

const logName = /^rollout-.+\.jsonl(?:\.(?:zst|zstd))?$/

/** sessions 按 YYYY/MM/DD 分层，archived_sessions 是平铺目录；只认 rollout-*.jsonl。 */
export async function* listCodex(roots: string[], signal?: AbortSignal): AsyncGenerator<SessionRef> {
  for (const root of roots) {
    for await (const log of walkLogs(root, { maxDepth: 3, signal, descend: (_dir, name) => /^\d{2,4}$/.test(name), accept: (_dir, name) => logName.test(name) })) {
      aborted(signal)
      const first = await readFirstRecord(log.path, log.compressed)
      const base: Omit<SessionRef, 'sessionId' | 'kind'> = { source: 'codex', path: log.path, root: log.root, compressed: log.compressed,
        revision: fileRevision(log.stat), updatedAt: new Date(log.stat.mtimeMs).toISOString() }
      const meta = first?.type === 'session_meta' ? codexSourceSchemas.meta.safeParse(first.payload) : undefined
      if (!meta?.success) {
        yield { ...base, sessionId: basename(log.path), kind: 'conversation', unsupportedReason: '首条记录不是有效的 Codex session_meta' }
        continue
      }
      const reason = codexUnsupportedReason(meta.data)
      yield { ...base, sessionId: meta.data.id, workingDirectory: workingDirectory(meta.data.cwd),
        kind: isCodexSubagent(meta.data) ? 'subagent' : 'conversation', ...(reason ? { unsupportedReason: reason } : {}) }
    }
  }
}

const callTypes = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call'])
const resultTypes = new Set(['function_call_output', 'custom_tool_call_output'])

function toolOutput(value: unknown): { output: string; isError?: boolean } {
  if (typeof value === 'string') return { output: value }
  if (Array.isArray(value)) {
    return { output: value.flatMap(item => item && typeof item === 'object' && typeof (item as LogRecord).text === 'string' ? [(item as LogRecord).text as string] : []).join('\n') }
  }
  if (value && typeof value === 'object') {
    const record = value as LogRecord
    const inner = typeof record.content === 'string' ? record.content : stringify(value)
    return { output: inner, ...(record.success === false ? { isError: true } : {}) }
  }
  return { output: stringify(value) }
}

function reasoningText(payload: LogRecord): string {
  // 优先使用明文推理正文；没有时退回摘要；只有加密内容时不输出任何文字。
  const pick = (value: unknown, kind: string) => Array.isArray(value)
    ? value.flatMap(item => item && typeof item === 'object' && (item as LogRecord).type === kind && typeof (item as LogRecord).text === 'string' ? [(item as LogRecord).text as string] : []).join('\n\n')
    : ''
  return pick(payload.content, 'reasoning_text') || pick(payload.summary, 'summary_text')
}

export async function readCodex(ref: SessionRef, options: ReadOptions, engineVersion: string): Promise<Transcript> {
  if (ref.unsupportedReason) throw new PinekinUnsupportedError(ref.unsupportedReason)
  const authorized = () => !options.signal?.aborted
  return withSourceLog(ref.path, ref.root, ref.compressed, authorized, async scan => {
    const builder = new TranscriptBuilder()
    const warnings = new Set<string>()
    let meta: ReturnType<typeof codexSourceSchemas.meta.parse> | undefined
    let createdAt = Infinity, updatedAt = -Infinity, title = '', calls = 0, expectedOrdinal: number | undefined
    await scan((record, line) => {
      const row = codexSourceSchemas.record.safeParse(record)
      if (!row.success) throw new Error(`Codex 第 ${line} 行字段无效或类型不支持`)
      const { type, payload, timestamp } = row.data
      if (expectedOrdinal !== undefined && row.data.ordinal !== expectedOrdinal++) throw new Error('Codex 分页序号缺失或不连续')
      const time = Date.parse(timestamp)
      createdAt = Math.min(createdAt, time); updatedAt = Math.max(updatedAt, time)
      if (!meta) {
        if (type !== 'session_meta') throw new Error('Codex 首条记录必须是 session_meta')
        const parsed = codexSourceSchemas.meta.safeParse(payload)
        if (!parsed.success) throw new Error('Codex session_meta 字段无效')
        const reason = codexUnsupportedReason(parsed.data)
        if (reason) throw new PinekinUnsupportedError(reason)
        if (parsed.data.history_mode === 'paginated') {
          if (row.data.ordinal !== 0) throw new Error('Codex 分页日志必须从序号 0 开始')
          expectedOrdinal = 1
        }
        meta = parsed.data
        return
      }
      if (type === 'session_meta') throw new Error(`Codex 第 ${line} 行重复 session_meta，不能混合多个会话`)
      if (type === 'compacted') { warnings.add('日志包含上下文压缩：压缩摘要不作为消息导入，压缩前的原始记录照常保留。'); return }
      if (type === 'event_msg') {
        if (payload.type === 'thread_rolled_back') warnings.add('日志包含回退：已写入的消息全部保留，不计算当前有效分支。')
        return
      }
      if (type !== 'response_item') return
      const kind = typeof payload.type === 'string' ? payload.type : ''
      if (kind === 'message') {
        const message = codexSourceSchemas.message.safeParse(payload)
        if (!message.success) throw new Error(`Codex 第 ${line} 行消息字段无效`)
        const { role, content } = message.data
        if (role === 'system' || role === 'developer') return
        if (message.data.encrypted_content != null) warnings.add('存在加密消息内容：未尝试解密，只保留已有明文。')
        const texts: string[] = [], attachments: TranscriptBlock[] = []
        for (const block of content) {
          if ((block.type === 'input_text' || block.type === 'output_text') && typeof block.text === 'string') texts.push(block.text)
          else if (block.type === 'input_image') attachments.push({ type: 'attachment', kind: 'image', note: '图片附件未随记录迁移' })
          else attachments.push({ type: 'attachment', kind: 'other', note: '未映射的内容块' })
        }
        if (role === 'user') {
          const text = codexUserText(texts.join('\n'))
          if (!title && text.trim()) title = sourcePromptTitle(text, 'codex')
          builder.user(timestamp, [{ type: 'text', text }, ...(text.trim() ? attachments : [])])
        } else {
          builder.assistant(timestamp, { type: 'text', text: texts.join('\n') })
          for (const attachment of attachments) builder.assistant(timestamp, attachment)
        }
      } else if (kind === 'reasoning') {
        builder.assistant(timestamp, { type: 'thinking', text: reasoningText(payload) })
      } else if (callTypes.has(kind)) {
        const id = typeof payload.call_id === 'string' ? payload.call_id : typeof payload.id === 'string' ? payload.id : `codex-call-${calls}`
        calls += 1
        const name = typeof payload.name === 'string' && payload.name ? payload.name : kind === 'local_shell_call' ? 'local_shell' : kind === 'web_search_call' ? 'web_search' : kind
        const input = kind === 'function_call' ? stringify(payload.arguments) : kind === 'custom_tool_call' ? stringify(payload.input) : stringify(payload.action)
        builder.assistant(timestamp, { type: 'tool_call', id, name, input })
      } else if (resultTypes.has(kind)) {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : ''
        builder.assistant(timestamp, { type: 'tool_result', callId, ...toolOutput(payload.output) })
      }
    })
    if (!meta) throw new Error('Codex 日志为空')
    const messages = builder.finish()
    if (!messages.some(message => message.role === 'user')) throw new PinekinUnsupportedError('Codex 会话没有可显示的用户消息')
    return {
      format: 'pinekin.transcript', version: 1, engineVersion, source: 'codex', sessionId: meta.id,
      kind: isCodexSubagent(meta) ? 'subagent' : 'conversation',
      title: title || `Codex · ${meta.id.slice(0, 8)}`,
      workingDirectory: workingDirectory(meta.cwd), sourceVersion: meta.cli_version,
      createdAt: new Date(Math.min(createdAt, Date.parse(meta.timestamp))).toISOString(), updatedAt: new Date(updatedAt).toISOString(),
      revision: ref.revision, messages, warnings: [...warnings],
    }
  })
}
