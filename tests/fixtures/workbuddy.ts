// 按官方 WorkBuddy 5.8.3 包内 LocalJsonlSessionStore 构造；不使用真实对话。
export function workbuddyRecord(id: string, parentId: string | undefined, role: string, text: string, extra: Record<string, unknown> = {}) {
  return { id, ...(parentId ? { parentId } : {}), timestamp: 1792368000000, sessionId: 'synthetic-workbuddy', type: 'message', role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }], ...extra }
}
export function workbuddyFixture(records: Record<string, unknown>[] = [
  workbuddyRecord('u', undefined, 'user', '合成 WorkBuddy 问题'),
  workbuddyRecord('a', 'u', 'assistant', '合成 WorkBuddy 答复'),
  { type: 'custom-title', timestamp: 1792368000000, customTitle: '合成 WorkBuddy 会话' },
  { type: 'session-meta', sessionId: 'synthetic-workbuddy', timestamp: 1792368000000, meta: {} },
]) {
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

/** 合成同一助手节点拆成文本与多个 function_call 的完整普通主会话。 */
export function workbuddyAssistantBlocksFixture() {
  const timestamp = 1792368000000, records: Record<string, unknown>[] = [
    workbuddyRecord('u', undefined, 'user', '合成 WorkBuddy 问题'),
    { id: 'snapshot', timestamp, type: 'file-history-snapshot', snapshot: {} },
    { timestamp, type: 'ai-title', aiTitle: '合成 WorkBuddy 会话', sessionId: 'synthetic-workbuddy' },
  ]
  let parentId = 'u'
  for (const [turn, count] of [3, 3, 3, 1, 1].entries()) {
    const thought = `thought-${turn}`, id = `assistant-${turn}`, providerData = { messageId: `provider-${turn}` }
    records.push({ id: thought, parentId, timestamp, type: 'reasoning', content: [] })
    records.push(workbuddyRecord(id, thought, 'assistant', `合成助手说明 ${turn + 1}`, { providerData }))
    for (let block = 0; block < count; block++) records.push({
      id, parentId: thought, timestamp, type: 'function_call', providerData, callId: `call-${turn}-${block}`, name: 'synthetic-tool', arguments: '不执行',
      ...(block === count - 1 ? { message: { role: 'assistant', content: '不作为重复正文' } } : {}),
    })
    parentId = id
    for (let block = 0; block < count; block++) {
      const result = `result-${turn}-${block}`
      records.push({ id: result, parentId, timestamp, type: 'function_call_result', callId: `call-${turn}-${block}`, result: '不作为答复' })
      parentId = result
    }
  }
  records.push({ id: 'final-thought', parentId, timestamp, type: 'reasoning', content: [] })
  records.push(workbuddyRecord('final', 'final-thought', 'assistant', '合成 WorkBuddy 答复'))
  return workbuddyFixture(records)
}
