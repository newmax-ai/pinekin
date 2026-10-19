import type { Message, Source } from './types'

/** 只拆分完整的 Codex 文件列表／请求包装；附件路径和标签始终只是文本。 */
function codexFileMessageParts(content: string): { primary: string; context: string } {
  const text = content.trimStart()
  if (!/^#{1,2} Files mentioned by the user:[ \t]*(?:\r?\n|$)/.test(text)) return { primary: content, context: '' }
  const lines = text.split('\n')
  let file = false, request = -1
  for (let index = 1; index < lines.length; index++) {
    // 代码示例或不完整文件列表不能靠后面的同名标题误匹配。
    if (/^[ \t]*(`{3,}|~{3,})/.test(lines[index])) break
    if (/^#{1,2} My request(?: for Codex)?:[ \t]*\r?$/.test(lines[index])) { request = index; break }
    if (/^##[ \t]+\S/.test(lines[index])) file = true
  }
  if (!file || request < 0) return { primary: content, context: '' }
  const context = lines.slice(0, request).join('\n').trim()
  const body = lines.slice(request + 1)
  const requestText = (end = body.length) => {
    let start = 0
    while (start < end && !body[start].trim()) start += 1
    while (end > start && !body[end - 1].trim()) end -= 1
    return body.slice(start, end).join('\n').replace(/\r$/, '')
  }
  const placeholder = '[未映射内容块，保留在原件中]'
  const image = /^<(\/?)(image(?:[ \t]+(?:[0-9]+|\([0-9]+\)))?)>$/
  let cut = body.length, hasPlaceholder = false
  while (cut > 0) {
    const line = body[cut - 1].replace(/\r$/, '')
    if (line === placeholder) hasPlaceholder = true
    else if (line.trim() && !image.test(line)) break
    cut -= 1
  }
  // 只移动生成占位所在的完整尾部，不吞掉代码里的同名文字或不匹配标签。
  const stack: string[] = []
  let valid = true, fence = ''
  for (const line of body.slice(0, cut)) {
    if (!fence) fence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? ''
    else {
      const close = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line)?.[1]
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = ''
    }
  }
  for (const line of body.slice(cut)) {
    const tag = image.exec(line.replace(/\r$/, ''))
    if (!tag) continue
    const key = tag[2].replace(/[ \t]+/g, ' ')
    if (!tag[1]) stack.push(key)
    else if (stack.pop() !== key) valid = false
  }
  if (!hasPlaceholder || fence || !valid || stack.length) return { primary: requestText(), context }
  return { primary: requestText(cut), context: context + '\n' + body.slice(cut).join('\n').trim() }
}

/** 仅识别完整、位于开头的已知包装，普通引用和代码保持原文。 */
export function sourceMessageParts(content: string, source: Source, role: Message['role']): { primary: string; context: string } {
  if (role !== 'user') return { primary: content, context: '' }
  if (source === 'codex') return codexFileMessageParts(content)
  if (source !== 'claude-code') return { primary: content, context: '' }
  let primary = content
  const contexts: string[] = []
  for (;;) {
    const match = /^\s*<(system-reminder|ide_opened_file|ide_selection|local-command-caveat)>[\s\S]*?<\/\1>\s*/.exec(primary)
    if (!match) break
    contexts.push(match[0].trim()); primary = primary.slice(match[0].length)
  }
  // 按行线性识别，避免宽泛正则在大量空行／缺失尾标记时二次回溯。
  if (primary.startsWith('Task:')) {
    const lines = primary.split('\n')
    for (let index = 2; index < lines.length; index += 1) {
      if (lines[index - 1].trim() || !/^Current URL:[ \t]*(?:https?:\/\/|file:\/\/\/|about:blank(?:$|[?#]))[^\r\n]*\r?$/.test(lines[index])) continue
      let snapshot = index + 1
      if (lines[snapshot]?.startsWith('Viewport:')) snapshot += 1
      const blank = snapshot
      while (snapshot < lines.length && !lines[snapshot].trim()) snapshot += 1
      if (snapshot === blank || !lines[snapshot]?.startsWith('Page snapshot:')) continue
      const task = lines.slice(0, index).join('\n').slice(5).trim()
      if (!task) break
      contexts.push(lines.slice(index).join('\n')); primary = task
      break
    }
  }
  return { primary, context: contexts.join('\n') }
}

export function sourcePromptTitle(content: string, source: Source): string {
  const { primary } = sourceMessageParts(content, source, 'user')
  const line = primary.trim().split(/\r?\n/).find(value => value.trim() && !/^(`{3,}|~{3,})[\w+.-]*\s*$/.test(value))?.replace(/\s+/g, ' ').trim() ?? ''
  const characters = Array.from(line)
  return characters.slice(0, 80).join('') + (characters.length > 80 ? '…' : '')
}

export function isBrowserTask(content: string): boolean {
  const parts = sourceMessageParts(content, 'claude-code', 'user')
  return /^Current URL:/m.test(parts.context) && /^Page snapshot:/m.test(parts.context)
}
