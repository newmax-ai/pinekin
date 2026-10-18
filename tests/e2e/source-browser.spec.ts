import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { claudeFixture, claudeRecords } from '../fixtures/claude-code'
import { DatabaseSync } from 'node:sqlite'
import { sourceNames, type BrowsableSource } from '../../src/core/sources'

let app: ElectronApplication, page: Page, root: string, data: string, source: string
async function launch() {
  const bootstrap = join(root, 'start.cjs')
  await writeFile(bootstrap, `const { app, dialog, clipboard } = require('electron');
    app.setPath('home', ${JSON.stringify(root)});
    app.setPath('appData', ${JSON.stringify(join(root, 'appData'))});
    globalThis.sourceWindowEvents = [];
    globalThis.sourceDialogCalls = 0;
    app.on('browser-window-created', (_event, window) => {
      window.on('show', () => globalThis.sourceWindowEvents.push('show'));
      window.on('focus', () => globalThis.sourceWindowEvents.push('focus'));
    });
    dialog.showOpenDialog = async () => { globalThis.sourceDialogCalls++; return { canceled: false, filePaths: [${JSON.stringify(source)}] }; };
    clipboard.writeText = () => { throw new Error('来源浏览不得使用剪贴板'); };
    import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});`)
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined &&
    !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'EMBER_DATA_DIR', 'STAITHE_DATA_DIR', 'STAITHE_TEST_BACKGROUND', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].includes(entry[0])))
  app = await electron.launch({ args: [bootstrap], env: { ...env, STAITHE_DATA_DIR: data, STAITHE_TEST_BACKGROUND: '1' } })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByRole('button', { name: '连接 App', exact: true })).toBeEnabled()
}
async function background() {
  const state = await app.evaluate(({ app, BrowserWindow }) => ({ active: process.platform === 'darwin' && app.isActive(),
    windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused() })),
    events: (globalThis as unknown as { sourceWindowEvents: string[] }).sourceWindowEvents }))
  expect(state.active).toBe(false); expect(state.events).toEqual([])
  expect(state.windows.every(window => !window.visible && !window.focused)).toBe(true)
}
async function selectSource(sourceId: BrowsableSource) {
  await page.getByRole('combobox', { name: '来源 App', exact: true }).click()
  await page.getByRole('option', { name: sourceNames[sourceId], exact: true }).click()
}
async function connect(sourceId: BrowsableSource = 'claude-code') {
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  await selectSource(sourceId)
  if (sourceId === 'claude-code' || sourceId === 'codex') await page.getByRole('button', { name: '连接', exact: true }).click()
  else {
    await page.getByText('支持范围与隐私说明', { exact: true }).click()
    await page.getByRole('button', { name: '使用自定义位置…' }).click()
  }
  await expect(page.getByRole('dialog')).toHaveCount(0)
}
async function searchFor(query: string) {
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索会话' }).fill(query)
}
async function openMatchingSession(query: string) {
  await searchFor(query)
  await expect(page.locator('.search-result')).toHaveCount(1)
  await page.locator('.search-result').click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}
async function manageConnections() {
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  await page.getByRole('button', { name: '管理连接', exact: true }).click()
}
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-sources-e2e-')))
  data = join(root, 'pinekin'); source = join(root, '.claude', 'projects')
  await mkdir(data); await mkdir(join(root, 'appData')); await mkdir(source, { recursive: true })
  for (let index = 0; index < 65; index++) await writeFile(join(source, `synthetic-${index}.jsonl`), claudeFixture())
  await writeFile(join(source, 'broken.jsonl'), 'not a session')
  await launch()
})
test.afterEach(async () => {
  try { if (app?.process().exitCode === null) await background() }
  finally { await app?.close(); await rm(root, { recursive: true, force: true }) }
})

