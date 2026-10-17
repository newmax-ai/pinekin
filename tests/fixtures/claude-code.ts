// 仅合成数据。assistant 的 apiBlockIndex 表示追加块，不是完整消息快照。
export const claudeSessionId = '11111111-2222-4333-8444-555555555555'
export function claudeRecords(): Record<string, unknown>[] {
  const base = { sessionId: claudeSessionId, version: '2.1.286', isSidechain: false, timestamp: '2026-10-17T00:00:00.000Z' }
  return [
    { type: 'file-history-snapshot', snapshot: { files: [] } },
    { ...base, type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: '合成问题：整理项目计划' } },
    { ...base, type: 'attachment', uuid: 'context', parentUuid: 'u1', attachment: { type: 'synthetic_context', content: '不得冒充用户输入' } },
    { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'context', apiBlockIndex: 0,
      message: { id: 'msg_synthetic', role: 'assistant', content: [{ type: 'thinking', thinking: '不得进入交接' }] } },
    { ...base, type: 'assistant', uuid: 'a2', parentUuid: 'a1', apiBlockIndex: 1,
      message: { id: 'msg_synthetic', role: 'assistant', content: [{ type: 'text', text: '合成答复：先确认目标。' }] } },
  ]
}
export function claudeFixture(records = claudeRecords()) { return Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n') }
