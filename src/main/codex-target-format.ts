import { z } from 'zod'
import type { Message } from '../core/types'
import { codexVersionSchema } from '../core/codex-version'

const inputSchema = z.strictObject({
  id: z.uuid(), title: z.string().min(1).max(200), cwd: z.string().startsWith('/').max(4096),
  version: codexVersionSchema, timestamp: z.iso.datetime(),
  messages: z.array(z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string() })).min(1).max(100_000),
})
/** 双投影：ResponseItem 供继续对话使用，EventMsg 供目标界面展示。没有工具、权限或原会话执行态。 */
export function buildCodexRollout(input: { id: string; title: string; cwd: string; version: string; timestamp: string; messages: Message[] }): string {
  const value = inputSchema.parse(input)
  const records: unknown[] = []
  const line = (type: string, payload: unknown) => records.push({ timestamp: value.timestamp, type, payload })
  line('session_meta', { id: value.id, session_id: value.id, timestamp: value.timestamp, cwd: value.cwd,
    originator: 'Pinekin', cli_version: value.version, source: 'cli', model_provider: 'openai', base_instructions: null })
  const turnId = `${value.id}-history`
  line('event_msg', { type: 'task_started', turn_id: turnId, model_context_window: null })
  for (const message of value.messages) {
    line('response_item', { type: 'message', role: message.role, content: [{ type: message.role === 'user' ? 'input_text' : 'output_text', text: message.content }] })
    line('event_msg', message.role === 'user' ? { type: 'user_message', message: message.content, images: [], local_images: [], text_elements: [] }
      : { type: 'agent_message', message: message.content, phase: 'final_answer' })
  }
  line('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: null })
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

const threadSchema = z.object({ thread: z.object({ id: z.string(), cwd: z.string().optional(), turns: z.array(z.object({
  status: z.literal('completed'), items: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('userMessage'), content: z.array(z.object({ type: z.literal('text'), text: z.string() })) }),
    z.object({ type: z.literal('agentMessage'), text: z.string() }),
  ])),
})) }) })
/** 必须经所选 Codex 自己的 thread/read 投影后逐条比对，不能用自写解析器自证兼容。 */
export function verifyCodexThread(result: unknown, id: string, messages: Message[], expectedCwd?: string): void {
  const parsed = threadSchema.safeParse(result)
  if (!parsed.success || parsed.data.thread.id !== id) throw new Error('Codex 未确认目标会话的完整可见历史。')
  if (expectedCwd !== undefined && parsed.data.thread.cwd !== expectedCwd) throw new Error('Codex 回读的工作目录与所选位置不一致，已停止创建。')
  const actual = parsed.data.thread.turns.flatMap(turn => turn.items.map(item => item.type === 'userMessage'
    ? { role: 'user', content: item.content.map(part => part.text).join('') } : { role: 'assistant', content: item.text }))
  if (JSON.stringify(actual) !== JSON.stringify(messages)) throw new Error('Codex 回读的历史与来源不一致，已停止创建。')
}
