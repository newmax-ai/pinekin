import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, realpath, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { SourceBrowser } from '../src/main/source-browser'
import { MAX_BYTES } from '../src/core/session'
import { SourceActivities } from '../src/main/source-activity'
import { parseSourceArchive } from '../src/main/source-reader'
import { withSourceLog } from '../src/main/source-log-file'
import { claudeRecords, claudeFixture } from './fixtures/claude-code'
import { codexMeta, codexMessage, codexFixture } from './fixtures/codex'
import { deepseekRecords, deepseekFixture } from './fixtures/deepseek'

type Source = 'claude-code' | 'codex' | 'deepseek'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function log(source: Source, count: number, text: string) {
  if (source === 'claude-code') {
    const base = claudeRecords()[1]
    return claudeFixture(Array.from({ length: count }, (_, index) => ({ ...base, uuid: `u-${index}`, parentUuid: index ? `u-${index - 1}` : null,
      entrypoint: 'cli', message: { role: 'user', content: `${index}:${text}` } })))
  }
  if (source === 'codex') return codexFixture([codexMeta(), ...Array.from({ length: count }, (_, index) => codexMessage('user', [{ type: 'input_text', text: `${index}:${text}` }], { id: `u-${index}` }))])
  const base = deepseekRecords()
  return deepseekFixture([base[0], ...Array.from({ length: count }, (_, index) => ({ ...base[1], seq: index,
    data: { id: `u-${index}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `${index}:${text}` }] } }))])
}
async function setup(source: Source, bytes: Buffer, extension = '.jsonl') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-large-log-'))); roots.push(root)
  const path = join(root, 'synthetic' + extension), data = join(root, 'data')
  await writeFile(path, bytes)
  const browser = new SourceBrowser(data)
  const connection = await browser.connect(source, root); await browser.waitForScan(connection.id)
  return { root, path, data, browser, connection }
}

describe.each(['claude-code', 'codex', 'deepseek'] as const)('%s 大日志按窗口阅读', source => {
  it('超过 5 MiB 仍可搜索与阅读，正文输出有界、长消息可续读、计数不缩水且不落盘正文', async () => {
    const text = '😀合成文本'.repeat(6000), bytes = log(source, 130, text)
    expect(bytes.length).toBeGreaterThan(MAX_BYTES)
    const { path, data, browser } = await setup(source, bytes)
    const page = await browser.page({})
    expect(page.total).toBe(1)
    const item = page.items[0], first = await browser.read(item.id)
    expect(first.window).toMatchObject({ offset: 0, textOffset: 0, totalMessages: 130, hasMore: true })
    expect(first.session.messages).toHaveLength(1)
    expect(Array.from(first.session.messages[0].content)).toHaveLength(16_384)
    const second = await browser.read(item.id, first.window!.next)
    expect(first.session.messages[0].content + second.session.messages[0].content).toBe('0:' + text)
    expect((await browser.page({ query: '0:' })).total).toBe(1)
    expect((await browser.page({})).connections[0].total).toBe(1)
    expect((await readFile(path)).equals(bytes)).toBe(true)
    expect(await readdir(data)).toEqual(['connections.json'])
    const last = await browser.read(item.id, { offset: 129, textOffset: 16384, snapshot: first.window!.snapshot })
    expect(last.window?.hasMore).toBe(false)
    expect(last.session.messages[0].content.endsWith(text.slice(-30))).toBe(true)
  })
  it('不把 10000 条消息当成会话上限，可读取最后一条', async () => {
    const { browser } = await setup(source, log(source, 10_001, '小消息'))
    const item = (await browser.page({})).items[0]
    const first = await browser.read(item.id)
    expect(first.window?.totalMessages).toBe(10_001)
    expect(first.session.messages).toHaveLength(100)
    const last = await browser.read(item.id, { offset: 10_000, textOffset: 0, snapshot: first.window!.snapshot })
    expect(last.session.messages).toEqual([{ role: 'user', content: '10000:小消息' }])
    expect(last.window?.hasMore).toBe(false)
  })
  it('续读时文件发生变化拒绝混合版本，但保留列表与从头读取能力', async () => {
    const { browser, path } = await setup(source, log(source, 101, '原文'))
    const item = (await browser.page({})).items[0], first = await browser.read(item.id)
    await writeFile(path, log(source, 101, '新的正文'))
    await expect(browser.read(item.id, first.window!.next)).rejects.toThrow(/变化|更新/)
    expect((await browser.page({})).total).toBe(1)
    expect((await browser.read(item.id)).session.messages[0].content).toBe('0:新的正文')
  })
  it('即使首段足够显示，尾部损坏也不能冒充完整校验成功', async () => {
    const bytes = Buffer.concat([log(source, 110, '可见前缀'), Buffer.from('{broken tail\n')])
    const { browser } = await setup(source, bytes)
    const item = (await browser.page({})).items[0]
    await expect(browser.read(item.id)).rejects.toThrow(/JSON|截断/)
    expect((await browser.page({})).total).toBe(1)
  })
})

it.each(['codex', 'deepseek'] as const)('%s 压缩日志展开超过 5 MiB 可按段读，坏尾部仍拒绝', async source => {
  const expanded = log(source, 80, '中文'.repeat(20_000))
  expect(expanded.length).toBeGreaterThan(MAX_BYTES)
  const bytes = zstdCompressSync(expanded)
  const { browser, path } = await setup(source, bytes, '.jsonl.zstd')
  const page = await browser.page({})
  expect(page.total).toBe(1)
  const content = await browser.read(page.items[0].id)
  expect(content.window).toMatchObject({ totalMessages: 80, hasMore: true })
  expect((await browser.read(page.items[0].id, content.window!.next)).session.messages.length).toBeGreaterThan(0)
  await writeFile(path, Buffer.concat([bytes, Buffer.from('tail garbage')]))
  await expect(browser.read(page.items[0].id)).rejects.toThrow(/压缩|Zstandard|解压/)
  expect((await browser.page({})).total).toBe(1)
})

it('Claude 完整父链仍校验，分页不把离链文本或工具带进当前链', async () => {
  const records = claudeRecords(), base = records[1]
  records.splice(2, 0, { ...base, uuid: 'other-branch', parentUuid: 'u1', message: { role: 'user', content: '禁止混入的旁支' } })
  const { browser, path } = await setup('claude-code', claudeFixture(records))
  const item = (await browser.page({})).items[0]
  expect(JSON.stringify(await browser.read(item.id))).not.toContain('禁止混入的旁支')
  records.push({ ...base, uuid: 'broken-branch', parentUuid: 'missing-parent' })
  await writeFile(path, claudeFixture(records))
  await expect(browser.read(item.id)).rejects.toThrow(/父链/)
  expect((await browser.page({})).total).toBe(1)
})

it.each(['claude-code', 'codex', 'deepseek'] as const)('%s 小会话的文字和工具语义与既有来源解析器一致', async source => {
  const bytes = source === 'claude-code' ? claudeFixture() : source === 'codex' ? codexFixture() : deepseekFixture()
  const expected = await parseSourceArchive(bytes), { browser } = await setup(source, bytes)
  const result = await browser.read((await browser.page({})).items[0].id)
  expect(result.session.messages).toEqual(expected.session.messages)
  expect(result.presentation).toEqual(expected.presentation)
})

it('Claude isMeta 助手记录沿用原有省略规则，不要求被省略记录具备答复 ID 和文本块', async () => {
  const rows = claudeRecords()
  rows[2] = { ...rows[2], type: 'assistant', isMeta: true, message: { role: 'assistant', content: '只作为注入元数据，不是答复' } }
  const bytes = claudeFixture(rows), expected = await parseSourceArchive(bytes), { browser } = await setup('claude-code', bytes)
  const result = await browser.read((await browser.page({})).items[0].id)
  expect(result.session.messages).toEqual(expected.session.messages)
  expect(result.presentation).toEqual(expected.presentation)
})

it('Claude 追加块跨越显示片段时仍按父链合并，物理行顺序不能改变工具调用与结果归属', async () => {
  const rows = claudeRecords(), base = rows[3]
  rows[4].message = { id: 'msg_synthetic', role: 'assistant', content: [{ type: 'text', text: 'A'.repeat(12_000) }] }
  rows.push({ ...base, uuid: 'a3', parentUuid: 'a2', apiBlockIndex: 2, message: { id: 'msg_synthetic', role: 'assistant', content: [
    { type: 'tool_use', id: 'call', name: 'synthetic_tool', input: { command: '不执行' } }, { type: 'text', text: 'B'.repeat(12_000) }] } })
  const result = { ...rows[1], uuid: 'result', parentUuid: 'a3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: '合成结果' }] } }
  // 结果行物理上先于调用，后续最终节点仍指向完整父链。
  rows.splice(3, 0, result)
  rows.push({ ...base, uuid: 'final', parentUuid: 'result', apiBlockIndex: 0, message: { id: 'final-msg', role: 'assistant', content: [{ type: 'text', text: '结束' }] } })
  const bytes = claudeFixture(rows), expected = await parseSourceArchive(bytes), { browser } = await setup('claude-code', bytes)
  const item = (await browser.page({})).items[0], first = await browser.read(item.id), next = await browser.read(item.id, first.window!.next)
  expect(first.session.messages[1].content + next.session.messages[0].content).toBe(expected.session.messages[1].content)
  expect(first.presentation).toEqual(expected.presentation)
  expect(next.session.messages.at(-1)?.content).toBe('结束')
})

it('完整读取支持跨压缩帧、跨块 UTF-8 和 BOM，不在帧边界丢字', async () => {
  const bytes = log('codex', 2, '😀中文'.repeat(9000)), cut = 65535
  const compressed = Buffer.concat([zstdCompressSync(Buffer.concat([Buffer.from('﻿'), bytes.subarray(0, cut)])), zstdCompressSync(bytes.subarray(cut))])
  const { browser } = await setup('codex', compressed, '.jsonl.zst')
  const item = (await browser.page({})).items[0], first = await browser.read(item.id), second = await browser.read(item.id, first.window!.next)
  expect(first.session.messages[0].content + second.session.messages[0].content).toBe('0:' + '😀中文'.repeat(9000))
})

it('流式 UTF-8 校验与授权撤销不会返回局部成功', async () => {
  const invalid = Buffer.concat([log('codex', 1, '前面合法'), Buffer.from([0xf0, 0x9f])])
  const { browser } = await setup('codex', invalid)
  const item = (await browser.page({})).items[0]
  await expect(browser.read(item.id)).rejects.toThrow(/UTF-8/)
  expect((await browser.page({})).total).toBe(1)
  const valid = await setup('codex', log('codex', 3, '合成文本'))
  let authorized = true
  await expect(withSourceLog(valid.path, valid.root, false, () => authorized, async scan => {
    await scan(() => { authorized = false })
    return '不得交付'
  })).rejects.toThrow(/断开|取消/)
})

it('并发日志请求最多同时持有两份索引工作区，完成后释放读取槽', async () => {
  const { path, root } = await setup('codex', log('codex', 1, '合成文本'))
  let release!: () => void, entered!: () => void, active = 0, maximum = 0
  const gate = new Promise<void>(resolve => { release = resolve }), twoEntered = new Promise<void>(resolve => { entered = resolve })
  const reads = Array.from({ length: 3 }, () => withSourceLog(path, root, false, () => true, async scan => {
    active += 1; maximum = Math.max(maximum, active)
    if (active === 2) entered()
    await gate
    await scan(() => {})
    active -= 1
  }))
  await twoEntered
  await new Promise<void>(resolve => setImmediate(resolve))
  const observed = maximum
  release(); await Promise.all(reads)
  expect(observed).toBe(2)
  expect(maximum).toBe(2)
})

it('大量工具活动只保留有界预览和名称索引，不随历史工具数增长', () => {
  const activity = new SourceActivities()
  for (let index = 0; index < 10_001; index++) activity.add('call', String(index), 'tool', '{}')
  expect(activity.presentation.activities).toHaveLength(100)
  expect(activity.presentation.toolCalls).toBe(10_001)
  expect((activity as unknown as { names: Map<string, string> }).names.size).toBeLessThanOrEqual(100)
})

it('Claude BOM 的 SDK 来源在显示前过滤，纯大小不会导致过滤', async () => {
  const records = claudeRecords().slice(1)
  records[0].entrypoint = 'sdk-ts'
  const { browser } = await setup('claude-code', Buffer.concat([Buffer.from('﻿'), claudeFixture(records)]))
  expect((await browser.page({})).total).toBe(0)
})
