import { basename } from 'node:path'
import { qwenMetadataSubtypes, qwenNodeSchema, qwenUnsupportedSubtypes } from '../main/qwen-source'
import { withSourceLog } from '../main/source-log-file'
import { sourcePromptTitle } from '../core/source-presentation'
import { sourceUserText } from '../core/source-user-content'
import { PinekinUnsupportedError, TranscriptBuilder, stringify } from './blocks'
import { aborted, fileRevision, readFirstRecord, walkLogs, workingDirectory } from './files'
import type { ReadOptions, SessionRef, Transcript, TranscriptBlock } from './types'

/** projects/<项目>/chats/*.jsonl；项目目录下的工具输出与工作流不进入。 */
export async function* listQwen(roots: string[], signal?: AbortSignal): AsyncGenerator<SessionRef> {
  for (const root of roots) {
    const logs = walkLogs(root, { maxDepth: 2, signal,
      descend: (_dir, name, depth) => depth === 0 || name === 'chats',
      accept: (directory, name) => basename(directory) === 'chats' && name.endsWith('.jsonl') })
    for await (const log of logs) {
      aborted(signal)
      const first = await readFirstRecord(log.path, false)
      const row = first ? qwenNodeSchema.safeParse(first) : undefined
      const base = { source: 'qwen-code' as const, path: log.path, root: log.root, compressed: false,
        revision: fileRevision(log.stat), updatedAt: new Date(log.stat.mtimeMs).toISOString(), kind: 'conversation' as const }
      if (!row?.success) {
        yield { ...base, sessionId: basename(log.path, '.jsonl'), unsupportedReason: '首条记录不是有效的 Qwen Code ChatRecord' }
        continue
      }
      yield { ...base, sessionId: row.data.sessionId, workingDirectory: workingDirectory(row.data.cwd) }
    }
  }
}

type Row = ReturnType<typeof qwenNodeSchema.parse>

function partsToBlocks(row: Row): { blocks: TranscriptBlock[]; text: string } {
  const blocks: TranscriptBlock[] = []
  const texts: string[] = []
  for (const part of row.message?.parts ?? []) {
    if (typeof part.text === 'string') {
      if (part.thought === true) blocks.push({ type: 'thinking', text: part.text })
      else { texts.push(part.text); blocks.push({ type: 'text', text: part.text }) }
    } else if (part.functionCall && typeof part.functionCall === 'object') {
      const call = part.functionCall as Record<string, unknown>
      blocks.push({ type: 'tool_call', id: typeof call.id === 'string' ? call.id : '', name: typeof call.name === 'string' ? call.name : 'tool', input: stringify(call.args ?? {}) })
    } else if (part.functionResponse && typeof part.functionResponse === 'object') {
      const response = part.functionResponse as Record<string, unknown>
      const value = response.response && typeof response.response === 'object' ? response.response as Record<string, unknown> : undefined
      const output = value && typeof value.output === 'string' ? value.output : value && typeof value.error === 'string' ? value.error : stringify(response.response)
      blocks.push({ type: 'tool_result', callId: typeof response.id === 'string' ? response.id : '', output, ...(value && typeof value.error === 'string' ? { isError: true } : {}) })
    } else if (part.inlineData || part.fileData) {
      blocks.push({ type: 'attachment', kind: part.inlineData ? 'image' : 'file', note: '附件未随记录迁移' })
    }
  }
  return { blocks, text: texts.join('\n') }
}

