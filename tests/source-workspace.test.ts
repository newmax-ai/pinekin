import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { SourceBrowser } from '../src/main/source-browser'
import { sourceQuerySchema } from '../src/core/sources'
import { claudeFixture, claudeRecords, claudeSessionId } from './fixtures/claude-code'
import { codexFixture } from './fixtures/codex'

// 仅合成数据：工作目录与会话 ID 都是虚构值，不读取真实客户端目录。
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'pinekin-workspace-test-')); directories.push(root)
  const input = join(root, 'source')
  await mkdir(input)
  return { root, input, browser: new SourceBrowser(join(root, 'pinekin')) }
}
function withCwd(sessionId: string, cwd: unknown, sidechain = false) {
  return claudeFixture(claudeRecords().map(record => 'sessionId' in record && 'uuid' in record
    ? { ...record, sessionId, cwd, isSidechain: sidechain, ...(sidechain ? { agentId: 'synthetic-agent' } : {}) } : record))
}
async function scan(browser: SourceBrowser, input: string, query: Record<string, unknown> = {}) {
  const connection = await browser.connect('claude-code', input)
  await browser.waitForScan(connection.id)
  return { connection, page: await browser.page({ connectionId: connection.id, limit: 100, ...query }) }
}
const parent = 'aaaaaaaa-0000-4000-8000-000000000001'

describe('来源目录：真实工作目录与子会话归属', () => {
  it('Claude 日志的绝对 cwd 作为工作目录，相对或非字符串的值被忽略', async () => {
    const { input, browser } = await setup()
    await mkdir(join(input, '-synthetic-a'))
    await writeFile(join(input, '-synthetic-a', 'one.jsonl'), withCwd(parent, '/synthetic/work/alpha'))
    await writeFile(join(input, '-synthetic-a', 'two.jsonl'), withCwd(claudeSessionId, '../relative'))
    await writeFile(join(input, '-synthetic-a', 'three.jsonl'), withCwd('aaaaaaaa-0000-4000-8000-000000000003', 42))
    const { page } = await scan(browser, input)
    const bySession = new Map(page.items.map(item => [item.sourceSessionId, item]))
    expect(bySession.get(parent)?.workspace).toBe('/synthetic/work/alpha')
    expect(bySession.get(claudeSessionId)?.workspace).toBeUndefined()
    expect(bySession.get('aaaaaaaa-0000-4000-8000-000000000003')?.workspace).toBeUndefined()
  })
  it('Codex session_meta 的 cwd 同样归入工作目录，便于跨 App 聚合', async () => {
    const { input, browser } = await setup()
    const text = codexFixture().toString('utf8').split('\n').filter(Boolean).map(line => {
      const record = JSON.parse(line)
      if (record.type === 'session_meta') record.payload.cwd = '/synthetic/work/alpha'
      return JSON.stringify(record)
    }).join('\n') + '\n'
    await writeFile(join(input, 'one.jsonl'), text)
    const connection = await browser.connect('codex', input)
    await browser.waitForScan(connection.id)
    const page = await browser.page({ connectionId: connection.id })
    expect(page.items[0].workspace).toBe('/synthetic/work/alpha')
  })
  it('subagents 目录下的会话记录父会话 ID，并从主列表折叠到父会话之下', async () => {
    const { input, browser } = await setup()
    const project = join(input, '-synthetic-a')
    await mkdir(join(project, parent, 'subagents'), { recursive: true })
    await writeFile(join(project, `${parent}.jsonl`), withCwd(parent, '/synthetic/work/alpha'))
    for (const name of ['agent-1', 'agent-2']) await writeFile(join(project, parent, 'subagents', `${name}.jsonl`), withCwd(parent, '/synthetic/work/alpha', true))
    const { connection, page } = await scan(browser, input)
    expect(page.items.map(item => item.kind)).toEqual(['conversation'])
    expect(page.items[0]).toMatchObject({ sourceSessionId: parent, subagentCount: 2 })
    expect(page.total).toBe(1)
    const children = await browser.page({ connectionId: connection.id, parentSessionId: parent })
    expect(children.items).toHaveLength(2)
    expect(children.items.every(item => item.kind === 'subagent' && item.parentSessionId === parent)).toBe(true)
    expect(children.items.every(item => item.subagentCount === undefined)).toBe(true)
    expect(await browser.read(children.items[0].id)).toMatchObject({ session: { source: 'claude-code' } })
  })
  it('找不到父会话的子会话仍留在主列表；搜索时不折叠', async () => {
    const { input, browser } = await setup()
    const project = join(input, '-synthetic-a'), orphan = 'bbbbbbbb-0000-4000-8000-000000000002'
    await mkdir(join(project, orphan, 'subagents'), { recursive: true })
    await writeFile(join(project, orphan, 'subagents', 'agent-1.jsonl'), withCwd(orphan, '/synthetic/work/beta', true))
    await mkdir(join(project, parent, 'subagents'), { recursive: true })
    await writeFile(join(project, `${parent}.jsonl`), withCwd(parent, '/synthetic/work/alpha'))
    await writeFile(join(project, parent, 'subagents', 'agent-1.jsonl'), withCwd(parent, '/synthetic/work/alpha', true))
    const { page } = await scan(browser, input)
    expect(page.items.map(item => item.parentSessionId ?? item.sourceSessionId).sort()).toEqual([parent, orphan])
    const searched = await browser.page({ query: 'synthetic/work/alpha' })
    expect(searched.items).toHaveLength(2)
  })
  it('按工作目录精确筛选，并返回已加载会话的工作目录分面', async () => {
    const { input, browser } = await setup()
    const project = join(input, '-synthetic-a')
    await mkdir(project)
    await writeFile(join(project, 'one.jsonl'), withCwd(parent, '/synthetic/work/alpha'))
    await writeFile(join(project, 'two.jsonl'), withCwd('cccccccc-0000-4000-8000-000000000004', '/synthetic/work/alpha'))
    await writeFile(join(project, 'three.jsonl'), withCwd('dddddddd-0000-4000-8000-000000000005', '/synthetic/work/beta'))
    const { page } = await scan(browser, input)
    expect(page.workspaces).toEqual([{ path: '/synthetic/work/alpha', count: 2 }, { path: '/synthetic/work/beta', count: 1 }])
    const filtered = await browser.page({ workspace: '/synthetic/work/alpha' })
    expect(filtered.items).toHaveLength(2)
    expect(filtered.items.every(item => item.workspace === '/synthetic/work/alpha')).toBe(true)
    // 分面不随筛选收窄，才能在筛选后切换到其他目录。
    expect(filtered.workspaces).toEqual(page.workspaces)
  })
  it('查询参数验证：工作目录与父会话 ID 有长度上限且不接受额外字段', () => {
    expect(sourceQuerySchema.safeParse({ workspace: '/x'.repeat(600) }).success).toBe(false)
    expect(sourceQuerySchema.safeParse({ parentSessionId: 'x'.repeat(513) }).success).toBe(false)
    expect(sourceQuerySchema.safeParse({ workspace: '/ok', parentSessionId: 'ok', extra: 1 }).success).toBe(false)
    expect(sourceQuerySchema.safeParse({ workspace: '/ok', parentSessionId: 'ok' }).success).toBe(true)
  })
})
