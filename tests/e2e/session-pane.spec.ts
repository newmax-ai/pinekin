import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

let app: ElectronApplication, page: Page, root: string
const storageKey = 'pinekin.session-pane-width'
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-session-pane-e2e-')))
  const data = join(root, 'data')
  await mkdir(data); await mkdir(join(root, 'appData'))
  const bootstrap = join(root, 'start.cjs')
  await writeFile(bootstrap, `const { app, dialog, clipboard } = require('electron');
    app.setPath('home', ${JSON.stringify(root)});
    app.setPath('appData', ${JSON.stringify(join(root, 'appData'))});
    globalThis.paneWindowEvents = [];
    app.on('browser-window-created', (_event, window) => {
      window.on('show', () => globalThis.paneWindowEvents.push('show'));
      window.on('focus', () => globalThis.paneWindowEvents.push('focus'));
    });
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    dialog.showSaveDialog = async () => ({ canceled: true });
    clipboard.writeText = () => { throw new Error('不得访问系统剪贴板'); };
    import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});`)
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined &&
    !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'EMBER_DATA_DIR', 'STAITHE_DATA_DIR', 'STAITHE_TEST_BACKGROUND', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME', 'NEWMAX_USER_DATA_DIR'].includes(entry[0])))
  app = await electron.launch({ args: [bootstrap], env: { ...env, STAITHE_DATA_DIR: data, STAITHE_TEST_BACKGROUND: '1' } })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1380, 900))
  await expect(page.getByRole('button', { name: '连接 App', exact: true })).toBeEnabled()
})
test.afterEach(async () => {
  try {
    if (app?.process().exitCode === null) {
      const state = await app.evaluate(({ app, BrowserWindow }) => ({ active: process.platform === 'darwin' && app.isActive(),
        windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused() })),
        events: (globalThis as unknown as { paneWindowEvents: string[] }).paneWindowEvents }))
      expect(state.active).toBe(false)
      expect(state.events).toEqual([])
      expect(state.windows.every(window => !window.visible && !window.focused)).toBe(true)
    }
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }) }
})

for (const mode of ['来源会话', '已有档案']) {
  test(`${mode}栏拖拽调宽、渐隐反馈、独立持久化与响应式限宽`, async () => {
    if (mode === '已有档案') {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('staithe:open-session', 'pane-fixture'))
      await expect(page.getByRole('button', { name: '返回来源会话' })).toBeVisible()
    }
    const handle = page.getByRole('separator', { name: '调整会话栏宽度' })
    const pane = page.locator('.session-pane')
    await expect(pane).toHaveCSS('width', '310px')
    await expect(page.locator('.sidebar-resize-handle')).toHaveCount(1)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await handle.hover()
      const highlight = await handle.evaluate(element => {
        const css = getComputedStyle(element, '::after')
        return { background: css.backgroundImage, opacity: css.opacity, top: parseFloat(css.top), bottom: parseFloat(css.bottom),
          radius: parseFloat(getComputedStyle(element.closest('.workspace-card')!).borderTopLeftRadius) }
      })
      expect(highlight.opacity).toBe('1')
      expect(highlight.background).toContain('linear-gradient')
      expect(highlight.background).toContain('rgba(0, 0, 0, 0)')
      expect(highlight.top).toBeGreaterThanOrEqual(highlight.radius)
      expect(highlight.bottom).toBeGreaterThanOrEqual(highlight.radius)
    }
    const bounds = (await handle.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width / 2 + 120, bounds.y + bounds.height / 2, { steps: 5 })
    await expect(pane).toHaveCSS('width', '430px')
    await expect(pane).toHaveAttribute('data-resizing', 'true')
    expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull()
    await page.mouse.up()
    await expect(pane).toHaveAttribute('data-resizing', 'false')
    expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe('430')
    expect(await page.evaluate(() => localStorage.getItem('pinekin.sidebar-width'))).toBeNull()
    await page.reload()
    await expect(pane).toHaveCSS('width', '430px')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 760))
    await expect(pane).toHaveCSS('width', '352px')
    expect((await page.locator('.detail').boundingBox())!.width).toBeGreaterThanOrEqual(400)
    expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe('430')
    await page.getByRole('button', { name: '收起侧栏' }).click()
    await expect(pane).toHaveCSS('width', '430px')
    await page.getByRole('button', { name: '展开侧栏' }).click()
    await expect(pane).toHaveCSS('width', '352px')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1380, 900))
    await expect(pane).toHaveCSS('width', '430px')
    await handle.focus()
    await page.keyboard.press('ArrowRight')
    await expect(pane).toHaveCSS('width', '440px')
    await handle.dblclick()
    await expect(pane).toHaveCSS('width', '310px')
    expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull()

    // 验证两个拖拽区域独立，侧栏变宽时会话栏按实际剩余空间收紧。
    const sidebarHandle = page.getByRole('separator', { name: '调整侧栏宽度' })
    const sidebarBounds = (await sidebarHandle.boundingBox())!
    await page.mouse.move(sidebarBounds.x + sidebarBounds.width / 2, sidebarBounds.y + sidebarBounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(sidebarBounds.x + sidebarBounds.width / 2 + 60, sidebarBounds.y + sidebarBounds.height / 2)
    await page.mouse.up()
    await expect(page.locator('.sidebar')).toHaveCSS('width', '300px')
    await handle.focus(); await page.keyboard.press('End')
    await expect(pane).toHaveCSS('width', '560px')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 760))
    await expect(pane).toHaveCSS('width', '292px')
    expect((await page.locator('.detail').boundingBox())!.width).toBeGreaterThanOrEqual(400)
    expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe('560')
    expect(await page.evaluate(() => localStorage.getItem('pinekin.sidebar-width'))).toBe('300')
    await sidebarHandle.focus(); await page.keyboard.press('End')
    await expect(pane).toHaveCSS('width', '280px')
    expect((await page.locator('.detail').boundingBox())!.width).toBeGreaterThanOrEqual(400)
  })
}
