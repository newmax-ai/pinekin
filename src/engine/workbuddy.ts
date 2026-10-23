import { basename } from 'node:path'
import { withSourceLog, type LogRecord } from '../main/source-log-file'
import { UnsupportedSourceError } from '../main/source-origin'
import { readWorkbuddyMetadata, workbuddyRevision, type WorkbuddyMetadata } from '../main/workbuddy-metadata'
import { createWorkbuddyIndexer, workbuddyForkReason, workbuddyInjectedMessage, workbuddyRecordText } from '../main/workbuddy-source'
import { PinekinUnsupportedError, TranscriptBuilder, iso, stringify } from './blocks'
import { aborted, fileRevision, walkLogs } from './files'
import type { ReadOptions, SessionRef, Transcript, TranscriptBlock } from './types'

const attachmentTypes: Record<string, 'image' | 'file' | 'other'> = { input_image: 'image', image: 'image', input_file: 'file', file: 'file', audio: 'other' }

/**
 * projects/<任务目录>/<会话 ID>.jsonl。目录名是 WorkBuddy 自建任务文件夹的转义结果，不可逆，所以不推断工作目录；
 * 云缓存（projects/cloud）、子代理目录和根级文件都不是普通本地主会话。
 */
export async function* listWorkbuddy(roots: string[], signal?: AbortSignal): AsyncGenerator<SessionRef> {
  for (const root of roots) {
    if (basename(root) === 'cloud') continue
    const logs = walkLogs(root, { maxDepth: 1, signal,
      descend: (_dir, name, depth) => depth === 0 && name !== 'cloud',
      accept: (directory, name) => name.endsWith('.jsonl') && !(directory === root && basename(root) === 'projects') })
    for await (const log of logs) {
      aborted(signal)
      let revision = fileRevision(log.stat), unsupportedReason: string | undefined
      try {
        const sidecar = await readWorkbuddyMetadata(log.path, log.root)
        revision = workbuddyRevision(revision, sidecar.revision)
        unsupportedReason = workbuddyForkReason(sidecar.meta)
      } catch (error) {
        // 侧车无法安全读取时按日志本身标记，修订号带上失败标识，侧车恢复后会重新评估。
        revision = workbuddyRevision(revision, 'unreadable')
        unsupportedReason = `WorkBuddy 会话侧车无法安全读取：${error instanceof Error ? error.message : String(error)}`
      }
      yield { source: 'workbuddy', sessionId: basename(log.path, '.jsonl'), path: log.path, root: log.root, compressed: false, revision,
        updatedAt: new Date(log.stat.mtimeMs).toISOString(), kind: 'conversation', ...(unsupportedReason ? { unsupportedReason } : {}) }
    }
  }
}

function time(record: LogRecord): number {
  const value = record.timestamp
  return typeof value === 'number' ? value : Date.parse(String(value))
}

export async function readWorkbuddy(ref: SessionRef, options: ReadOptions, engineVersion: string): Promise<Transcript> {
  if (ref.unsupportedReason) throw new PinekinUnsupportedError(ref.unsupportedReason)
  aborted(options.signal)
  const authorized = () => !options.signal?.aborted
  let meta: WorkbuddyMetadata
  try { meta = (await readWorkbuddyMetadata(ref.path, ref.root, authorized)).meta } catch (error) {
    if (error instanceof UnsupportedSourceError) throw new PinekinUnsupportedError(error.message)
    throw error
  }
  try {
    return await withSourceLog(ref.path, ref.root, false, authorized, async scan => {
      // 结构校验（父链、重复 ID、压缩／分叉／子会话边界）与 App 的来源浏览共用同一份索引器。
      const indexer = createWorkbuddyIndexer({ fileId: ref.sessionId, meta })
      const builder = new TranscriptBuilder()
      let reasoning = 0, first = Infinity
      await scan((record, line) => {
        indexer.accept(record, line)
        const at = time(record)
        if (record.type === 'reasoning') { reasoning += 1; return }
        if (!['message', 'function_call', 'function_call_output', 'function_call_result'].includes(String(record.type))) return
        first = Math.min(first, at)
        if (record.type === 'message') {
          const data = record.providerData && typeof record.providerData === 'object' ? record.providerData as LogRecord : {}
          if (workbuddyInjectedMessage(String(record.role), data)) return
          const text = workbuddyRecordText(record, line)
          if (record.role === 'user') {
            const attachments: TranscriptBlock[] = (record.content as LogRecord[]).flatMap(block => {
              const kind = attachmentTypes[String(block.type)]
              return kind ? [{ type: 'attachment' as const, kind, note: '附件未随记录迁移' }] : []
            })
            builder.user(iso(at), [{ type: 'text', text: text.trim() }, ...attachments])
          } else if (record.role === 'assistant' && text.trim()) builder.assistant(iso(at), { type: 'text', text })
        } else if (record.type === 'function_call') {
          builder.assistant(iso(at), { type: 'tool_call', id: typeof record.callId === 'string' ? record.callId : '',
            name: typeof record.name === 'string' && record.name ? record.name : 'tool', input: stringify(record.arguments ?? {}) })
        } else {
          builder.assistant(iso(at), { type: 'tool_result', callId: typeof record.callId === 'string' ? record.callId : '',
            output: stringify(record.result ?? record.output) })
        }
      })
      const index = indexer.finish()
      const messages = builder.finish()
      if (!messages.some(message => message.role === 'user')) throw new PinekinUnsupportedError('WorkBuddy 会话没有可显示的用户消息')
      return {
        format: 'pinekin.transcript', version: 1, engineVersion, source: 'workbuddy', sessionId: ref.sessionId, kind: 'conversation',
        title: index.session.title, createdAt: iso(first), updatedAt: index.session.updatedAt, revision: ref.revision, messages,
        warnings: reasoning ? ['WorkBuddy 的推理记录未导入。'] : [],
      } satisfies Transcript
    })
  } catch (error) {
    if (error instanceof UnsupportedSourceError) throw new PinekinUnsupportedError(error.message)
    throw error
  }
}
