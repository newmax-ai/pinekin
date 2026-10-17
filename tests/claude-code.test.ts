import { describe, expect, it } from 'vitest'
import { isClaudeCodeLog, parseClaudeCode } from '../src/main/claude-code'
import { claudeFixture, claudeRecords, claudeSessionId } from './fixtures/claude-code'

const text = (records = claudeRecords()) => claudeFixture(records).toString('utf8')
const child = (uuid: string, parentUuid: string, patch: Record<string, unknown> = {}) => ({
  ...claudeRecords()[4], uuid, parentUuid, ...patch,
})

describe('Claude Code JSONL 显式末条消息父链文本投影', () => {
  it('跳过元数据识别原生日志，保留 attachment 父链但只提取人类和助手文本', () => {
    expect(isClaudeCodeLog('﻿\n' + text())).toBe(true)
    expect(isClaudeCodeLog('{}\n')).toBe(false)
    expect(isClaudeCodeLog('not-json')).toBe(false)
    expect(isClaudeCodeLog('')).toBe(false)
    const result = parseClaudeCode('﻿\n' + text())
    expect(result).toMatchObject({ adapterId: 'claude-code-jsonl', sourceVersion: '2.1.286', originalSessionId: claudeSessionId,
      session: { source: 'claude-code', demo: false } })
    expect(result.session.messages).toEqual([{ role: 'user', content: '合成问题：整理项目计划' }, { role: 'assistant', content: '合成答复：先确认目标。' }])
    expect(result.warnings.join('\n')).toMatch(/不是.*原生恢复/)
    expect(result.warnings.join('\n')).toMatch(/末条.*父链/)
    expect(result.warnings.join('\n')).toMatch(/推理.*工具/)
  })
  it('最后 user/assistant 记录决定投影链，不混入兄弟分支或按 last-prompt 误选', () => {
    const records = claudeRecords()
    records.push(child('discarded', 'u1', { message: { id: 'msg_other', role: 'assistant', content: [{ type: 'text', text: '兄弟分支不要展示' }] } }))
    records.push(child('latest', 'a2', { apiBlockIndex: 2, message: { id: 'msg_synthetic', role: 'assistant', content: [{ type: 'text', text: '然后排优先级。' }] } }))
    records.push({ type: 'last-prompt', leafUuid: 'discarded' })
    const result = parseClaudeCode(text(records))
    expect(result.session.messages.map(message => message.content).join('\n')).not.toContain('兄弟分支')
    expect(result.session.messages[1].content).toBe('合成答复：先确认目标。\n然后排优先级。')
    expect(result.warnings.join('\n')).toMatch(/分支/)
  })
  it('tool_result 和 isMeta 用户节点保留图连接，不伪造用户主动输入，文本不按正文去重', () => {
    const records = claudeRecords()
    records.push(child('tool', 'a2', { type: 'user', isMeta: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '不得展示工具结果' }] } }))
    records.push(child('meta', 'tool', { type: 'user', isMeta: true, message: { role: 'user', content: '不得展示运行时输入' } }))
    records.push(child('answer', 'meta', { apiBlockIndex: 0, message: { id: 'msg_next', role: 'assistant', content: [{ type: 'text', text: '合成答复：先确认目标。' }, { type: 'image', source: { url: 'https://invalid.example/不访问' } }] } }))
    const result = parseClaudeCode(text(records))
    expect(result.session.messages).toHaveLength(3)
    expect(result.session.messages[1].content).toBe(result.session.messages[2].content)
    expect(JSON.stringify(result.session.messages)).not.toMatch(/工具结果|运行时输入|https:/)
  })
  it.each([
    (r: Record<string, unknown>[]) => { r[1].parentUuid = 'external-prefix' },
    (r: Record<string, unknown>[]) => { r[1].parentUuid = 'a2' },
    (r: Record<string, unknown>[]) => { r[4].uuid = 'a1' },
    (r: Record<string, unknown>[]) => { r[4].sessionId = 'another-session' },
    (r: Record<string, unknown>[]) => { r[4].isSidechain = true },
    (r: Record<string, unknown>[]) => { r[4].timestamp = 'yesterday' },
    (r: Record<string, unknown>[]) => { r[4].logicalParentUuid = 'u1' },
    (r: Record<string, unknown>[]) => { r[1].isCompactSummary = true },
    (r: Record<string, unknown>[]) => { r[2].type = 'system'; r[2].subtype = 'compact_boundary' },
    (r: Record<string, unknown>[]) => { r[2].type = 'future_state' },
    (r: Record<string, unknown>[]) => { r[4].apiBlockIndex = 0 },
    (r: Record<string, unknown>[]) => { delete r[4].apiBlockIndex },
    (r: Record<string, unknown>[]) => { r[4].message = { role: 'user', content: [] } },
    (r: Record<string, unknown>[]) => { r[4].message = { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(200_001) }] } },
  ])('拒绝断链、循环、重复、混会话、子会话、压缩边界及未知结构 %#', patch => {
    const records = claudeRecords(); patch(records)
    expect(() => parseClaudeCode(text(records))).toThrow(/Claude Code/)
  })
  it('无索引的完整 assistant 消息允许独立 ID；重复 ID 但没有块索引时拒绝猜测', () => {
    const records = claudeRecords().filter(record => record.uuid !== 'a1')
    Object.assign(records[3], { parentUuid: 'context', apiBlockIndex: undefined })
    expect(parseClaudeCode(text(records)).session.messages).toHaveLength(2)
    records.push(child('replay', 'a2', { apiBlockIndex: undefined }))
    expect(() => parseClaudeCode(text(records))).toThrow(/索引/)
  })
  it('只有元数据、内部用户或推理时拒绝空档案；错误不回显私人内容', () => {
    expect(() => parseClaudeCode(text([{ type: 'summary', summary: 'PRIVATE_SENTINEL' }]))).toThrow(/没有/)
    const records = claudeRecords(); records[1].isMeta = true
    ;(records[4].message as { content: unknown[] }).content = [{ type: 'thinking', thinking: 'PRIVATE_SENTINEL' }]
    expect(() => parseClaudeCode(text(records))).toThrow(/没有/)
    for (const value of [text() + '{"PRIVATE_SENTINEL":', 'x'.repeat(5 * 1024 * 1024 + 1), text([{ type: 'user', uuid: 'x', message: 'PRIVATE_SENTINEL' }])]) {
      try { parseClaudeCode(value); expect.unreachable() }
      catch (error) { expect(String(error)).not.toContain('PRIVATE_SENTINEL') }
    }
  })
  it('拒绝单行/总行数预算和合并文本超限，不静默截断', () => {
    expect(() => parseClaudeCode(JSON.stringify({ type: 'summary', summary: 'x'.repeat(512 * 1024) }))).toThrow(/单行/)
    expect(() => parseClaudeCode('\n'.repeat(20_001) + text())).toThrow(/行数/)
    const records = claudeRecords()
    ;(records[4].message as { content: unknown[] }).content = [{ type: 'text', text: 'x'.repeat(150_000) }]
    records.push(child('too-long', 'a2', { apiBlockIndex: 2, message: { id: 'msg_synthetic', role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(150_000) }] } }))
    expect(() => parseClaudeCode(text(records))).toThrow(/合并/)
  })
})