export async function readQwen(ref: SessionRef, options: ReadOptions, engineVersion: string): Promise<Transcript> {
  if (ref.unsupportedReason) throw new PinekinUnsupportedError(ref.unsupportedReason)
  const authorized = () => !options.signal?.aborted
  return withSourceLog(ref.path, ref.root, false, authorized, async scan => {
    const rows = new Map<string, Row>()
    let sessionId = '', cwd = '', version = '', customTitle = '', last: Row | undefined
    await scan((record, line) => {
      const parsed = qwenNodeSchema.safeParse(record)
      if (!parsed.success) throw new Error(`Qwen Code 第 ${line} 行字段无效或类型不支持`)
      const row = parsed.data
      if (rows.has(row.uuid)) throw new Error('Qwen Code UUID 重复，未猜测重放或修订')
      if (sessionId && sessionId !== row.sessionId) throw new Error('Qwen Code 混合多个会话')
      sessionId = row.sessionId; cwd ||= row.cwd; version = row.version
      if (row.isSidechain || row.forkedFrom != null || row.subtype && (qwenUnsupportedSubtypes.has(row.subtype) || row.subtype.startsWith('managed_session_'))) {
        throw new PinekinUnsupportedError('Qwen Code 分叉、子会话、回退、压缩或托管会话边界尚未支持')
      }
      if (row.type === 'system') {
        if (!row.subtype || !qwenMetadataSubtypes.has(row.subtype)) throw new PinekinUnsupportedError('Qwen Code 未知系统事件的历史语义尚未支持')
        const value = row.systemPayload?.customTitle
        if (row.subtype === 'custom_title' && typeof value === 'string' && value.trim()) customTitle = Array.from(value.trim()).slice(0, 200).join('')
      } else last = row
      rows.set(row.uuid, row)
    })
    if (!last) throw new PinekinUnsupportedError('Qwen Code 没有可显示的问答记录')
    // 只接受完整单根父链；多分支时拒绝，不混合旁支问答。
    const chain: Row[] = []
    const visited = new Set<string>()
    for (let row: Row | undefined = last; row; row = row.parentUuid === null ? undefined : rows.get(row.parentUuid)) {
      if (visited.has(row.uuid)) throw new Error('Qwen Code 父链循环')
      visited.add(row.uuid); chain.push(row)
      if (row.parentUuid !== null && !rows.has(row.parentUuid)) throw new Error('Qwen Code 父链缺失，不读取外部历史引用')
    }
    if ([...rows.values()].some(row => row.type !== 'system' && !visited.has(row.uuid))) throw new PinekinUnsupportedError('Qwen Code 多分支会话尚未支持')
    chain.reverse()
    const builder = new TranscriptBuilder()
    let prompt = '', createdAt = Infinity, updatedAt = -Infinity
    for (const row of chain) {
      const time = Date.parse(row.timestamp)
      createdAt = Math.min(createdAt, time); updatedAt = Math.max(updatedAt, time)
      if (row.type === 'system' || !row.message) continue
      const { blocks, text } = partsToBlocks(row)
      if (row.type === 'user') {
        // 通知、Agent 注入、定时任务与运行时提示不冒充真实用户输入。
        if (row.subtype || row.provenance !== undefined && row.provenance !== 'real_user') continue
        const cleaned = sourceUserText(text, 'qwen-code', 'user')
        if (!prompt && cleaned.trim()) prompt = sourcePromptTitle(cleaned, 'qwen-code')
        builder.user(row.timestamp, [{ type: 'text', text: cleaned }, ...blocks.filter(block => block.type === 'attachment')])
      } else {
        for (const block of blocks) builder.assistant(row.timestamp, block)
      }
    }
    const messages = builder.finish()
    if (!messages.some(message => message.role === 'user')) throw new PinekinUnsupportedError('Qwen Code 会话没有可显示的用户消息')
    return {
      format: 'pinekin.transcript', version: 1, engineVersion, source: 'qwen-code', sessionId, kind: 'conversation',
      title: customTitle || prompt || `Qwen Code · ${sessionId.slice(0, 8)}`,
      workingDirectory: workingDirectory(cwd), sourceVersion: version,
      createdAt: new Date(createdAt).toISOString(), updatedAt: new Date(updatedAt).toISOString(),
      revision: ref.revision, messages, warnings: [],
    }
  })
}
