import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as filesystem from 'node:fs/promises'
import { SourceBrowser } from '../src/main/source-browser'
import { claudeFixture, claudeRecords, claudeSessionId } from './fixtures/claude-code'

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open) }
})
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const jsonl = (...records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n'
const prompt = (content: unknown, flags = {}) => ({ type: 'user', sessionId: claudeSessionId, message: { role: 'user', content }, ...flags })
async function setup(bytes: string | Buffer, name = 'session.jsonl') {
  const root = await mkdtemp(join(tmpdir(), 'pinekin-titles-')); roots.push(root)
  const input = join(root, 'source'), data = join(root, 'data')
  await mkdir(input)
  const path = join(input, name)
  await writeFile(path, bytes)
  const browser = new SourceBrowser(data)
  return { input, data, path, browser, async scan() {
    const connection = await browser.connect('claude-code', input)
    await browser.waitForScan(connection.id)
    return browser.page({ connectionId: connection.id })
  } }
}

describe('来源列表的 Claude Code 标题', () => {
  it.each([
    [{ type: 'ai-title', aiTitle: '自动生成标题' }, '自动生成标题'],
    [{ type: 'summary', summary: '历史摘要标题', leafUuid: 'a2' }, '历史摘要标题'],
    [{ type: 'custom-title', customTitle: '用户重命名' }, '用户重命名'],
  ])('识别明确的标题元数据 %j', async (record, title) => {
    const { scan } = await setup(Buffer.concat([claudeFixture(), Buffer.from(jsonl(record))]))
    expect((await scan()).items[0].title).toBe(title)
  })
  it('没有显式标题时使用首条有效用户文本，列表与正文标题保持一致', async () => {
    const { browser, scan, data } = await setup(claudeFixture())
    const page = await scan()
    expect(page.items[0].title).toBe('合成问题：整理项目计划')
    expect((await browser.page({ query: '整理项目计划' })).total).toBe(1)
    expect((await browser.page({ query: 'session.jsonl' })).total).toBe(1)
    expect((await browser.read(page.items[0].id)).session.title).toBe(page.items[0].title)
    expect(await readdir(data)).toEqual(['connections.json'])
    expect(await readFile(join(data, 'connections.json'), 'utf8')).not.toMatch(/合成问题|messages/)
  })
  it('同类型最后一次重命名生效，自定义标题不被后来的自动标题、摘要或消息覆盖', async () => {
    const bytes = jsonl({ type: 'custom-title', customTitle: '旧标题' }, ...claudeRecords(),
      { type: 'custom-title', customTitle: '新标题' }, { type: 'ai-title', aiTitle: '自动标题' },
      { type: 'summary', summary: '摘要标题' }, prompt('后续消息'))
    const { scan, browser } = await setup(bytes)
    const page = await scan()
    expect(page.items[0].title).toBe('新标题')
    // 正文解析继续采用原有严格父链；另用可解析日志验证标题不跳回首问。
    const readable = await setup(jsonl(...claudeRecords(), { type: 'custom-title', customTitle: '新标题' }))
    const item = (await readable.scan()).items[0]
    expect((await readable.browser.read(item.id)).session.title).toBe('新标题')
    expect((await browser.page({ query: '新标题' })).total).toBe(1)
  })
  it('大日志保留尾部最新标题，按块检查归属，超大单行读取失败也不隐藏会话', async () => {
    const bytes = Buffer.concat([claudeFixture(), Buffer.from(jsonl({ type: 'progress', data: '填充'.repeat(1_500_000) },
      { type: 'custom-title', customTitle: '超大日志的最新标题' }))])
    const { scan, browser, path } = await setup(bytes)
    const originalOpen = filesystem.open
    const requests: number[] = []
    vi.mocked(filesystem.open).mockImplementation(async (...args) => {
      const handle = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then(fs => fs.open(...args))
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation((...readArgs: Parameters<typeof handle.read>) => {
        requests.push(Number((readArgs as unknown[])[2]))
        return read(...readArgs)
      })
      return handle
    })
    const page = await scan()
    expect(page.items).toHaveLength(1)
    const id = createHash('sha256').update(page.connections[0].id).update('\0').update('session.jsonl').digest('hex')
    expect((await browser.check({ mode: 'manual', selectedId: id })).selected).toMatchObject({ title: '超大日志的最新标题', availability: 'unreadable', sourceSessionId: claudeSessionId })
    expect(Math.max(...requests)).toBeLessThanOrEqual(1024 * 1024)
    expect(requests.filter(size => size === 64 * 1024).length).toBeGreaterThan(3)
    await expect(browser.read(id)).rejects.toThrow(/8 MiB/)
    expect((await browser.page({})).total).toBe(1)
    expect((await readFile(path)).equals(bytes)).toBe(true)
    expect(originalOpen).toBe(filesystem.open)
  })
  it('头部自定义标题优先于尾部自动标题，头尾之间的正文不被索引', async () => {
    const bytes = jsonl({ type: 'custom-title', customTitle: '固定名称' }, prompt('首问'),
      { type: 'progress', data: 'x'.repeat(70_000) }, prompt('中间正文不参与搜索'),
      { type: 'progress', data: 'y'.repeat(70_000) }, { type: 'ai-title', aiTitle: '尾部自动名称' })
    const { scan, browser } = await setup(bytes)
    expect((await scan()).items[0].title).toBe('固定名称')
    expect((await browser.page({ query: '中间正文不参与搜索' })).total).toBe(0)
  })
  it('尾部消息不能假装首问，没有可用标题时仍保留文件名', async () => {
    const { scan } = await setup(jsonl({ type: 'progress', data: 'x'.repeat(1_200_000) }, prompt('仅在尾部的后续消息')))
    expect((await scan()).items[0].title).toBe('session.jsonl')
  })
  it('忽略注入、工具结果、命令和 IDE 包装，只取普通用户文本块', async () => {
    const { scan } = await setup(jsonl(
      prompt('系统注入', { isMeta: true }),
      prompt([{ type: 'tool_result', content: '工具输出' }, { type: 'text', text: '工具旁白' }]),
      prompt('<local-command-stdout>命令输出</local-command-stdout>'),
      prompt('<command-name>/compact</command-name>'), prompt('[Request interrupted by user]'),
      prompt('<bash-input>synthetic-command</bash-input>'),
      prompt([{ type: 'text', text: '<bash-stdout>合成输出</bash-stdout>' }, { type: 'text', text: '<bash-stderr></bash-stderr>' }]),
      prompt('<ide_opened_file>仅 IDE 提示</ide_opened_file>'),
      prompt([{ type: 'image', source: '不读取图片' }, { type: 'text', text: '<system-reminder>不显示提示</system-reminder>\n真正的问题\n第二行' }]),
      prompt('后续用户输入')))
    expect((await scan()).items[0].title).toBe('真正的问题')
  })
  it('首问标题仅取第一行并限制长度，不拆开 Unicode 字符', async () => {
    const { scan } = await setup(jsonl(prompt('  修复\t标题 ' + '😀'.repeat(240) + '\n不把正文第二行挤进列表')))
    const title = (await scan()).items[0].title
    expect(title).toMatch(/^修复 标题 😀/)
    expect(Array.from(title).length).toBeLessThanOrEqual(81)
    expect(title).not.toMatch(/[\n\r\t�]/)
  })
  it.each([null, [], '损坏', 4, { type: 'ai-title', aiTitle: {} }, { type: 'custom-title', customTitle: ' ' }])('异常元数据 %j 不阻塞发现', async record => {
    const { scan } = await setup(jsonl(record, prompt('有效标题')) + '{"type":"custom-title"')
    const page = await scan()
    expect(page.connections[0].status).toBe('ready')
    expect(page.items[0].title).toBe('有效标题')
  })
  it('刷新后更新重命名，子目录文件仍有标题并验证本文件正文', async () => {
    const { scan, browser, input, path } = await setup(claudeFixture())
    await mkdir(join(input, 'subagents'))
    await writeFile(join(input, 'subagents', 'agent.jsonl'), claudeFixture())
    const page = await scan(), sub = page.items.find(item => item.project === 'subagents')!
    expect(sub).toMatchObject({ title: '合成问题：整理项目计划', kind: 'subagent', availability: 'unread' })
    expect((await browser.read(sub.id)).session.messages).toHaveLength(2)
    await writeFile(path, jsonl(...claudeRecords(), { type: 'custom-title', customTitle: '刷新后的名称' }))
    await browser.refresh(page.connections[0].id); await browser.waitForScan(page.connections[0].id)
    expect((await browser.page({ query: '刷新后的名称' })).total).toBe(1)
  })
})
