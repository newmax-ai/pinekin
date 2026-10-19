import type { Message } from '../core/types'
import type { BrowsableSource, SourceReadCursor } from '../core/sources'

export interface TransferPage {
  title: string; source: BrowsableSource; snapshot: string; totalMessages: number; offset: number; textOffset: number
  fragments: { position: number; role: 'user' | 'assistant'; content: string }[]
  next?: SourceReadCursor
}
export interface SourceTransfer {
  title: string; source: BrowsableSource; snapshot: string; messages: Message[]
}

/** 从来源重新读取完整文本；片段按原始位置合并，不能用阅读器当前缓存代替。 */
export async function collectSourceTransfer(read: (cursor: SourceReadCursor) => Promise<TransferPage>, assertAllowed = () => {}, maxBytes = 32 * 1024 * 1024): Promise<SourceTransfer> {
  let cursor: SourceReadCursor = { offset: 0, textOffset: 0 }
  let first: TransferPage | undefined
  const messages: Message[] = []
  let lastPosition = -1, bytes = 0, pages = 0
  for (;;) {
    assertAllowed()
    if (++pages > 100_000) throw new Error('会话超过接续读取上限，未截断或创建目标。')
    const page = await read(cursor)
    assertAllowed()
    first ??= page
    if (page.snapshot !== first.snapshot || page.source !== first.source || page.totalMessages !== first.totalMessages ||
      page.offset !== cursor.offset || page.textOffset !== cursor.textOffset) throw new Error('来源已变化或片段不连续，请重新接续。')
    let previous = cursor.offset - 1
    for (const fragment of page.fragments) {
      if (!Number.isSafeInteger(fragment.position) || fragment.position <= previous || fragment.position >= page.totalMessages) throw new Error('来源消息顺序不完整。')
      previous = fragment.position
      bytes += Buffer.byteLength(fragment.content, 'utf8')
      if (bytes > maxBytes) throw new Error('会话文本超过 32 MiB 接续上限，未截断或创建目标。')
      if (fragment.position === lastPosition) {
        const last = messages.at(-1)!
        if (!cursor.textOffset || fragment.position !== cursor.offset || last.role !== fragment.role) throw new Error('来源消息片段角色不一致。')
        last.content += fragment.content
      } else {
        if (fragment.position < lastPosition || fragment.position === cursor.offset && cursor.textOffset) throw new Error('来源消息缺少开头，不能创建不完整接续。')
        if (messages.length >= 100_000) throw new Error('会话超过 100000 条文本接续上限，未截断或创建目标。')
        messages.push({ role: fragment.role, content: fragment.content })
        lastPosition = fragment.position
      }
    }
    if (!page.next) break
    if (page.next.snapshot !== page.snapshot || page.next.offset < cursor.offset || page.next.offset === cursor.offset && page.next.textOffset <= cursor.textOffset ||
      page.next.offset >= page.totalMessages) throw new Error('来源续读游标无效，已停止接续。')
    cursor = page.next
  }
  const visible = messages.filter(message => message.content.trim())
  if (!visible.length) throw new Error('没有可接续的用户或助手文本。')
  return { title: first!.title, source: first!.source, snapshot: first!.snapshot, messages: visible }
}
