import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceBrowser } from '../src/main/source-browser'
import { claudeFixture } from './fixtures/claude-code'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
describe('动作只能定位已授权来源元数据', () => {
  it('按opaque ID读取元数据副本，不泄漏路径，断开后立即失效', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-entry-actions-')))
    directories.push(root)
    const source = join(root, 'source'); await mkdir(source)
    await writeFile(join(source, 'one.jsonl'), claudeFixture())
    const browser = new SourceBrowser(join(root, 'data'))
    const connection = await browser.connect('claude-code', source)
    await browser.refresh(connection.id); await browser.waitForScan(connection.id)
    const item = (await browser.page({})).items[0]
    const original = await browser.getEntry(item.id)
    expect(original).toEqual(item)
    expect(original).not.toHaveProperty('path')
    original.sourceSessionId = 'changed'
    expect((await browser.getEntry(item.id)).sourceSessionId).toBe(item.sourceSessionId)
    await browser.disconnect(connection.id)
    await expect(browser.getEntry(item.id)).rejects.toThrow('已断开')
  })
  it('未知ID与路径不触发读取授权外数据', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-entry-actions-')))
    directories.push(root)
    const browser = new SourceBrowser(root)
    await expect(browser.getEntry('a'.repeat(64))).rejects.toThrow('不存在')
    await expect(browser.getEntry('/private/secret')).rejects.toThrow()
  })
})