test('连接面板精简指引，关闭按钮不默认聚焦或闪出提示，键盘关闭仍可用', async () => {
  await page.evaluate(() => {
    const state = window as unknown as { dialogFocusEvents: string[] }
    state.dialogFocusEvents = []
    document.addEventListener('focusin', event => {
      if (event.target instanceof HTMLElement && event.target.closest('dialog')) state.dialogFocusEvents.push(event.target.getAttribute('aria-label') ?? event.target.tagName)
    })
  })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.evaluate(() => { (window as unknown as { dialogFocusEvents: string[] }).dialogFocusEvents = [] })
    await page.getByRole('button', { name: '连接 App', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '连接来源 App' })
    await expect(page.getByLabel('来源 App', { exact: true })).toBeFocused()
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { dialogFocusEvents: string[] }).dialogFocusEvents)).not.toContain('关闭连接面板')
    await expect(dialog.locator('.notice')).toHaveCount(0)
    await expect(dialog.locator('.dialog-header .dialog-icon')).toHaveCount(0)
    await expect(dialog.locator('.dialog-header > h2')).toHaveText('连接来源 App')
    await expect(dialog.locator('.ds-dialog-close')).toHaveCSS('height', '32px')
    await expect(dialog.locator('.ds-dialog-close')).toHaveCSS('width', '42px')
    await expect(dialog.locator('.ds-dialog-close svg')).toHaveCSS('width', '18px')
    await expect(dialog.locator('.dialog-content > p')).toHaveCount(0)
    await expect(dialog.getByRole('region', { name: '连接说明' })).toHaveCount(1)
    await expect(dialog.locator('.connection-card-message h3')).toHaveText('连接后，直接浏览会话')
    await expect(dialog.locator('.connection-card-message p')).toHaveText('将尝试复用已有连接；首次自动定位暂未支持。')
    await expect(dialog.locator('.connection-card-privacy')).toHaveText('只读访问 · 不保存正文 · 不修改来源')
    await expect(dialog.locator('.connection-card details')).toHaveCount(1)
    await expect(dialog.locator('select')).toHaveCount(0)
    await expect(dialog.getByRole('combobox')).toHaveCSS('height', '32px')
    expect((await dialog.boundingBox())!.height).toBeLessThan(420)
    await expect(dialog.getByRole('button', { name: '连接', exact: true })).toBeVisible()
    await expect(dialog.locator('details')).not.toHaveAttribute('open')
    await expect(dialog.locator('details p').first()).toBeHidden()
    if (colorScheme === 'light') await dialog.screenshot({ path: 'test-results/pinekin-connect-card.png', scale: 'css' })
    await page.keyboard.press('Shift+Tab')
    await expect(page.getByRole('button', { name: '关闭连接面板' })).toBeFocused()
    await expect(page.getByRole('tooltip')).toHaveText('关闭连接面板')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: '连接 App', exact: true })).toBeFocused()
    await manageConnections()
    await expect(page.getByRole('dialog', { name: '管理连接' })).toBeFocused()
    await expect(page.locator('.dialog-header h2')).toHaveText('管理连接')
    await expect(page.locator('.dialog-header .dialog-icon')).toHaveCount(0)
    await expect(page.locator('.dialog-header svg')).toHaveCount(1)
    await expect(page.getByRole('button', { name: '关闭连接管理' })).toHaveClass(/ds-dialog-close/)
    await expect(page.getByRole('button', { name: '关闭连接管理' })).toHaveCSS('height', '32px')
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCSS('outline-style', 'none')
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: '关闭连接管理' })).toBeFocused()
    await expect(page.getByRole('tooltip')).toHaveText('关闭连接管理')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await background()
  }
})

