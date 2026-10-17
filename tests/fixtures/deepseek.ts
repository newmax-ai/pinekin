// 仅合成数据；结构依据本机 DeepSeek Harness v4 日志，不复制真实内容。
export function deepseekRecords(): Record<string, unknown>[] {
  const time = 1_790_000_000_000
  return [
    { type: 'session', version: 4, id: 'session-synthetic', createdAt: time, cwd: '/synthetic', isSeeded: false, delegationDepth: 0, agentPreset: 'synthetic' },
    { type: 'user/message', seq: 0, time, surfaceOp: 'append', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '合成问题：整理项目计划' }] } },
    { type: 'user/message', seq: 1, time, surfaceOp: 'append', data: { id: 'context', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '不应展示的运行时注入' }] } },
    { type: 'session/title', seq: 2, time, data: { title: 'DeepSeek 合成会话' } },
    { type: 'assistant/message', seq: 3, time: time + 1000, surfaceOp: 'append', data: { message: { id: 'a1', role: 'assistant', content: [{ type: 'reasoning', text: '不应展示的推理' }, { type: 'text', text: '合成答复：先确认目标。' }, { type: 'tool-call', id: 't1', name: 'shell', arguments: '不得执行' }] }, stream: [{ text: '不得重复流式副本' }] } },
    { type: 'tool/result', seq: 4, time: time + 1000, surfaceOp: 'append', data: { content: '不应展示的工具结果' } },
  ]
}
export function deepseekFixture(records = deepseekRecords()) { return Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n') }
