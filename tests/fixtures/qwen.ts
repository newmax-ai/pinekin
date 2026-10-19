// 按 QwenLM/qwen-code 62c86c5 的 ChatRecord 构造，全部为合成会话。
export function qwenRecord(uuid: string, parentUuid: string | null, type: string, message?: unknown, extra: Record<string, unknown> = {}) {
  return { uuid, parentUuid, type, sessionId: 'synthetic-qwen', timestamp: '2026-10-19T00:00:00.000Z', cwd: '/synthetic/project', version: 'synthetic', ...(message ? { message } : {}), ...extra }
}
export function qwenFixture(records = [
  qwenRecord('u', null, 'user', { role: 'user', parts: [{ text: '请检查合成项目' }] }),
  qwenRecord('a', 'u', 'assistant', { role: 'model', parts: [{ text: '合成答复' }] }),
  qwenRecord('title', 'a', 'system', undefined, { subtype: 'custom_title', systemPayload: { customTitle: '合成千问会话', titleSource: 'manual' } }),
]) {
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}
