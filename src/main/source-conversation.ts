import type { Message, ParsedArchive } from '../core/types'
import { sourcePromptTitle } from '../core/source-presentation'
import { sourceUserText } from '../core/source-user-content'

export function sourceTitle(value: unknown): string {
  return typeof value === 'string' ? Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, 200).join('') : ''
}

/** 只剥离开头完整的已知注入包装；不执行指令，不删除普通引用或未闭合文本。 */
export function codexUserText(value: string): string {
  return sourceUserText(value, 'codex', 'user')
}

export function codexFirstPrompt(record: Record<string, unknown>): string {
  const payload = record.payload as Record<string, unknown> | null | undefined
  if (record.type !== 'response_item' || !payload || payload.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) return ''
  const texts = payload.content.flatMap(block => block && block.type === 'input_text' && typeof block.text === 'string' ? [block.text] : [])
  return sourcePromptTitle(codexUserText(texts.join('\n')), 'codex')
}

/** 来源阅读与档案导入分开：原解析器的结构校验和原始档案语义保持不变。 */
export function sourceConversation(parsed: ParsedArchive): ParsedArchive {
  if (parsed.session.source !== 'codex') {
    const messages = parsed.session.messages.map(message => ({ ...message, content: sourceUserText(message.content, parsed.session.source, message.role) }))
      .filter(message => message.content.trim())
    return { ...parsed, session: { ...parsed.session, messages } }
  }
  let omitted = 0, cleaned = 0
  const messages: Message[] = []
  for (const message of parsed.session.messages) {
    if (message.role === 'system') { omitted += 1; continue }
    if (message.role !== 'user') { messages.push(message); continue }
    const content = codexUserText(message.content)
    if (!content.trim()) { omitted += 1; continue }
    if (content !== message.content) cleaned += 1
    messages.push({ ...message, content })
  }
  const title = sourcePromptTitle(messages.find(message => message.role === 'user')?.content ?? '', 'codex') || parsed.session.title
  const warnings = parsed.warnings.filter(warning => !warning.startsWith('标题由会话 ID 生成') && !warning.startsWith('developer 角色映射'))
  warnings.push(`来源阅读视图省略系统／开发者与纯注入上下文：${omitted} 条；整理用户消息前置包装：${cleaned} 条。原记录仍在来源文件，档案导入规则未改变。`)
  warnings.push('来源阅读标题优先使用首条可显示用户文本；不是客户端自定义标题，未读取外部标题索引或数据库。')
  if (!messages.length) warnings.push('排除上下文后没有可显示的用户或助手消息；不使用工具、事件副本或压缩摘要伪造问答。')
  return { ...parsed, session: { ...parsed.session, title, messages }, warnings }
}
