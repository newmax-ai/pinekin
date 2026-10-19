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
// 仅本地命令的原生日志结构；命令文字只作为合成数据，绝不执行。
export function claudeLocalCommandRecords(): Record<string, unknown>[] {
  const base = { sessionId: claudeSessionId, version: '2.1.280', isSidechain: false, isMeta: false,
    timestamp: '2026-10-17T00:00:00.000Z', type: 'system', subtype: 'local_command', entrypoint: 'cli' }
  return [
    { type: 'mode', mode: 'synthetic', sessionId: claudeSessionId },
    { type: 'permission-mode', permissionMode: 'synthetic', sessionId: claudeSessionId },
    { ...base, uuid: 'command-input', parentUuid: null, content: '<command-name>/synthetic-status</command-name>' },
    { ...base, uuid: 'command-output', parentUuid: 'command-input', content: '<local-command-stdout>合成命令状态，不是助手回答</local-command-stdout>', commandRun: true },
    { type: 'last-prompt', leafUuid: 'command-output', sessionId: claudeSessionId },
    { type: 'cost-state', sessionId: claudeSessionId, totalCostUSD: 0 },
  ]
}
export function claudeFixture(records = claudeRecords()) { return Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n') }
