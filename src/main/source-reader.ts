import type { ParsedArchive } from '../core/types'
import type { SourcePresentation } from '../core/sources'
import { MAX_BYTES } from '../core/session'
import { claudeAuxiliaryReason, isClaudeAuxiliaryLog, isClaudeCodeLog, parseClaudeCode } from './claude-code'
import { UnsupportedSourceError } from './source-origin'
import { isCodexRollout, isCodexSubagent, parseCodex } from './codex'
import { isDeepSeekLog, parseDeepSeek } from './deepseek'
import { decodeCompressedLog, isZstandard } from './codex-zstd'
import { parseArchive } from './imports'
import { sourceConversation } from './source-conversation'
import { SourceActivities } from './source-activity'

export type SourceArchive = ParsedArchive & { presentation?: SourcePresentation }

/** 来源预览扩展与档案导入隔离，共用原解析器的结构、安全和父链校验。 */
export async function parseSourceArchive(bytes: Uint8Array): Promise<SourceArchive> {
  if (bytes.byteLength > MAX_BYTES) throw new Error('文件过大，最大支持 5 MB')
  const input = Buffer.from(bytes)
  if (isZstandard(input)) {
    // 共用原有 5 MiB 展开、8 MiB 窗口和格式门禁，保证不会递归解压其他内容。
    const parsed = await parseSourceArchive(Buffer.from(await decodeCompressedLog(input)))
    return { ...parsed, sourceName: `${parsed.sourceName} · Zstandard`, warnings: [...parsed.warnings,
      '输入为 Zstandard 压缩日志；使用有界展开后的同一来源阅读投影，不保存展开副本或执行内容。'] }
  }
  if (input.subarray(0, 8).equals(Buffer.from('XDTSHARE'))) return sourceConversation(await parseArchive(input))
  const text = new TextDecoder('utf-8', { fatal: true }).decode(input)
  if (isClaudeAuxiliaryLog(text)) throw new UnsupportedSourceError(claudeAuxiliaryReason)
  if (isClaudeCodeLog(text, true)) return sourceConversation(parseClaudeCode(text, true))
  if (isDeepSeekLog(text)) return sourceConversation(parseDeepSeek(text, true))
  if (!isCodexRollout(text)) return sourceConversation(await parseArchive(input))
  const parsed = sourceConversation(parseCodex(text, true))
  // 原解析器已验证完整日志及所有消息；这里只对允许的响应项做展示投影。
  const activity = new SourceActivities()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const record = JSON.parse(line)
    const item = record.payload
    if (record.type === 'session_meta' && isCodexSubagent(item)) activity.presentation.kind = 'subagent'
    if (record.type !== 'response_item') { activity.presentation.omittedRecords += 1; continue }
    if (['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call'].includes(item.type)) {
      activity.add('call', item.call_id ?? item.id, item.name ?? item.type, item.arguments ?? item.input ?? item.action)
    } else if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      const output = typeof item.output === 'string' ? item.output : Array.isArray(item.output)
        ? item.output.flatMap((block: { type?: unknown; text?: unknown } | null) => block?.type === 'input_text' && typeof block.text === 'string' ? [block.text] : []).join('\n') : ''
      activity.add('result', item.call_id, undefined, output)
    } else if (item.type === 'message') {
      for (const block of item.content) if (!['input_text', 'output_text'].includes(block.type)) activity.presentation.attachments += 1
    } else activity.presentation.omittedRecords += 1
  }
  activity.presentation.textMessages = parsed.session.messages.length
  return { ...parsed, presentation: activity.presentation, warnings: [
    ...parsed.warnings.filter(warning => !warning.startsWith('工具调用或结果未映射')),
    '来源阅读额外展示工具活动预览，最多 100 条、每条 1,024 字符；不执行历史工具，不将活动伪装为助手答复，完整内容仍在原件。',
  ] }
}
