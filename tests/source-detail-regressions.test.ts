import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { SourceBrowser } from '../src/main/source-browser'
import { parseSourceArchive } from '../src/main/source-reader'
import { parseArchive } from '../src/main/imports'
import { sourceMessageParts } from '../src/core/source-presentation'
import { claudeFixture, claudeRecords } from './fixtures/claude-code'
import { codexFixture, codexMeta, codexMessage } from './fixtures/codex'
import { deepseekFixture, deepseekRecords } from './fixtures/deepseek'
import type { BrowsableSource } from '../src/core/sources'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function indexed(source: BrowsableSource, bytes: Buffer, subagent = false, name = 'synthetic.jsonl') {
  const root = await mkdtemp(join(tmpdir(), 'pinekin-detail-')); roots.push(root)
  const input = join(root, 'source'), directory = subagent ? join(input, 'subagents') : input
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, name), bytes)
  const browser = new SourceBrowser(join(root, 'data'))
  const connection = await browser.connect(source, input); await browser.waitForScan(connection.id)
  return { browser, item: (await browser.page({})).items[0] }
}

describe('来源详情截图回归（全部合成数据）', () => {
  it.each(['file:///synthetic/gallery.html', 'about:blank', 'http://127.0.0.1:9999/test'])('Claude 浏览器任务识别 %s，不将页面快照混在提问里', async url => {
    const records = claudeRecords()
    const content = `Task: 检查合成页面\n\nCurrent URL: ${url}\nViewport: 800x560\n\nPage snapshot:\n合成页面内容`
    records[1].message = { role: 'user', content }
    const { browser, item } = await indexed('claude-code', claudeFixture(records))
    expect(item).toMatchObject({ title: '检查合成页面', kind: 'browser-task' })
    const parsed = await browser.read(item.id)
    expect(sourceMessageParts(parsed.session.messages[0].content, 'claude-code', 'user')).toEqual({ primary: '检查合成页面', context: `Current URL: ${url}\nViewport: 800x560\n\nPage snapshot:\n合成页面内容` })
  })
  it('Claude 独立子会话可读取当前文件单父链，不读外部历史，档案导入仍严格拒绝', async () => {
    const records = claudeRecords().map(record => record.uuid ? { ...record, isSidechain: true } : record)
    const bytes = claudeFixture(records), { browser, item } = await indexed('claude-code', bytes, true)
    expect(item).toMatchObject({ kind: 'subagent', availability: 'unread' })
    const parsed = await browser.read(item.id)
    expect(parsed.session.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(parsed.presentation?.kind).toBe('subagent')
    expect(parsed.warnings.join('\n')).toMatch(/当前文件|继承上下文/)
    await expect(parseArchive(bytes)).rejects.toThrow(/子会话/)
  })
  it.each([
    { source: { subagent: 'review' } },
    { parent_thread_id: '11111111-1111-4111-8111-111111111111' },
    { subagent_history_start_ordinal: 3 },
  ])('Codex 子会话 %j 展示文件内问答而不是一律禁止', async fields => {
    const meta = codexMeta(); Object.assign(meta.payload as object, fields)
    const bytes = codexFixture([meta, codexMessage('user', [{ type: 'input_text', text: '核对合成修改' }]), codexMessage('assistant', [{ type: 'output_text', text: '合成核对结果' }])])
    const { browser, item } = await indexed('codex', bytes)
    expect(item.availability).toBe('unread')
    const parsed = await browser.read(item.id)
    expect(parsed.session.messages.map(message => message.content)).toEqual(['核对合成修改', '合成核对结果'])
    expect(parsed.presentation?.kind).toBe('subagent')
    expect(parsed.warnings.join('\n')).toMatch(/当前文件.*继承|继承.*当前文件/)
    await expect(parseArchive(bytes)).rejects.toThrow(/子会话/)
  })
  it('Codex 需要外部历史分页的记录仍不冒充完整单文件', async () => {
    const meta = codexMeta(); Object.assign(meta.payload as object, { history_base: { path: '/synthetic/do-not-read' } })
    await expect(parseSourceArchive(codexFixture([meta, codexMessage()]))).rejects.toThrow(/继承其他历史/)
  })
  it.each(['zstd', 'zst'])('DeepSeek .jsonl.%s 压缩标题首次扫描立即可见，无需点击正文', async extension => {
    const { browser, item } = await indexed('deepseek', zstdCompressSync(deepseekFixture()), false, `session.v4.jsonl.${extension}`)
    expect(item).toMatchObject({ title: 'DeepSeek 合成会话', sourceSessionId: 'session-synthetic', availability: 'unread' })
    expect((await browser.page({ query: 'DeepSeek 合成会话' })).total).toBe(1)
    expect((await browser.read(item.id)).session.title).toBe(item.title)
    await browser.refresh(item.connectionId); await browser.waitForScan(item.connectionId)
    expect((await browser.page({})).items[0].title).toBe(item.title)
  })
  it('DeepSeek 压缩流损坏时只标记该条不可读，不伪造标题', async () => {
    const { item } = await indexed('deepseek', Buffer.from('not-zstd'), false, 'session.v4.jsonl.zstd')
    expect(item.availability).toBe('unreadable')
  })
  it('DeepSeek 首次列表读取尾部标题，点击前即可搜索，读取后不跳变', async () => {
    const records = deepseekRecords()
    records.splice(3, 0, { type: 'diagnostic', seq: 2, time: 1_790_000_000_000, data: { padding: 'x'.repeat(90_000) } })
    records.slice(1).forEach((record, index) => { record.seq = index })
    const { browser, item } = await indexed('deepseek', deepseekFixture(records))
    expect(item.title).toBe('DeepSeek 合成会话')
    expect((await browser.page({ query: 'DeepSeek 合成会话' })).total).toBe(1)
    expect((await browser.read(item.id)).session.title).toBe(item.title)
  })
  it('DeepSeek 无标题事件时首问立即兜底，不用运行时上下文，列表和正文一致', async () => {
    const records = deepseekRecords().filter(record => record.type !== 'session/title')
    const first = records[1]; records[1] = records[2]; records[2] = first
    ;(records[2].data as { content: { text: string }[] }).content[0].text = '真正的首问\n第二行不当标题'
    records.slice(1).forEach((record, index) => { record.seq = index })
    const { browser, item } = await indexed('deepseek', deepseekFixture(records))
    expect(item.title).toBe('真正的首问')
    expect((await browser.read(item.id)).session.title).toBe(item.title)
  })
})
