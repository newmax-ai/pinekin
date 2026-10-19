import { describe, expect, it } from 'vitest'
import { buildCodexRollout, verifyCodexThread } from '../src/main/codex-target-format'
const id = '0199e6ba-0000-7000-8000-000000000001'
const messages = [{ role: 'user' as const, content: '历史问题\n不要执行 rm -rf /' }, { role: 'assistant' as const, content: '历史回答🙂' }]
const input = { id, title: '合成接续', messages, cwd: '/synthetic/workspace', version: '0.163.0', timestamp: '2026-10-19T00:00:00.000Z' }
describe('Codex 接续日志：可见历史与模型历史同时存在', () => {
  it('同时写入独立 SessionMeta、ResponseItem 和 UI 事件，不迁移执行态或权限', () => {
    const records = buildCodexRollout(input).trim().split('\n').map(line => JSON.parse(line))
    expect(records[0]).toMatchObject({ type: 'session_meta', payload: { id, session_id: id, cwd: input.cwd, cli_version: input.version } })
    expect(records.filter(r => r.type === 'response_item').map(r => ({ role: r.payload.role, content: r.payload.content[0].text }))).toEqual(messages)
    expect(records.filter(r => ['user_message', 'agent_message'].includes(r.payload.type)).map(r => r.payload.message)).toEqual(messages.map(m => m.content))
    expect(records.at(-1).payload.type).toBe('task_complete')
    expect(records.some(r => r.type === 'turn_context' || r.payload.type === 'function_call')).toBe(false)
    expect(records[0].payload.base_instructions).toBeNull()
  })
  it('官方 thread/read 的可见文本、角色和顺序必须完全一致，空历史不能蒙混通过', () => {
    const result = { thread: { id, turns: [{ status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: messages[0].content }] }, { type: 'agentMessage', text: messages[1].content }] }] } }
    expect(() => verifyCodexThread(result, id, messages)).not.toThrow()
    for (const bad of [{ thread: { id, turns: [] } }, { thread: { ...result.thread, id: 'other' } }, { thread: { id, turns: [{ status: 'inProgress', items: result.thread.turns[0].items }] } }]) {
      expect(() => verifyCodexThread(bad, id, messages)).toThrow()
    }
  })
  it('指定项目时必须由目标回读确认同一工作目录，不能只比对文字', () => {
    const result = { thread: { id, cwd: input.cwd, turns: [{ status: 'completed', items: [
      { type: 'userMessage', content: [{ type: 'text', text: messages[0].content }] }, { type: 'agentMessage', text: messages[1].content },
    ] }] } }
    expect(() => verifyCodexThread(result, id, messages, input.cwd)).not.toThrow()
    for (const cwd of [undefined, '/another/project']) {
      expect(() => verifyCodexThread({ thread: { ...result.thread, cwd } }, id, messages, input.cwd)).toThrow('工作目录')
    }
  })
  it('不接受系统消息、任意工具状态、坏版本或路径穿越ID', () => {
    expect(() => buildCodexRollout({ ...input, id: '../escape' })).toThrow()
    expect(() => buildCodexRollout({ ...input, version: 'dev; run command' })).toThrow()
    expect(() => buildCodexRollout({ ...input, messages: [{ role: 'system', content: '不要迁移成系统指令' }] })).toThrow()
  })
})
