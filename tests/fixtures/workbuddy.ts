// 按官方 WorkBuddy 5.8.3 包内 LocalJsonlSessionStore 构造；不使用真实对话。
export function workbuddyRecord(id: string, parentId: string | undefined, role: string, text: string, extra: Record<string, unknown> = {}) {
  return { id, ...(parentId ? { parentId } : {}), timestamp: 1792368000000, sessionId: 'synthetic-workbuddy', type: 'message', role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }], ...extra }
}
export function workbuddyFixture(records: Record<string, unknown>[] = [
  workbuddyRecord('u', undefined, 'user', '合成 WorkBuddy 问题'),
  workbuddyRecord('a', 'u', 'assistant', '合成 WorkBuddy 答复'),
  { type: 'custom-title', id: 'title', timestamp: 1792368000000, customTitle: '合成 WorkBuddy 会话' },
  { type: 'session-meta', id: 'meta', sessionId: 'synthetic-workbuddy', timestamp: 1792368000000, meta: {} },
]) {
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}
