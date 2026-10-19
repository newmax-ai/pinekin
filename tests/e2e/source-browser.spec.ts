import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, readlink, readdir, realpath, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { claudeFixture, claudeRecords } from '../fixtures/claude-code'
import { fixtureSessions } from '../fixtures/sessions'
import { codexFixture, codexMessage, codexMeta } from '../fixtures/codex'
import { DatabaseSync } from 'node:sqlite'
import { createCindyDatabase } from '../fixtures/cindy-database'
import { sourceNames, type BrowsableSource } from '../../src/core/sources'

let app: ElectronApplication, page: Page, root: string, data: string, source: string
async function launch(newmaxDataDirectory?: string) {
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
    ...(newmaxDataDirectory ? { NEWMAX_USER_DATA_DIR: newmaxDataDirectory } : {}) } })
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
    await expect(page.getByRole('alert')).toBeVisible()
    await page.getByRole('button', { name: '使用自定义位置…' }).click()
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
async function manageConnections() {
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '连接来源 App' })).toBeVisible()
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
test.afterEach(async () => {
  try { if (app?.process().exitCode === null) await background() }
  finally { await app?.close(); await rm(root, { recursive: true, force: true }) }
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
  await control.click()
  await expect(control).toBeDisabled(); await expect(control).not.toBeChecked()
  await expect(control).toHaveCSS('opacity', '0.4')
  await expect(dialog.getByRole('button', { name: '完成', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape'); await expect(dialog).toBeVisible()
  await app.evaluate(() => (globalThis as unknown as { finishSwitchTest: () => void }).finishSwitchTest())
  await expect(control).toBeEnabled(); await expect(control).not.toBeChecked()
  await expect(dialog.getByRole('alert')).toContainText('合成连接失败')
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
      expect(initialHeight).toBeLessThan(144)
      await expect(card.locator('.connection-inline-info')).toBeHidden()
      await selectSource('claude-code')
      await expect(card.getByRole('switch')).toBeChecked()
      await expect(card.locator('.connection-inline-info')).toBeVisible()
      expect((await card.boundingBox())!.height).toBeGreaterThan(initialHeight)
      const boxes = await dialog.locator('.connection-source-card').evaluateAll(cards => cards.map(card => {
        const { y, height } = card.getBoundingClientRect(); return { y, height }
      }))
      for (const box of boxes) expect(box.height).toBeCloseTo(boxes[0].height, 1)
      await selectSource('claude-code')
      await expect(card.locator('.connection-inline-info')).toBeHidden()
      expect((await card.boundingBox())!.height).toBe(initialHeight)
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
    const card = dialog.getByRole('region', { name: 'NewMax 来源', exact: true })
    const initialHeight = (await card.boundingBox())!.height
    await selectSource('newmax')
    await expect(card.getByRole('alert')).toContainText('合成错误')
    expect((await card.boundingBox())!.height).toBeGreaterThan(initialHeight)
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
    await selectSource('newmax')
    await expect(dialog.getByRole('switch', { name: '连接 NewMax', exact: true })).not.toBeChecked()
    await expect(dialog.getByRole('alert')).toContainText('未找到')
    await selectSource('claude-code')
    await expect(dialog.getByRole('switch', { name: '连接 Claude Code', exact: true })).toBeChecked()
    await selectSource('newmax')
    await expect(dialog.getByRole('switch', { name: '连接 NewMax', exact: true })).not.toBeChecked()
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
    await expect(dialog.getByRole('switch', { name: '连接 NewMax', exact: true })).toBeFocused()
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
    await expect(dialog.getByRole('list', { name: '来源 App' }).getByRole('switch')).toHaveCount(5)
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
    await expect(dialog.getByRole('switch', { name: '连接 NewMax', exact: true })).toBeFocused()
    const list = dialog.getByRole('list', { name: '来源 App' })
    await expect(list.getByRole('switch')).toHaveCount(5)
    const box = (await dialog.boundingBox())!, viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    expect(box.x).toBeGreaterThanOrEqual(8); expect(box.y).toBeGreaterThanOrEqual(8)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 8)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 8)
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await page.evaluate(async () => (await window.staithe.sources.connections()).length)).toBe(0)
    await page.keyboard.press('Tab')
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
    await expect(list.getByRole('switch')).toHaveCount(5)
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

test('NewMax 开发副本共享数据库链接可直接连接，固定真实路径并在重启后保持授权目标', async () => {
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

test('NewMax 与 Cindy 活跃 WAL 一次多选自动添加，零系统选择框，来源及副文件无写入', async () => {
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

test('批量添加一项数据库失败不影响另一项，错误逐项显示且不冒充连接成功', async () => {
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
  await writeFile(join(source, 'huge-title.jsonl'), Buffer.concat([claudeFixture(), Buffer.from(JSON.stringify({ type: 'progress', padding: 'x'.repeat(6 * 1024 * 1024) }) + '\n' +
    JSON.stringify({ type: 'ai-title', aiTitle: '超大日志仍显示标题' }) + '\n')]))
  await connect()
  await openMatchingSession('标题回归的首条合成提问')
  await expect(page.locator('.detail-title-row h2')).toHaveText('标题回归的首条合成提问')
  await openMatchingSession('尾部的最新会话名称')
  await expect(page.locator('.detail-title-row h2')).toHaveText('尾部的最新会话名称')
  await expect(page.getByRole('region', { name: '会话消息' })).toBeVisible()
  expect(await page.evaluate(() => window.staithe.sources.page({ query: '超大日志仍显示标题' }).then(result => result.total))).toBe(0)
  await expect(page.locator('.session-card').filter({ hasText: '超大日志仍显示标题' })).toHaveCount(0)
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
  await expect(page.getByRole('region', { name: '会话消息' }).getByRole('article')).toHaveCount(2)
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
  await expect(page.locator('.detail-meta')).toContainText('4 条消息')
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
  await expect(page.getByRole('alert')).toContainText('格式')
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

test('自定义 NewMax SQLite 只读访问，切换为已关闭 WAL 后刷新仍可读且不创建副文件', async () => {
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

test('未找到来源可改选其他 App，保留失败原因，不擅自打开系统选择器', async () => {
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  await selectSource('codex')
  await expect(page.getByRole('alert')).toContainText('未找到 Codex')
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
  await expect(grid.locator(':scope > li')).toHaveCount(5)
  await expect(grid.getByRole('switch')).toHaveCount(5)
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
  await expect(grid.getByRole('switch')).toHaveCount(5)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    for (const [width, columns] of [[1200, 3], [760, 2], [520, 1]]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setMinimumSize(0, 0); window.setSize(width, 720)
      }, width)
      await expect(grid).toHaveCSS('display', 'grid')
      await expect.poll(() => grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(columns)
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
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
    await page.getByRole('button', { name: '连接 App', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '连接来源 App' })
    await selectSource('newmax'); await selectSource('codex')
    await expect(dialog.getByRole('button', { name: '完成', exact: true })).toBeEnabled()
    await expect(dialog.getByRole('alert')).toHaveCount(2)
    for (const sourceId of ['newmax', 'codex'] as const) {
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
