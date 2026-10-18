import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, appendFile, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { claudeFixture, claudeRecords } from '../fixtures/claude-code'

let app: ElectronApplication, page: Page, root: string, source: string, selectedPath: string

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-refresh-e2e-')))
  source = join(root, '.claude', 'projects'); await mkdir(source, { recursive: true })
  for (let index = 0; index < 64; index++) await writeFile(join(source, `${index}.jsonl`), claudeFixture())
  selectedPath = join(source, 'selected.jsonl')
  const records = claudeRecords()
  records[1].message = { role: 'user', content: Array.from({ length: 45 }, (_, i) => `合成阅读段落 ${i}：用于验证阅读位置保持稳定。`).join('\n\n') }
  await writeFile(selectedPath, claudeFixture([...records, { type: 'custom-title', customTitle: '刷新验收会话' }]))
  const bootstrap = join(root, 'start.cjs')
  await writeFile(bootstrap, `const { app, dialog, clipboard } = require('electron');
    app.setPath('home', ${JSON.stringify(root)}); app.setPath('appData', ${JSON.stringify(join(root, 'appData'))});
    globalThis.refreshWindowEvents = [];
    app.on('browser-window-created', (_event, window) => {
      window.on('show', () => globalThis.refreshWindowEvents.push('show'));
      window.on('focus', () => globalThis.refreshWindowEvents.push('focus'));
    });
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    dialog.showSaveDialog = async () => ({ canceled: true });
    clipboard.writeText = () => { throw new Error('测试不得使用系统剪贴板'); };
    import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});`)
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined &&
    !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'EMBER_DATA_DIR', 'STAITHE_DATA_DIR', 'STAITHE_TEST_BACKGROUND', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME', 'NEWMAX_USER_DATA_DIR'].includes(entry[0])))
  app = await electron.launch({ args: [bootstrap], env: { ...env, STAITHE_DATA_DIR: join(root, 'data'), STAITHE_TEST_BACKGROUND: '1' } })
  page = await app.firstWindow(); await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  await page.getByRole('checkbox', { name: '选择 Claude Code', exact: true }).check()
  await page.getByRole('button', { name: '连接所选 App', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.session-card')).toHaveCount(50)
})
test.afterEach(async () => {
  try {
    const state = await app.evaluate(({ BrowserWindow }) => ({ events: (globalThis as unknown as { refreshWindowEvents: string[] }).refreshWindowEvents,
      windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused() })) }))
    expect(state.events).toEqual([])
    expect(state.windows.every(window => !window.visible && !window.focused)).toBe(true)
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }) }
})
async function refresh() {
  await page.getByRole('button', { name: '刷新当前来源', exact: true }).click()
  await expect(page.getByRole('button', { name: '刷新当前来源', exact: true })).toBeEnabled()
}

test('真实滚动位置、分页和阅读容器保持稳定，更新提示与删除快照分离', async () => {
  await page.getByRole('button', { name: '刷新验收会话 .', exact: true }).click()
  const messages = page.getByRole('region', { name: '会话消息' })
  await expect(messages).toBeVisible()
  await page.getByRole('button', { name: '加载更多', exact: true }).click()
  await expect(page.locator('.session-card')).toHaveCount(65)
  await page.evaluate(() => {
    const list = document.querySelector('.session-list')!, messages = document.querySelector('.messages')!
    list.scrollTop = 360; messages.scrollTop = 180
    Object.assign(window, { refreshOriginalList: list, refreshOriginalMessages: messages })
  })
  await writeFile(join(source, 'new.jsonl'), claudeFixture([...claudeRecords(), { type: 'custom-title', customTitle: '新出现的会话' }]))
  await appendFile(selectedPath, JSON.stringify({ ...claudeRecords()[1], uuid: 'u2', parentUuid: 'a2', message: { role: 'user', content: '刷新后新增的合成消息' } }) + '\n')
  await refresh()
  await expect(page.getByText('此对话有更新', { exact: true })).toBeVisible()
  await expect(messages).not.toContainText('刷新后新增的合成消息')
  await expect(page.locator('.session-card')).toHaveCount(65)
  expect(await page.evaluate(() => ({ list: document.querySelector('.session-list')!.scrollTop, messages: document.querySelector('.messages')!.scrollTop }))).toEqual({ list: 360, messages: 180 })
  await page.getByRole('button', { name: '查看更新', exact: true }).click()
  await expect(messages).toContainText('刷新后新增的合成消息')
  expect(await messages.evaluate(element => element.scrollTop)).toBe(180)
  await expect(page.getByRole('button', { name: '跳到新增消息', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '列表有更新，点击查看', exact: true }).click()
  await expect(page.getByRole('button', { name: '新出现的会话 .', exact: true })).toBeVisible()
  await expect(page.locator('.session-card')).toHaveCount(65)
  expect(await page.evaluate(() => {
    const state = window as unknown as { refreshOriginalList: Element; refreshOriginalMessages: Element }
    return document.querySelector('.session-list') === state.refreshOriginalList && document.querySelector('.messages') === state.refreshOriginalMessages
  })).toBe(true)
  await rm(selectedPath); await refresh()
  await expect(page.getByText('来源会话已删除，当前显示的是上次读取的内容', { exact: true })).toBeVisible()
  await expect(messages).toContainText('刷新后新增的合成消息')
  await expect(page.getByRole('button', { name: '重新读取正文', exact: true })).toBeDisabled()
})

test('隐藏窗口不检查，恢复可见后后台检查授权目录而不唤起窗口', async () => {
  await page.clock.install()
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
  await writeFile(join(source, 'automatic.jsonl'), claudeFixture([...claudeRecords(), { type: 'custom-title', customTitle: '自动发现的会话' }]))
  await page.clock.fastForward(120_000)
  await expect(page.getByRole('button', { name: /^Claude Code\s*65$/ })).toBeVisible()
  // 仅推进隔离测试主进程的限流时钟，不等待真实时间，也不操作系统焦点。
  await app.evaluate(() => { const now = Date.now; Date.now = () => now() + 120_000 })
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')) })
  await page.clock.fastForward(1000)
  await expect(page.getByRole('button', { name: /^Claude Code\s*66$/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '自动发现的会话 .', exact: true })).toBeVisible()
})
