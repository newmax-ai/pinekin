import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { SourceBrowser } from '../src/main/source-browser'
import { claudeFixture, claudeRecords } from './fixtures/claude-code'
import { codexFixture, codexMeta, codexMessage } from './fixtures/codex'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
it('来源目录区分浏览器任务、子会话和纯辅助记录，正常对话不误分类', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinekin-kinds-')); roots.push(root)
  const input = join(root, 'source'); await mkdir(input)
  const records = claudeRecords()
  records[1].message = { role: 'user', content: 'Task: 合成浏览器任务\n\nCurrent URL: http://localhost/test\nViewport: 400x800\n\nPage snapshot:\n合成页面' }
  await writeFile(join(input, 'task.jsonl'), claudeFixture(records))
  await writeFile(join(input, 'normal.jsonl'), claudeFixture())
  await writeFile(join(input, 'helper.jsonl'), JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }) + '\n')
  await writeFile(join(input, 'side.jsonl'), claudeFixture(claudeRecords().map(record => record.uuid ? { ...record, isSidechain: true } : record)))
  const browser = new SourceBrowser(join(root, 'data')), connection = await browser.connect('claude-code', input)
  await browser.waitForScan(connection.id)
  const page = await browser.page({})
  expect(page.items).toHaveLength(3)
  expect(page.items.find(item => item.title === '合成浏览器任务')).toMatchObject({ kind: 'browser-task' })
  const subagent = page.items.find(item => item.kind === 'subagent')!
  expect(subagent.availability).toBe('unread')
  expect((await browser.read(subagent.id)).session.messages).toHaveLength(2)
  expect(page.items.find(item => item.title === 'helper.jsonl')).toBeUndefined()
  const normal = page.items.find(item => item.kind === 'conversation')!
  expect((await browser.read(normal.id)).session.messages).toHaveLength(2)
  const task = page.items.find(item => item.kind === 'browser-task')!
  expect((await browser.read(task.id)).presentation?.kind).toBe('browser-task')
})
it('Codex 元数据声明的子会话在点击前标明类型，正文按当前文件验证，不靠文件名猜测', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinekin-kinds-')); roots.push(root)
  const input = join(root, 'source'); await mkdir(input)
  const meta = codexMeta(); meta.payload = { ...meta.payload as object, parent_thread_id: '11111111-2222-4333-8444-555555555555' }
  await writeFile(join(input, 'rollout.jsonl'), codexFixture([meta, codexMessage()]))
  const browser = new SourceBrowser(join(root, 'data')), connection = await browser.connect('codex', input)
  await browser.waitForScan(connection.id)
  expect((await browser.page({})).items[0]).toMatchObject({ kind: 'subagent', availability: 'unread' })
})
