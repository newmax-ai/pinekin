import { basename } from 'node:path'
import { deepseekSourceSchemas } from '../main/deepseek'
import { createLogIndexer, recordText } from '../main/source-log-index'
import { withSourceLog } from '../main/source-log-file'
import { sourcePromptTitle } from '../core/source-presentation'
import { PinekinUnsupportedError, TranscriptBuilder, iso } from './blocks'
import { aborted, fileRevision, readFirstRecord, walkLogs, workingDirectory } from './files'
import type { ReadOptions, SessionRef, Transcript } from './types'

const unsupportedHeader = '仅支持 DeepSeek Harness session-v4 独立主会话，不支持继承、委派或未来格式'
const projectionWarning = 'DeepSeek Harness 仅导入问答文本；推理、工具调用与结果、附件、流式副本和运行状态未导入。'
// 固定官方契约见 docs/engine.md；仅省略已确认不会改写已落盘问答的运行态事件。
const surfaceEvents = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result'])
const metadataEvents = new Set(['session/title', 'permission/preset', 'sandbox/mode', 'approval/policy', 'agent/inbox/spliced',
  'turn/start', 'step/start', 'step/end', 'turn/end', 'request/header', 'request/context', 'session/title-llm-request',
  'tool/call', 'web/deepseek-search-llm-request', 'job/registered', 'job/settled', 'session/end-seed'])

/** 只在授权 sessions 根内发现日志，不进入子代理目录，也不沿日志中的外部引用读取。 */
export async function* listDeepseek(roots: string[], signal?: AbortSignal): AsyncGenerator<SessionRef> {
  for (const root of roots) {
    const logs = walkLogs(root, { maxDepth: 4, signal,
      descend: (_directory, name) => name !== 'subagents',
      accept: (_directory, name) => /\.jsonl(?:\.(?:zst|zstd))?$/.test(name) })
    for await (const log of logs) {
      aborted(signal)
      const first = await readFirstRecord(log.path, log.compressed)
      const header = deepseekSourceSchemas.header.safeParse(first)
      yield { source: 'deepseek', sessionId: header.success ? header.data.id : basename(log.path).replace(/\.jsonl(?:\.(?:zst|zstd))?$/, ''),
        path: log.path, root: log.root, compressed: log.compressed, revision: fileRevision(log.stat),
        updatedAt: new Date(log.stat.mtimeMs).toISOString(), kind: 'conversation',
        ...(header.success ? { workingDirectory: workingDirectory(header.data.cwd) } : first ? { unsupportedReason: unsupportedHeader } : {}) }
    }
  }
}

export async function readDeepseek(ref: SessionRef, options: ReadOptions, engineVersion: string): Promise<Transcript> {
  if (ref.unsupportedReason) throw new PinekinUnsupportedError(ref.unsupportedReason)
  aborted(options.signal)
  return withSourceLog(ref.path, ref.root, ref.compressed, () => !options.signal?.aborted, async scan => {
    // 复用 App 的连续 seq、append、角色、唯一消息 ID 和注入净化校验，不另建宽松解析器。
    const indexer = createLogIndexer('deepseek')
    const builder = new TranscriptBuilder()
    let header: ReturnType<typeof deepseekSourceSchemas.header.parse> | undefined
    let prompt = ''
    await scan((record, line) => {
      if (!header) {
        const parsed = deepseekSourceSchemas.header.safeParse(record)
        if (!parsed.success) throw new PinekinUnsupportedError(unsupportedHeader)
        header = parsed.data
        if (header.id !== ref.sessionId) throw new Error('DeepSeek 会话身份在读取前发生变化')
        indexer.accept(record, line)
        return
      }
      const type = String(record.type)
      if (surfaceEvents.has(type)) {
        if (record.surfaceOp !== 'append') throw new PinekinUnsupportedError('DeepSeek Harness 历史表面替换或未知操作尚未支持')
      } else {
        if (!metadataEvents.has(type)) throw new PinekinUnsupportedError('DeepSeek Harness 未知事件的历史语义尚未支持')
        if (record.surfaceOp !== undefined || record.sourceEventSeqs !== undefined) throw new PinekinUnsupportedError('DeepSeek Harness 非表面事件含未知历史操作')
      }
      indexer.accept(record, line)
      const event = deepseekSourceSchemas.event.parse(record)
      if (event.type === 'session/end-seed' && event.data.inherited !== undefined && event.data.inherited !== false) {
        throw new PinekinUnsupportedError('DeepSeek Harness 独立头部与继承边界冲突，未导入')
      }
      if (event.type !== 'user/message' && event.type !== 'assistant/message') return
      if (event.type === 'user/message') {
        const source = event.data.source as { kind: string }
        if (source.kind !== 'user') return
      }
      const text = recordText('deepseek', record, line)
      if (event.type === 'user/message') {
        if (!prompt && text.trim()) prompt = sourcePromptTitle(text, 'deepseek')
        builder.user(iso(event.time), [{ type: 'text', text }])
      } else if (text.trim()) builder.assistant(iso(event.time), { type: 'text', text })
    })
    const messages = builder.finish()
    if (!header || !messages.some(message => message.role === 'user')) throw new PinekinUnsupportedError('DeepSeek Harness 会话没有可导入的真实用户文本')
    const index = indexer.finish()
    return { format: 'pinekin.transcript', version: 1, engineVersion, source: 'deepseek', sessionId: header.id,
      kind: 'conversation', title: index.session.title || prompt, sourceVersion: 'session-v4',
      workingDirectory: workingDirectory(header.cwd), createdAt: iso(header.createdAt), updatedAt: index.session.updatedAt,
      revision: ref.revision, messages, warnings: [projectionWarning] }
  })
}
