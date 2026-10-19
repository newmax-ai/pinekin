import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceBrowser } from '../src/main/source-browser'
import { sourceCandidates, type SourceLocationContext } from '../src/main/source-discovery'
import { autoConnectSource } from '../src/main/source-discovery'
import { claudeFixture } from './fixtures/claude-code'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-location-'))); roots.push(root)
  const context: SourceLocationContext = { home: join(root, 'home'), appData: join(root, 'appData'), platform: 'darwin', env: {} }
  const data = join(root, 'pinekin')
  await mkdir(data); await mkdir(context.home)
  return { root, context, data }
}
async function directory(path: string) { await mkdir(path, { recursive: true }); return path }
async function save(data: string, connections: { id: string; source: string; path: string }[]) {
  await writeFile(join(data, 'connections.json'), JSON.stringify({ version: 1, connections }))
}

describe('Claude 与 NewMax 的数据目录隔离', () => {
  it.each(['.newmax', '.newmax/projects'])('忽略继承到 NewMax %s 的 CLAUDE_CONFIG_DIR，回到 Claude 默认目录', async name => {
    const { context } = await setup()
    context.env.CLAUDE_CONFIG_DIR = join(context.home, name)
    expect(sourceCandidates('claude-code', context)).toEqual([join(context.home, '.claude', 'projects')])
  })
  it('配置的 NewMax 数据根及其子目录也不能作为 Claude 环境覆盖，不混入默认 NewMax 日志', async () => {
    const { root, context } = await setup()
    context.env.NEWMAX_USER_DATA_DIR = join(root, 'custom-newmax')
    context.env.CLAUDE_CONFIG_DIR = join(root, 'custom-newmax', 'runtime')
    expect(sourceCandidates('claude-code', context)).toEqual([join(context.home, '.claude', 'projects')])
    expect(sourceCandidates('newmax', context)).toEqual([join(root, 'custom-newmax', 'newmax.db')])
  })
  it('保留合法 Claude 自定义目录，不按相似名称、任意 .newmax 路径片段或相对覆盖猜归属', async () => {
    const { root, context } = await setup()
    for (const custom of [join(context.home, '.newmax-extra'), join(root, 'workspace', '.newmax')]) {
      context.env.CLAUDE_CONFIG_DIR = custom
      expect(sourceCandidates('claude-code', context)).toEqual([join(custom, 'projects')])
    }
    context.env.CLAUDE_CONFIG_DIR = '../elsewhere'
    expect(() => sourceCandidates('claude-code', context)).toThrow('绝对路径')
  })
  it.each(['.newmax', '.newmax/projects', '.newmax/projects/workspace'])('手动 Claude 连接拒绝 NewMax %s，不保存授权或读取正文', async name => {
    const { data, context } = await setup(), input = await directory(join(context.home, name))
    await writeFile(join(input, 'cli.jsonl'), claudeFixture())
    const browser = new SourceBrowser(data, context)
    await expect(browser.connect('claude-code', input)).rejects.toThrow(/NewMax.*Claude Code|Claude Code.*NewMax/)
    expect(await browser.connections()).toEqual([])
    await expect(readFile(join(data, 'connections.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(input, 'cli.jsonl'))).toEqual(claudeFixture())
  })
  it('规范化后的目录也受归属检查，不能通过手动选择的父目录别名连接 NewMax', async () => {
    const { data, context, root } = await setup(), native = await directory(join(context.home, '.newmax', 'projects'))
    await symlink(join(context.home, '.newmax'), join(root, 'alias'))
    const browser = new SourceBrowser(data, context)
    await expect(browser.connect('claude-code', join(root, 'alias', 'projects'))).rejects.toThrow(/NewMax/)
    expect(await browser.connections()).toEqual([])
    expect(await realpath(native)).toBe(native)
  })
  it('启动恢复错误旧连接时明确显示目录不匹配，不再扫描成 0 条成功，也不偷偷授权新位置', async () => {
    const { data, context } = await setup(), id = randomUUID(), wrong = join(context.home, '.newmax', 'projects')
    await save(data, [{ id, source: 'claude-code', path: wrong }])
    const before = await readFile(join(data, 'connections.json')), browser = new SourceBrowser(data, context)
    await browser.restoreConnections(); await browser.waitForScan(id)
    expect((await browser.connections())[0]).toMatchObject({ id, status: 'error', total: null, discovered: 0, error: expect.stringMatching(/NewMax/) })
    expect(await readFile(join(data, 'connections.json'))).toEqual(before)
  })
  it('显式重新连接时修复旧错误目录、保留连接 ID 和其他授权；NewMax 原文件不变', async () => {
    const { data, context, root } = await setup(), id = randomUUID(), otherId = randomUUID()
    const wrong = await directory(join(context.home, '.newmax', 'projects'))
    const right = await directory(join(context.home, '.claude', 'projects'))
    const custom = await directory(join(root, 'custom-claude'))
    await writeFile(join(wrong, 'sdk.jsonl'), '不读取 NewMax 执行记录')
    await writeFile(join(right, 'one.jsonl'), claudeFixture())
    await save(data, [{ id, source: 'claude-code', path: wrong }, { id: otherId, source: 'claude-code', path: custom }])
    context.env.CLAUDE_CONFIG_DIR = join(context.home, '.newmax')
    const browser = new SourceBrowser(data, context)
    const result = await autoConnectSource(browser, 'claude-code', context)
    expect(result.warnings).toEqual([])
    expect(result.connections.map(item => item.id).sort()).toEqual([id, otherId].sort())
    expect((await browser.page({})).total).toBe(1)
    const config = JSON.parse(await readFile(join(data, 'connections.json'), 'utf8'))
    expect(config.connections).toEqual(expect.arrayContaining([{ id, source: 'claude-code', path: right }, { id: otherId, source: 'claude-code', path: custom }]))
    expect(await readFile(join(wrong, 'sdk.jsonl'), 'utf8')).toBe('不读取 NewMax 执行记录')
  })
  it('已有正确连接时去除错误连接而不创建重复项，其他来源授权不受影响', async () => {
    const { data, context } = await setup(), wrongId = randomUUID(), rightId = randomUUID(), codexId = randomUUID()
    const wrong = await directory(join(context.home, '.newmax', 'projects'))
    const right = await directory(join(context.home, '.claude', 'projects'))
    const codex = await directory(join(context.home, '.codex', 'sessions'))
    await save(data, [{ id: wrongId, source: 'claude-code', path: wrong }, { id: rightId, source: 'claude-code', path: right }, { id: codexId, source: 'codex', path: codex }])
    const browser = new SourceBrowser(data, context)
    expect((await browser.connect('claude-code', right)).id).toBe(rightId)
    await browser.waitForScan(rightId)
    expect((await browser.connections()).map(item => item.id).sort()).toEqual([rightId, codexId].sort())
    expect(JSON.parse(await readFile(join(data, 'connections.json'), 'utf8')).connections).toHaveLength(2)
  })
  it('多个旧错误连接合并后不会再等待已撤销的 ID，保留一个修复后的连接', async () => {
    const { data, context } = await setup(), first = randomUUID(), second = randomUUID()
    const wrong = await directory(join(context.home, '.newmax', 'projects'))
    const nested = await directory(join(wrong, 'workspace'))
    const right = await directory(join(context.home, '.claude', 'projects'))
    await writeFile(join(right, 'one.jsonl'), claudeFixture())
    await save(data, [{ id: first, source: 'claude-code', path: wrong }, { id: second, source: 'claude-code', path: nested }])
    const browser = new SourceBrowser(data, context)
    const result = await autoConnectSource(browser, 'claude-code', context)
    expect(result.warnings).toEqual([])
    expect(result.connections).toHaveLength(1)
    expect(result.connections[0]).toMatchObject({ id: first, status: 'ready', total: 1 })
    expect(await browser.connections()).toHaveLength(1)
  })
  it('正确目录不存在时保留旧授权和错误，不覆盖或改接其他位置', async () => {
    const { data, context } = await setup(), id = randomUUID(), wrong = await directory(join(context.home, '.newmax', 'projects'))
    await save(data, [{ id, source: 'claude-code', path: wrong }])
    const before = await readFile(join(data, 'connections.json')), browser = new SourceBrowser(data, context)
    context.env.CLAUDE_CONFIG_DIR = join(context.home, '.newmax')
    const result = await autoConnectSource(browser, 'claude-code', context)
    expect(result.warnings.join('')).toContain('NewMax')
    expect(result.connections).toHaveLength(1)
    expect(result.connections[0].status).toBe('error')
    expect(await readFile(join(data, 'connections.json'))).toEqual(before)
  })
})
