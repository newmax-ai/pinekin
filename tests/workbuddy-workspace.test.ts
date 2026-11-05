import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SourceBrowser } from '../src/main/source-browser'
import { workbuddyFixture, workbuddyRecord } from './fixtures/workbuddy'

// 全部使用合成数据，不扫描真实客户端或读取引用的工作目录。
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'pinekin-workbuddy-workspace-')); roots.push(root)
  const input = join(root, 'projects', 'encoded-storage-name'), output = join(root, 'pinekin')
  await mkdir(input, { recursive: true })
  return { input, output, browser: new SourceBrowser(output) }
}
function log(id: string, cwd: unknown, later: unknown = '/synthetic/changed') {
  return workbuddyFixture([
    { type: 'session-meta', sessionId: id, meta: { cwd: '/synthetic/unpersisted' } },
    workbuddyRecord('u', undefined, 'user', '合成工作区问题', { sessionId: id, cwd }),
    workbuddyRecord('a', 'u', 'assistant', '合成工作区回答', { sessionId: id, cwd: later }),
  ])
}
async function connect(browser: SourceBrowser, input: string) {
  const connection = await browser.connect('workbuddy', input)
  await browser.waitForScan(connection.id)
  return connection
}

describe('WorkBuddy 5.9.3 日志工作目录筛选', () => {
  it('按首个历史 cwd 分组、精确筛选与分页；不从编码目录或后续 cwd 猜测归属', async () => {
    const { input, output, browser } = await setup(), paths: string[] = []
    for (const [id, cwd] of [['one', '/synthetic/alpha'], ['two', '/synthetic/alpha'], ['three', 'C:\\synthetic\\beta']]) {
      const path = join(input, `${id}.jsonl`)
      await writeFile(path, log(id, cwd)); paths.push(path)
    }
    const before = await Promise.all(paths.map(path => readFile(path)))
    await connect(browser, input)
    const all = await browser.page({ source: 'workbuddy' })
    expect(all.items).toHaveLength(3)
    expect(all.items.every(item => item.availability === 'unread')).toBe(true)
    expect(all.workspaces).toEqual([{ path: '/synthetic/alpha', count: 2 }, { path: 'C:\\synthetic\\beta', count: 1 }])
    const first = await browser.page({ source: 'workbuddy', workspace: '/synthetic/alpha', limit: 1 })
    expect(first).toMatchObject({ total: 2, hasMore: true, workspaces: all.workspaces })
    const next = await browser.page({ source: 'workbuddy', workspace: '/synthetic/alpha', limit: 1, offset: 1 })
    expect(next.items[0].workspace).toBe('/synthetic/alpha')
    expect(next.items[0].id).not.toBe(first.items[0].id)
    expect((await browser.page({ source: 'workbuddy', workspace: '/synthetic/alph' })).total).toBe(0)
    expect((await browser.page({ source: 'workbuddy', query: 'C:\\synthetic\\beta' })).total).toBe(1)
    expect((await browser.page({ source: 'workbuddy' })).total).toBe(3)
    expect(await Promise.all(paths.map(path => readFile(path)))).toEqual(before)
    expect(await readdir(output)).toEqual(['connections.json'])
  })
  it.each([undefined, '', null, false])('跳过缺失或空 cwd %j，使用首个非空历史 cwd', async cwd => {
    const { input, browser } = await setup()
    await writeFile(join(input, 'one.jsonl'), log('one', cwd, '\\\\synthetic\\share\\beta'))
    await connect(browser, input)
    expect((await browser.page({ source: 'workbuddy' })).items[0].workspace).toBe('\\\\synthetic\\share\\beta')
  })
  it.each(['../relative', '/synthetic\nunsafe', '/synthetic\u007funsafe', '/x'.repeat(513), 42, { path: '/synthetic/not-a-string' }])('无效的首个 cwd %j 不参与筛选，也不用后续目录代替', async cwd => {
    const { input, browser } = await setup()
    await writeFile(join(input, 'one.jsonl'), log('one', cwd))
    await connect(browser, input)
    const page = await browser.page({ source: 'workbuddy' })
    expect(page.items).toHaveLength(1)
    expect(page.items[0].workspace).toBeUndefined()
    expect(page.workspaces).toEqual([])
  })
  it('旧日志无 cwd 时保持可读，不采用未经持久化契约确认的 meta.cwd 或 sidecar.cwd', async () => {
    const { input, browser } = await setup()
    const path = join(input, 'one.jsonl')
    await writeFile(path, log('one', null, null))
    await writeFile(join(input, 'one.meta.json'), JSON.stringify({ cwd: '/synthetic/sidecar' }))
    await connect(browser, input)
    const page = await browser.page({ source: 'workbuddy' })
    expect(page.items[0].workspace).toBeUndefined()
    expect(page.workspaces).toEqual([])
    expect((await browser.read(page.items[0].id)).session.messages).toHaveLength(2)
  })
  it('刷新后更新目录与快照，不沿用旧筛选项', async () => {
    const { input, browser } = await setup(), path = join(input, 'one.jsonl')
    await writeFile(path, log('one', '/synthetic/alpha'))
    const connection = await connect(browser, input), before = await browser.page({ source: 'workbuddy' })
    await writeFile(path, log('one', '/synthetic/longer-beta'))
    await browser.refresh(connection.id); await browser.waitForScan(connection.id)
    const after = await browser.page({ source: 'workbuddy' })
    expect(after.snapshot).not.toBe(before.snapshot)
    expect(after.items[0].workspace).toBe('/synthetic/longer-beta')
    expect(after.workspaces).toEqual([{ path: '/synthetic/longer-beta', count: 1 }])
    expect((await browser.page({ source: 'workbuddy', workspace: '/synthetic/alpha' })).total).toBe(0)
  })
  it('工作目录不放宽父链与分叉检查', async () => {
    const { input, browser } = await setup()
    await writeFile(join(input, 'broken.jsonl'), workbuddyFixture([
      workbuddyRecord('u', 'missing', 'user', '合成错误父链', { sessionId: 'broken', cwd: '/synthetic/alpha' }),
    ]))
    await writeFile(join(input, 'fork.jsonl'), log('fork', '/synthetic/alpha'))
    await writeFile(join(input, 'fork.meta.json'), '{"isForkedCompactionSession":true}')
    await connect(browser, input)
    const page = await browser.page({ source: 'workbuddy' })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ availability: 'unreadable' })
    expect(page.items[0].workspace).toBeUndefined()
    expect(page.workspaces).toEqual([])
  })
})
