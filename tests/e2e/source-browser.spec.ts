import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, readlink, readdir, realpath, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { claudeFixture, claudeRecords } from '../fixtures/claude-code'
import { fixtureSessions } from '../fixtures/sessions'
import { startElectronDiagnostics, finishElectronDiagnostics } from '../support/electron-diagnostics'
import { codexFixture, codexMessage, codexMeta } from '../fixtures/codex'
import { DatabaseSync } from 'node:sqlite'
import { createCindyDatabase } from '../fixtures/cindy-database'
import { sourceNames, type BrowsableSource } from '../../src/core/sources'

const macTest = process.platform === 'darwin' ? test : test.skip
const supportsDatabaseSources = process.platform === 'darwin' || process.platform === 'win32'
const databaseTest = supportsDatabaseSources ? test : test.skip
let app: ElectronApplication, page: Page, root: string, data: string, source: string
async function launch(newmaxDataDirectory?: string, claudeConfigDirectory?: string) {
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
    !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'EMBER_DATA_DIR', 'STAITHE_DATA_DIR', 'STAITHE_TEST_BACKGROUND', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME', 'NEWMAX_USER_DATA_DIR'].includes(entry[0])))
  app = await electron.launch({ args: [bootstrap], env: { ...env, STAITHE_DATA_DIR: data, STAITHE_TEST_BACKGROUND: '1',
    ...(newmaxDataDirectory ? { NEWMAX_USER_DATA_DIR: newmaxDataDirectory } : {}),
    ...(claudeConfigDirectory ? { CLAUDE_CONFIG_DIR: claudeConfigDirectory } : {}) } })
  await startElectronDiagnostics(app, Boolean(process.env.CI))
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
  const control = page.getByRole('switch', { name: `连接 ${sourceNames[sourceId]}`, exact: true })
  await control.click()
  await expect(control).toBeEnabled()
}
async function submit() { await page.getByRole('button', { name: '完成', exact: true }).click() }
async function connect(sourceId: BrowsableSource = 'claude-code', manual = false) {
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  await selectSource(sourceId)
  if (manual) {
    const card = page.getByRole('region', { name: `${sourceNames[sourceId]} 来源`, exact: true })
    await expect(card.getByRole('status')).toContainText('未找到')
    await expect(card.getByRole('alert')).toHaveCount(0)
    await card.getByRole('button', { name: '使用自定义位置…' }).click()
  }
  await expect(page.getByRole('switch', { name: `连接 ${sourceNames[sourceId]}`, exact: true })).toBeChecked()
  await submit()
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
async function settleConnectionDialog() {
  const dialog = page.getByRole('dialog', { name: '连接来源 App' })
  // 开关状态和网格列数先于 ResizeObserver → rAF 的高度提交；基线必须等自然高度收敛。
  await expect.poll(() => dialog.evaluate(element => {
    const height = (selector: string) => element.querySelector<HTMLElement>(selector)!.offsetHeight
    const viewport = element.querySelector<HTMLElement>('.dialog-content')!
    const style = getComputedStyle(viewport)
    const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
    const target = Math.min(Math.ceil(height('.dialog-header') + height('.connection-content-inner') + height('.dialog-footer') + padding), Math.max(0, innerHeight - 64))
    return Math.abs(element.getBoundingClientRect().height - target) < 0.5
      && Math.abs(parseFloat(element.style.height) - target) < 0.5
  })).toBe(true)
}
async function manageConnections() {
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '连接来源 App' })).toBeVisible()
  await settleConnectionDialog()
}
function seedNewMax(db: DatabaseSync) {
  db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, source TEXT, created_at INTEGER, updated_at INTEGER,
    forked_from_id TEXT, is_private INTEGER, message_count INTEGER);
    CREATE TABLE messages (seq INTEGER, id TEXT, conversation_id TEXT, role TEXT, content TEXT, timestamp INTEGER, data TEXT);
    INSERT INTO conversations VALUES ('one','数据库合成会话','app',1000,2000,NULL,0,1);`)
  const message = { id: 'm1', role: 'user', content: '仅合成数据库正文', timestamp: 2000 }
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(0, message.id, 'one', message.role, message.content, 2000, JSON.stringify(message))
}
async function snapshot(directory: string) {
  return Promise.all((await readdir(directory)).sort().map(async name => {
    const path = join(directory, name), info = await stat(path)
    return { name, bytes: await readFile(path), mtimeMs: info.mtimeMs }
  }))
}
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-sources-e2e-')))
  data = join(root, 'pinekin'); source = join(root, '.claude', 'projects')
  await mkdir(data); await mkdir(join(root, 'appData')); await mkdir(source, { recursive: true })
  for (let index = 0; index < 65; index++) await writeFile(join(source, `synthetic-${index}.jsonl`), claudeFixture())
  await writeFile(join(source, 'broken.jsonl'), 'not a session')
  await launch()
})
test.afterEach(async ({}, testInfo) => {
  try {
    if (app) await finishElectronDiagnostics(app, testInfo, Boolean(process.env.CI))
    if (app?.process().exitCode === null) await background()
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }) }
})

test('NewMax 继承的 Claude 环境目录不会混淆来源，旧误连明确报错并可修复', async () => {
  await app.close()
  const newmaxHome = join(root, '.newmax'), wrong = join(newmaxHome, 'projects')
  await mkdir(wrong, { recursive: true })
  await writeFile(join(wrong, 'sdk.jsonl'), '不得作为 Claude 会话读取的合成运行日志')
  const id = '11111111-2222-4333-8444-555555555555'
  await writeFile(join(data, 'connections.json'), JSON.stringify({ version: 1, connections: [{ id, source: 'claude-code', path: wrong }] }))
  await launch(undefined, newmaxHome)
  await manageConnections()
  await expect(page.getByRole('region', { name: 'Claude Code 来源', exact: true }).getByRole('alert')).toContainText('NewMax 数据目录')
  const result = await page.evaluate(() => window.staithe.sources.autoConnect('claude-code'))
  expect(result.warnings).toEqual([])
  expect(result.connections).toHaveLength(1)
  expect(result.connections[0]).toMatchObject({ id, status: 'ready', total: 66 })
  const saved = JSON.parse(await readFile(join(data, 'connections.json'), 'utf8'))
  expect(saved.connections).toEqual([{ id, source: 'claude-code', path: source }])
  expect(await readFile(join(wrong, 'sdk.jsonl'), 'utf8')).toBe('不得作为 Claude 会话读取的合成运行日志')
})

test('复制收进更多菜单，双主题窄窗直接操作，不显示目标表单或修改来源', async () => {
  await connect()
  await openMatchingSession('synthetic-0')
  const before = await snapshot(source)
  await app.evaluate(({ clipboard }) => {
    const state = globalThis as unknown as { handoffClipboard?: string; handoffCopyCalls: number }
    state.handoffCopyCalls = 0
    clipboard.writeText = async text => { state.handoffClipboard = text; state.handoffCopyCalls++ }
  })
  for (const { width, height, colorScheme } of [
    { width: 1440, height: 1000, colorScheme: 'light' },
    { width: 1000, height: 680, colorScheme: 'dark' },
  ] as const) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width, height })
    await page.emulateMedia({ colorScheme })
    const trigger = page.getByRole('button', { name: '更多会话操作' })
    await trigger.click()
    await expect(page.getByRole('menuitem', { name: '复制会话文本' })).toBeFocused()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('checkbox')).toHaveCount(0)
    await expect(page.getByRole('combobox')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '在另一个 App 继续' })).toHaveCount(0)
    expect(await page.locator('.detail-header').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.getByRole('menuitem', { name: '复制会话文本' }).click()
    await expect(page.locator('.source-actions-feedback')).toHaveText(/已复制会话文本/)
    expect(await app.evaluate(() => (globalThis as unknown as { handoffClipboard: string }).handoffClipboard)).toContain('合成问题')
    await page.getByRole('button', { name: '关闭操作提示' }).click()
    await trigger.click(); await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
  }
  expect(await app.evaluate(() => (globalThis as unknown as { handoffCopyCalls: number }).handoffCopyCalls)).toBe(2)
  expect(await snapshot(source)).toEqual(before)
  const files = await readdir(data)
  expect(files).not.toContain('library.json'); expect(files).not.toContain('imports')
})

test('页头在延迟读取、成功、切换和失败时保持位置，元信息自然宽度且小点两侧均为 8px', async () => {
  await connect()
  // 只挂起隔离测试的正文 IPC，不接触真实来源、剪贴板或文件选择器。
  await app.evaluate(({ ipcMain }, session) => {
    type Pending = { resolve: (title?: string) => void; reject: () => void }
    const state = globalThis as unknown as { headerReadPending?: Pending }
    ipcMain.removeHandler('pinekin:sources-read')
    ipcMain.handle('pinekin:sources-read', (_event, id: string) => new Promise((resolve, reject) => {
      state.headerReadPending = {
        resolve: (title = '合成问题：整理项目计划') => { state.headerReadPending = undefined; resolve({ session: { ...session, id, title }, warnings: [],
          window: { offset: 0, textOffset: 0, totalMessages: session.messages.length, hasMore: false, snapshot: 'c'.repeat(64) } }) },
        reject: () => { state.headerReadPending = undefined; reject(new Error('合成页头读取失败')) },
      }
    }))
  }, fixtureSessions[0])
  const header = page.locator('.detail-header')
  const pin = header.getByRole('button', { name: '更多会话操作' })
  const count = header.locator('.detail-message-count')
  async function layout() {
    return header.evaluate(element => [element, ...element.querySelectorAll('.detail-title-group, .detail-meta, .source-detail-meta > *, .detail-title-row > button')].map(node => {
      const { x, y, width, height } = node.getBoundingClientRect()
      // 数字和日期随内容自然占宽，只约束这一行的位置和高度不跳动。
      if (node.classList.contains('detail-meta')) return { x, y, height }
      return node.parentElement?.classList.contains('source-detail-meta') ? { y, height } : { x, y, width, height }
    }))
  }
  async function pending() {
    await expect.poll(() => app.evaluate(() => !!(globalThis as unknown as { headerReadPending?: unknown }).headerReadPending)).toBe(true)
  }
  async function spacing() {
    const meta = header.locator('.detail-meta')
    await expect(meta).toHaveCSS('column-gap', '8px')
    const gaps = await meta.evaluate(element => Array.from(element.children).slice(1).map(item => {
      const previous = item.previousElementSibling!.getBoundingClientRect()
      const box = item.getBoundingClientRect()
      const text = document.createRange()
      text.selectNodeContents(item)
      const bounds = text.getBoundingClientRect()
      const dotWidth = parseFloat(getComputedStyle(item, '::before').width)
      return { left: box.x - previous.right, right: bounds.x - box.x - dotWidth, trailing: box.right - bounds.right,
        flexible: item.classList.contains('source-detail-summary') }
    }))
    for (const gap of gaps) {
      expect(gap.left).toBeCloseTo(8, 1)
      expect(gap.right).toBeCloseTo(8, 1)
      if (!gap.flexible) expect(gap.trailing).toBeCloseTo(0, 1)
    }
    const summaryBounds = (await meta.locator('.source-detail-summary').boundingBox())!, dateBounds = (await meta.locator('time').boundingBox())!
    expect(dateBounds.x - summaryBounds.x - summaryBounds.width).toBeCloseTo(8, 1)
    await expect(meta.locator('.source-detail-summary-text')).toHaveCSS('text-overflow', 'ellipsis')
  }
  for (const { width, colorScheme } of [{ width: 1440, colorScheme: 'light' }, { width: 1000, colorScheme: 'dark' }] as const) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800), width)
    await page.emulateMedia({ colorScheme })
    await openMatchingSession('synthetic-0')
    await pending()
    await expect(pin).toBeDisabled()
    await expect(count).toHaveText('— 条来源消息 · 当前片段 — 条文本')
    await spacing()
    const node = await header.elementHandle()
    const loading = await layout()
    await expect(header.locator('.source-detail-context')).toHaveCSS('margin-top', '2px')
    await expect(header.locator('.detail-meta')).toHaveCSS('margin-top', '0px')
    expect(await header.locator('.source-detail-summary').evaluate(element => ({ width: getComputedStyle(element, '::before').width, height: getComputedStyle(element, '::before').height }))).toEqual({ width: '2px', height: '2px' })
    await app.evaluate(() => (globalThis as unknown as { headerReadPending: { resolve: () => void } }).headerReadPending.resolve())
    await expect(pin).toBeEnabled()
    await expect(count).toHaveText(`${fixtureSessions[0].messages.length} 条来源消息 · 当前片段 ${fixtureSessions[0].messages.length} 条文本`)
    await expect(header.locator('.source-detail-summary')).toHaveAttribute('title', `${fixtureSessions[0].messages.length} 条来源消息 · 当前片段 ${fixtureSessions[0].messages.length} 条文本`)
    await spacing()
    expect(await layout()).toEqual(loading)
    await openMatchingSession('synthetic-63')
    await pending()
    await expect(count).toHaveText('— 条来源消息 · 当前片段 — 条文本')
    expect(await layout()).toEqual(loading)
    const longTitle = '合成双行标题用于验证切换时描述与正文位置保持稳定。'.repeat(12)
    await app.evaluate((_electron, title) => (globalThis as unknown as { headerReadPending: { resolve(title?: string): void } }).headerReadPending.resolve(title), longTitle)
    await expect(pin).toBeEnabled()
    await expect(header.locator('h2')).toHaveText(longTitle)
    await expect(header.locator('h2')).toHaveCSS('height', '24px')
    await expect(header.locator('h2')).toHaveCSS('white-space', 'nowrap')
    expect(await layout()).toEqual(loading)
    await openMatchingSession('synthetic-64')
    await pending()
    await expect(pin).toBeDisabled()
    await expect(count).toHaveText('— 条来源消息 · 当前片段 — 条文本')
    expect(await node!.evaluate(element => element === document.querySelector('.detail-header'))).toBe(true)
    expect(await layout()).toEqual(loading)
    await app.evaluate(() => (globalThis as unknown as { headerReadPending: { reject: () => void } }).headerReadPending.reject())
    await expect(page.getByText(/合成页头读取失败/)).toBeVisible()
    await expect(pin).toBeDisabled()
    await spacing()
    expect(await layout()).toEqual(loading)
    await node!.dispose()
  }
  await background()
})

test('详情不展示直读标签和不可用主按钮，标题优先且更多操作靠右', async () => {
  await connect()
  await openMatchingSession('synthetic-0')
  await expect(page.getByRole('region', { name: '会话消息' })).toBeVisible()
  for (const { width, colorScheme } of [
    { width: 1440, colorScheme: 'light' },
    { width: 1000, colorScheme: 'dark' },
  ] as const) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800), width)
    await page.emulateMedia({ colorScheme })
    const header = page.locator('.detail-header')
    const group = header.locator('.detail-title-group')
    await expect(group.locator('.archive-badge, .reader-state')).toHaveCount(0)
    await expect(header.getByText('来源直读')).toHaveCount(0)
    await expect(header.getByRole('button', { name: '在原 App 打开' })).toHaveCount(0)
    await expect(header.getByRole('button', { name: '在另一个 App 继续' })).toHaveCount(0)
    const title = (await group.boundingBox())!
    const actions = (await header.locator('.source-actions').boundingBox())!
    expect(title.width).toBeGreaterThan(actions.width)
    expect(actions.y >= title.y + title.height || actions.x >= title.x + title.width).toBe(true)
    const pin = header.getByRole('button', { name: '更多会话操作' })
    await expect(pin).toBeVisible()
    const bounds = (await header.boundingBox())!, button = (await pin.boundingBox())!
    const primary = (await header.getByRole('button', { name: /^(复制|保存)接续文件$/ }).boundingBox())!
    // 更多菜单位于主操作左侧；整个操作组仍与页头右边距对齐。
    expect(bounds.x + bounds.width - actions.x - actions.width).toBeCloseTo(24, 0)
    expect(button.x + button.width).toBeLessThanOrEqual(primary.x)
    expect(button.y).toBeGreaterThanOrEqual(bounds.y)
    await expect(page.locator('.detail-footer')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '重新读取正文' })).toHaveCount(0)
    expect(await header.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  }
  await page.locator('.detail-header').getByRole('button', { name: '更多会话操作' }).click()
  await expect(page.getByRole('menu', { name: '更多会话操作' })).toBeVisible()
  await background()
})

test('连接弹窗默认点击遮罩关闭，内部点击和拖出不误关并恢复焦点', async () => {
  const trigger = page.getByRole('button', { name: '连接 App', exact: true })
  for (const connected of [false, true]) {
    if (connected) await connect()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await trigger.click()
      const dialog = page.getByRole('dialog', { name: '连接来源 App' })
      const heading = dialog.getByRole('heading', { name: '连接来源 App', exact: true })
      await heading.click()
      const box = (await dialog.boundingBox())!
      const outside = { x: box.x - 12, y: box.y + box.height / 2 }
      await page.mouse.click(box.x + 4, box.y + 4)
      await expect(dialog).toBeVisible()
      await heading.hover(); await page.mouse.down()
      await page.mouse.move(outside.x, outside.y); await page.mouse.up()
      await expect(dialog).toBeVisible()
      await page.mouse.click(outside.x, outside.y)
      await expect(dialog).toHaveCount(0)
      await expect(trigger).toBeFocused()
    }
  }
})

test('会话卡片两行标题仅末行截断处渐隐，调宽后取消且来源与档案一致', async () => {
  const title = '合成播放任务 file:///synthetic/' + 'WorkspacePath'.repeat(4)
  const shortTitle = '合成短标题'
  for (let index = 0; index < 65; index++) {
    await writeFile(join(source, `synthetic-${index}.jsonl`), claudeFixture([...claudeRecords(),
      { type: 'custom-title', customTitle: index === 64 ? shortTitle : title }]))
  }
  await connect()
  const verify = async () => {
    const long = page.locator('.session-card h3').filter({ hasText: title }).first()
    const short = page.getByRole('heading', { level: 3, name: shortTitle, exact: true })
    const handle = page.getByRole('separator', { name: '调整会话栏宽度' })
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await handle.focus(); await page.keyboard.press('Home')
      await expect(long).toHaveAttribute('data-lines', '2')
      await expect(long).toHaveAttribute('data-overflow', 'true')
      await expect(long).toHaveAttribute('title', title)
      await expect(long).toHaveText(title)
      await expect(long).toHaveCSS('text-overflow', 'clip')
      await expect(long).toHaveCSS('-webkit-line-clamp', 'none')
      const css = await long.evaluate(element => {
        const styles = getComputedStyle(element)
        return { mask: styles.maskImage, size: styles.maskSize, repeat: styles.maskRepeat,
          lineHeight: parseFloat(styles.lineHeight), height: element.getBoundingClientRect().height }
      })
      expect(css.mask.match(/linear-gradient/g)).toHaveLength(2)
      expect(css.mask).toContain('64px')
      expect(css.size).toContain('calc(100% - ')
      expect(css.repeat).toBe('no-repeat, no-repeat')
      expect(css.height).toBeCloseTo(css.lineHeight * 2, 1)
      await expect(short).toHaveAttribute('data-overflow', 'false')
      await expect(short).toHaveCSS('mask-image', 'none')
      const card = long.locator('..')
      await expect(card.locator('.card-meta')).toHaveCSS('mask-image', 'none')
      await expect(card).toHaveCSS('padding', '8px 12px')
      await handle.focus(); await page.keyboard.press('End')
      await expect(long).toHaveAttribute('data-overflow', 'false')
      await expect(long).toHaveCSS('mask-image', 'none')
      expect(await long.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(css.lineHeight * 2)
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1380, 900))
  await verify()
  await app.close()
  await writeFile(join(data, 'library.json'), JSON.stringify([
    { ...fixtureSessions[0], id: 'mask-long', title },
    { ...fixtureSessions[0], id: 'mask-short', title: shortTitle },
  ]))
  await launch()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1380, 900))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('staithe:open-session', 'mask-long'))
  await expect(page.getByRole('button', { name: '返回来源会话' })).toBeVisible()
  await verify()
  await background()
})

test('会话卡片显示友好时间、完整时刻且停留时自动更新，不改变紧凑布局', async () => {
  await connect()
  const originalTime = page.locator('.session-card time').first()
  await expect(originalTime).toBeVisible()
  const dateTime = (await originalTime.getAttribute('datetime'))!
  await page.clock.install({ time: new Date(Date.parse(dateTime) + 59 * 60_000) })
  await page.reload()
  const card = page.locator('.session-card').first()
  const time = card.locator('time')
  await expect(time).toHaveText('59分钟前')
  const full = await time.getAttribute('title')
  expect(full).toMatch(/^\d{4}年\d{2}月\d{2}日 \d{2}:\d{2}:\d{2}$/)
  await expect(time).toHaveAttribute('aria-label', full!)
  await expect(time).toHaveAttribute('datetime', dateTime)
  await expect(card).toHaveCSS('padding', '8px 12px')
  expect(await card.evaluate(element => element.children.length)).toBe(2)
  await page.clock.fastForward(60_000)
  await expect(time).toHaveText('1小时前')
  await expect(time).toHaveAttribute('title', full!)
  await background()
})

test('浅深主题下鼠标和键盘聚焦均无外轮廓，保留会话选中态与搜索交互', async () => {
  await connect()
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    const card = page.locator('.session-card').first()
    await card.click()
    await expect(card).toHaveClass(/selected/)
    const selectedBackground = await card.evaluate(element => getComputedStyle(element).backgroundColor)
    await page.keyboard.press('Tab')
    for (const control of [card, page.locator('.nav-item.active'), page.locator('.sidebar-resize-handle')]) {
      await control.focus()
      await expect(control).toBeFocused()
      expect(await control.evaluate(element => element.matches(':focus-visible'))).toBe(true)
      await expect(control).toHaveCSS('outline-style', 'none')
    }
    await expect(card).toHaveCSS('background-color', selectedBackground)
    await expect(card).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await searchFor('合成问题')
    const input = page.getByRole('textbox', { name: '搜索会话' })
    await expect(input).toBeFocused()
    await expect(input).toHaveCSS('outline-style', 'none')
    const result = page.locator('.search-result').first()
    await result.focus()
    await expect(result).toBeFocused()
    await expect(result).toHaveCSS('outline-style', 'none')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }
})

test('连接开关浅深主题、键盘、减少动画与忙碌保护一致，失败保持真实状态', async () => {
  await manageConnections()
  const dialog = page.getByRole('dialog', { name: '连接来源 App' })
  const control = dialog.getByRole('switch', { name: '连接 Claude Code', exact: true })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await expect(dialog.getByRole('checkbox')).toHaveCount(0)
    await expect(control).toHaveCSS('width', '28px')
    await expect(control).toHaveCSS('height', '16px')
    await expect(control).toHaveCSS('border-radius', '9999px')
    await expect(control).toHaveCSS('corner-shape', /^(?:round|superellipse\(1\))$/)
    await expect(control).not.toBeChecked()
    await control.focus(); await page.keyboard.press('Enter')
    await expect(control).toBeChecked(); await expect(control).toBeEnabled()
    await expect(control).toHaveCSS('background-color', colorScheme === 'light' ? 'rgb(23, 23, 23)' : 'rgb(255, 255, 255)')
    await expect(control.locator('.ds-switch-thumb')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 12, 0)')
    await control.focus()
    await page.keyboard.press('Space'); await expect(control).not.toBeChecked(); await expect(control).toBeEnabled()
    await expect(dialog).toBeVisible()
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(control).not.toHaveCSS('transition-duration', '0s')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(control).toHaveCSS('transition-duration', '0s')
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('pinekin:sources-auto-connect')
    ipcMain.handle('pinekin:sources-auto-connect', () => new Promise(resolve => {
      (globalThis as unknown as { finishSwitchTest: () => void }).finishSwitchTest = () => resolve({ connections: [], warnings: ['合成连接失败'] })
    }))
  })
  await settleConnectionDialog()
  const { frame: stableFrame, footer: stableFooter } = await dialog.evaluate(element => {
    const box = (node: Element) => {
      const { x, y, width, height } = node.getBoundingClientRect()
      return { x, y, width, height }
    }
    return { frame: box(element), footer: box(element.querySelector('.dialog-footer')!) }
  })
  await control.click()
  await expect(control).toBeDisabled(); await expect(control).not.toBeChecked()
  await expect(dialog.getByRole('region', { name: 'Claude Code 来源', exact: true }).getByRole('status')).toHaveText('正在连接…')
  await expect(dialog.locator('.connection-feedback')).toHaveCount(0)
  expect(await dialog.boundingBox()).toEqual(stableFrame)
  expect(await dialog.locator('.dialog-footer').boundingBox()).toEqual(stableFooter)
  await expect(control).toHaveCSS('opacity', '0.4')
  await expect(dialog.getByRole('button', { name: '完成', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape'); await expect(dialog).toBeVisible()
  await app.evaluate(() => (globalThis as unknown as { finishSwitchTest: () => void }).finishSwitchTest())
  await expect(control).toBeEnabled(); await expect(control).not.toBeChecked()
  await expect(dialog.getByRole('alert')).toContainText('合成连接失败')
  await expect.poll(async () => (await dialog.boundingBox())!.height).toBeGreaterThanOrEqual(stableFrame!.height)
  expect((await dialog.boundingBox())!.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight - 64))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(dialog).toHaveCSS('transition-property', 'height, max-width, max-height')
  await expect(dialog).toHaveCSS('transition-duration', '0.18s, 0.18s, 0.18s')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(dialog).toHaveCSS('transition-duration', '0s')
  await background()
})

test('卡片按最大内容统一高度，跨行等高，长错误由弹窗内容区滚动', async () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    for (const width of [1200, 760, 520]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setMinimumSize(0, 0); window.setSize(width, 760)
      }, width)
      await manageConnections()
      const dialog = page.getByRole('dialog', { name: '连接来源 App' })
      await expect(dialog.getByRole('tablist')).toHaveCount(0)
      const card = dialog.getByRole('region', { name: 'Claude Code 来源', exact: true })
      const initialHeight = (await card.boundingBox())!.height
      const frame = (await dialog.boundingBox())!
      expect(initialHeight).toBeLessThan(144)
      if (width === 1200) expect(frame.height).toBeLessThan(await page.evaluate(() => innerHeight - 64))
      await expect(dialog.locator('.connection-feedback')).toHaveCount(0)
      await expect(card.locator('.connection-inline-info')).toBeHidden()
      await selectSource('claude-code')
      await expect(card.getByRole('switch')).toBeChecked()
      await expect(card.locator('.connection-inline-info')).toBeVisible()
      expect((await card.boundingBox())!.height).toBeGreaterThan(initialHeight)
      await expect.poll(async () => (await dialog.boundingBox())!.height).toBeGreaterThanOrEqual(frame.height)
      expect((await dialog.boundingBox())!.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight - 64))
      expect((await dialog.boundingBox())!.width).toBe(frame.width)
      const boxes = await dialog.locator('.connection-source-card').evaluateAll(cards => cards.map(card => {
        const { y, height } = card.getBoundingClientRect(); return { y, height }
      }))
      for (const box of boxes) expect(box.height).toBeCloseTo(boxes[0].height, 1)
      await selectSource('claude-code')
      await expect(card.locator('.connection-inline-info')).toBeHidden()
      await expect.poll(async () => (await card.boundingBox())!.height).toBe(initialHeight)
      await expect(dialog).toHaveCSS('height', `${frame.height}px`)
      await page.keyboard.press('Escape')
    }
  }
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('pinekin:sources-auto-connect')
    ipcMain.handle('pinekin:sources-auto-connect', () => ({ connections: [], warnings: ['合成错误：' + '权限检查未完成；'.repeat(80)] }))
  })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 760))
    await manageConnections()
    const dialog = page.getByRole('dialog', { name: '连接来源 App' })
    const card = dialog.getByRole('region', { name: 'Codex 来源', exact: true })
    const initialHeight = (await card.boundingBox())!.height
    const frame = (await dialog.boundingBox())!
    await selectSource('codex')
    await expect(card.getByRole('alert')).toContainText('合成错误')
    expect((await card.boundingBox())!.height).toBeGreaterThan(initialHeight)
    await expect(dialog).toHaveCSS('height', `${await page.evaluate(() => innerHeight - 64)}px`)
    expect((await dialog.boundingBox())!.height).toBeGreaterThanOrEqual(frame.height)
    const heights = await dialog.locator('.connection-source-card').evaluateAll(cards => cards.map(element => element.getBoundingClientRect().height))
    for (const height of heights) expect(height).toBeCloseTo(heights[0], 1)
    const body = card.locator('.connection-inline-info')
    expect(await body.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true)
    const content = dialog.locator('.connection-content')
    expect(await content.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    const footer = (await dialog.locator('.dialog-footer').boundingBox())!
    await content.evaluate(element => { element.scrollTop = element.scrollHeight })
    expect((await dialog.locator('.dialog-footer').boundingBox())!.y).toBe(footer.y)
    expect(footer.y + footer.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight))
    await page.keyboard.press('Escape')
  }
  await background()
})

test('开关即时生效且失败可直接重试，不需要批量提交，完成按钮保持固定文案', async () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await manageConnections()
    const dialog = page.getByRole('dialog', { name: '连接来源 App' })
    const done = dialog.getByRole('button', { name: '完成', exact: true })
    const width = (await done.boundingBox())!.width
    await expect(dialog.getByRole('button', { name: /连接所选|重试所选|断开连接/ })).toHaveCount(0)
    await selectSource('codex')
    await expect(dialog.getByRole('switch', { name: '连接 Codex', exact: true })).not.toBeChecked()
    await expect(dialog.getByRole('region', { name: 'Codex 来源', exact: true }).getByRole('status')).toContainText('未找到')
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await selectSource('claude-code')
    await expect(dialog.getByRole('switch', { name: '连接 Claude Code', exact: true })).toBeChecked()
    await selectSource('codex')
    await expect(dialog.getByRole('switch', { name: '连接 Codex', exact: true })).not.toBeChecked()
    expect(await page.evaluate(async () => (await window.staithe.sources.connections()).map(item => item.source))).toEqual(['claude-code'])
    await expect(done).toHaveText('完成')
    expect((await done.boundingBox())!.width).toBe(width)
    await selectSource('claude-code')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  }
})

test('多选列表保留原关闭规格，初始不聚焦关闭按钮，键盘关闭与管理入口可用', async () => {
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
    await expect(dialog.getByRole('switch', { name: supportsDatabaseSources ? '连接 NewMax' : '连接 Claude Code', exact: true })).toBeFocused()
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { dialogFocusEvents: string[] }).dialogFocusEvents)).not.toContain('关闭连接面板')
    await expect(dialog.locator('.notice')).toHaveCount(0)
    await expect(dialog.locator('.dialog-header .dialog-icon')).toHaveCount(0)
    await expect(dialog.locator('.dialog-heading > h2')).toHaveText('连接来源 App')
    await expect(dialog.locator('.dialog-heading > h2 + .connection-description')).toHaveText('连接 App，集中浏览本机会话；断开不会删除原会话。')
    await expect(dialog.locator('.connection-description')).toHaveCSS('margin-top', '4px')
    await expect(dialog.locator('.ds-dialog-close')).toHaveCSS('height', '32px')
    await expect(dialog.locator('.ds-dialog-close')).toHaveCSS('width', '42px')
    await expect(dialog.locator('.ds-dialog-close svg')).toHaveCSS('width', '18px')
    await expect(dialog.getByRole('list', { name: '来源 App' }).getByRole('switch')).toHaveCount(7)
    await expect(dialog.locator('.connection-card')).toHaveCount(0)
    await expect(dialog.locator('.connection-card-privacy')).toHaveText('只读访问 · 不保存正文 · 不修改来源')
    await expect(dialog.locator('select')).toHaveCount(0)
    await expect(dialog.getByRole('combobox')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: '完成', exact: true })).toBeEnabled()
    await expect(dialog.getByRole('tablist')).toHaveCount(0)
    await page.keyboard.press('Shift+Tab')
    await expect(page.getByRole('button', { name: '关闭连接面板' })).toBeFocused()
    await expect(page.getByRole('tooltip')).toHaveText('关闭连接面板')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: '连接 App', exact: true })).toBeFocused()
    await expect(page.getByRole('dialog', { name: '管理连接' })).toHaveCount(0)
    await background()
  }
})

test('App 多选列表在浅深主题与窄窗口不溢出，Space 勾选、Enter 提交，成功只显示已连接来源', async () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
    await expect(page.locator('.sidebar-section .nav-item')).toHaveText(['连接 App', '所有会话'])
    await page.getByRole('button', { name: '连接 App', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '连接来源 App' })
    await expect(dialog.getByRole('switch', { name: supportsDatabaseSources ? '连接 NewMax' : '连接 Claude Code', exact: true })).toBeFocused()
    const list = dialog.getByRole('list', { name: '来源 App' })
    await expect(list.getByRole('switch')).toHaveCount(7)
    const box = (await dialog.boundingBox())!, viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    expect(box.x).toBeGreaterThanOrEqual(8); expect(box.y).toBeGreaterThanOrEqual(8)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 8)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 8)
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await page.evaluate(async () => (await window.staithe.sources.connections()).length)).toBe(0)
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('switch', { name: supportsDatabaseSources ? '连接 Claude Code' : '连接 Codex', exact: true })).toBeFocused()
    // 不支持的平台跳过禁用的 NewMax，从 Claude 开始；仍验证 Tab / Shift+Tab 顺序。
    if (!supportsDatabaseSources) await page.keyboard.press('Shift+Tab')
    const control = page.getByRole('switch', { name: '连接 Claude Code', exact: true })
    await expect(control).toBeFocused()
    await page.keyboard.press('Space')
    await expect(control).toBeChecked(); await expect(control).toBeEnabled()
    expect(await page.evaluate(async () => (await window.staithe.sources.connections()).length)).toBe(1)
    await page.getByRole('button', { name: '完成', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Claude Code\s*66$/ })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: '连接 App', exact: true }).click()
    await expect(list.getByRole('switch')).toHaveCount(7)
    await expect(control).toBeChecked()
    await expect(dialog).toBeVisible()
    await selectSource('claude-code')
    await expect(control).not.toBeChecked()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '所有会话', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await page.getByRole('button', { name: '前进', exact: true }).click()
    await expect(page.getByRole('button', { name: '所有会话', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await background()
  }
})

macTest('NewMax 开发副本共享数据库链接可直接连接，固定真实路径并在重启后保持授权目标', async () => {
  await background(); await app.close()
  const canonical = join(root, '.newmax'), replica = join(root, '.newmax-clean')
  await mkdir(canonical); await mkdir(replica)
  const target = join(canonical, 'newmax.db'), alias = join(replica, 'newmax.db')
  const writer = new DatabaseSync(target)
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;'); seedNewMax(writer)
    await symlink('../.newmax/newmax.db', alias)
    const before = await snapshot(canonical), originalLink = await readlink(alias)
    await launch(replica)
    await connect('newmax')
    await expect(page.getByRole('button', { name: /^NewMax\s*1$/ })).toBeVisible()
    await page.locator('.session-card').click()
    await expect(page.getByRole('region', { name: '会话消息' })).toContainText('仅合成数据库正文')
    expect(await app.evaluate(() => (globalThis as unknown as { sourceDialogCalls: number }).sourceDialogCalls)).toBe(0)
    const config = JSON.parse(await readFile(join(data, 'connections.json'), 'utf8'))
    expect(config.connections).toMatchObject([{ source: 'newmax', path: target }])
    expect(config.connections).toHaveLength(1)
    expect(await readlink(alias)).toBe(originalLink)
    expect(await snapshot(canonical)).toEqual(before)
    // 连接后改动副本链接，既有授权不应被静默重定向。
    const outside = join(root, 'outside'); await mkdir(outside)
    const other = new DatabaseSync(join(outside, 'newmax.db')); seedNewMax(other)
    other.exec("UPDATE conversations SET title='不应读取的新目标'"); other.close()
    await rm(alias); await symlink(join(outside, 'newmax.db'), alias)
    await background(); await app.close(); await launch(replica)
    await expect(page.getByRole('button', { name: /^NewMax\s*1$/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^数据库合成会话/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^不应读取的新目标/ })).toHaveCount(0)
    expect(await snapshot(canonical)).toEqual(before)
  } finally { writer.close() }
})

databaseTest('NewMax 与 Cindy 活跃 WAL 一次多选自动添加，零系统选择框，来源及副文件无写入', async () => {
  const newmaxRoot = join(root, '.newmax'), cindyRoot = join(root, 'appData', 'Cindy')
  await mkdir(newmaxRoot); await mkdir(cindyRoot)
  const newmax = new DatabaseSync(join(newmaxRoot, 'newmax.db')), cindy = new DatabaseSync(join(cindyRoot, 'cindy-synthetic.db'))
  try {
    newmax.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;'); seedNewMax(newmax)
    cindy.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;'); createCindyDatabase(cindy, 'cindy-one')
    cindy.exec("UPDATE sessions SET title='Cindy 活跃会话',updated_at=3000")
    const beforeNewMax = await snapshot(newmaxRoot), beforeCindy = await snapshot(cindyRoot)
    await page.getByRole('button', { name: '连接 App', exact: true }).click()
    await selectSource('newmax'); await selectSource('cindy')
    await expect(page.getByRole('switch', { name: '连接 NewMax', exact: true })).toBeChecked()
    await expect(page.getByRole('switch', { name: '连接 Cindy', exact: true })).toBeChecked()
    await page.getByRole('dialog').screenshot({ path: 'test-results/pinekin-connect-multi.png', scale: 'css' })
    expect(JSON.parse(await readFile(join(data, 'connections.json'), 'utf8')).connections).toHaveLength(2)
    await submit()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^NewMax\s*1$/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Cindy\s*1$/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^所有会话\s*2$/ })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: /^数据库合成会话/ }).click()
    await expect(page.getByRole('region', { name: '会话消息' })).toContainText('仅合成数据库正文')
    await page.getByRole('button', { name: /^Cindy 活跃会话/ }).click()
    await expect(page.getByRole('region', { name: '会话消息' })).toContainText('合成用户问题')
    expect(await app.evaluate(() => (globalThis as unknown as { sourceDialogCalls: number }).sourceDialogCalls)).toBe(0)
    expect(await snapshot(newmaxRoot)).toEqual(beforeNewMax)
    expect(await snapshot(cindyRoot)).toEqual(beforeCindy)
    expect(await readdir(data)).not.toContain('imports')
  } finally { newmax.close(); cindy.close() }
})

const linuxTest = process.platform === 'linux' ? test : test.skip
linuxTest('Linux 明确禁用数据库连接，通用日志连接仍可用且不打开选择框', async () => {
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '连接来源 App' })
  for (const name of ['NewMax', 'Cindy']) {
    const card = dialog.getByRole('region', { name: `${name} 来源`, exact: true })
    await expect(card.getByRole('switch')).toBeDisabled()
    await expect(card).toContainText('当前平台 暂不支持安全数据库直读')
    await expect(card.getByRole('button', { name: '使用自定义位置…' })).toHaveCount(0)
  }
  await selectSource('claude-code')
  await expect(dialog.getByRole('switch', { name: '连接 Claude Code', exact: true })).toBeChecked()
  expect(await page.evaluate(async () => (await window.staithe.sources.connections()).map(item => item.source))).toEqual(['claude-code'])
  expect(await app.evaluate(() => (globalThis as unknown as { sourceDialogCalls: number }).sourceDialogCalls)).toBe(0)
  await submit()
  await expect(dialog).toHaveCount(0)
  // 排序依赖文件时间；首项可能是专门用于错误测试的 broken.jsonl，明确选择健康合成日志。
  await openMatchingSession('synthetic-0')
  await expect(page.getByRole('region', { name: '会话消息' })).toBeVisible()
})

databaseTest('批量添加一项数据库失败不影响另一项，错误逐项显示且不冒充连接成功', async () => {
  const cindyRoot = join(root, 'appData', 'Cindy'); await mkdir(cindyRoot)
  await writeFile(join(cindyRoot, 'cindy-broken.db'), 'not sqlite')
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  await selectSource('claude-code'); await selectSource('cindy')
  const dialog = page.getByRole('dialog')
  const result = dialog.getByRole('region', { name: 'Cindy 来源', exact: true })
  await expect(result.getByRole('alert')).toContainText('数据库结构未支持')
  await expect(result.locator('.connection-state')).toHaveCount(0)
  await expect(result.locator('.connection-location-count')).toContainText('读取失败')
  await expect(dialog.getByRole('switch', { name: '连接 Cindy', exact: true })).toBeChecked()
  await expect(dialog.getByRole('switch', { name: '连接 Claude Code', exact: true })).toBeChecked()
  await submit()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Claude Code\s*66$/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: /^Cindy\s*读取失败$/ })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Cindy')
})

test('UI 文字不可选中，输入、正文与代码仍可选择', async () => {
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '连接来源 App' })
  await expect(dialog.getByRole('heading', { name: '连接来源 App', exact: true })).toHaveCSS('user-select', 'none')
  await expect(dialog.locator('.dialog-heading > .connection-description')).toHaveCSS('user-select', 'none')
  const list = page.getByRole('list', { name: '来源 App' })
  await expect(list).toHaveCSS('user-select', 'none')
  for (const heading of await list.getByRole('heading').all()) await expect(heading).toHaveCSS('user-select', 'none')
  const selectAll = process.platform === 'darwin' ? 'Meta+a' : 'Control+a'
  await page.keyboard.press(selectAll)
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('')
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

test('Claude 标题覆盖首问、尾部重命名和超大日志，搜索与阅读区名称一致', async () => {
  const records = claudeRecords()
  records[1].message = { role: 'user', content: '标题回归的首条合成提问' }
  await writeFile(join(source, 'prompt-title.jsonl'), claudeFixture(records))
  const renamed = Buffer.concat([claudeFixture(), Buffer.from(JSON.stringify({ type: 'file-history-snapshot', padding: 'x'.repeat(140_000) }) + '\n' +
    JSON.stringify({ type: 'custom-title', customTitle: '尾部的最新会话名称' }) + '\n')])
  await writeFile(join(source, 'renamed-title.jsonl'), renamed)
  await writeFile(join(source, 'huge-title.jsonl'), Buffer.concat([claudeFixture(), Buffer.from(JSON.stringify({ type: 'file-history-snapshot', padding: 'x'.repeat(6 * 1024 * 1024) }) + '\n' +
    JSON.stringify({ type: 'ai-title', aiTitle: '超大日志仍显示标题' }) + '\n')]))
  await connect()
  await openMatchingSession('标题回归的首条合成提问')
  await expect(page.locator('.detail-title-row h2')).toHaveText('标题回归的首条合成提问')
  await openMatchingSession('尾部的最新会话名称')
  await expect(page.locator('.detail-title-row h2')).toHaveText('尾部的最新会话名称')
  await expect(page.getByRole('region', { name: '会话消息' })).toBeVisible()
  expect(await page.evaluate(() => window.staithe.sources.page({ query: '超大日志仍显示标题' }).then(result => result.total))).toBe(1)
  await openMatchingSession('超大日志仍显示标题')
  await expect(page.getByRole('region', { name: '会话消息' })).toBeVisible()
  expect(await page.evaluate(() => window.staithe.sources.page({ query: '超大日志仍显示标题' }).then(result => result.total))).toBe(1)
  // 文件名仍可查找，不要求用户知道新提取出的标题。
  await openMatchingSession('renamed-title.jsonl')
  await expect(page.locator('.detail-title-row h2')).toHaveText('尾部的最新会话名称')
  expect((await readFile(join(source, 'renamed-title.jsonl'))).equals(renamed)).toBe(true)
  expect(await readFile(join(data, 'connections.json'), 'utf8')).not.toMatch(/最新会话名称|首条合成提问|messages/)
  await background()
})

test('长 Claude 首问仍显示标题，预览预算外标题按需读取后同步列表', async () => {
  const records = claudeRecords()
  records[1].message = { role: 'user', content: '合成长页面核对任务\nPage snapshot:\n' + 'snapshot '.repeat(12_000) }
  await writeFile(join(source, 'long-prompt.jsonl'), claudeFixture(records))
  const late = claudeRecords()
  late[1].message = { role: 'user', content: '预算之外的合成标题' }
  await writeFile(join(source, 'late-prompt.jsonl'), Buffer.from([
    ...Array.from({ length: 18 }, () => ({ type: 'file-history-snapshot', snapshot: 'x'.repeat(64_000) })), ...late,
  ].map(record => JSON.stringify(record)).join('\n') + '\n'))
  await connect()
  await openMatchingSession('合成长页面核对任务')
  await expect(page.locator('.detail-title-row h2')).toContainText('合成长页面核对任务')
  await expect(page.getByRole('region', { name: '会话消息' }).getByRole('article')).toHaveCount(1)
  await page.getByRole('button', { name: '下一段', exact: true }).click()
  await expect(page.getByRole('navigation', { name: '正文分段导航' })).toContainText('第 16385 个字符')
  await page.getByRole('button', { name: '上一段', exact: true }).click()
  await expect(page.getByRole('navigation', { name: '正文分段导航' })).not.toContainText('第 16385 个字符')
  await openMatchingSession('late-prompt.jsonl')
  await expect(page.locator('.detail-title-row h2')).toHaveText('预算之外的合成标题')
  await expect(page.locator('.session-card h3').filter({ hasText: /^预算之外的合成标题$/ })).toHaveCount(1)
  await openMatchingSession('预算之外的合成标题')
  expect(await readFile(join(data, 'connections.json'), 'utf8')).not.toMatch(/合成标题|snapshot|messages/)
  await background()
})

test('Codex 标题使用实际首问，来源阅读排除系统和环境注入且保留完整问答顺序', async () => {
  const directory = join(root, '.codex', 'sessions')
  await mkdir(directory, { recursive: true })
  const bytes = codexFixture([
    codexMeta({ base_instructions: { text: 'x'.repeat(80_000) } }),
    codexMessage('developer', [{ type: 'input_text', text: '<app-context>合成桌面上下文，不是对话</app-context>' }]),
    codexMessage('user', [{ type: 'input_text', text: '# AGENTS.md instructions for /synthetic\n<INSTRUCTIONS>合成规则</INSTRUCTIONS>' }]),
    codexMessage('user', [{ type: 'input_text', text: '<environment_context>合成环境</environment_context>\n核对 Codex 实际对话' }]),
    codexMessage('assistant', [{ type: 'output_text', text: '先确认合成问题' }]),
    codexMessage('user', [{ type: 'input_text', text: '这是第二个合成问题' }]),
    codexMessage('assistant', [{ type: 'output_text', text: '这是最终合成回答' }]),
  ])
  await writeFile(join(directory, 'rollout-conversation.jsonl'), bytes)
  await connect('codex')
  await expect(page.locator('.session-card h3')).toHaveText('核对 Codex 实际对话')
  await openMatchingSession('核对 Codex 实际对话')
  await expect(page.locator('.detail-title-row h2')).toHaveText('核对 Codex 实际对话')
  const messages = page.getByRole('region', { name: '会话消息' })
  await expect(messages.getByRole('article')).toHaveCount(4)
  await expect(messages.getByRole('article').first()).toContainText('核对 Codex 实际对话')
  await expect(messages).not.toContainText('app-context')
  await expect(messages).not.toContainText('environment_context')
  await expect(messages).not.toContainText('合成规则')
  await expect(messages.getByRole('article').last()).toContainText('这是最终合成回答')
  await expect(page.locator('.detail-meta')).toContainText('4 条来源消息')
  await openMatchingSession('rollout-conversation.jsonl')
  await expect(page.locator('.detail-title-row h2')).toHaveText('核对 Codex 实际对话')
  expect(await readFile(join(directory, 'rollout-conversation.jsonl'))).toEqual(bytes)
  await background()
})

test('搜索结果描述保持单行，长项目路径用末端 mask 渐隐，短描述不渐隐', async () => {
  const longProject = join(source, 'long-project-name-'.repeat(12), 'nested-project-name-'.repeat(10))
  await mkdir(longProject, { recursive: true })
  await writeFile(join(longProject, 'fade-description-test.jsonl'), claudeFixture())
  await connect()
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    for (const width of [1380, 600]) {
      await page.setViewportSize({ width, height: 800 })
      await searchFor('fade-description-test')
      const description = page.locator('.search-result small .ds-fade-text')
      await expect(description).toHaveCount(1)
      await expect(description).toHaveAttribute('data-overflow', 'true')
      await expect(description).toHaveCSS('white-space', 'nowrap')
      await expect(description).toHaveCSS('overflow', 'hidden')
      await expect(description).toHaveCSS('text-overflow', 'clip')
      await expect(description).toHaveCSS('mask-image', /linear-gradient/)
      await expect(description).toHaveAttribute('title', /Claude Code · .*long-project-name-/)
      const geometry = await description.evaluate(element => ({ height: element.clientHeight, font: Number.parseFloat(getComputedStyle(element).fontSize), overflowing: element.scrollWidth > element.clientWidth }))
      expect(geometry.overflowing).toBe(true)
      expect(geometry.height).toBeLessThan(geometry.font * 2)
      await page.getByRole('textbox', { name: '搜索会话' }).fill('synthetic-0')
      await expect(description).toHaveAttribute('data-overflow', 'false')
      await expect(description).toHaveCSS('mask-image', 'none')
      await page.keyboard.press('Escape')
    }
  }
  await background()
})

test('搜索弹窗固定尺寸，结果、分页、加载与错误状态不抖动，小窗口内仍可滚动', async () => {
  await connect()
  const dialog = page.getByRole('dialog', { name: '搜索会话' })
  const input = page.getByRole('textbox', { name: '搜索会话' })
  const results = page.locator('.search-results')
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    for (const viewport of [{ width: 1380, height: 800 }, { width: 1000, height: 680 }, { width: 600, height: 400 }]) {
      await page.setViewportSize(viewport)
      await searchFor('')
      await expect(page.locator('.search-result')).toHaveCount(50)
      const bounds = (await dialog.boundingBox())!
      const header = await page.locator('.search-header').boundingBox()
      expect(bounds.width).toBe(Math.min(660, viewport.width - 48))
      expect(bounds.height).toBe(Math.min(500, viewport.height - 64))
      expect(bounds.x).toBeGreaterThanOrEqual(24)
      expect(bounds.y).toBeGreaterThanOrEqual(32)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 24)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 32)
      await results.evaluate(element => { element.scrollTop = element.scrollHeight })
      await expect(page.locator('.search-result').last()).toBeInViewport()
      expect(await page.locator('.search-header').boundingBox()).toEqual(header)
      await page.getByRole('button', { name: '加载更多结果', exact: true }).click()
      await expect(page.locator('.search-result')).toHaveCount(66)
      expect(await dialog.boundingBox()).toEqual(bounds)
      await input.fill('synthetic-64')
      await expect(page.locator('.search-result')).toHaveCount(1)
      expect(await dialog.boundingBox()).toEqual(bounds)
      await input.fill('绝不匹配的合成尺寸关键词')
      await expect(dialog.getByRole('heading', { name: '没有匹配的会话' })).toBeVisible()
      expect(await dialog.boundingBox()).toEqual(bounds)
      await dialog.getByRole('button', { name: '清空关键词' }).click()
      await expect(page.locator('.search-result')).toHaveCount(50)
      expect(await dialog.boundingBox()).toEqual(bounds)
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await page.keyboard.press('Escape')
      await searchFor('synthetic-64')
      await expect(page.locator('.search-result')).toHaveCount(1)
      expect(await dialog.boundingBox()).toEqual(bounds)
      await page.keyboard.press('Escape')
    }
  }
  // 仅在隔离进程中挂起和拒绝查询，稳定覆盖加载与失败状态。
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('pinekin:sources-page')
    ipcMain.handle('pinekin:sources-page', () => new Promise((_resolve, reject) => {
      (globalThis as unknown as { rejectSearchSizeTest: () => void }).rejectSearchSizeTest = () => reject(new Error('合成搜索尺寸读取失败'))
    }))
  })
  await searchFor('等待尺寸')
  await expect(results).toHaveAttribute('aria-busy', 'true')
  const loadingBounds = await dialog.boundingBox()
  expect(loadingBounds!.height).toBe(336)
  await app.evaluate(() => (globalThis as unknown as { rejectSearchSizeTest: () => void }).rejectSearchSizeTest())
  await expect(dialog.getByRole('alert')).toContainText('合成搜索尺寸读取失败')
  expect(await dialog.boundingBox()).toEqual(loadingBounds)
  await background()
})

test('搜索仅改变弹层结果，保留背景分页、滚动和正文，选择后才跳转', async () => {
  await connect()
  await expect(page.locator('.session-card')).toHaveCount(50)
  // broken.jsonl 也必须保留在目录，不能依赖文件时间或随机 ID 的排序选择正文。
  await page.getByRole('button', { name: /^合成问题：整理项目计划 / }).first().click()
  await expect(page.getByRole('region', { name: '会话消息' })).toBeVisible()
  await page.locator('.session-list').evaluate(element => { element.scrollTop = 140 })
  async function backgroundContent() {
    return page.evaluate(() => ({
      cards: Array.from(document.querySelectorAll('.session-card')).map(element => ({ label: element.getAttribute('aria-label'), selected: element.getAttribute('aria-pressed') })),
      count: document.querySelector('.list-heading [role="status"]')?.textContent,
      detail: document.querySelector('.detail')?.textContent,
      scroll: document.querySelector('.session-list')?.scrollTop,
    }))
  }
  const original = await backgroundContent()
  expect(original.scroll).toBeGreaterThan(0)
  await searchFor('synthetic-64')
  await expect(page.locator('.search-result')).toHaveCount(1)
  expect(await backgroundContent()).toEqual(original)
  const input = page.getByRole('textbox', { name: '搜索会话' })
  await input.fill('绝不匹配的合成关键词')
  await expect(page.getByRole('heading', { name: '没有匹配的会话' })).toBeVisible()
  expect(await backgroundContent()).toEqual(original)
  await page.getByRole('button', { name: '清空关键词' }).click()
  await expect(page.locator('.search-result')).toHaveCount(50)
  await page.getByRole('button', { name: '加载更多结果', exact: true }).click()
  await expect(page.locator('.search-result')).toHaveCount(66)
  expect(await backgroundContent()).toEqual(original)
  await input.fill('synthetic-64')
  await expect(page.locator('.search-result')).toHaveCount(1)
  await page.getByRole('button', { name: '清空搜索' }).click()
  await expect(page.locator('.search-result')).toHaveCount(50)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await backgroundContent()).toEqual(original)
  await searchFor('synthetic-64')
  await expect(page.locator('.search-result')).toHaveCount(1)
  await page.locator('.search-result').click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '会话消息' })).toBeVisible()
  await expect(page.locator('.session-card')).toHaveCount(50)
  await expect(page.locator('.list-heading [role="status"]')).toHaveText('50 / 66 条已加载')
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

test('空档案库直接连接、完整计数、分页搜索、按需正文，重启自动加载已授权来源', async () => {
  await expect(page.getByRole('heading', { name: '尚未连接会话来源' })).toBeVisible()
  await expect(page.locator('.sidebar-section').getByRole('button', { name: /^Claude Code/ })).toHaveCount(0)
  await connect()
  await expect(page.getByRole('button', { name: /^Claude Code\s*66$/ })).toBeVisible()
  expect(await app.evaluate(() => (globalThis as unknown as { sourceDialogCalls: number }).sourceDialogCalls)).toBe(0)
  await expect(page.locator('.session-card')).toHaveCount(50)
  await expect(page.getByText('50 / 66 条已加载')).toBeVisible()
  await expect(page.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0)
  await page.locator('.session-list').evaluate(element => { element.scrollTop = element.scrollHeight - element.clientHeight - 120 })
  await expect(page.locator('.session-card')).toHaveCount(66)
  await openMatchingSession('synthetic-64')
  await expect(page.getByRole('region', { name: '会话消息' })).toBeVisible()
  await expect(page.getByText('未导入 Pinekin', { exact: true })).toHaveCount(0)
  const files = await readdir(data)
  expect(files).not.toContain('library.json'); expect(files).not.toContain('imports')
  const config = await readFile(join(data, 'connections.json'), 'utf8')
  expect(config).not.toContain('messages'); expect(config).not.toContain('合成问题')
  await page.getByRole('button', { name: '更多会话操作' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: '复制会话文本' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '导出聊天记录' })).toBeVisible()
  await expect(page.getByRole('button', { name: '在另一个 App 继续' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await background(); await app.close()
  // 即使其他默认位置存在会话，启动也不能为尚未授权的 App 自动连接。
  const unconnected = join(root, '.codex', 'sessions'); await mkdir(unconnected, { recursive: true })
  await writeFile(join(unconnected, 'unconnected.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'unconnected' } }))
  await launch()
  await expect(page.getByRole('button', { name: /^Claude Code\s*66$/ })).toBeVisible()
  await expect(page.locator('.session-card')).toHaveCount(50)
  await expect(page.getByText('50 / 66 条已加载')).toBeVisible()
  await expect(page.getByRole('button', { name: /待刷新/ })).toHaveCount(0)
  expect(await page.evaluate(async () => (await window.staithe.sources.connections()).map(item => item.source))).toEqual(['claude-code'])
  expect(await app.evaluate(() => (globalThis as unknown as { sourceDialogCalls: number }).sourceDialogCalls)).toBe(0)
})

test('重启自动刷新时单个来源失败不阻塞其他来源，手动刷新仍可修复', async () => {
  const codex = join(root, '.codex', 'sessions')
  await mkdir(codex, { recursive: true })
  await writeFile(join(codex, 'one.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'one' } }))
  await connect('claude-code'); await connect('codex')
  await background(); await app.close()
  await rm(codex, { recursive: true })
  await writeFile(join(source, 'added-before-restart.jsonl'), claudeFixture())
  await launch()
  await expect(page.getByRole('button', { name: /^Claude Code\s*67$/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Codex\s*读取失败$/ })).toBeVisible()
  await mkdir(codex); await writeFile(join(codex, 'repaired.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'repaired' } }))
  await manageConnections()
  const card = page.getByRole('dialog').getByRole('region', { name: 'Codex 来源', exact: true })
  await expect(card.getByRole('alert')).toContainText('来源已移动或删除')
  await page.getByRole('button', { name: '关闭连接面板' }).click()
  await page.getByRole('button', { name: '刷新当前来源', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Codex\s*1$/ })).toBeVisible()
  await manageConnections()
  await expect(card.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: '关闭连接面板' }).click()
})

test('启动遇到损坏授权配置仍显示窗口与真实错误，不覆盖配置或发现新来源', async () => {
  await background(); await app.close()
  const path = join(data, 'connections.json'); await writeFile(path, 'broken')
  await launch()
  await expect(page.getByRole('heading', { name: '暂时无法读取会话列表' })).toBeVisible()
  await expect(page.locator('.detail').getByRole('alert')).toContainText('连接配置损坏')
  expect(await readFile(path, 'utf8')).toBe('broken')
  expect(await app.evaluate(() => (globalThis as unknown as { sourceDialogCalls: number }).sourceDialogCalls)).toBe(0)
  await expect(page.locator('.sidebar-section').getByRole('button', { name: /^Claude Code/ })).toHaveCount(0)
})

test('损坏日志保留且失败有原因，刷新发现增删，断开撤销授权但不删除来源', async () => {
  await connect()
  await expect(page.getByRole('button', { name: /^Claude Code\s*66$/ })).toBeVisible()
  await openMatchingSession('broken')
  await expect(page.getByRole('heading', { name: '暂时无法读取这段会话' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('日志第 1 行 JSON 无效或截断')
  await writeFile(join(source, 'new-one.jsonl'), claudeFixture())
  await searchFor('')
  await page.getByRole('button', { name: '关闭搜索' }).click()
  await page.getByRole('button', { name: '刷新当前来源', exact: true }).click()
  await expect(page.getByRole('button', { name: '刷新当前来源', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: /^Claude Code\s*67$/ })).toBeVisible()
  await manageConnections()
  await selectSource('claude-code')
  await expect(page.getByRole('switch', { name: '连接 Claude Code', exact: true })).not.toBeChecked()
  await page.getByRole('button', { name: '关闭连接面板' }).click()
  await expect(page.locator('.sidebar-section').getByRole('button', { name: /^Claude Code/ })).toHaveCount(0)
  expect(await readdir(source)).toHaveLength(67)
  expect(JSON.parse(await readFile(join(data, 'connections.json'), 'utf8')).connections).toEqual([])
})

databaseTest('自定义 NewMax SQLite 只读访问，切换为已关闭 WAL 后刷新仍可读且不创建副文件', async () => {
  await app.close()
  source = join(root, 'custom-newmax.db')
  const db = new DatabaseSync(source); seedNewMax(db); db.close()
  await launch()
  const before = await readFile(source), files = await readdir(root)
  await connect('newmax', true)
  await expect(page.getByRole('button', { name: /^NewMax\s*1$/ })).toBeVisible()
  await page.locator('.session-card').click()
  await expect(page.getByRole('region', { name: '会话消息' })).toContainText('仅合成数据库正文')
  expect(await readFile(source)).toEqual(before)
  expect(await readdir(root)).toEqual(files)
  const update = new DatabaseSync(source); update.exec('PRAGMA journal_mode=WAL'); update.close()
  const walFiles = await readdir(root)
  await page.getByRole('button', { name: '刷新当前来源', exact: true }).click()
  await expect(page.getByRole('button', { name: '刷新当前来源', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: /^NewMax\s*1$/ })).toBeVisible()
  await manageConnections()
  await expect(page.getByRole('alert')).toHaveCount(0)
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
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  await expect(page.getByRole('switch', { name: '连接 Codex', exact: true })).toBeChecked()
  await page.getByRole('button', { name: '关闭连接面板' }).click()
  await page.evaluate(() => window.staithe.sources.autoConnect('codex'))
  await expect(page.getByRole('button', { name: /^Codex\s*2$/ })).toBeVisible()
  expect(await app.evaluate(() => (globalThis as unknown as { sourceDialogCalls: number }).sourceDialogCalls)).toBe(0)
  expect(JSON.parse(await readFile(join(data, 'connections.json'), 'utf8')).connections).toHaveLength(2)
})

test('已有 Qwen 多行提示时重复连接不收缩再展开弹窗、网格或卡片', async () => {
  const notice = '未找到 Qwen Code 的本机会话，可能尚未安装或尚未创建会话，也可使用自定义位置。'
  await app.evaluate(({ ipcMain }, notice) => {
    let calls = 0
    ipcMain.removeHandler('pinekin:sources-auto-connect')
    ipcMain.handle('pinekin:sources-auto-connect', () => {
      const result = { connections: [], warnings: [], notices: [notice] }
      if (++calls === 1) return result
      return new Promise(resolve => {
        (globalThis as unknown as { finishRetryLayout: () => void }).finishRetryLayout = () => resolve(result)
      })
    })
  }, notice)
  await manageConnections(); await selectSource('qwen-code')
  const dialog = page.getByRole('dialog', { name: '连接来源 App' })
  const card = dialog.getByRole('region', { name: 'Qwen Code 来源', exact: true })
  await expect(card.getByRole('status')).toHaveText(notice)
  await expect.poll(() => dialog.evaluate(element => {
    const header = element.querySelector<HTMLElement>('.connection-header')!, footer = element.querySelector<HTMLElement>('.dialog-footer')!
    const inner = element.querySelector<HTMLElement>('.connection-content-inner')!, viewport = element.querySelector<HTMLElement>('.connection-content')!
    const style = getComputedStyle(viewport)
    const natural = header.offsetHeight + footer.offsetHeight + inner.offsetHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    return Math.abs(element.getBoundingClientRect().height - Math.min(Math.ceil(natural), innerHeight - 64))
  })).toBeLessThan(1)
  const layout = () => dialog.evaluate(element => [element, ...element.querySelectorAll('.connection-app-list, .connection-source-card, .connection-summary, .dialog-footer')].map(node => {
    const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }
  }))
  const before = await layout(), control = card.getByRole('switch')
  for (let attempt = 0; attempt < 3; attempt++) {
    await control.click(); await expect(control).toBeDisabled()
    await expect(card.getByRole('status')).toHaveText('正在连接…')
    await expect(card.locator('.connection-summary')).toHaveAttribute('data-notice', 'true')
    await expect(card.locator('.connection-summary > p')).toHaveText(notice)
    await expect(card.locator('.connection-summary > p')).toHaveAttribute('aria-hidden', 'true')
    expect(await layout()).toEqual(before)
    await app.evaluate(() => (globalThis as unknown as { finishRetryLayout: () => void }).finishRetryLayout())
    await expect(control).toBeEnabled(); await expect(card.getByRole('status')).toHaveText(notice)
    expect(await layout()).toEqual(before)
  }
  expect(await app.evaluate(() => (globalThis as unknown as { sourceDialogCalls: number }).sourceDialogCalls)).toBe(0)
})

test('未找到来源仅显示中性提示，可改选其他 App，不擅自打开系统选择器', async () => {
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  await selectSource('codex')
  await expect(page.getByRole('region', { name: 'Codex 来源', exact: true }).getByRole('status')).toContainText('未找到 Codex')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('switch', { name: '连接 Codex', exact: true })).not.toBeChecked()
  await expect(page.getByRole('button', { name: '使用自定义位置…' })).toBeVisible()
  expect(await app.evaluate(() => (globalThis as unknown as { sourceDialogCalls: number }).sourceDialogCalls)).toBe(0)
  expect(await readdir(data)).not.toContain('connections.json')
  await selectSource('claude-code'); await submit()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Claude Code\s*66$/ })).toBeVisible()
})

test('来源卡片直接整合位置统计与 small 开关，适配三列两列单列', async () => {
  for (const name of ['sessions', 'archived_sessions']) {
    const directory = join(root, '.codex', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${name}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: name } }))
  }
  await connect(); await connect('codex'); await manageConnections()
  const dialog = page.getByRole('dialog', { name: '连接来源 App' })
  const grid = dialog.getByRole('list', { name: '来源 App' })
  await expect(dialog.getByRole('list')).toHaveCount(1)
  await expect(grid.locator(':scope > li')).toHaveCount(7)
  await expect(grid.getByRole('switch')).toHaveCount(7)
  await expect(grid.getByRole('button', { name: /刷新连接|断开连接|暂停统计/ })).toHaveCount(0)
  const codex = grid.getByRole('region', { name: 'Codex 来源', exact: true })
  await expect(codex.getByRole('region')).toHaveCount(2)
  await expect(codex.getByText('2 条会话', { exact: true })).toBeVisible()
  await expect(codex.getByText('普通会话', { exact: true })).toBeVisible()
  await expect(codex.getByText('归档会话', { exact: true })).toBeVisible()
  await expect(codex.locator('details, summary')).toHaveCount(0)
  await expect(codex.getByRole('switch')).toHaveCSS('width', '28px')
  await expect(codex.getByRole('switch')).toHaveCSS('height', '16px')
  const originalCards = await grid.locator(':scope > li').elementHandles()
  await expect(grid.getByRole('switch')).toHaveCount(7)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    for (const [width, columns] of [[1200, 3], [760, 2], [520, 1]]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setMinimumSize(0, 0); window.setSize(width, 720)
      }, width)
      await expect(grid).toHaveCSS('display', 'grid')
      await expect.poll(() => grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(columns)
      await settleConnectionDialog()
      const boxes = await grid.locator(':scope > li:not([hidden])').evaluateAll(items => items.map(item => {
        const box = item.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height }
      }))
      expect(boxes[0].width).toBeGreaterThan(200)
      for (const box of boxes) expect(box.height).toBeCloseTo(boxes[0].height, 1)
      const metrics = await codex.evaluate(element => {
        const style = getComputedStyle(element), info = element.querySelector('.connection-inline-info')!
        return { bottomGap: element.getBoundingClientRect().bottom - info.getBoundingClientRect().bottom,
          padding: parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth) }
      })
      expect(Math.abs(metrics.bottomGap - metrics.padding)).toBeLessThanOrEqual(1)
      if (columns > 1) { expect(boxes[1].y).toBe(boxes[0].y); expect(boxes[1].x).toBeGreaterThan(boxes[0].x) }
      else expect(boxes[1].y).toBeGreaterThan(boxes[0].y)
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      const footer = (await dialog.locator('.dialog-footer').boundingBox())!
      await dialog.locator('.connection-content').evaluate(element => { element.scrollTop = element.scrollHeight })
      expect((await dialog.locator('.dialog-footer').boundingBox())!.y).toBe(footer.y)
      expect(footer.y + footer.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight))
      await dialog.locator('.connection-content').evaluate(element => { element.scrollTop = 0 })
      if (columns === 3) await dialog.screenshot({ path: `outputs/connection-cards/switch-${colorScheme}.png`, scale: 'css' })
    }
  }
  await selectSource('codex')
  await expect(codex.getByRole('switch')).not.toBeChecked()
  expect(await page.evaluate(async () => (await window.staithe.sources.connections()).map(item => item.source))).toEqual(['claude-code'])
  for (const name of ['sessions', 'archived_sessions']) expect(await readdir(join(root, '.codex', name))).toHaveLength(1)
  for (const [index, card] of originalCards.entries()) {
    expect(await card.evaluate((element, index) => element.parentElement?.children[index] === element, index)).toBe(true)
  }
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await background()
})

test('多项失败直接显示原因，浅深主题下卡片内信息与底部操作不溢出', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('pinekin:sources-auto-connect')
    ipcMain.handle('pinekin:sources-auto-connect', () => ({ connections: [], warnings: ['合成权限错误'] }))
  })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
    await page.getByRole('button', { name: '连接 App', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '连接来源 App' })
    await selectSource('deepseek'); await selectSource('codex')
    await expect(dialog.getByRole('button', { name: '完成', exact: true })).toBeEnabled()
    await expect(dialog.getByRole('alert')).toHaveCount(2)
    for (const sourceId of ['deepseek', 'codex'] as const) {
      const card = dialog.getByRole('region', { name: `${sourceNames[sourceId]} 来源`, exact: true })
      await expect(card.locator('details, summary')).toHaveCount(0)
      const manual = card.getByRole('button', { name: '使用自定义位置…' })
      await manual.scrollIntoViewIfNeeded()
      await expect(manual).toBeVisible()
    }
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    const footer = (await dialog.locator('.dialog-footer').boundingBox())!
    expect(footer.y + footer.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight))
    expect(await app.evaluate(() => (globalThis as unknown as { sourceDialogCalls: number }).sourceDialogCalls)).toBe(0)
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
  await expect(page.locator('.sidebar-section').getByRole('button', { name: /^NewMax/ })).toHaveCount(0)
})