test('来源选择复用 DS 菜单，弹窗内不裁切，键盘关闭只收起菜单且不闪 Tooltip', async () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
    await page.getByRole('button', { name: '连接 App', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '连接来源 App' })
    const trigger = page.getByRole('combobox', { name: '来源 App' })
    await expect(trigger).toBeFocused()
    await page.keyboard.press('ArrowDown')
    const menu = page.getByRole('listbox', { name: '来源 App' })
    await expect(menu).toBeVisible()
    expect(await menu.evaluate(element => element.matches(':popover-open'))).toBe(true)
    expect(await menu.evaluate(element => element.closest('dialog') !== null)).toBe(true)
    await expect(page.getByRole('option')).toHaveCount(5)
    await expect(page.getByRole('option').first()).toHaveCSS('min-height', '32px')
    const box = (await menu.boundingBox())!, viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    expect(box.x).toBeGreaterThanOrEqual(8); expect(box.y).toBeGreaterThanOrEqual(8)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 8)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 8)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await expect(trigger).toBeFocused()
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await trigger.click()
    await page.getByRole('option', { name: 'DeepSeek Harness', exact: true }).click()
    await expect(trigger).toHaveText('DeepSeek Harness')
    await expect(dialog.locator('.connection-card-message p')).toHaveText('Pinekin 自动查找本机会话，无需导出或导入。')
    await expect(menu).toHaveCount(0)
    await trigger.click()
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(trigger).toHaveText('Claude Code')
    await trigger.click()
    await dialog.getByRole('heading', { name: '连接来源 App', exact: true }).click()
    await expect(menu).toHaveCount(0)
    await trigger.focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Tab')
    await expect(menu).toHaveCount(0)
    await expect(dialog.locator('summary')).toBeFocused()
    await trigger.click()
    // 弹窗卸载时同时清理原生 top layer，不留下阻挡后续操作的菜单。
    await page.getByRole('button', { name: '关闭连接面板' }).click()
    await expect(dialog).toHaveCount(0)
    expect(await page.locator(':popover-open').count()).toBe(0)
    await background()
  }
})

test('UI 文字不可选中，菜单可操作，输入、正文与代码仍可选择', async () => {
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '连接来源 App' })
  await expect(dialog.getByRole('heading', { name: '连接来源 App', exact: true })).toHaveCSS('user-select', 'none')
  await expect(dialog.locator('.connection-card-message p')).toHaveCSS('user-select', 'none')
  const trigger = page.getByRole('combobox', { name: '来源 App' })
  await expect(trigger).toHaveCSS('user-select', 'none')
  await trigger.click()
  const menu = page.getByRole('listbox', { name: '来源 App' })
  await expect(menu).toHaveCSS('user-select', 'none')
  for (const option of await menu.getByRole('option').all()) {
    await expect(option).toHaveCSS('user-select', 'none')
    await expect(option.locator('span').last()).toHaveCSS('user-select', 'none')
  }
  const selectAll = process.platform === 'darwin' ? 'Meta+a' : 'Control+a'
  await page.keyboard.press(selectAll)
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('')
  await page.getByRole('option', { name: 'Claude Code', exact: true }).click()
  await expect(trigger).toHaveText('Claude Code')
  await page.getByRole('button', { name: '关闭连接面板' }).click()

  const records = claudeRecords()
  records[4].message = { id: 'msg_synthetic', role: 'assistant', content: [{ type: 'text', text: '合成答复：正文仍可复制。\n```ts\nconst synthetic = true\n```' }] }
  await writeFile(join(source, 'synthetic-0.jsonl'), claudeFixture(records))
  await connect()
  await expect(page.locator('.session-card').first()).toHaveCSS('user-select', 'none')
  await searchFor('synthetic-0')
  const input = page.getByRole('textbox', { name: '搜索会话' })
  await expect(input).toHaveCSS('user-select', 'text')
  await input.press(selectAll)
  expect(await input.evaluate(element => {
    const input = element as HTMLInputElement
    return input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0)
  })).toBe('synthetic-0')
  await page.locator('.search-result').click()
  const body = page.locator('.message-body p').first()
  await expect(body).toHaveCSS('user-select', 'text')
  await body.dblclick()
  expect((await page.evaluate(() => window.getSelection()?.toString()))?.length).toBeGreaterThan(0)
  await expect(page.locator('.code-block pre')).toHaveCSS('user-select', 'text')
  const code = page.locator('.code-block code')
  await expect(code).toHaveCSS('user-select', 'text')
  await expect(page.locator('.code-label')).toHaveCSS('user-select', 'none')
  await code.dblclick()
  expect((await page.evaluate(() => window.getSelection()?.toString()))?.length).toBeGreaterThan(0)
  await background()
})

