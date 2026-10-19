import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeAuxiliaryReason, isClaudeAuxiliaryLog } from '../src/main/claude-code'
import { SourceBrowser } from '../src/main/source-browser'
import { parseSourceArchive } from '../src/main/source-reader'
import { parseArchive } from '../src/main/imports'
import { createLogIndexer } from '../src/main/source-log-index'
import { readSourceLog } from '../src/main/source-log-reader'
import { inspectLogSupport } from '../src/main/source-log-inspect'
import { UnsupportedSourceError } from '../src/main/source-origin'
import { claudeFixture, claudeRecords } from './fixtures/claude-code'

// 仅合成终端记录；命令和输出都是不可信文本，绝不执行。
function terminalRecords(input: unknown = '<bash-input>synthetic-command --version</bash-input>', output: unknown = '<bash-stdout>合成版本输出</bash-stdout><bash-stderr></bash-stderr>'): Record<string, unknown>[] {
  const { message: _message, ...base } = claudeRecords()[1]
  return [
    { type: 'permission-mode', permissionMode: 'synthetic' },
    { ...base, entrypoint: 'cli', uuid: 'terminal-input', parentUuid: null, message: { role: 'user', content: input } },
    { ...base, uuid: 'terminal-output', parentUuid: 'terminal-input', message: { role: 'user', content: output } },
  ]
}
function mixedRecords() {
  const records = claudeRecords()
  records[1].parentUuid = 'terminal-output'
  return [...terminalRecords(), ...records]
}
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(records = terminalRecords()) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-terminal-'))); roots.push(root)
  const input = join(root, 'source'); await mkdir(input)
  const path = join(input, 'terminal.jsonl'), bytes = claudeFixture(records)
  await writeFile(path, bytes)
  const browser = new SourceBrowser(join(root, 'data'))
  return { input, path, bytes, browser, async scan() {
    const connection = await browser.connect('claude-code', input)
    await browser.waitForScan(connection.id)
    return browser.page({})
  } }
}

