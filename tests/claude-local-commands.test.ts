import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isClaudeAuxiliaryLog, claudeAuxiliaryReason } from '../src/main/claude-code'
import { SourceBrowser } from '../src/main/source-browser'
import { parseSourceArchive } from '../src/main/source-reader'
import { parseArchive } from '../src/main/imports'
import { createLogIndexer } from '../src/main/source-log-index'
import { readSourceLog } from '../src/main/source-log-reader'
import { inspectLogSupport } from '../src/main/source-log-inspect'
import { UnsupportedSourceError } from '../src/main/source-origin'
import { claudeFixture, claudeLocalCommandRecords, claudeRecords } from './fixtures/claude-code'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(records = claudeLocalCommandRecords()) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-local-command-'))); roots.push(root)
  const input = join(root, 'source'); await mkdir(input)
  const path = join(input, 'commands.jsonl'), bytes = claudeFixture(records)
  await writeFile(path, bytes)
  const browser = new SourceBrowser(join(root, 'data'))
  return { input, path, bytes, browser, async scan() {
    const connection = await browser.connect('claude-code', input)
    await browser.waitForScan(connection.id)
    return browser.page({})
  } }
}
function mixedRecords() {
  const records = claudeRecords()
  records[1].parentUuid = 'command-output'
  return [...claudeLocalCommandRecords(), ...records]
}

