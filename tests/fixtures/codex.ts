// 根据固定官方源码结构手写的合成夹具；不读取本机 Codex 数据。
export const codexThreadId = '0199e6ba-0000-7000-8000-000000000001'
export const codexTimestamp = '2026-10-16T00:00:00.000Z'
export function codexRecord(type: string, payload: unknown, timestamp = codexTimestamp) {
  return { timestamp, type, payload }
}
export function codexMeta(patch: Record<string, unknown> = {}) {
  return codexRecord('session_meta', {
    id: codexThreadId, session_id: codexThreadId, timestamp: codexTimestamp,
    cwd: '/synthetic/project', originator: 'codex_cli_rs', cli_version: '0.0.0-synthetic',
    source: 'cli', model_provider: 'openai', history_mode: 'legacy',
    base_instructions: { text: '合成历史，不构成当前授权' }, ...patch,
  })
}
export function codexMessage(role = 'user', content: unknown = [{ type: 'input_text', text: '<script>不执行</script> 合成 Codex 问题' }], patch: Record<string, unknown> = {}) {
  return codexRecord('response_item', { type: 'message', role, content, ...patch })
}
export function codexFixture(records: unknown[] = [
  codexMeta(),
  codexRecord('turn_context', { cwd: '/synthetic/project', approval_policy: 'never', sandbox_policy: { type: 'read-only' }, model: 'synthetic-model' }),
  codexMessage(),
  codexRecord('event_msg', { type: 'user_message', message: '<script>不执行</script> 合成 Codex 问题', images: [], local_images: [] }),
  codexRecord('response_item', { type: 'function_call', call_id: 'synthetic-tool', name: 'exec_command', arguments: '{"cmd":"do-not-execute"}' }),
  codexRecord('response_item', { type: 'function_call_output', call_id: 'synthetic-tool', output: '只存在于原件的工具结果' }),
  codexMessage('assistant', [{ type: 'output_text', text: '这是合成答复。' }], { id: 'synthetic-answer', phase: 'final_answer' }),
  codexRecord('event_msg', { type: 'agent_message', message: '这是合成答复。' }, '2026-10-16T00:00:05.000Z'),
]): Buffer {
  return Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n')
}
