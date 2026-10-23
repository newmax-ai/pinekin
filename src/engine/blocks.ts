import type { TranscriptBlock, TranscriptMessage } from './types'

/** 只读展示用途的单块上限；超出时截断并标记，不静默丢弃整条会话。 */
export const ENGINE_LIMITS = {
  messages: 10_000,
  textChars: 200_000,
  toolChars: 64_000,
  /** 整条记录累计字符预算，防止异常日志撑爆调用方内存。 */
  totalChars: 48_000_000,
  firstLineBytes: 1024 * 1024,
}

export class PinekinUnsupportedError extends Error {
  constructor(message: string) { super(message); this.name = 'PinekinUnsupportedError' }
}

function clip(text: string, limit: number): { text: string; truncated?: boolean } {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text }
}

/** 统一为 UTC ISO 字符串，保证同一记录内可按字符串比较先后。 */
export function iso(timestamp: string | number): string {
  const time = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp)
  return new Date(Number.isFinite(time) ? time : 0).toISOString()
}

export function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value ?? null) ?? '' } catch { return '' }
}

/** 按来源顺序组装用户／助手消息；助手的思考、工具调用和结果并入同一回合。 */
export class TranscriptBuilder {
  readonly messages: TranscriptMessage[] = []
  private current?: TranscriptMessage
  private used = 0
  private users = 0
  private assistants = 0

  private charge(chars: number) {
    this.used += chars
    if (this.used > ENGINE_LIMITS.totalChars) throw new PinekinUnsupportedError('会话内容超过 Pinekin 引擎的内存预算，未返回局部结果')
  }

  private open(role: 'user' | 'assistant', timestamp: string): TranscriptMessage {
    if (this.messages.length >= ENGINE_LIMITS.messages) throw new PinekinUnsupportedError(`会话消息超过 ${ENGINE_LIMITS.messages} 条，未截断导入`)
    const id = role === 'user' ? `u${this.users++}` : `a${this.assistants++}`
    const message: TranscriptMessage = { id, role, timestamp, blocks: [] }
    this.messages.push(message)
    return message
  }

  user(timestamp: string, blocks: TranscriptBlock[]) {
    // 纯注入上下文清洗后为空时不算新回合，避免把同一助手回合切成两段。
    if (!blocks.some(block => block.type !== 'text' || block.text.trim())) return
    this.current = undefined
    const message = this.open('user', iso(timestamp))
    for (const block of blocks) this.push(message, block)
  }

  assistant(timestamp: string, block: TranscriptBlock) {
    const time = iso(timestamp)
    if (!this.current) this.current = this.open('assistant', time)
    if (time > this.current.timestamp) this.current.timestamp = time
    this.push(this.current, block)
  }

  private push(message: TranscriptMessage, block: TranscriptBlock) {
    if (block.type === 'text' || block.type === 'thinking') {
      if (!block.text.trim()) return
      const clipped = clip(block.text, ENGINE_LIMITS.textChars)
      this.charge(clipped.text.length)
      message.blocks.push({ type: block.type, ...clipped })
    } else if (block.type === 'tool_call') {
      const clipped = clip(block.input, ENGINE_LIMITS.toolChars)
      this.charge(clipped.text.length + block.name.length)
      message.blocks.push({ type: 'tool_call', id: block.id, name: block.name.slice(0, 200), input: clipped.text, ...(clipped.truncated ? { truncated: true } : {}) })
    } else if (block.type === 'tool_result') {
      const clipped = clip(block.output, ENGINE_LIMITS.toolChars)
      this.charge(clipped.text.length)
      message.blocks.push({ type: 'tool_result', callId: block.callId, output: clipped.text, ...(block.isError ? { isError: true } : {}), ...(clipped.truncated ? { truncated: true } : {}) })
    } else {
      this.charge(block.note.length)
      message.blocks.push(block)
    }
  }

  /** 去掉没有任何内容的消息（例如只有空白或全部被识别为注入上下文）。 */
  finish(): TranscriptMessage[] {
    return this.messages.filter(message => message.blocks.length > 0)
  }
}
