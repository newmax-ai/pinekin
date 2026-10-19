import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { workbuddyAssistantBlocksFixture } from '../fixtures/workbuddy'
import { qwenFixture } from '../fixtures/qwen'
import { browsableSources } from '../../src/core/sources'

let app: ElectronApplication | undefined, root: string | undefined
// 此用例会启动隔离 Electron 实例；遵守仅主 dev 的会话约束时不要运行。
test.afterEach(async () => {
  try {
    if (app?.process().exitCode === null) {
      const state = await app.evaluate(({ BrowserWindow, app }) => ({ active: process.platform === 'darwin' && app.isActive(),
        visible: BrowserWindow.getAllWindows().some(window => window.isVisible() || window.isFocused()),
        events: (globalThis as unknown as { domesticWindowEvents: string[] }).domesticWindowEvents }))
      expect(state).toEqual({ active: false, visible: false, events: [] })
    }
  } finally { await app?.close(); if (root) await rm(root, { recursive: true, force: true }) }
})

test('WorkBuddy 与 Qwen Code 可以独立授权、搜索、只读浏览和断开，不访问真实数据', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-domestic-e2e-')))
  const data = join(root, 'pinekin'), appData = join(root, 'appData')
  const wb = join(root, '.workbuddy', 'projects', 'synthetic'), qwen = join(root, '.qwen', 'projects', 'synthetic', 'chats')
  await Promise.all([data, appData, wb, qwen].map(path => mkdir(path, { recursive: true })))
  const wbPath = join(wb, 'synthetic-workbuddy.jsonl'), qwenPath = join(qwen, 'synthetic-qwen.jsonl')
  const wbBytes = workbuddyAssistantBlocksFixture(), qwenBytes = qwenFixture()
  await writeFile(wbPath, wbBytes); await writeFile(qwenPath, qwenBytes)
  const bootstrap = join(root, 'start.cjs')
  await writeFile(bootstrap, `const { app, dialog, clipboard } = require('electron');
    app.setPath('home', ${JSON.stringify(root)}); app.setPath('appData', ${JSON.stringify(appData)});
    globalThis.domesticWindowEvents = [];
    app.on('browser-window-created', (_event, window) => {
      window.on('show', () => globalThis.domesticWindowEvents.push('show'));
      window.on('focus', () => globalThis.domesticWindowEvents.push('focus'));
    });
    dialog.showOpenDialog = async () => { throw new Error('默认连接不应调用系统文件对话框'); };
    clipboard.writeText = () => { throw new Error('来源读取不应访问系统剪贴板'); };
    import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});`)
  const excluded = new Set(['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'EMBER_DATA_DIR', 'STAITHE_DATA_DIR', 'STAITHE_TEST_BACKGROUND',
    'WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR', 'QWEN_HOME', 'QWEN_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME', 'NEWMAX_USER_DATA_DIR'])
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !excluded.has(entry[0])))
  app = await electron.launch({ args: [bootstrap], env: { ...env, STAITHE_DATA_DIR: data, STAITHE_TEST_BACKGROUND: '1' } })
  const page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '连接来源 App' })
  await expect(dialog.getByRole('switch')).toHaveCount(browsableSources.length)
  expect(await page.evaluate(() => window.staithe.sources.connections())).toEqual([])
  for (const name of ['WorkBuddy', 'Qwen Code']) {
    const control = dialog.getByRole('switch', { name: `连接 ${name}`, exact: true })
    await control.click(); await expect(control).toBeEnabled(); await expect(control).toBeChecked()
    await expect(dialog.getByRole('region', { name: `${name} 来源`, exact: true })).toContainText('1 条会话')
  }
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await expect(page.locator('.session-card')).toHaveCount(2)
  for (const [title, reply] of [['合成 WorkBuddy 会话', '合成 WorkBuddy 答复'], ['合成千问会话', '合成答复']]) {
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    const search = page.getByRole('dialog', { name: '搜索会话' })
    await search.getByRole('textbox', { name: '搜索会话' }).fill(title)
    await expect(search.locator('.search-result')).toHaveCount(1)
    await search.locator('.search-result').click()
    await expect(page.getByRole('region', { name: '会话消息', exact: true })).toContainText(reply)
  }
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  const control = page.getByRole('switch', { name: '连接 WorkBuddy', exact: true })
  await control.click(); await expect(control).toBeEnabled(); await expect(control).not.toBeChecked()
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await expect(page.locator('.session-card')).toHaveCount(1)
  expect(await readFile(wbPath, 'utf8')).toBe(wbBytes)
  expect(await readFile(qwenPath, 'utf8')).toBe(qwenBytes)
  const saved = JSON.parse(await readFile(join(data, 'connections.json'), 'utf8'))
  expect(saved.connections).toHaveLength(1)
  expect(saved.connections[0].source).toBe('qwen-code')
})
