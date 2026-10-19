import type { Message, ParsedArchive } from '../core/types'
import { sourcePromptTitle } from '../core/source-presentation'

export function sourceTitle(value: unknown): string {
  return typeof value === 'string' ? Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, 200).join('') : ''
}

/** 只剥离开头完整的已知注入包装；不执行指令，不删除普通引用或未闭合文本。 */
export function codexUserText(value: string): string {
  let text = value.trim(), stripped = false
  const context = /^(?:<(?<tag>environment_context|user_instructions|codex_apps_client_time_context|external_codex_apps_open_page|recommended_plugins)>[\s\S]*?<\/\k<tag>>|# AGENTS\.md instructions(?: for [^\r\n]+)?\r?\n\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>)\s*/
  for (;;) {
    const match = context.exec(text)
    if (!match) break
    text = text.slice(match[0].length).trimStart()
    stripped = true
  }
  // 不用任意位置的分隔符截断正常用户讨论；必须有已知 IDE 前缀或独立开头标记。
  const request = /^(?:# Context from my IDE setup:[\s\S]*?\r?\n)?## My request for Codex:\s*/.exec(text)
  if (request) { text = text.slice(request[0].length); stripped = true }
  return stripped ? text.trim() : value
}

export function codexFirstPrompt(record: Record<string, unknown>): string {
  const payload = record.payload as Record<string, unknown> | null | undefined
  if (record.type !== 'response_item' || !payload || payload.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) return ''
  const texts = payload.content.flatMap(block => block && block.type === 'input_text' && typeof block.text === 'string' ? [block.text] : [])
  return sourcePromptTitle(codexUserText(texts.join('\n')), 'codex')
}

/** 来源阅读与档案导入分开：原解析器的结构校验和原始档案语义保持不变。 */
export function sourceConversation(parsed: ParsedArchive): ParsedArchive {
  if (parsed.session.source !== 'codex') return parsed
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