test('来源主界面沿用原布局、插画、紧凑卡片和弹窗搜索，不附带重设计', async () => {
  await connect()
  await expect(page.locator('.session-card')).toHaveCount(50)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    for (const width of [1380, 1000]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800), width)
      await expect(page.locator('.session-pane')).toHaveCSS('width', width === 1000 ? '280px' : '310px')
      await expect(page.locator('.session-card').first()).toHaveCSS('padding', '8px 12px')
      expect(await page.locator('.session-card').first().evaluate(element => element.children.length)).toBe(2)
      await expect(page.getByRole('navigation', { name: '浏览导航' }).getByRole('button')).toHaveCount(3)
      await expect(page.locator('.brand .search-trigger')).toBeVisible()
      await expect(page.locator('.storage-note .storage-illustration')).toBeVisible()
      await expect(page.locator('.session-pane input')).toHaveCount(0)
      await expect(page.locator('[class*="relay-"]')).toHaveCount(0)
      await expect(page.locator('.list-heading + .session-list')).toBeVisible()
      await expect(page.getByText('中转站', { exact: true })).toHaveCount(0)
      await searchFor('')
      await expect(page.locator('.search-header .search')).toBeVisible()
      await expect(page.getByRole('textbox', { name: '搜索会话' })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: '搜索', exact: true })).toBeFocused()
      await background()
    }
  }
})

test('空档案库直接连接、完整计数、分页搜索、按需正文，重启只保留位置授权', async () => {
  await expect(page.getByRole('heading', { name: '尚未连接会话来源' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Claude Code\s*未连接$/ })).toBeVisible()
  await connect()
  await expect(page.getByRole('button', { name: /^Claude Code\s*66$/ })).toBeVisible()
  expect(await app.evaluate(() => (globalThis as unknown as { sourceDialogCalls: number }).sourceDialogCalls)).toBe(0)
  await expect(page.locator('.session-card')).toHaveCount(50)
  await expect(page.getByText('50 / 66 条已加载')).toBeVisible()
  await page.getByRole('button', { name: '加载更多', exact: true }).click()
  await expect(page.locator('.session-card')).toHaveCount(66)
  await openMatchingSession('synthetic-64')
  await expect(page.getByRole('region', { name: '会话消息' })).toBeVisible()
  await expect(page.getByText('未导入 Pinekin', { exact: true })).toBeVisible()
  const files = await readdir(data)
  expect(files).not.toContain('library.json'); expect(files).not.toContain('imports')
  const config = await readFile(join(data, 'connections.json'), 'utf8')
  expect(config).not.toContain('messages'); expect(config).not.toContain('合成问题')
  await page.getByRole('button', { name: 'Pin 走这段对话' }).click()
  await page.getByLabel('目标 App').selectOption('codex')
  await expect(page.locator('.dialog-header h2')).toHaveText('选择接续目标')
  await expect(page.locator('.dialog-header .dialog-icon')).toHaveCount(0)
  await expect(page.locator('.dialog-header svg')).toHaveCount(1)
  await expect(page.getByRole('button', { name: '自动接续暂未支持', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '返回会话', exact: true }).click()
  await background(); await app.close(); await launch()
  await expect(page.getByRole('button', { name: /^Claude Code\s*待刷新$/ })).toBeVisible()
  await expect(page.locator('.session-card')).toHaveCount(0)
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Claude Code\s*66$/ })).toBeVisible()
})

