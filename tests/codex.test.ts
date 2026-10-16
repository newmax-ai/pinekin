import { describe, expect, it } from 'vitest'
import { parseArchive } from '../src/main/imports'
import { codexFixture, codexMessage, codexMeta, codexRecord, codexThreadId } from './fixtures/codex'

const parse = (records: unknown[]) => parseArchive(codexFixture(records))
describe('Codex 单文件 JSONL 文本投影', () => {
  it('按内容识别，保留来源 ID/声明版本/原始时间，不重复导入事件副本', async () => {
    const result = await parseArchive(codexFixture())
    expect(result).toMatchObject({ adapterId: 'codex-rollout', adapterVersion: '0.1.0', sourceName: 'Codex JSONL',
      originalSessionId: codexThreadId, sourceVersion: '0.0.0-synthetic', session: {
        source: 'codex', title: `Codex · ${codexThreadId.slice(0, 8)}`, updatedAt: '2026-10-16T00:00:05.000Z', demo: false,
        messages: [{ role: 'user', content: '<script>不执行</script> 合成 Codex 问题' }, { role: 'assistant', content: '这是合成答复。' }],
      } })
    expect(result.warnings.join('\n')).toMatch(/事件记录.*2/)
    expect(result.warnings.join('\n')).toMatch(/工具.*2/)
    expect(result.warnings.join('\n')).toMatch(/不是原生恢复/)
    expect(result.session.messages).not.toEqual(expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('do-not-execute') })]))
  })
  it('支持 BOM、CRLF 和空行；缺省 history_mode 仍按 legacy 处理', async () => {
    const text = codexFixture([codexMeta({ history_mode: undefined, session_id: undefined }), codexMessage()]).toString()
    const result = await parseArchive(Buffer.from('﻿\r\n' + text.replaceAll('\n', '\r\n\r\n')))
    expect(result.session.messages).toHaveLength(1)
  })
  it('正文按输入顺序保留，相同文字不是去重依据，更新时间取实际最晚记录', async () => {
    const second = { ...codexMessage(), timestamp: '2026-10-16T10:00:00+08:00' }
    const result = await parse([codexMeta(), second, codexMessage()])
    expect(result.session.messages).toHaveLength(2)
    expect(result.session.updatedAt).toBe('2026-10-16T02:00:00.000Z')
  })
  it('developer 显式映射为系统历史，推理、未知响应项和元数据不伪装成助手正文', async () => {
    const result = await parse([codexMeta(), codexMessage('developer', [{ type: 'input_text', text: '历史开发者指令，不执行' }]),
      codexMessage('system', [{ type: 'input_text', text: '历史系统记录' }]), codexMessage(),
      codexRecord('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: '不进入交接的推理' }], encrypted_content: 'synthetic' }),
      codexRecord('response_item', { type: 'future_item', text: '不认识的响应内容' }),
      codexRecord('world_state', { full: true, state: { private: '不进入正文' } }),
    ])
    expect(result.session.messages.map(message => message.role)).toEqual(['system', 'system', 'user'])
    expect(result.warnings.join('\n')).toMatch(/developer/)
    expect(result.warnings.join('\n')).toMatch(/推理.*1/)
    expect(result.warnings.join('\n')).toMatch(/未映射响应项.*1/)
    expect(JSON.stringify(result.session.messages)).not.toContain('不进入')
  })
  it('多模态、未知块、加密内容和消息阶段明确提示，不访问 URL', async () => {
    const result = await parse([codexMeta(), codexMessage('assistant', [
      { type: 'output_text', text: '文本', annotations: [{ url: 'https://invalid.example/private' }] },
      { type: 'input_image', image_url: 'file:///private/never-read.png' }, { type: 'future_content', text: '不猜测字段' },
    ], { phase: 'commentary', encrypted_content: 'synthetic-ciphertext', status: 'incomplete' })])
    expect(result.session.messages[0].content).toContain('文本')
    expect(result.session.messages[0].content).toContain('未映射')
    expect(result.session.messages[0].content).toContain('加密')
    const report = result.warnings.join('\n')
    expect(report).toMatch(/内容块.*2/)
    expect(report).toMatch(/加密/)
    expect(report).toMatch(/阶段/)
    expect(report).toMatch(/完成状态/)
    expect(JSON.stringify(result.session.messages)).not.toContain('file:///')
  })
  it('压缩和回退只报告日志事实，不展开替代历史或冒充当前有效分支', async () => {
    const result = await parse([codexMeta(), codexMessage(),
      codexRecord('compacted', { message: '压缩摘要不是普通答复', replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '重复快照' }] }] }),
      codexRecord('event_msg', { type: 'thread_rolled_back', num_turns: 1 }),
      codexMessage('assistant', [{ type: 'output_text', text: '之后的回答' }]),
    ])
    expect(result.session.messages).toHaveLength(2)
    expect(result.warnings.join('\n')).toMatch(/压缩/)
    expect(result.warnings.join('\n')).toMatch(/回退/)
    expect(result.warnings.join('\n')).toMatch(/有效分支/)
    expect(JSON.stringify(result.session.messages)).not.toContain('重复快照')
  })
  it('分页、继承其他历史和子会话边界均拒绝，不沿路径补读', async () => {
    for (const patch of [{ history_mode: 'paginated' }, { history_mode: 'future' },
      { history_base: { rollout_id: 'other', ordinal_exclusive: 10 } }, { subagent_history_start_ordinal: 1 },
      { parent_thread_id: '0199e6ba-0000-7000-8000-000000000002' },
      { session_id: '0199e6ba-0000-7000-8000-000000000002' },
      { forked_from_id: '0199e6ba-0000-7000-8000-000000000002' },
      { source: { subagent: 'review' } }]) {
      await expect(parse([codexMeta(patch), codexMessage()])).rejects.toThrow(/分页|继承|子会话|历史模式/)
    }
  })
  it('缺少消息、只有事件副本和非 Codex JSONL 不能伪装成已导入会话', async () => {
    for (const records of [[codexMeta()], [codexMeta(), codexRecord('event_msg', { type: 'user_message', message: '只有事件' })],
      [codexMessage()], [{ session_id: 'history-jsonl', text: '其他历史格式' }]]) {
      await expect(parse(records)).rejects.toThrow()
    }
  })
  it('拒绝第二个 session_meta、未知顶层类型、错误角色和重复显式消息 ID', async () => {
    for (const extra of [codexMeta(), codexRecord('future_record', {}), codexMessage('root'),
      codexMessage('assistant', [{ type: 'output_text', text: '另一个回答' }], { id: 'same' })]) {
      await expect(parse([codexMeta(), codexMessage('user', [{ type: 'input_text', text: '测试' }], { id: 'same' }), extra])).rejects.toThrow()
    }
  })
  it('校验元数据、时间戳、已知正文块与对象边界，错误不泄露正文', async () => {
    for (const patch of [{ id: '../unsafe' }, { timestamp: 'yesterday' }, { cli_version: null }, { cwd: [] }, { session_id: 1 }]) {
      await expect(parse([codexMeta(patch), codexMessage()])).rejects.toThrow()
    }
    for (const record of [{ ...codexMessage(), timestamp: 'wrong' }, codexMessage('user', 'not-array'),
      codexMessage('user', [{ type: 'input_text', text: 1 }]), codexRecord('event_msg', null), codexRecord('response_item', {}), null]) {
      await expect(parse([codexMeta(), record])).rejects.toThrow(/第 2 行/)
    }
    await expect(parseArchive(Buffer.concat([codexFixture([codexMeta(), codexMessage()]), Buffer.from('{"private-secret":')]))).rejects.toThrow(/第 3 行/)
    try { await parse([codexMeta(), codexMessage('private-secret-role')]) } catch (error) {
      expect(String(error)).not.toContain('private-secret-role')
    }
  })
  it('空白行、单行、总消息数量均受限，不默默截断', async () => {
    await expect(parseArchive(Buffer.from('\n'.repeat(20_001) + codexFixture().toString()))).rejects.toThrow(/行数/)
    await expect(parse([codexMeta(), codexMessage('user', [{ type: 'input_text', text: 'x'.repeat(512 * 1024) }])])).rejects.toThrow(/单行/)
    const records = [codexMeta(), ...Array.from({ length: 10_001 }, () => codexMessage('user', []))]
    await expect(parse(records)).rejects.toThrow(/消息数量/)
  })
})
