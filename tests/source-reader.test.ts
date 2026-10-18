import { describe, expect, it } from 'vitest'
import { zstdCompressSync } from 'node:zlib'
import { parseSourceArchive } from '../src/main/source-reader'
import { parseArchive } from '../src/main/imports'
import { claudeFixture, claudeRecords } from './fixtures/claude-code'
import { codexFixture, codexMessage, codexMeta, codexRecord } from './fixtures/codex'

function browserTask() {
  const records = claudeRecords()
  records[1].message = { role: 'user', content: 'Task: 检查合成播放按钮\n\nCurrent URL: http://127.0.0.1:9999/synthetic\nViewport: 400x800\n\nPage snapshot:\n合成页面内容' }
  records[3].message = { role: 'assistant', id: 'a', content: [{ type: 'tool_use', id: 'call-1', name: 'browser_click', input: { selector: '#play' } }] }
  records[4] = { ...records[1], uuid: 'result-1', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '合成按钮已点击' }] } }
  records.push({ ...records[3], uuid: 'complete', parentUuid: 'result-1', message: { role: 'assistant', id: 'b', content: [{ type: 'tool_use', id: 'call-2', name: 'browser_task_complete', input: { summary: '合成检查完成' } }] } })
  return records
}

describe('来源阅读的消息完整性与活动说明', () => {
  it('同一 Codex 日志压缩前后文字、标题和工具活动完全一致，档案入口保持纯文本', async () => {
    const bytes = codexFixture(), compressed = zstdCompressSync(bytes)
    const raw = await parseSourceArchive(bytes), packed = await parseSourceArchive(compressed)
    expect(packed.presentation).toEqual(raw.presentation)
    expect(packed.session).toEqual(raw.session)
    expect(packed.warnings.join('\n')).toContain('Zstandard')
    expect(await parseArchive(compressed)).not.toHaveProperty('presentation')
  })
  it('工具驱动会话不再伪装成只有一句提问，工具独立呈现且不混入问答', async () => {
    const parsed = await parseSourceArchive(claudeFixture(browserTask()))
    expect(parsed.session.messages).toHaveLength(1)
    expect(parsed.presentation).toMatchObject({ kind: 'browser-task', textMessages: 1, toolCalls: 2, toolResults: 1, activitiesTruncated: false })
    expect(parsed.presentation?.activities.map(item => item.kind)).toEqual(['call', 'result', 'call'])
    expect(parsed.presentation?.activities[1]).toMatchObject({ name: 'browser_click', content: '合成按钮已点击' })
    expect(parsed.presentation?.activities[2].content).toContain('合成检查完成')
    expect(parsed.session.messages[0].content).not.toContain('合成检查完成')
  })
  it('只统计选中父链的活动，不能把其他分支的工具补进会话', async () => {
    const records = browserTask()
    records.splice(3, 0, { ...records[3], uuid: 'other', parentUuid: 'u1', message: { role: 'assistant', id: 'other', content: [{ type: 'tool_use', name: 'off_branch', id: 'off', input: {} }] } })
    const parsed = await parseSourceArchive(claudeFixture(records))
    expect(parsed.presentation?.toolCalls).toBe(2)
    expect(JSON.stringify(parsed.presentation)).not.toContain('off_branch')
  })
  it('来源阅读接受旧版无 apiBlockIndex 的连续助手记录，档案严格规则保持不变', async () => {
    const records = claudeRecords().map(record => { const { apiBlockIndex: _index, ...legacy } = record; return legacy })
    await expect(parseArchive(claudeFixture(records))).rejects.toThrow(/追加块索引/)
    const parsed = await parseSourceArchive(claudeFixture(records))
    expect(parsed.session.messages).toHaveLength(2)
    expect(parsed.session.messages[1].content).toBe('合成答复：先确认目标。')
    expect(parsed.warnings.join('\n')).toMatch(/旧版.*追加块/)
  })
  it('无索引的重复文本记录保留为独立片段，不猜测增量合并或悄悄去重', async () => {
    const records = claudeRecords()
    records[3].message = { role: 'assistant', id: 'legacy', content: [{ type: 'text', text: '相同片段' }] }
    records[4].message = { role: 'assistant', id: 'legacy', content: [{ type: 'text', text: '相同片段' }] }
    delete records[3].apiBlockIndex; delete records[4].apiBlockIndex
    const parsed = await parseSourceArchive(claudeFixture(records))
    expect(parsed.session.messages.map(message => message.content)).toEqual(['合成问题：整理项目计划', '相同片段', '相同片段'])
  })
  it('仍拒绝有索引的倒序、混合索引、多根和缺失父链，不用兼容开关放松结构', async () => {
    const repeated = claudeRecords(); repeated[4].apiBlockIndex = 0
    const mixed = claudeRecords(); delete mixed[4].apiBlockIndex
    const missing = claudeRecords(); missing[4].parentUuid = 'missing'
    const roots = claudeRecords(); roots[4].parentUuid = null
    for (const records of [repeated, mixed, missing, roots]) await expect(parseSourceArchive(claudeFixture(records))).rejects.toThrow()
  })
  it('没有文字消息的工具会话仍提供活动，不捏造用户/助手答复', async () => {
    const records = browserTask(); records[1].message = { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'synthetic' } }] }
    const parsed = await parseSourceArchive(claudeFixture(records))
    expect(parsed.session.messages).toEqual([])
    expect(parsed.presentation).toMatchObject({ toolCalls: 2, toolResults: 1, attachments: 2 })
  })
  it('活动输出有数量和文本预算，保留总数与截断标记，不执行或展开图片', async () => {
    const rows = [codexMeta(), codexMessage()]
    for (let index = 0; index < 110; index++) rows.push(codexRecord('response_item', { type: 'function_call', call_id: String(index), name: 'synthetic_tool', arguments: 'x'.repeat(1000) }))
    rows.push(codexRecord('response_item', { type: 'function_call_output', call_id: '0', output: '<script>不会运行</script>' + 'x'.repeat(20_000) }))
    const parsed = await parseSourceArchive(codexFixture(rows))
    expect(parsed.presentation?.toolCalls).toBe(110)
    expect(parsed.presentation?.toolResults).toBe(1)
    expect(parsed.presentation?.activities.length).toBeLessThanOrEqual(100)
    expect(parsed.presentation?.activitiesTruncated).toBe(true)
    expect(JSON.stringify(parsed.presentation).length).toBeLessThan(150_000)
  })
  it('Codex 用户注入块不抢首问，工具结果与明文答复分别保留', async () => {
    const bytes = codexFixture([codexMeta(), codexMessage('user', [{ type: 'input_text', text: '<codex_apps_client_time_context>时间</codex_apps_client_time_context>' }, { type: 'input_text', text: '<external_codex_apps_open_page>页面</external_codex_apps_open_page>' }, { type: 'input_text', text: '实际提问' }]),
      codexRecord('response_item', { type: 'function_call', call_id: 'one', name: 'test_tool', arguments: '{"only":"synthetic"}' }),
      codexRecord('response_item', { type: 'function_call_output', call_id: 'one', output: '合成工具结果' }),
      codexMessage('assistant', [{ type: 'output_text', text: '实际答复' }])])
    const parsed = await parseSourceArchive(bytes)
    expect(parsed.session.messages).toEqual([{ role: 'user', content: '实际提问' }, { role: 'assistant', content: '实际答复' }])
    expect(parsed.session.title).toBe('实际提问')
    expect(parsed.presentation).toMatchObject({ textMessages: 2, toolCalls: 1, toolResults: 1 })
  })
})
