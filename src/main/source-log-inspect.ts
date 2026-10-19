import type { SourceRecordKind } from '../core/sources'
import { createQwenIndexer } from './qwen-source'
import { basename } from 'node:path'
import { createWorkbuddyIndexer } from './workbuddy-source'
import { readWorkbuddyMetadata, workbuddyRevision } from './workbuddy-metadata'
import { claudeAuxiliaryReason, isClaudeAuxiliaryLog } from './claude-code'
import { ClaudeLogOrigin, sdkOriginReason } from './source-origin'
import { codexFirstPrompt, sourceTitle } from './source-conversation'
import { deepseekFirstPrompt } from './deepseek'
import { codexUnsupportedReason, isCodexSubagent } from './codex'
import type { LogSource } from './source-log-index'
import { withSourceLog } from './source-log-file'

/** 目录的完整归属检查只保留元数据，不创建消息索引、正文页或磁盘副本。 */
export function inspectLogSupport(path: string, root: string, source: LogSource, expectedRevision: string, authorized: () => boolean) {
  return withSourceLog(path, root, /\.(zst|zstd)$/.test(path), authorized, async (scan, revision) => {
    if (source === 'workbuddy') {
      const metadata = await readWorkbuddyMetadata(path, root, authorized)
      if (workbuddyRevision(revision, metadata.revision) !== expectedRevision) throw new Error('来源在目录检查期间变化，请刷新')
      const fileId = basename(path, '.jsonl'), parser = createWorkbuddyIndexer({ fileId, meta: metadata.meta })
      await scan((record, line) => parser.accept(record, line))
      const index = parser.finish()
      if ((await readWorkbuddyMetadata(path, root, authorized)).revision !== metadata.revision) throw new Error('WorkBuddy 元数据在检查期间变化，请刷新')
      return { reason: undefined, kind: 'conversation' as const, sourceSessionId: fileId, title: index.session.title }
    }
    if (revision !== expectedRevision) throw new Error('来源在目录检查期间变化，请刷新')
    if (source === 'qwen-code') {
      const parser = createQwenIndexer()
      await scan((record, line) => parser.accept(record, line))
      const index = parser.finish()
      return { reason: undefined, kind: 'conversation' as const, sourceSessionId: index.session.id, title: index.session.title }
    }
    const origin = new ClaudeLogOrigin()
    let reason: string | undefined, kind: SourceRecordKind | undefined, sourceSessionId: string | undefined, prompt = '', custom = '', auxiliary = true, records = 0
    await scan(record => {
      records += 1
      if (source === 'claude-code') {
        origin.observe(record)
        if (auxiliary) auxiliary = isClaudeAuxiliaryLog(JSON.stringify(record))
        if (record.isCompactSummary || record.isVisibleInTranscriptOnly || record.logicalParentUuid != null || record.subtype === 'compact_boundary') reason = 'Claude 压缩或逻辑父链边界尚未支持'
        if (record.isSidechain === true) kind = 'subagent'
      } else if (source === 'codex') {
        const payload = record.payload as Record<string, unknown> | undefined
        if (record.type === 'session_meta' && payload) {
          if (typeof payload.id === 'string') sourceSessionId = payload.id.slice(0, 512)
          reason = codexUnsupportedReason(payload) ?? reason
          if (isCodexSubagent(payload)) kind = 'subagent'
        }
        if (!prompt) prompt = codexFirstPrompt(record)
      } else {
        if (record.type === 'session') {
          if (typeof record.id === 'string') sourceSessionId = record.id.slice(0, 512)
          if (record.version !== 4 || record.isSeeded !== false || record.delegationDepth !== 0) reason = '仅支持 DeepSeek v4 独立主会话'
        }
        if (!prompt) prompt = deepseekFirstPrompt(record)
        const data = record.data as Record<string, unknown> | undefined
        if (record.type === 'session/title' && data) custom = sourceTitle(data.title) || custom
      }
    })
    if (source === 'claude-code') {
      if (records && auxiliary) { reason = claudeAuxiliaryReason; kind = 'internal' }
      if (origin.value(true) === 'sdk') reason = sdkOriginReason
    }
    return { reason, kind, sourceSessionId, title: custom || prompt }
  })
}
