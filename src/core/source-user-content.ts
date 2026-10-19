import type { Message, Source } from './types'

/** 数据库每行只补读这个有界前缀；超长未闭合包装不能以残片冒充问题。 */
export const SOURCE_CONTEXT_PREFIX_CHARS = 65_536
export const SOURCE_TEXT_POLICY_VERSION = 'source-user-context-v1'
export const SOURCE_CONTEXT_WARNING = '已知运行时前置上下文不作为用户问答、首问标题、复制导出或跨 App 接续；原件不变。仅识别完整的已知包装，不按措辞猜测删除普通提问、字面引用、代码或未知内容；这不是任意提示注入的检测保证。'

const tags = new Set(['system-reminder', 'environment_context', 'user_instructions', 'codex_apps_client_time_context',
  'external_codex_apps_open_page', 'recommended_plugins', 'ide_opened_file', 'ide_selection'])

/** 返回完整块的结束位置；只扫描文本，不解释 HTML/XML，不执行其中的指令。 */
function blockEnd(text: string, tag: string, offset = 0): number | undefined {
  const tokens = new RegExp(`<(/?)${tag}(?:[ \\t\\r\\n][^<>]*)?>`, 'g')
  tokens.lastIndex = offset
  let depth = 0
  for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
    depth += token[1] ? -1 : 1
    if (depth === 0) return token.index + token[0].length
  }
  return undefined
}

export interface SourceUserContent {
  primary: string
  context: string
  /** 被剥离的开头在原文中的 Unicode 码点数，与 SQLite substr/length 游标一致。 */
  prefixChars: number
  /** 已识别开头，但有界前缀里还没有完整结束标记。 */
  incomplete: boolean
}

/** 所有已连接来源共用。只处理用户消息的完整已知前置包装，其他文字保持原样。 */
export function sourceUserContent(content: string, source: Source, role: Message['role']): SourceUserContent {
  if (role !== 'user' || source === 'other') return { primary: content, context: '', prefixChars: 0, incomplete: false }
  let cut = 0, incomplete = false
  for (;;) {
    const remaining = content.slice(cut), leading = remaining.length - remaining.trimStart().length
    const text = remaining.slice(leading)
    let end: number | undefined, known = false
    const open = /^<([a-z][a-z_-]*)([^<>]*)>/.exec(text)
    if (open && tags.has(open[1])) {
      const attributes = open[2]
      // 只接受已确认的 user-context 属性，不能因标签名相似就删除用户自定义结构。
      known = !attributes.trim() || open[1] === 'system-reminder' && /^\s+data-role\s*=\s*(?:"user-context"|'user-context')\s*$/.test(attributes)
      if (known) end = blockEnd(text, open[1])
    } else if (/^# AGENTS\.md instructions(?: for [^\r\n]+)?\r?\n\s*<INSTRUCTIONS>/.test(text)) {
      known = true
      const offset = text.indexOf('<INSTRUCTIONS>')
      end = blockEnd(text, 'INSTRUCTIONS', offset)
    }
    if (known && end === undefined) { incomplete = true; break }
    if (end === undefined && source === 'codex') {
      const request = /^(?:# Context from my IDE setup:[\s\S]*?\r?\n)?## My request for Codex:\s*/.exec(text)
      if (request && !/^[ \t]*(`{3,}|~{3,})/m.test(request[0])) end = request[0].length
    }
    if (end === undefined) {
      // 预算也可能截在下一个起始标签内部（如 <syste），此时不能认定其后是正文。
      if (text.startsWith('<') && !text.includes('>') && [...tags].some(tag => {
        const start = `<${tag}`
        return start.startsWith(text) || text.startsWith(start) && (!text[start.length] || /\s/.test(text[start.length]))
      })) incomplete = true
      break
    }
    const next = text.slice(end)
    cut += leading + end + (next.length - next.trimStart().length)
  }
  const context = content.slice(0, cut).trim()
  let primary = content.slice(cut)
  // 只有来源与前置注入共同证实的 WorkBuddy 请求包装才解包，独立字面标签保持原样。
  if (source === 'workbuddy' && cut > 0 && primary.startsWith('<user_query>')) {
    const end = blockEnd(primary, 'user_query')
    if (end === primary.trimEnd().length) {
      primary = primary.slice('<user_query>'.length, end - '</user_query>'.length)
      cut += '<user_query>'.length
    }
  }
  return { primary, context, prefixChars: Array.from(content.slice(0, cut)).length, incomplete }
}

export function sourceUserText(content: string, source: Source, role: Message['role']): string {
  return sourceUserContent(content, source, role).primary
}
