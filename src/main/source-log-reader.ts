import { sessionSchema } from '../core/session'
import { SOURCE_PAGE_MESSAGES, SOURCE_TEXT_CHARS, sourceReadCursorSchema, type SourceReadCursor, type SourceReadWindow } from '../core/sources'
import { sourcePromptTitle } from '../core/source-presentation'
import { createLogIndexer, recordText, sliceCodePoints, claudeToolEvents, type IndexedMessage, type LogSource, type ToolEvent } from './source-log-index'
import { withSourceLog } from './source-log-file'
import { SourceActivities } from './source-activity'
import type { SourceArchive } from './source-reader'

type Slot = { line?: number; start: number; length: number; value?: string }
function slots(message: IndexedMessage, start: number, length: number): Slot[] {
  const result: Slot[] = [], end = start + length
  let position = 0
  message.parts.forEach((part, index) => {
    if (index) {
      if (position >= start && position < end) result.push({ start: 0, length: 1, value: '\n' })
      position += 1
    }
    const from = Math.max(start, position), until = Math.min(end, position + part.length)
    if (until > from) result.push({ line: part.line, start: from - position, length: until - from })
    position += part.length
  })
  return result
}

/** 两次有界扫描：先验证全文件并建立轻量结构索引，再只保留当前片段与有限活动预览。 */
export function readSourceLog(path: string, root: string, source: LogSource, input: SourceReadCursor,
  authorized: () => boolean): Promise<SourceArchive & { window: SourceReadWindow; revision: string }> {
  const cursor = sourceReadCursorSchema.parse(input), compressed = /\.(zst|zstd)$/.test(path)
  return withSourceLog(path, root, compressed, authorized, async (scan, revision) => {
    if (cursor.snapshot && cursor.snapshot !== revision) throw new Error('来源日志已变化，请从头重新读取；未混合不同版本的片段')
    const parser = createLogIndexer(source)
    await scan((record, line) => parser.accept(record, line))
    const index = parser.finish(), totalMessages = index.messages.length
    if (cursor.offset > totalMessages || cursor.offset === totalMessages && totalMessages > 0) throw new Error('日志窗口超出消息范围，请刷新')
    const plans: { role: IndexedMessage['role']; slots: Slot[] }[] = [], selected = new Map<number, Slot[]>()
    let next: SourceReadCursor | undefined
    for (let offset = cursor.offset; offset < Math.min(totalMessages, cursor.offset + SOURCE_PAGE_MESSAGES); offset++) {
      const message = index.messages[offset], start = offset === cursor.offset ? cursor.textOffset : 0
      if (start > message.length) throw new Error('消息片段超出文本范围，请刷新')
      const length = Math.min(message.length - start, SOURCE_TEXT_CHARS), pieces = slots(message, start, length)
      plans.push({ role: message.role, slots: pieces })
      for (const slot of pieces) if (slot.line !== undefined) selected.set(slot.line, [...(selected.get(slot.line) ?? []), slot])
      if (start + length < message.length) { next = { offset, textOffset: start + length, snapshot: revision }; break }
      if (offset + 1 < totalMessages) next = { offset: offset + 1, textOffset: 0, snapshot: revision }
      else next = undefined
    }
    const tools = new Map<number, ToolEvent[]>(), firstUser = index.messages.find(message => message.role === 'user')?.parts[0]?.line
    let title = index.session.title
    await scan((record, line) => {
      if (selected.has(line) || source === 'claude-code' && firstUser === line) {
        const text = recordText(source, record, line)
        for (const slot of selected.get(line) ?? []) slot.value = sliceCodePoints(text, slot.start, slot.length)
        if (source === 'claude-code' && firstUser === line) title = sourcePromptTitle(text, source) || title
      }
      const count = index.tools?.get(line)
      if (count) tools.set(line, claudeToolEvents(record, count))
    })
    if (index.tools && index.presentation) {
      const activity = new SourceActivities()
      for (const line of index.tools.keys()) for (const event of tools.get(line) ?? []) activity.add(event.kind, event.id, event.name, event.content)
      index.presentation.activities = activity.presentation.activities
      index.presentation.activitiesTruncated ||= activity.presentation.activitiesTruncated
    }
    const messages = plans.map(plan => ({ role: plan.role, content: plan.slots.map(slot => {
      if (slot.value === undefined) throw new Error('来源片段不完整，请重新读取')
      return slot.value
    }).join('') }))
    return { adapterId: 'source-stream', adapterVersion: '0.1.0', sourceName: `${source} · 流式来源阅读`,
      session: sessionSchema.parse({ ...index.session, title, messages }), warnings: [...index.warnings,
        ...(compressed ? ['Zstandard 完整流已检查 EOF、尾部与 8 MiB 解码窗口；总展开量不再受旧 5 MiB 限制。'] : [])],
      ...(index.presentation ? { presentation: index.presentation } : {}), revision,
      window: { offset: cursor.offset, textOffset: cursor.textOffset, totalMessages, snapshot: revision, hasMore: !!next, ...(next ? { next } : {}) } }
  })
}