describe('Claude 本地终端记录不是用户问答（仅合成数据）', () => {
  it.each([
    ['字符串', '<bash-input>synthetic-command</bash-input>', '<bash-stdout>合成输出</bash-stdout><bash-stderr>合成错误</bash-stderr>'],
    ['文本块', [{ type: 'text', text: '<bash-input>synthetic-command</bash-input>' }], [{ type: 'text', text: '<bash-stdout>合成输出</bash-stdout>' }, { type: 'text', text: '<bash-stderr></bash-stderr>' }]],
    ['本地命令提示前缀', '<local-command-caveat>合成提示，不是提问</local-command-caveat>\n<bash-input>synthetic-command</bash-input>', '<bash-stdout></bash-stdout><bash-stderr></bash-stderr>'],
    ['本地斜杠命令', '<command-name>/synthetic-status</command-name>\n<command-message>synthetic-status</command-message>\n<command-args></command-args>', '<local-command-stdout>合成状态</local-command-stdout>'],
  ])('%s：完整纯终端父链识别为辅助日志，列表和读取均排除', async (_name, input, output) => {
    const records = terminalRecords(input, output), { scan, bytes, input: root, path } = await setup(records)
    expect(isClaudeAuxiliaryLog(bytes.toString())).toBe(true)
    expect((await scan()).total).toBe(0)
    await expect(parseSourceArchive(bytes)).rejects.toBeInstanceOf(UnsupportedSourceError)
    await expect(readSourceLog(path, root, 'claude-code', { offset: 0, textOffset: 0 }, () => true)).rejects.toBeInstanceOf(UnsupportedSourceError)
    const index = createLogIndexer('claude-code')
    records.forEach((record, line) => index.accept(record, line + 1))
    expect(() => index.finish()).toThrow(claudeAuxiliaryReason)
  })
  it('独立 isMeta 命令提示与终端输入、输出组成同一父链时仍排除整份辅助日志', async () => {
    const records = terminalRecords(), caveat = { ...records[1], uuid: 'terminal-caveat', isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: '<local-command-caveat>合成本地提示，不发送给模型</local-command-caveat>' }] } }
    records[1].parentUuid = 'terminal-caveat'; records.splice(1, 0, caveat)
    const { scan, bytes, input, path } = await setup(records)
    expect(isClaudeAuxiliaryLog(bytes.toString())).toBe(true)
    expect((await scan()).total).toBe(0)
    await expect(readSourceLog(path, input, 'claude-code', { offset: 0, textOffset: 0 }, () => true)).rejects.toBeInstanceOf(UnsupportedSourceError)
  })
  it('纯终端文件不进入搜索、分页、计数和未变缓存，不删除原文件', async () => {
    const { input, path, bytes, browser, scan } = await setup()
    await writeFile(join(input, 'conversation.jsonl'), claudeFixture())
    const page = await scan()
    expect(page).toMatchObject({ total: 1, hasMore: false })
    expect(page.connections[0]).toMatchObject({ total: 1, discovered: 1 })
    expect((await browser.page({ query: 'terminal.jsonl' })).total).toBe(0)
    expect((await browser.page({ offset: 1, limit: 1 })).items).toEqual([])
    await browser.check({ mode: 'manual' })
    expect((await browser.page({})).total).toBe(1)
    expect(await readFile(path)).toEqual(bytes)
  })
  it('混合日志只投影真实问答，列表与两种正文入口的标题一致，接续文本不含终端输出', async () => {
    const records = mixedRecords(), { browser, bytes, scan } = await setup(records), page = await scan()
    expect(isClaudeAuxiliaryLog(bytes.toString())).toBe(false)
    expect(page.items[0].title).toBe('合成问题：整理项目计划')
    expect((await browser.page({ query: 'synthetic-command' })).total).toBe(0)
    const buffered = await parseSourceArchive(bytes), streamed = await browser.read(page.items[0].id)
    for (const parsed of [buffered, streamed]) {
      expect(parsed.session.title).toBe(page.items[0].title)
      expect(parsed.session.messages.map(message => message.content)).toEqual(['合成问题：整理项目计划', '合成答复：先确认目标。'])
      expect(parsed.presentation).toMatchObject({ textMessages: 2, toolCalls: 0, toolResults: 0 })
      expect(parsed.presentation!.omittedRecords).toBeGreaterThanOrEqual(3)
      expect(JSON.stringify(parsed.session)).not.toMatch(/bash-|synthetic-command|合成版本输出/)
    }
    expect(streamed.window).toMatchObject({ totalMessages: 2, hasMore: false })
    expect(JSON.stringify(await browser.transfer(page.items[0].id))).not.toMatch(/bash-|synthetic-command|合成版本输出/)
    // 旧档案入口维持原有投影，不把来源阅读规则扩大为档案协议变更。
    expect((await parseArchive(bytes)).session.messages).toHaveLength(4)
  })
  it('对话末尾的终端记录从正文省略，但父链中的真实问答不丢失', async () => {
    const records = claudeRecords(), terminal = terminalRecords()
    terminal[1].parentUuid = 'a2'
    const { browser, scan, bytes } = await setup([...records, ...terminal]), page = await scan()
    for (const parsed of [await parseSourceArchive(bytes), await browser.read(page.items[0].id)]) {
      expect(parsed.session.messages).toHaveLength(2)
      expect(parsed.session.title).toBe('合成问题：整理项目计划')
    }
  })
  it.each([
    ['普通提问包含标签', '请解释 <bash-input>synthetic-command</bash-input> 的含义'],
    ['代码示例', '```xml\n<bash-stdout>示例输出</bash-stdout>\n```'],
    ['终端标签后有真实请求', '<bash-stdout>合成输出</bash-stdout>\n请帮我解释这个结果'],
    ['未闭合标签', '<bash-input>synthetic-command'],
    ['未知标签', '<bash-future>不能猜测过滤</bash-future>'],
    ['独立提示不证明命令', '<local-command-caveat>这是提示引用</local-command-caveat>'],
    ['混合文本块', [{ type: 'text', text: '<bash-stdout>合成输出</bash-stdout>' }, { type: 'text', text: '请解释' }]],
    ['混入图片', [{ type: 'text', text: '<bash-input>synthetic-command</bash-input>' }, { type: 'image', source: { type: 'synthetic' } }]],
    ['混入未知块', [{ type: 'text', text: '<bash-input>synthetic-command</bash-input>' }, { type: 'future-block' }]],
  ])('%s 不过滤潜在用户输入', async (_name, content) => {
    const records = claudeRecords(); records[1].message = { role: 'user', content }
    const { scan, browser, bytes } = await setup(records), page = await scan()
    expect(isClaudeAuxiliaryLog(bytes.toString())).toBe(false)
    expect(page.total).toBe(1)
    expect((await browser.read(page.items[0].id)).session.messages[0].content).toContain(typeof content === 'string' ? content : '<bash-')
  })
  it.each([
    ['缺失父链', { parentUuid: 'missing' }],
    ['循环', { parentUuid: 'terminal-output' }],
    ['多根', { parentUuid: null }],
    ['UUID 重放', { uuid: 'terminal-input' }],
    ['混合会话', { sessionId: '99999999-2222-4333-8444-555555555555' }],
    ['无效节点', { timestamp: undefined }],
    ['消息角色不一致', { message: { role: 'assistant', content: '<bash-stdout>输出</bash-stdout>' } }],
  ])('%s 即使有终端标签也不能静默隐藏损坏', async (_name, fields) => {
    const records = terminalRecords(); Object.assign(records[2], fields)
    const { scan, browser, bytes } = await setup(records), page = await scan()
    expect(isClaudeAuxiliaryLog(bytes.toString())).toBe(false)
    expect(page.total).toBe(1)
    await expect(browser.read(page.items[0].id)).rejects.toThrow()
    expect((await browser.page({})).items[0].availability).toBe('unreadable')
  })
  it.each([80_000, 1_100_000, 5_300_000])('明确 CLI 入口、超出预览的纯终端文件（%i 字符）仍完成整份分类', async size => {
    const records = terminalRecords(undefined, `<bash-stdout>${'x'.repeat(size)}</bash-stdout><bash-stderr></bash-stderr>`)
    // 显式标题不能阻止纯终端识别，也不能替代完整日志判定。
    records.unshift({ type: 'custom-title', customTitle: '合成终端状态' })
    expect((await (await setup(records)).scan()).total).toBe(0)
  })
  it('预览全是终端记录但尾部有真实提问时保留，完整支持检查也不误过滤', async () => {
    const records = mixedRecords()
    records.splice(2, 0, { type: 'file-history-snapshot', snapshot: 'x'.repeat(1_100_000) })
    const { browser, scan, input, path } = await setup(records), page = await scan(), item = page.items[0]
    expect(page.total).toBe(1)
    expect(await inspectLogSupport(path, input, 'claude-code', item.revision!, () => true)).not.toHaveProperty('reason', claudeAuxiliaryReason)
    expect((await browser.read(item.id)).session.messages).toHaveLength(2)
  })
  it('列出后变成纯终端即时过滤，追加真实问答后刷新恢复原 ID', async () => {
    const { path, browser, scan, input } = await setup(mixedRecords()), item = (await scan()).items[0]
    await writeFile(path, claudeFixture(terminalRecords()))
    await expect(browser.read(item.id)).rejects.toThrow(claudeAuxiliaryReason)
    expect((await browser.page({})).total).toBe(0)
    const selected = (await browser.check({ mode: 'manual', selectedId: item.id })).selected!
    expect(await inspectLogSupport(path, input, 'claude-code', selected.revision!, () => true)).toMatchObject({ kind: 'internal', reason: claudeAuxiliaryReason })
    await writeFile(path, claudeFixture(mixedRecords()))
    await browser.check({ mode: 'manual' })
    expect((await browser.page({})).items[0].id).toBe(item.id)
    expect((await browser.read(item.id)).session.messages).toHaveLength(2)
  })
})
