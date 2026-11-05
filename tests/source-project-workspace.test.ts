import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { SourceBrowser } from '../src/main/source-browser'
import { codexFixture } from './fixtures/codex'
import { deepseekFixture } from './fixtures/deepseek'
import { qwenFixture, qwenRecord } from './fixtures/qwen'
import { workbuddyFixture } from './fixtures/workbuddy'

type ProjectSource = 'codex' | 'deepseek' | 'qwen-code'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(source: ProjectSource | 'workbuddy') {
  const root = await mkdtemp(join(tmpdir(), 'pinekin-source-project-')); roots.push(root)
  const input = join(root, source === 'qwen-code' ? 'projects/encoded-project/chats' : 'source')
  await mkdir(input, { recursive: true })
  return { input, browser: new SourceBrowser(join(root, 'pinekin')) }
}
function log(source: ProjectSource, cwd: unknown, id = 'synthetic-session') {
  const fixture = source === 'codex' ? codexFixture() : source === 'deepseek' ? deepseekFixture() : qwenFixture()
  return Buffer.from(fixture.toString().split('\n').filter(Boolean).map(line => {
    const row = JSON.parse(line)
    if (source === 'codex' && row.type === 'session_meta') {
      row.payload.cwd = cwd
      row.payload.id = row.payload.session_id = `0199e6ba-0000-7000-8000-00000000000${['one', 'two', 'three'].indexOf(id) + 1}`
    }
    if (source === 'deepseek' && row.type === 'session') { row.cwd = cwd; row.id = id }
    if (source === 'qwen-code') { row.cwd = cwd; row.sessionId = id }
    return JSON.stringify(row)
  }).join('\n') + '\n')
}
const formats = [
  { source: 'codex', compressed: false }, { source: 'codex', compressed: true },
  { source: 'deepseek', compressed: false }, { source: 'deepseek', compressed: true },
  { source: 'qwen-code', compressed: false },
] as const

describe('其他日志来源的项目目录筛选（仅合成日志）', () => {
  it.each(formats)('$source compressed=$compressed：投影目录、精确筛选与分页，筛选后保留完整分面', async ({ source, compressed }) => {
    const { input, browser } = await setup(source)
    const paths: string[] = []
    for (const [id, cwd] of [['one', '/synthetic/work/alpha'], ['two', '/synthetic/work/alpha'], ['three', 'C:\\synthetic\\beta']]) {
      const path = join(input, `${id}.jsonl${compressed ? '.zst' : ''}`), bytes = log(source, cwd, id)
      await writeFile(path, compressed ? zstdCompressSync(bytes) : bytes); paths.push(path)
    }
    const before = await Promise.all(paths.map(path => readFile(path)))
    const connection = await browser.connect(source, input); await browser.waitForScan(connection.id)
    const all = await browser.page({ source })
    expect(all.items).toHaveLength(3)
    expect(all.items.every(item => item.workspace && item.availability === 'unread')).toBe(true)
    expect(all.workspaces).toEqual([{ path: '/synthetic/work/alpha', count: 2 }, { path: 'C:\\synthetic\\beta', count: 1 }])
    const page = await browser.page({ source, workspace: '/synthetic/work/alpha', limit: 1 })
    expect(page).toMatchObject({ total: 2, hasMore: true, workspaces: all.workspaces })
    expect(page.items[0].workspace).toBe('/synthetic/work/alpha')
    const next = await browser.page({ source, workspace: '/synthetic/work/alpha', offset: 1, limit: 1 })
    expect(next.items).toHaveLength(1)
    expect(next.items[0].id).not.toBe(page.items[0].id)
    expect((await browser.page({ source, query: 'C:\\synthetic\\beta' })).total).toBe(1)
    expect((await browser.page({ source, workspace: '/synthetic/work/alph' })).total).toBe(0)
    expect(await Promise.all(paths.map(path => readFile(path)))).toEqual(before)
  })
  it.each(['deepseek', 'qwen-code'] as const)('%s：无效目录不成为筛选项，不从存储目录名推断归属', async source => {
    const { input, browser } = await setup(source)
    for (const [index, cwd] of ['', '../relative', 'bad\npath', '/x'.repeat(513)].entries()) {
      await writeFile(join(input, `${index}.jsonl`), log(source, cwd, `synthetic-${index}`))
    }
    const connection = await browser.connect(source, input); await browser.waitForScan(connection.id)
    const page = await browser.page({ source })
    expect(page.items).toHaveLength(4)
    expect(page.items.every(item => item.workspace === undefined)).toBe(true)
    expect(page.workspaces).toEqual([])
  })
  it('Qwen 按唯一根记录的 cwd 归组，不因物理记录顺序或后续切换目录改变归属', async () => {
    const { input, browser } = await setup('qwen-code')
    await writeFile(join(input, 'one.jsonl'), qwenFixture([
      qwenRecord('a', 'u', 'assistant', { role: 'model', parts: [{ text: '合成回答' }] }, { cwd: '/synthetic/changed' }),
      qwenRecord('u', null, 'user', { role: 'user', parts: [{ text: '合成问题' }] }, { cwd: '/synthetic/root' }),
      qwenRecord('b', 'a', 'assistant', { role: 'model', parts: [{ text: '合成结束' }] }, { cwd: '/synthetic/changed' }),
    ]))
    const connection = await browser.connect('qwen-code', input); await browser.waitForScan(connection.id)
    expect((await browser.page({ source: 'qwen-code' })).items[0].workspace).toBe('/synthetic/root')
  })
  it.each(['deepseek', 'qwen-code'] as const)('%s：目录元数据变更后刷新会更新筛选与快照', async source => {
    const { input, browser } = await setup(source), path = join(input, 'one.jsonl')
    await writeFile(path, log(source, '/synthetic/work/alpha'))
    const connection = await browser.connect(source, input); await browser.waitForScan(connection.id)
    const before = await browser.page({ source })
    await writeFile(path, log(source, '/synthetic/work/beta-longer'))
    await browser.refresh(connection.id); await browser.waitForScan(connection.id)
    const after = await browser.page({ source })
    expect(after.snapshot).not.toBe(before.snapshot)
    expect(after.items[0].workspace).toBe('/synthetic/work/beta-longer')
    expect((await browser.page({ source, workspace: '/synthetic/work/alpha' })).total).toBe(0)
  })
  it('WorkBuddy 未验证的 cwd 或元数据不被当作项目归属', async () => {
    const { input, browser } = await setup('workbuddy')
    await writeFile(join(input, 'synthetic-workbuddy.jsonl'), workbuddyFixture())
    await writeFile(join(input, 'synthetic-workbuddy.meta.json'), JSON.stringify({ cwd: '/synthetic/unverified', workingDir: '/synthetic/unverified' }))
    const connection = await browser.connect('workbuddy', input); await browser.waitForScan(connection.id)
    const page = await browser.page({ source: 'workbuddy' })
    expect(page.items).toHaveLength(1)
    expect(page.items[0].workspace).toBeUndefined()
    expect(page.workspaces).toEqual([])
  })
})
