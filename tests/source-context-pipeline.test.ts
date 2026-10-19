import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browsableSources, SOURCE_TEXT_CHARS } from '../src/core/sources'
import { buildSourceTranscript } from '../src/core/source-transcript'
import { collectSourceTransfer } from '../src/main/source-transfer'
import { readSourceLog } from '../src/main/source-log-reader'
import { SourceBrowser } from '../src/main/source-browser'
import { sourceReadWindow } from '../src/main/source-read-window'
import type { LogSource } from '../src/main/source-log-index'
import { claudeRecords } from './fixtures/claude-code'
import { codexMeta, codexMessage } from './fixtures/codex'
import { deepseekRecords } from './fixtures/deepseek'
import { qwenRecord } from './fixtures/qwen'
import { workbuddyRecord } from './fixtures/workbuddy'

const runtime = '<system-reminder data-role="user-context">合成旧客户端身份及运行环境，不是用户提问</system-reminder>'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const logSources: LogSource[] = ['claude-code', 'codex', 'deepseek', 'workbuddy', 'qwen-code']
function records(source: LogSource, text: string) {
  if (source === 'claude-code') {
    const template = claudeRecords(), user = template[1]
    return [{ ...user, message: { role: 'user', content: text } },
      { ...user, uuid: 'injected', parentUuid: 'u1', message: { role: 'user', content: runtime } },
      { ...template[4], parentUuid: 'injected', message: { id: 'assistant-id', role: 'assistant', content: [{ type: 'text', text: '合成答复' }] } }]
  }
  if (source === 'codex') return [codexMeta(), codexMessage('user', [{ type: 'input_text', text }]),
    codexMessage('user', [{ type: 'input_text', text: runtime }]), codexMessage('assistant', [{ type: 'output_text', text: '合成答复' }], { id: 'assistant-id' })]
  if (source === 'deepseek') {
    const time = 1790000000000
    return [deepseekRecords()[0],
      { type: 'user/message', seq: 0, time, surfaceOp: 'append', data: { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } },
      { type: 'user/message', seq: 1, time, surfaceOp: 'append', data: { id: 'injected', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: runtime }] } },
      { type: 'assistant/message', seq: 2, time, surfaceOp: 'append', data: { message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: '合成答复' }] } } }]
  }
  if (source === 'workbuddy') return [workbuddyRecord('u', undefined, 'user', text), workbuddyRecord('injected', 'u', 'user', runtime), workbuddyRecord('a', 'injected', 'assistant', '合成答复')]
  return [qwenRecord('u', null, 'user', { role: 'user', parts: [{ text }] }),
    qwenRecord('injected', 'u', 'user', { role: 'user', parts: [{ text: runtime }] }), qwenRecord('a', 'injected', 'assistant', { role: 'model', parts: [{ text: '合成答复' }] })]
}
async function setup(source: LogSource, text: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-context-pipeline-'))); roots.push(root)
  const path = join(root, source === 'workbuddy' ? 'synthetic-workbuddy.jsonl' : 'synthetic.jsonl')
  await writeFile(path, records(source, text).map(row => JSON.stringify(row)).join('\n') + '\n')
  return { root, path }
}