describe('Claude 纯本地命令不冒充对话（仅合成数据）', () => {
  it('完整模式头、local_command 单父链和费用尾部识别为辅助记录', () => {
    expect(isClaudeAuxiliaryLog(claudeFixture(claudeLocalCommandRecords()).toString())).toBe(true)
  })
  it('物理行倒序但逻辑父链完整时仍可确认辅助记录', () => {
    expect(isClaudeAuxiliaryLog(claudeFixture(claudeLocalCommandRecords().reverse()).toString())).toBe(true)
  })
  it('有真实问答时绝不因本地命令前缀隐藏整份文件', async () => {
    const records = mixedRecords()
    expect(isClaudeAuxiliaryLog(claudeFixture(records).toString())).toBe(false)
    const { browser, scan } = await setup(records), page = await scan()
    expect(page.total).toBe(1)
    const parsed = await browser.read(page.items[0].id)
    expect(parsed.session.messages.map(message => message.content)).toEqual(['合成问题：整理项目计划', '合成答复：先确认目标。'])
    expect(JSON.stringify(parsed.session)).not.toContain('local-command-stdout')
  })
  it.each([
    ['缺失父链', { parentUuid: 'missing' }],
    ['多个根', { parentUuid: null }],
    ['循环', { parentUuid: 'command-output' }],
    ['UUID 重放', { uuid: 'command-input' }],
    ['混合会话', { sessionId: '99999999-2222-4333-8444-555555555555' }],
    ['缺少节点字段', { timestamp: undefined }],
    ['未知系统子类型', { subtype: 'future_command' }],
    ['携带未验证消息', { message: { role: 'user', content: '不能隐藏潜在消息' } }],
    ['压缩边界', { subtype: 'compact_boundary' }],
  ] as const)('%s 不能被伪装成已确认的辅助记录', async (_name, fields) => {
    const records = claudeLocalCommandRecords(); Object.assign(records[3], fields)
    expect(isClaudeAuxiliaryLog(claudeFixture(records).toString())).toBe(false)
    if ('subtype' in fields && fields.subtype === 'compact_boundary') return
    const { scan } = await setup(records)
    expect((await scan()).total).toBe(1)
  })
  it('未知类型、坏 JSON 和截断尾部仍保留，不凭有效前缀静默过滤', async () => {
    const { browser, path, bytes, scan } = await setup()
    for (const tail of ['{"type":"future-record"}\n', '{"type":']) {
      await writeFile(path, Buffer.concat([bytes, Buffer.from(tail)]))
      expect(isClaudeAuxiliaryLog((await readFile(path)).toString())).toBe(false)
      const page = await scan()
      expect(page.total).toBe(1)
      await expect(browser.read(page.items[0].id)).rejects.toThrow()
      expect((await browser.page({})).items[0].availability).toBe('unreadable')
    }
  })
  it('缓冲来源入口和流式来源入口均返回类型化辅助状态，不伪造消息', async () => {
    const { input, path, bytes } = await setup()
    await expect(parseSourceArchive(bytes)).rejects.toBeInstanceOf(UnsupportedSourceError)
    await expect(readSourceLog(path, input, 'claude-code', { offset: 0, textOffset: 0 }, () => true)).rejects.toThrow(claudeAuxiliaryReason)
    const index = createLogIndexer('claude-code')
    claudeLocalCommandRecords().forEach((record, line) => index.accept(record, line + 1))
    expect(() => index.finish()).toThrow(UnsupportedSourceError)
    // 来源过滤不放宽档案导入，也不把命令输出转换成助手答复。
    await expect(parseArchive(bytes)).rejects.toThrow()
  })
  it('首次列表、搜索、分页、统计和未变缓存均排除纯命令，保留原件', async () => {
    const { input, path, bytes, browser, scan } = await setup()
    await writeFile(join(input, 'conversation.jsonl'), claudeFixture())
    const page = await scan()
    expect(page).toMatchObject({ total: 1, hasMore: false })
    expect(page.connections[0]).toMatchObject({ total: 1, discovered: 1 })
    expect((await browser.page({ query: 'commands.jsonl' })).total).toBe(0)
    expect((await browser.page({ offset: 1, limit: 1 })).items).toEqual([])
    await browser.check({ mode: 'manual' })
    expect((await browser.page({})).total).toBe(1)
    expect(await readFile(path)).toEqual(bytes)
  })
  it.each([80_000, 1_100_000, 5_300_000])('完整辅助文件超过预览预算（%i 字符）仍在发布前过滤', async size => {
    const records = claudeLocalCommandRecords()
    records[2].content = 'x'.repeat(size)
    const { scan } = await setup(records)
    expect((await scan()).total).toBe(0)
  })
  it('完整流式支持检查和列表判断一致', async () => {
    const { input, path, browser, scan } = await setup(mixedRecords())
    const page = await scan(), revision = page.items[0].revision!
    expect(await inspectLogSupport(path, input, 'claude-code', revision, () => true)).not.toHaveProperty('reason', claudeAuxiliaryReason)
    await writeFile(path, claudeFixture(claudeLocalCommandRecords()))
    // 从读取失败后的已过滤条目取得当前文件指纹，不额外接触真实客户端。
    await expect(browser.read(page.items[0].id)).rejects.toThrow(claudeAuxiliaryReason)
    const selected = (await browser.check({ mode: 'manual', selectedId: page.items[0].id })).selected!
    expect(await inspectLogSupport(path, input, 'claude-code', selected.revision!, () => true)).toMatchObject({ reason: claudeAuxiliaryReason, kind: 'internal' })
  })
  it('只有前缀是命令、真实消息位于 1 MiB 预览之后时保留对话', async () => {
    const records = mixedRecords(); records[2].content = 'x'.repeat(1_100_000)
    const { browser, scan } = await setup(records), page = await scan()
    expect(page.total).toBe(1)
    expect((await browser.read(page.items[0].id)).session.messages).toHaveLength(2)
  })
  it('扫描后变成纯命令立即过滤；随后追加真实问答可刷新恢复相同条目', async () => {
    const { path, browser, scan } = await setup(mixedRecords()), page = await scan(), item = page.items[0]
    await writeFile(path, claudeFixture(claudeLocalCommandRecords()))
    await expect(browser.read(item.id)).rejects.toThrow(claudeAuxiliaryReason)
    expect((await browser.page({})).total).toBe(0)
    expect((await browser.connections())[0]).toMatchObject({ total: 0, discovered: 0 })
    await writeFile(path, claudeFixture(mixedRecords()))
    await browser.check({ mode: 'manual' })
    expect((await browser.page({})).items[0].id).toBe(item.id)
    expect((await browser.read(item.id)).session.messages).toHaveLength(2)
  })
})
