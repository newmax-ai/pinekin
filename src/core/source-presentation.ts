import type { Message, Source } from './types'

/** 仅识别完整、位于开头的已知包装，普通引用和代码保持原文。 */
export function sourceMessageParts(content: string, source: Source, role: Message['role']): { primary: string; context: string } {
  if (source !== 'claude-code' || role !== 'user') return { primary: content, context: '' }
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