describe('运行时上下文不跨阅读、导出、接续边界', () => {
  it.each([
    [[{ type: 'text', text: '<system-reminder>合成隐藏身份' }, { type: 'text', text: '</system-reminder>\n真实问题' }], '真实问题'],
    ['<local-command-caveat>用户引用</local-command-caveat>\n真实问题', '<local-command-caveat>用户引用</local-command-caveat>'],
  ])('Claude 目录首问与正文采用整条消息相同规则，不泄漏跨块上下文或误删字面提示 %j', async (input, expectedTitle) => {
    const { root, path } = await setup('claude-code', '占位')
    const rows: Record<string, unknown>[] = records('claude-code', '占位')
    rows[0].message = { role: 'user', content: input }
    await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    const browser = new SourceBrowser(join(root, 'pinekin'))
    const connection = await browser.connect('claude-code', root); await browser.waitForScan(connection.id)
    const entry = (await browser.page({ source: 'claude-code' })).items[0]
    expect(entry.title).toBe(expectedTitle)
    const content = await browser.read(entry.id)
    expect(content.session.title).toBe(expectedTitle)
    expect(buildSourceTranscript(content).text).not.toContain('合成隐藏身份')
  })
  it.each(logSources)('%s 在结构校验后、建正文长度索引前统一清洗，纯注入记录不成为问答', async source => {
    const { root, path } = await setup(source, `${runtime}\n真实用户问题`)
    const content = await readSourceLog(path, root, source, { offset: 0, textOffset: 0 }, () => true)
    expect(content.session.messages).toEqual([{ role: 'user', content: '真实用户问题' }, { role: 'assistant', content: '合成答复' }])
    expect(content.window.totalMessages).toBe(2)
    expect(content.window.snapshot).not.toBe(content.revision)
    await expect(readSourceLog(path, root, source, { offset: 0, textOffset: 0, snapshot: content.revision }, () => true)).rejects.toThrow('已变化')
    if (source !== 'claude-code') expect(content.session.title).toBe('真实用户问题')
  })
  it.each(logSources)('%s 的提示包装跨原始窗口时也不泄漏，净化后的长提问仍可逐字续读', async source => {
    const question = '汉😀'.repeat(9000)
    const prefix = '<system-reminder data-role="user-context">' + '合成环境'.repeat(5000) + '</system-reminder>\n'
    const { root, path } = await setup(source, prefix + question)
    const first = await readSourceLog(path, root, source, { offset: 0, textOffset: 0 }, () => true)
    const second = await readSourceLog(path, root, source, first.window.next!, () => true)
    expect(first.window.totalMessages).toBe(2)
    expect(first.session.messages[0].content + second.session.messages[0].content).toBe(question)
    expect(second.session.messages[1].content).toBe('合成答复')
  })
  it.each(browsableSources)('%s 的接续出口再次清洗完整拼回的用户文字，不信任旧阅读缓存', async source => {
    const result = await collectSourceTransfer(async () => ({
      source, title: '合成标题', snapshot: 'synthetic', totalMessages: 3, offset: 0, textOffset: 0,
      fragments: [{ position: 0, role: 'user', content: `${runtime}\n真实问题` },
        { position: 1, role: 'user', content: runtime }, { position: 2, role: 'assistant', content: '合成答复' }],
    }))
    expect(result.messages).toEqual([{ role: 'user', content: '真实问题' }, { role: 'assistant', content: '合成答复' }])
  })
  it.each(browsableSources)('%s 的复制与 Markdown 出口不带旧缓存中的已知注入', source => {
    const result = buildSourceTranscript({ session: { id: 'synthetic', source, title: '合成标题', updatedAt: '2026-10-19T00:00:00.000Z', tags: [], demo: false,
      messages: [{ role: 'user', content: `${runtime}\n真实问题` }, { role: 'user', content: runtime }, { role: 'assistant', content: '合成答复' }] }, warnings: [] })
    expect(result.error).toBeUndefined()
    expect(result.text).toContain('真实问题')
    expect(result.text).not.toContain('合成旧客户端身份')
    expect(result.text).toContain('## 2. assistant')
  })
  it.each(['newmax', 'cindy'] as const)('%s 的数据库片段按原始游标剥离跨页前缀，正文不泄漏和跳字', source => {
    const prefix = '<system-reminder data-role="user-context">' + '合成'.repeat(10000) + '</system-reminder>\n'
    const raw = prefix + '真实问题😀', snapshot = 'synthetic', points = Array.from(raw)
    const row = (offset: number) => ({ position: 0, role: 'user', content: points.slice(offset, offset + SOURCE_TEXT_CHARS).join(''),
      text_length: points.length, text_offset: offset, context_prefix: raw, has_nul: 0 })
    const first = sourceReadWindow({ budget: { count: 1 }, snapshot, rows: [row(0)] }, { offset: 0, textOffset: 0 }, source)
    const second = sourceReadWindow({ budget: { count: 1 }, snapshot, rows: [row(SOURCE_TEXT_CHARS)] }, first.window.next!, source)
    expect(first.messages[0].content).toBe('')
    expect(first.window.hasMore).toBe(true)
    expect(second.messages[0].content).toBe('真实问题😀')
    expect(second.window.hasMore).toBe(false)
  })
  it.each(['newmax', 'cindy'] as const)('%s 超出有界前缀预算的未闭合运行时包装明确阻断，不把残片带出', source => {
    const prefix = '<system-reminder data-role="user-context">' + 'x'.repeat(65536)
    const content = prefix.slice(0, SOURCE_TEXT_CHARS)
    expect(() => sourceReadWindow({ budget: { count: 1 }, snapshot: 'synthetic', rows: [{ position: 0, role: 'user', content,
      context_prefix: prefix.slice(0, 65536), text_length: prefix.length + 1000, text_offset: 0, has_nul: 0 }] }, { offset: 0, textOffset: 0 }, source)).toThrow(/上下文.*预算/)
  })
})
