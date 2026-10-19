import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { SourceBrowser } from '../src/main/source-browser'
import { parseArchive } from '../src/main/imports'
import { claudeFixture, claudeRecords } from './fixtures/claude-code'
import { codexFixture, codexMessage, codexMeta, codexRecord } from './fixtures/codex'
import type { BrowsableSource } from '../src/core/sources'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function connect(bytes: Buffer, source: BrowsableSource = 'codex') {
  const root = await mkdtemp(join(tmpdir(), 'pinekin-conversation-')); roots.push(root)
  const input = join(root, 'source'), data = join(root, 'data'), name = 'rollout-synthetic.jsonl'
  await mkdir(input); await writeFile(join(input, name), bytes)
  const browser = new SourceBrowser(data), connection = await browser.connect(source, input)
  await browser.waitForScan(connection.id)
  const entry = (await browser.page({})).items[0]
  return { browser, entry, data, input, name }
}
const user = (text: string) => codexMessage('user', [{ type: 'input_text', text }])
const answer = codexMessage('assistant', [{ type: 'output_text', text: '合成答复' }])
const instructions = '# AGENTS.md instructions for /synthetic/project\n\n<INSTRUCTIONS>合成工作区约束</INSTRUCTIONS>'

describe('来源标题和对话投影回归', () => {
  it('Claude 首问含超过 64 KiB 的页面快照时仍提取列表标题，保留原始问答内容', async () => {
    const records = claudeRecords()
    const prompt = '核对播放暂停\n\nPage snapshot:\n' + 'snapshot '.repeat(12_000)
    records[1].message = { role: 'user', content: prompt }
    const bytes = claudeFixture(records)
    const { browser, entry, input, name } = await connect(bytes, 'claude-code')
    expect(entry.title).toMatch(/^核对播放暂停/)
    let content = await browser.read(entry.id)
    expect(content.session.title).toBe(entry.title)
    let restored = '', hasAssistant = false
    for (;;) {
      restored += content.session.messages.filter(message => message.role === 'user').map(message => message.content).join('')
      hasAssistant ||= content.session.messages.some(message => message.role === 'assistant')
      if (!content.window?.next) break
      content = await browser.read(entry.id, content.window.next)
    }
    expect(restored).toBe(prompt)
    expect(hasAssistant).toBe(true)
    expect(await readFile(join(input, name))).toEqual(bytes)
  })
  it('Codex 跳过系统和注入上下文，使用首条真实提问作为列表和阅读标题', async () => {
    const bytes = codexFixture([codexMeta(), codexMessage('developer', [{ type: 'input_text', text: '<app-context>桌面上下文</app-context>' }]),
      codexMessage('system', [{ type: 'input_text', text: '历史系统规则' }]), user(instructions),
      user('<environment_context>合成环境</environment_context>'), user('修复会话解析'), answer,
      codexRecord('event_msg', { type: 'agent_message', message: '合成答复' })])
    const { browser, entry, data, input, name } = await connect(bytes)
    expect(entry.title).toBe('修复会话解析')
    const result = await browser.read(entry.id)
    expect(result.session.title).toBe(entry.title)
    expect(result.session.messages).toEqual([{ role: 'user', content: '修复会话解析' }, { role: 'assistant', content: '合成答复' }])
    expect(result.warnings.join('\n')).toMatch(/来源阅读.*上下文.*4/)
    expect(result.warnings.join('\n')).not.toContain('标题由会话 ID 生成')
    expect((await browser.page({ query: '修复会话解析' })).total).toBe(1)
    expect((await browser.page({ query: name })).total).toBe(1)
    expect(await readdir(data)).toEqual(['connections.json'])
    expect(await readFile(join(data, 'connections.json'), 'utf8')).not.toMatch(/修复会话解析|桌面上下文|messages/)
    expect(await readFile(join(input, name))).toEqual(bytes)
    // 档案导入仍保留系统历史，不把来源阅读规则静默应用到旧档案。
    expect((await parseArchive(bytes)).session.messages.map(message => message.role)).toEqual(['system', 'system', 'user', 'user', 'user', 'assistant'])
  })
  it('Codex 超过 64 KiB 的前置上下文不遮住后面的首问', async () => {
    const { browser, entry } = await connect(codexFixture([codexMeta({ base_instructions: { text: 'x'.repeat(80_000) } }),
      user(instructions), user('长前缀之后的真实问题'), answer]))
    expect(entry.title).toBe('长前缀之后的真实问题')
    expect((await browser.read(entry.id)).session.title).toBe(entry.title)
  })
  it.each([
    ['<environment_context>环境</environment_context>\n实际问题', '实际问题'],
    [instructions + '\n实际问题', '实际问题'],
    ['# AGENTS.md instructions\n\n<INSTRUCTIONS>多根约束</INSTRUCTIONS>\n实际问题', '实际问题'],
    ['  保留普通用户输入的缩进\n    代码示例  ', '  保留普通用户输入的缩进\n    代码示例  '],
    ['<user_instructions>约束</user_instructions>\n<environment_context>环境</environment_context>\n实际问题', '实际问题'],
    ['# Context from my IDE setup:\n## Open tabs:\n- synthetic.ts\n\n## My request for Codex:\n实际问题', '实际问题'],
    ['请解释 <environment_context> 示例和 ## My request for Codex: 标记', '请解释 <environment_context> 示例和 ## My request for Codex: 标记'],
    ['```xml\n<environment_context>这是代码示例</environment_context>\n```', '```xml\n<environment_context>这是代码示例</environment_context>\n```'],
    ['<environment_context>未闭合的普通文本', '<environment_context>未闭合的普通文本'],
    ['<unknown_context>不认识的内容</unknown_context>', '<unknown_context>不认识的内容</unknown_context>'],
  ])('只处理完整且位于开头的已知包装：%s', async (text, expected) => {
    const { browser, entry } = await connect(codexFixture([codexMeta(), user(text), answer]))
    const result = await browser.read(entry.id)
    expect(result.session.messages[0]).toEqual({ role: 'user', content: expected })
    expect(entry.title).toBe(expected.trim().split('\n').find(line => !/^(`{3,}|~{3,})[\w+.-]*\s*$/.test(line))?.replace(/\s+/g, ' ').trim())
  })
  it('保留混合内容块中的真实问题、未知占位和重复提问，不把事件或工具重复成消息', async () => {
    const bytes = codexFixture([codexMeta(), codexMessage('user', [
      { type: 'input_text', text: '<environment_context>环境</environment_context>' },
      { type: 'input_text', text: '查看附件' }, { type: 'input_image', image_url: 'file:///do-not-read.png' },
    ]), user('查看附件'), answer, codexRecord('event_msg', { type: 'user_message', message: '查看附件' }),
    codexRecord('response_item', { type: 'function_call_output', call_id: 'synthetic', output: '不是助手答复' })])
    const { browser, entry } = await connect(bytes)
    expect(entry.title).toBe('查看附件')
    const result = await browser.read(entry.id)
    expect(result.session.messages).toHaveLength(3)
    expect(result.session.messages[0].content).toBe('查看附件\n[未映射内容块，保留在原件中]')
    expect(result.session.messages[1].content).toBe('查看附件')
  })
  it('纯上下文会话返回空阅读投影和明确说明，不伪造问答', async () => {
    const { browser, entry } = await connect(codexFixture([codexMeta(), user(instructions), codexMessage('developer', [{ type: 'input_text', text: '上下文' }])]))
    const result = await browser.read(entry.id)
    expect(result.session.messages).toEqual([])
    expect(result.warnings.join('\n')).toMatch(/没有可显示的用户或助手消息/)
  })
  it('超大 Codex 日志保留在目录和搜索中，巨大事件不传入正文页', async () => {
    const { browser, entry } = await connect(codexFixture([codexMeta(), user('超大日志的首问'), codexRecord('event_msg', { type: 'synthetic', data: 'x'.repeat(6 * 1024 * 1024) })]))
    expect(entry.title).toBe('超大日志的首问')
    expect((await browser.page({ query: '超大日志的首问' })).total).toBe(1)
    const content = await browser.read(entry.id)
    expect(content.session.messages).toEqual([{ role: 'user', content: '超大日志的首问' }])
    expect(JSON.stringify(content).length).toBeLessThan(10_000)
    expect((await browser.connections())[0].total).toBe(1)
  })
  it('标题预览预算外的首问只在按需读取后补到内存索引，不扫描整份正文', async () => {
    const filler = Array.from({ length: 18 }, () => ({ type: 'file-history-snapshot', snapshot: 'x'.repeat(64_000) }))
    const records = [...filler, ...claudeRecords()]
    const { browser, entry, name } = await connect(Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n'), 'claude-code')
    expect(entry.title).toBe(name)
    const result = await browser.read(entry.id)
    expect((await browser.page({})).items[0].title).toBe(result.session.title)
    expect((await browser.page({ query: '整理项目计划' })).total).toBe(1)
  })
})
