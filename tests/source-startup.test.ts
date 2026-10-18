import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SourceBrowser } from '../src/main/source-browser'
import { claudeFixture } from './fixtures/claude-code'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-startup-'))); roots.push(root)
  const data = join(root, 'pinekin'), first = join(root, 'first'), second = join(root, 'second')
  await mkdir(first); await mkdir(second)
  await writeFile(join(first, 'one.jsonl'), claudeFixture())
  await writeFile(join(second, 'two.jsonl'), claudeFixture())
  return { root, data, first, second, browser: new SourceBrowser(data) }
}
async function finish(browser: SourceBrowser) {
  for (const connection of await browser.connections()) await browser.waitForScan(connection.id)
  return browser.page({})
}

describe('启动恢复已授权来源', () => {
  it('启动时刷新全部保存的位置，不等待扫描完成才返回，也不读取正文或重写授权', async () => {
    const { data, first, second, browser } = await setup()
    const a = await browser.connect('claude-code', first), b = await browser.connect('codex', second)
    await finish(browser)
    const config = await readFile(join(data, 'connections.json'))
    const restarted = new SourceBrowser(data), read = vi.spyOn(restarted, 'read')
    await restarted.restoreConnections()
    expect(await restarted.connections()).toMatchObject([{ id: a.id, status: 'scanning', total: null }, { id: b.id, status: 'scanning', total: null }])
    const page = await finish(restarted)
    expect(page.total).toBe(2)
    expect(page.connections.every(item => item.status === 'ready' && item.total === 1)).toBe(true)
    expect(read).not.toHaveBeenCalled()
    expect(await readFile(join(data, 'connections.json'))).toEqual(config)
    expect(await readdir(data)).toEqual(['connections.json'])
  })
  it('没有连接时不发现或添加来源，也不创建连接配置', async () => {
    const { root, data } = await setup()
    const restarted = new SourceBrowser(data)
    await restarted.restoreConnections()
    expect(await restarted.connections()).toEqual([])
    expect((await restarted.page({})).items).toEqual([])
    expect(await readdir(root)).not.toContain('pinekin')
  })
  it('已断开的位置不会重新出现，即使其文件仍然存在', async () => {
    const { data, first, second, browser } = await setup()
    const kept = await browser.connect('claude-code', first), removed = await browser.connect('codex', second)
    await finish(browser); await browser.disconnect(removed.id)
    const restarted = new SourceBrowser(data)
    await restarted.restoreConnections()
    const page = await finish(restarted)
    expect(page.connections).toMatchObject([{ id: kept.id, source: 'claude-code', status: 'ready' }])
    expect(page.items).toHaveLength(1)
    expect(await readdir(second)).toEqual(['two.jsonl'])
  })
  it('重复或并发启动恢复不重启扫描，完成后不会偷偷自动刷新新增文件', async () => {
    const { data, first, browser } = await setup()
    await browser.connect('claude-code', first); await finish(browser)
    const restarted = new SourceBrowser(data)
    await Promise.all([restarted.restoreConnections(), restarted.restoreConnections()])
    expect((await finish(restarted)).total).toBe(1)
    await writeFile(join(first, 'later.jsonl'), claudeFixture())
    await restarted.restoreConnections()
    expect((await finish(restarted)).total).toBe(1)
    const [connection] = await restarted.connections()
    await restarted.refresh(connection.id)
    expect((await finish(restarted)).total).toBe(2)
  })
  it('一个来源失败不影响其他来源，不自动重试失败项，手动刷新仍可恢复', async () => {
    const { data, first, second, browser } = await setup()
    const failed = await browser.connect('claude-code', first), good = await browser.connect('codex', second)
    await finish(browser); await rm(first, { recursive: true })
    const restarted = new SourceBrowser(data)
    await restarted.restoreConnections()
    const page = await finish(restarted)
    expect(page.connections.find(item => item.id === failed.id)).toMatchObject({ status: 'error', total: null, error: expect.stringContaining('移动或删除') })
    expect(page.connections.find(item => item.id === good.id)).toMatchObject({ status: 'ready', total: 1 })
    await mkdir(first); await writeFile(join(first, 'restored.jsonl'), claudeFixture())
    await restarted.restoreConnections()
    expect((await restarted.connections()).find(item => item.id === failed.id)?.status).toBe('error')
    await restarted.refresh(failed.id)
    expect((await finish(restarted)).total).toBe(2)
  })
  it('用户暂停启动扫描后不被重复恢复打断，损坏配置明确报错且不覆盖', async () => {
    const { data, first, browser } = await setup()
    const connection = await browser.connect('claude-code', first); await finish(browser)
    const restarted = new SourceBrowser(data)
    await restarted.restoreConnections(); await restarted.cancel(connection.id); await finish(restarted)
    await restarted.restoreConnections()
    expect(await restarted.connections()).toMatchObject([{ status: 'cancelled', total: null }])
    await writeFile(join(data, 'connections.json'), 'broken')
    await expect(new SourceBrowser(data).restoreConnections()).rejects.toThrow('连接配置损坏')
    expect(await readFile(join(data, 'connections.json'), 'utf8')).toBe('broken')
  })
})