test('损坏日志保留且失败有原因，刷新发现增删，断开撤销授权但不删除来源', async () => {
  await connect()
  await expect(page.getByRole('button', { name: /^Claude Code\s*66$/ })).toBeVisible()
  await openMatchingSession('broken')
  await expect(page.getByRole('heading', { name: '暂时无法读取这段会话' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('格式')
  await writeFile(join(source, 'new-one.jsonl'), claudeFixture())
  await searchFor('')
  await page.getByRole('button', { name: '关闭搜索' }).click()
  await manageConnections()
  await page.getByRole('button', { name: '刷新连接', exact: true }).click()
  await expect(page.getByRole('button', { name: '刷新连接', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '关闭连接管理' }).click()
  await expect(page.getByRole('button', { name: /^Claude Code\s*67$/ })).toBeVisible()
  await manageConnections()
  await page.getByRole('button', { name: '断开连接', exact: true }).click()
  await expect(page.getByText('尚未保存连接', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭连接管理' }).click()
  await expect(page.getByRole('button', { name: /^Claude Code\s*未连接$/ })).toBeVisible()
  expect(await readdir(source)).toHaveLength(67)
  expect(JSON.parse(await readFile(join(data, 'connections.json'), 'utf8')).connections).toEqual([])
})

test('Electron SQLite 使用固定只读句柄，不创建副文件，WAL 明确拒绝而非显示零条', async () => {
  await app.close()
  source = join(root, 'newmax.db')
  const db = new DatabaseSync(source)
  db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, source TEXT, created_at INTEGER, updated_at INTEGER,
    forked_from_id TEXT, is_private INTEGER, message_count INTEGER);
    CREATE TABLE messages (seq INTEGER, id TEXT, conversation_id TEXT, role TEXT, content TEXT, timestamp INTEGER, data TEXT);
    INSERT INTO conversations VALUES ('one','数据库合成会话','app',1000,2000,NULL,0,1);`)
  const message = { id: 'm1', role: 'user', content: '仅合成数据库正文', timestamp: 2000 }
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(0, message.id, 'one', message.role, message.content, 2000, JSON.stringify(message))
  db.close()
  await launch()
  const before = await readFile(source), files = await readdir(root)
  await connect('newmax')
  await expect(page.getByRole('button', { name: /^NewMax\s*1$/ })).toBeVisible()
  await page.locator('.session-card').click()
  await expect(page.getByRole('region', { name: '会话消息' })).toContainText('仅合成数据库正文')
  expect(await readFile(source)).toEqual(before)
  expect(await readdir(root)).toEqual(files)
  const update = new DatabaseSync(source); update.exec('PRAGMA journal_mode=WAL'); update.close()
  const walFiles = await readdir(root)
  await page.getByRole('button', { name: '刷新来源', exact: true }).click()
  await expect(page.getByRole('button', { name: /^NewMax\s*读取失败$/ })).toBeVisible()
  await manageConnections()
  await expect(page.getByRole('alert')).toContainText('WAL')
  expect(await readdir(root)).toEqual(walFiles)
})

test('Codex 一次连接当前与归档会话，不弹文件选择器，重复连接不重复计数', async () => {
  for (const name of ['sessions', 'archived_sessions']) {
    const directory = join(root, '.codex', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${name}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: name } }))
  }
  await connect('codex')
  await expect(page.getByRole('button', { name: /^Codex\s*2$/ })).toBeVisible()
  await connect('codex')
  await expect(page.getByRole('button', { name: /^Codex\s*2$/ })).toBeVisible()
  expect(await app.evaluate(() => (globalThis as unknown as { sourceDialogCalls: number }).sourceDialogCalls)).toBe(0)
  const connections = JSON.parse(await readFile(join(data, 'connections.json'), 'utf8')).connections
  expect(connections).toHaveLength(2)
})

test('自动定位未找到后给出重试与手动入口，不擅自打开系统选择器', async () => {
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  await selectSource('codex')
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('连接未完成')
  await expect(page.getByRole('button', { name: '重试连接' })).toBeVisible()
  await expect(page.getByRole('button', { name: '手动指定位置' })).toHaveCount(0)
  await page.getByText('查看详情与其他方式', { exact: true }).click()
  await expect(page.locator('.connection-card-reason')).toContainText('未找到 Codex')
  await expect(page.getByRole('button', { name: '使用自定义位置…' })).toBeVisible()
  expect(await app.evaluate(() => (globalThis as unknown as { sourceDialogCalls: number }).sourceDialogCalls)).toBe(0)
  expect(await readdir(data)).not.toContain('connections.json')
  await selectSource('claude-code')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '手动指定位置' })).toHaveCount(0)
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Claude Code\s*66$/ })).toBeVisible()
})

test('连接结果在原卡片内替换，未知默认位置不诱导无效重试，详情与底部操作不溢出', async () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
    await page.getByRole('button', { name: '连接 App', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '连接来源 App' })
    const card = dialog.getByRole('region', { name: '连接说明' })
    await selectSource('newmax')
    const before = (await dialog.boundingBox())!
    await dialog.getByRole('button', { name: '连接', exact: true }).click()
    await expect(card.getByRole('alert')).toContainText('NewMax 暂不支持首次自动连接')
    await expect(dialog.locator('.connection-card')).toHaveCount(1)
    await expect(dialog.locator('.dialog-status')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: '重试连接' })).toHaveCount(0)
    await expect(card.locator('details')).not.toHaveAttribute('open')
    expect(Math.abs((await dialog.boundingBox())!.height - before.height)).toBeLessThan(24)
    await dialog.getByRole('button', { name: '选择其他 App' }).click()
    await expect(dialog.getByRole('combobox')).toBeFocused()
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await dialog.screenshot({ path: `test-results/pinekin-connect-card-result-${colorScheme}.png`, scale: 'css' })
    await card.getByText('查看详情与其他方式', { exact: true }).click()
    await expect(card.locator('.connection-card-reason')).toContainText('暂不能自动定位')
    await expect(card.getByRole('button', { name: '使用自定义位置…' })).toBeVisible()
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    const footer = (await dialog.locator('.dialog-footer').boundingBox())!
    expect(footer.y + footer.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight))
    expect(await app.evaluate(() => (globalThis as unknown as { sourceDialogCalls: number }).sourceDialogCalls)).toBe(0)
    await selectSource('claude-code')
    await expect(card.locator('details')).not.toHaveAttribute('open')
    await expect(card.getByRole('alert')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await background()
  }
})

test('preload 仅暴露具名来源 API，IPC 拒绝非法来源、路径读取和超限分页', async () => {
  const results = await page.evaluate(async () => {
    const api = window.staithe.sources
    const reject = async (action: () => Promise<unknown>) => { try { await action(); return false } catch { return true } }
    return { invalidSource: await reject(() => api.connect('other' as never)),
      invalidAutoSource: await reject(() => api.autoConnect('other' as never)),
      autoPath: await reject(() => api.autoConnect({ source: 'codex', path: '/private' } as never)),
      traversal: await reject(() => api.read('../private')), arbitrary: await reject(() => api.read('a'.repeat(64))),
      page: await reject(() => api.page({ limit: 500 })), extra: await reject(() => api.page({ path: '/private' } as never)),
      refresh: await reject(() => api.refresh('invalid')), disconnect: await reject(() => api.disconnect('invalid')) }
  })
  expect(Object.values(results).every(Boolean)).toBe(true)
  expect(await readdir(data)).not.toContain('connections.json')
  await expect(page.getByRole('button', { name: /^NewMax\s*未连接$/ })).toBeVisible()
})
