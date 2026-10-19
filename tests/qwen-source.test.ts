import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceBrowser } from '../src/main/source-browser'
import { autoConnectSource, sourceCandidates, type SourceLocationContext } from '../src/main/source-discovery'
import { sourceSchema, type BrowsableSource } from '../src/core/sources'
import { readSourceLog } from '../src/main/source-log-reader'
import { qwenFixture, qwenRecord } from './fixtures/qwen'

const roots: string[] = []
const qwen = 'qwen-code' as BrowsableSource
const cursor = { offset: 0, textOffset: 0 }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(text = qwenFixture()) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-qwen-'))); roots.push(root)
  const context: SourceLocationContext = { home: join(root, 'home'), appData: join(root, 'appData'), platform: 'darwin', env: {} }
  const logs = join(context.home, '.qwen', 'projects', '-synthetic', 'chats')
  await mkdir(logs, { recursive: true })
  const path = join(logs, 'synthetic-qwen.jsonl')
  await writeFile(path, text)
  const browser = new SourceBrowser(join(root, 'pinekin'))
  return { root, logs, path, browser, context }
}
async function read(text = qwenFixture()) {
  const { logs, path } = await setup(text)
  return readSourceLog(path, logs, 'qwen-code', cursor, () => true)
}

describe('Qwen Code 来源契约', () => {
  it('来源枚举接受千问，固定查找 projects，不扫描 settings 或凭据', async () => {
    const { context } = await setup()
    expect(sourceSchema.parse('qwen-code')).toBe('qwen-code')
    expect(sourceCandidates(qwen, context)).toEqual([join(context.home, '.qwen', 'projects')])
    context.env.QWEN_HOME = '/synthetic/qwen-home'
    expect(sourceCandidates(qwen, context)).toEqual(['/synthetic/qwen-home/projects'])
    context.env.QWEN_RUNTIME_DIR = '/synthetic/runtime'
    expect(sourceCandidates(qwen, context)).toEqual(['/synthetic/runtime/projects'])
    context.env.QWEN_RUNTIME_DIR = '../relative'
    expect(() => sourceCandidates(qwen, context)).toThrow('绝对路径')
  })
  it('自动连接、元数据搜索、按需阅读与重启复用，原件不变且只保存授权', async () => {
    const { browser, root, context, path } = await setup()
    const original = await readFile(path, 'utf8')
    const result = await autoConnectSource(browser, qwen, context)
    expect(result.warnings).toEqual([])
    expect(result.connections).toHaveLength(1)
    const page = await browser.page({ source: qwen, query: '合成千问会话' })
    expect(page.total).toBe(1)
    expect(page.items[0]).toMatchObject({ title: '合成千问会话', source: 'qwen-code', sourceSessionId: 'synthetic-qwen' })
    const content = await browser.read(page.items[0].id)
    expect(content.session.messages).toEqual([{ role: 'user', content: '请检查合成项目' }, { role: 'assistant', content: '合成答复' }])
    expect(content.session.source).toBe('qwen-code')
    expect(content.window).toMatchObject({ totalMessages: 2, hasMore: false })
    expect(content.warnings.join('')).toContain('原生恢复')
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(await readdir(join(root, 'pinekin'))).toEqual(['connections.json'])
    const restarted = new SourceBrowser(join(root, 'pinekin'))
    await restarted.restoreConnections()
    await restarted.waitForScan(result.connections[0].id)
    expect((await restarted.page({})).total).toBe(1)
    await browser.disconnect(result.connections[0].id)
    await expect(browser.read(page.items[0].id)).rejects.toThrow('已断开')
  })
  it('目录只读取 projects/<project>/chats/*.jsonl，不读取工具结果、子代理和辅助流水', async () => {
    const { browser, context, logs } = await setup()
    const project = join(logs, '..')
    await mkdir(join(project, 'tool-results'))
    await writeFile(join(project, 'tool-results', 'not-a-chat.jsonl'), '这不是会话，不应解析')
    await mkdir(join(logs, 'subagents'))
    await writeFile(join(logs, 'subagents', 'agent.jsonl'), '这不是主会话，不应解析')
    await writeFile(join(logs, 'journal.jsonl'), '{"type":"started"}\n')
    await autoConnectSource(browser, qwen, context)
    const page = await browser.page({})
    expect(page.total).toBe(2)
    expect(page.items.some(item => item.title === 'journal.jsonl' && item.availability === 'unreadable')).toBe(true)
    expect(page.items.some(item => item.title.includes('not-a-chat') || item.title.includes('agent.jsonl'))).toBe(false)
  })
  it('只显示 text，排除 thought、工具、附件及带来源标记的注入，不沿路径读取', async () => {
    const text = qwenFixture([
      qwenRecord('u', null, 'user', { role: 'user', parts: [{ text: '真实问题' }, { inlineData: { mimeType: 'image/png', data: 'fake' } }] }),
      qwenRecord('i', 'u', 'user', { role: 'user', parts: [{ text: '运行时注入' }] }, { subtype: 'notification', provenance: 'system' }),
      qwenRecord('a', 'i', 'assistant', { role: 'model', parts: [{ text: '隐藏推理', thought: true }, { text: '真实答复' }, { functionCall: { name: 'shell', args: { command: '不要执行' } } }] }),
      qwenRecord('t', 'a', 'tool_result', { role: 'user', parts: [{ functionResponse: { name: 'shell', response: { output: '不要显示成用户提问' } } }] }),
    ])
    const content = await read(text)
    expect(content.session.messages).toEqual([{ role: 'user', content: '真实问题' }, { role: 'assistant', content: '真实答复' }])
    expect(content.presentation).toMatchObject({ textMessages: 2, toolCalls: 1, toolResults: 1, attachments: 1 })
  })
  it('标题使用最后自定义标题，缺失时用首问，不使用工具或推理兜底', async () => {
    const content = await read(qwenFixture([
      qwenRecord('u', null, 'user', { role: 'user', parts: [{ text: '第一行首问\n第二行' }] }),
      qwenRecord('a', 'u', 'assistant', { role: 'model', parts: [{ text: '回答' }] }),
    ]))
    expect(content.session.title).toBe('第一行首问')
  })
  it('长文本按 Unicode 分段，续读绑定文件快照并拒绝变化后混读', async () => {
    const message = '汉😀'.repeat(9000)
    const { path, logs } = await setup(qwenFixture([qwenRecord('u', null, 'user', { role: 'user', parts: [{ text: message }] })]))
    const first = await readSourceLog(path, logs, 'qwen-code', cursor, () => true)
    const second = await readSourceLog(path, logs, 'qwen-code', first.window.next!, () => true)
    expect(first.session.messages[0].content + second.session.messages[0].content).toBe(message)
    expect(second.window.hasMore).toBe(false)
    await writeFile(path, qwenFixture())
    await expect(readSourceLog(path, logs, 'qwen-code', first.window.next!, () => true)).rejects.toThrow('已变化')
  })
  it.each(['rewind', 'chat_compression', 'parent_session', 'branch_checkpoint', 'managed_session_header_v1'])('目录前置过滤未支持的 %s 边界', async subtype => {
    const { browser, context } = await setup(qwenFixture([
      qwenRecord('u', null, 'user', { role: 'user', parts: [{ text: '问题' }] }),
      qwenRecord('s', 'u', 'system', undefined, { subtype, systemPayload: {} }),
    ]))
    await autoConnectSource(browser, qwen, context)
    expect((await browser.page({})).total).toBe(0)
    expect((await browser.connections())[0].total).toBe(0)
  })
  it.each([
    ['缺失父链', [qwenRecord('u', 'missing', 'user', { role: 'user', parts: [{ text: '问题' }] })]],
    ['重复 UUID', [qwenRecord('u', null, 'user', { role: 'user', parts: [{ text: '一' }] }), qwenRecord('u', 'u', 'assistant', { role: 'model', parts: [{ text: '二' }] })]],
    ['多根', [qwenRecord('u', null, 'user', { role: 'user', parts: [{ text: '一' }] }), qwenRecord('a', null, 'assistant', { role: 'model', parts: [{ text: '二' }] })]],
    ['混合会话', [qwenRecord('u', null, 'user', { role: 'user', parts: [{ text: '一' }] }), qwenRecord('a', 'u', 'assistant', { role: 'model', parts: [{ text: '二' }] }, { sessionId: 'another' })]],
    ['角色错误', [qwenRecord('u', null, 'user', { role: 'model', parts: [{ text: '问题' }] })]],
    ['未知类型', [qwenRecord('u', null, 'alien', { role: 'user', parts: [{ text: '问题' }] })]],
  ])('%s 不伪造为可读会话，损坏条目保留重试', async (_name, records) => {
    const { browser, context } = await setup(qwenFixture(records))
    await autoConnectSource(browser, qwen, context)
    const page = await browser.page({})
    expect(page.total).toBe(1)
    expect(page.items[0].availability).toBe('unreadable')
    await expect(browser.read(page.items[0].id)).rejects.toThrow()
  })
  it('不能把 Claude JSONL 当成 Qwen Code，也不读取符号链接', async () => {
    const { browser, context, logs, path } = await setup('{"type":"user","message":{"role":"user","content":"不是 Qwen"}}\n')
    await symlink(path, join(logs, 'linked.jsonl'))
    await autoConnectSource(browser, qwen, context)
    const page = await browser.page({})
    expect(page.total).toBe(1)
    expect(page.items[0].availability).toBe('unreadable')
    expect((await browser.connections())[0].ignoredLinks).toBe(1)
    await expect(browser.read(page.items[0].id)).rejects.toThrow()
  })
  it('读取时授权失效不交付正文', async () => {
    const { logs, path } = await setup()
    await expect(readSourceLog(path, logs, 'qwen-code', cursor, () => false)).rejects.toThrow()
  })
})
