import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { SourceBrowser } from '../src/main/source-browser'
import { autoConnectSource, sourceCandidates, type SourceLocationContext } from '../src/main/source-discovery'
import { claudeFixture } from './fixtures/claude-code'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-discovery-'))); roots.push(root)
  const home = join(root, 'home'), appData = join(root, 'appData'), data = join(root, 'pinekin')
  await mkdir(home); await mkdir(appData)
  const context: SourceLocationContext = { home, appData, platform: 'darwin', env: {} }
  return { root, data, context, browser: new SourceBrowser(data) }
}
async function directory(path: string) { await mkdir(path, { recursive: true }); return path }

describe('自动定位与只读连接', () => {
  it('点击连接后定位 Claude Code 默认 projects，不要求选择文件、不写正文副本', async () => {
    const { browser, data, context } = await setup()
    const projects = await directory(join(context.home, '.claude', 'projects', 'synthetic'))
    await writeFile(join(projects, 'one.jsonl'), claudeFixture())
    expect(await browser.connections()).toEqual([])
    const result = await autoConnectSource(browser, 'claude-code', context)
    expect(result.warnings).toEqual([]); expect(result.connections).toHaveLength(1)
    await browser.waitForScan(result.connections[0].id)
    expect((await browser.page({})).total).toBe(1)
    expect(await readdir(data)).toEqual(['connections.json'])
    expect(await readFile(join(data, 'connections.json'), 'utf8')).not.toContain('messages')
    expect(await readdir(projects)).toEqual(['one.jsonl'])
  })
  it('Codex 同时连接当前与归档目录，不只取第一个，重复连接不增加连接并刷新已保存位置', async () => {
    const { browser, context } = await setup()
    for (const name of ['sessions', 'archived_sessions']) await directory(join(context.home, '.codex', name))
    const result = await autoConnectSource(browser, 'codex', context)
    expect(result.connections).toHaveLength(2); expect(result.warnings).toEqual([])
    for (const item of result.connections) await browser.waitForScan(item.id)
    const again = await autoConnectSource(browser, 'codex', context)
    expect(again.connections.map(item => item.id)).toEqual(result.connections.map(item => item.id))
    for (const item of again.connections) await browser.waitForScan(item.id)
    expect(await browser.connections()).toHaveLength(2)
  })
  it('使用显式 CLI home 覆盖，不把默认账号混进来；只检查会话子目录', async () => {
    const { browser, root, context } = await setup()
    const custom = await directory(join(root, 'custom'))
    context.env = { CLAUDE_CONFIG_DIR: custom, CODEX_HOME: custom }
    await directory(join(custom, 'projects')); await directory(join(custom, 'sessions'))
    await directory(join(context.home, '.claude', 'projects'))
    await writeFile(join(custom, 'auth.json'), '不得读取')
    expect(sourceCandidates('claude-code', context)).toEqual([join(custom, 'projects')])
    expect(sourceCandidates('codex', context)).toEqual([join(custom, 'sessions'), join(custom, 'archived_sessions')])
    const result = await autoConnectSource(browser, 'claude-code', context)
    expect(result.connections).toHaveLength(1)
    await browser.waitForScan(result.connections[0].id)
    expect(await readFile(join(custom, 'auth.json'), 'utf8')).toBe('不得读取')
  })
  it('未安装或没有会话时返回可操作提示，不打开文件选择器或创建配置', async () => {
    const { browser, root, context } = await setup()
    const result = await autoConnectSource(browser, 'claude-code', context)
    expect(result.connections).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.notices?.join('')).toMatch(/未找到.*Claude Code/)
    expect(await readdir(root)).not.toContain('pinekin')
  })
  it('一个候选失败不丢掉另一个，权限错误不会冒充没有安装', async () => {
    const { browser, context } = await setup()
    await directory(join(context.home, '.codex', 'sessions')); await directory(join(context.home, '.codex', 'archived_sessions'))
    const original = browser.connect.bind(browser)
    vi.spyOn(browser, 'connect').mockImplementation((source, path) => {
      if (basename(path) === 'sessions') return Promise.reject(Object.assign(new Error('synthetic permission'), { code: 'EACCES' }))
      return original(source, path)
    })
    const result = await autoConnectSource(browser, 'codex', context)
    expect(result.connections).toHaveLength(1)
    expect(result.warnings.join('')).toContain('读取权限')
    expect(result.warnings.join('')).not.toContain('未找到')
    await browser.waitForScan(result.connections[0].id)
  })
  it('拒绝符号链接与经过链接的候选，不越出默认会话位置', async () => {
    const { browser, root, context } = await setup()
    const external = await directory(join(root, 'external'))
    await directory(join(external, 'projects')); await directory(join(external, 'archived_sessions'))
    await symlink(external, join(context.home, '.claude'))
    await directory(join(context.home, '.codex'))
    await symlink(join(external, 'archived_sessions'), join(context.home, '.codex', 'sessions'))
    for (const source of ['claude-code', 'codex'] as const) {
      const result = await autoConnectSource(browser, source, context)
      expect(result.connections).toEqual([]); expect(result.warnings.join('')).toContain('符号链接')
    }
    expect(await readdir(external)).toEqual(['archived_sessions', 'projects'])
  })
  it('DeepSeek 使用 .dsh/sessions，支持 DSH_HOME 和波浪号，空白覆盖视为未设置', async () => {
    const { browser, context } = await setup()
    expect(sourceCandidates('deepseek', context)).toEqual([join(context.home, '.dsh', 'sessions')])
    context.env.DSH_HOME = '  '
    expect(sourceCandidates('deepseek', context)).toEqual([join(context.home, '.dsh', 'sessions')])
    context.env.DSH_HOME = '~/custom-harness'
    const logs = await directory(join(context.home, 'custom-harness', 'sessions'))
    await writeFile(join(logs, 'session.v4.jsonl'), '{"type":"session","version":4,"id":"synthetic","isSeeded":false,"delegationDepth":0}')
    const result = await autoConnectSource(browser, 'deepseek', context)
    expect(result.connections).toHaveLength(1); expect(result.warnings).toEqual([])
    await browser.waitForScan(result.connections[0].id)
    expect((await browser.page({})).total).toBe(1)
  })
  it('Cindy 只浅层枚举国内／国际版账号库，忽略凭据、备份、其他数据库及子目录', async () => {
    const { browser, context } = await setup()
    const domestic = await directory(join(context.appData, 'Cindy'))
    const global = await directory(join(context.appData, 'CindyGlobal'))
    for (const name of ['cindy-one.db', 'cindy-two.db', 'cindy-one.db-wal', 'cindy-one.db.bak', 'auth.json', 'other.db']) {
      await writeFile(join(domestic, name), 'synthetic')
    }
    await directory(join(domestic, 'nested', 'cindy-nested.db'))
    await writeFile(join(global, 'cindy-three.db'), 'synthetic')
    // 这里仅验证文件名发现，不让模拟数据库内容进入真实 SQLite 解析。
    vi.spyOn(browser, 'waitForScan').mockResolvedValue()
    const connect = vi.spyOn(browser, 'connect').mockImplementation(async (source, path) => ({
      id: path, source, label: path, status: 'scanning', discovered: 0, total: null, issues: 0, ignoredLinks: 0,
    }))
    const result = await autoConnectSource(browser, 'cindy', context)
    expect(result.connections).toHaveLength(3); expect(result.warnings).toEqual([])
    expect(connect.mock.calls.map(call => call[1]).sort()).toEqual([
      join(domestic, 'cindy-one.db'), join(domestic, 'cindy-two.db'), join(global, 'cindy-three.db'),
    ].sort())
  })
  it('Cindy 根目录链接被拒绝，NewMax 仅检查源码确认的固定数据库路径', async () => {
    const { browser, context, root } = await setup()
    await symlink(await directory(join(root, 'outside')), join(context.appData, 'Cindy'))
    expect((await autoConnectSource(browser, 'cindy', context)).warnings.join('')).toContain('符号链接')
    const result = await autoConnectSource(browser, 'newmax', context)
    expect(result.connections).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.notices?.join('')).toContain('未找到 NewMax')
    expect(sourceCandidates('newmax', context)).toEqual([join(context.home, '.newmax', 'newmax.db')])
    context.env.NEWMAX_USER_DATA_DIR = join(root, 'custom')
    expect(sourceCandidates('newmax', context)).toEqual([join(root, 'custom', 'newmax.db')])
    context.env.NEWMAX_USER_DATA_DIR = ''
    expect(sourceCandidates('newmax', context)).toEqual([join(context.home, '.newmax', 'newmax.db')])
    for (const value of ['relative', '~/custom', '  ']) {
      context.env.NEWMAX_USER_DATA_DIR = value
      expect(() => sourceCandidates('newmax', context)).toThrow('绝对路径')
    }
  })
  it('NewMax 首次自动发现固定数据库，扫描失败作为该 App 的失败原因返回而不是成功', async () => {
    const { browser, context } = await setup()
    await directory(join(context.home, '.newmax'))
    await writeFile(join(context.home, '.newmax', 'newmax.db'), 'broken sqlite')
    const result = await autoConnectSource(browser, 'newmax', context)
    expect(result.connections).toHaveLength(1)
    expect(result.connections[0].status).toBe('error')
    expect(result.warnings.join('')).toMatch(/数据库|SQLite/)
  })
  it('已授权自定义位置在重启后自动复用，无需重复选位置', async () => {
    const { browser, context, root, data } = await setup()
    const custom = await directory(join(root, 'custom-projects'))
    await writeFile(join(custom, 'one.jsonl'), claudeFixture())
    const initial = await browser.connect('claude-code', custom)
    await browser.waitForScan(initial.id)
    const restarted = new SourceBrowser(data)
    const result = await autoConnectSource(restarted, 'claude-code', context)
    expect(result.connections.map(item => item.id)).toEqual([initial.id])
    expect(result.warnings).toEqual([])
    await restarted.waitForScan(initial.id)
    expect((await restarted.page({})).total).toBe(1)
  })
  it('NewMax 复用已授权连接，不因未知默认路径迫使用户再选文件', async () => {
    const { browser, context } = await setup()
    vi.spyOn(browser, 'connections').mockResolvedValue([{ id: 'saved', source: 'newmax', label: 'newmax.db', status: 'idle', total: null, discovered: 0, issues: 0, ignoredLinks: 0 }])
    const refresh = vi.spyOn(browser, 'refresh').mockResolvedValue()
    vi.spyOn(browser, 'waitForScan').mockResolvedValue()
    const result = await autoConnectSource(browser, 'newmax', context)
    expect(result.connections).toHaveLength(1); expect(result.warnings).toEqual([])
    expect(refresh).toHaveBeenCalledWith('saved')
  })
  it('调用方失效后不保存连接或开始扫描', async () => {
    const { browser, context } = await setup()
    await directory(join(context.home, '.claude', 'projects'))
    const guard = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error('调用方已关闭') })
    await expect(autoConnectSource(browser, 'claude-code', context, guard)).rejects.toThrow('调用方已关闭')
    expect(await browser.connections()).toEqual([])
  })
  it('候选类型错误、相对环境变量与非法来源均不扩大扫描范围', async () => {
    const { browser, context } = await setup()
    await directory(join(context.home, '.claude'))
    await writeFile(join(context.home, '.claude', 'projects'), 'not a directory')
    expect((await autoConnectSource(browser, 'claude-code', context)).warnings.join('')).toContain('文件夹')
    context.env.CLAUDE_CONFIG_DIR = '../elsewhere'
    await expect(autoConnectSource(browser, 'claude-code', context)).rejects.toThrow('绝对路径')
    await expect(autoConnectSource(browser, 'other' as never, context)).rejects.toThrow()
    expect(await browser.connections()).toEqual([])
  })
})
