import { SOURCE_PAGE_MESSAGES, SOURCE_TEXT_CHARS, sourceReadCursorSchema, type SourceReadCursor, type SourceReadWindow } from '../core/sources'
import { SOURCE_CONTEXT_PREFIX_CHARS, sourceUserContent } from '../core/source-user-content'
import type { DatabaseProjection, DatabaseRow } from './source-sqlite'

/** 调用方只传固定白名单 SELECT；所有游标数值再次验证后才进入 SQL。 */
export function textWindowQuery(select: string, input: SourceReadCursor): string {
  const cursor = sourceReadCursorSchema.parse(input)
  const start = `CASE WHEN position=${cursor.offset} THEN ${cursor.textOffset} ELSE 0 END`
  // 在同一 SQLite 事务中流式散列所选会话的完整白名单投影，包含尚未展示的尾部。
  // 只返回定长摘要；不拼接整段正文、不扩大分页输出，也不读取配置或凭据。
  const fingerprintQuery = `${select} ORDER BY position`.replaceAll("'", "''")
  return `SELECT json_object('kind','snapshot','value',lower(hex(sha3_query('${fingerprintQuery}',256))));
    WITH projected AS (${select}), page AS (SELECT * FROM projected ORDER BY position LIMIT ${SOURCE_PAGE_MESSAGES} OFFSET ${cursor.offset})
    SELECT json_object('kind','row','value',json_object(
      'position',position,'seq',seq,'id',id,'role',role,'content',substr(display,(${start})+1,${SOURCE_TEXT_CHARS}),
      'context_prefix',CASE WHEN role='user' THEN substr(display,1,${SOURCE_CONTEXT_PREFIX_CHARS}) ELSE NULL END,
      'text_length',length(display),'text_offset',${start},'has_nul',instr(display,char(0))>0,'timestamp',timestamp,'created_at',timestamp,
      'rewind_at',NULL,'internal',internal,'consistent',consistent)) FROM page ORDER BY position;`
}

/** 只剥离当前原始片段中落在已确认上下文前缀内的部分；游标仍按原文推进。 */
function projectedRow(row: DatabaseRow, source: 'newmax' | 'cindy' | undefined, start: number, length: number): DatabaseRow {
  if (!source || row.role !== 'user') return row
  const content = row.content as string
  const prefix = typeof row.context_prefix === 'string' ? row.context_prefix : start === 0 ? content : ''
  if (!prefix) return row
  const parts = sourceUserContent(prefix, source, 'user'), prefixLength = Array.from(prefix).length
  if (length > prefixLength && (parts.incomplete || parts.prefixChars > 0 && !parts.primary.trim())) {
    throw new Error('运行时上下文超过安全前缀预算，未将未确认的残片作为用户提问；原件不变')
  }
  if (parts.prefixChars <= start) return row
  return { ...row, content: Array.from(content).slice(parts.prefixChars - start).join('') }
}

/** 遇到长消息先停在它的当前片段，下一窗口从相同消息的下一个码点继续。 */
export function sourceReadWindow(projection: DatabaseProjection, cursor: SourceReadCursor,
  source: 'newmax' | 'cindy' | undefined = projection.source): { messages: DatabaseRow[]; window: SourceReadWindow } {
  const { budget, snapshot } = projection
  const total = Number(budget?.count)
  if (!Number.isSafeInteger(total) || total < 0 || !snapshot) throw new Error('正文窗口统计无效，请刷新')
  if (cursor.snapshot && cursor.snapshot !== snapshot) throw new Error('来源正文已变化，请查看更新后重新阅读；未混合不同版本的片段')
  if (cursor.offset > total || (cursor.offset === total && total > 0)) throw new Error('正文窗口已超出消息范围，请刷新')
  const messages: DatabaseRow[] = []
  let next: SourceReadCursor | undefined
  for (const row of projection.rows) {
    // SQLite 的 TEXT length/substr 在 NUL 处停止；不能把后半段丢失伪装成阅读完成。
    if (row.has_nul === 1) throw new Error('正文含空字符，当前分段读取暂未支持；会话仍保留，未返回截断成功')
    const position = Number(row.position), length = Number(row.text_length), start = Number(row.text_offset)
    if (typeof row.content !== 'string' || !Number.isSafeInteger(length) || length < 0 || start > length ||
      position !== cursor.offset + messages.length || start !== (messages.length ? 0 : cursor.textOffset)) throw new Error('正文片段或顺序无效，请刷新')
    // 必须先按原文计算下一游标，不能用净化后的长度跳回上下文中或丢失正文。
    const end = start + Array.from(row.content).length
    messages.push(projectedRow(row, source, start, length))
    if (end < length) { next = { offset: position, textOffset: end, snapshot }; break }
    if (position + 1 < total) next = { offset: position + 1, textOffset: 0, snapshot }
    else next = undefined
  }
  if (total > cursor.offset && !messages.length) throw new Error('来源正文窗口为空，请刷新')
  return { messages, window: { offset: cursor.offset, textOffset: cursor.textOffset, totalMessages: total, snapshot, hasMore: !!next, ...(next ? { next } : {}) } }
}
