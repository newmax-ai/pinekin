import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

let app: ElectronApplication, page: Page, root: string

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pinekin-shadow-e2e-'))
  const data = join(root, 'data')
  await mkdir(data)
  const bootstrap = join(root, 'start.cjs')
  await writeFile(bootstrap, `const { app, dialog, clipboard } = require('electron');
    app.setPath('home', ${JSON.stringify(root)});
    app.setPath('appData', ${JSON.stringify(join(root, 'appData'))});
    globalThis.shadowWindowEvents = [];
    app.on('browser-window-created', (_event, window) => {
      window.on('show', () => globalThis.shadowWindowEvents.push('show'));
      window.on('focus', () => globalThis.shadowWindowEvents.push('focus'));
    });
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    clipboard.writeText = () => { throw new Error('阴影验收不得使用系统剪贴板'); };
    import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});`)
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined &&
    !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'EMBER_DATA_DIR', 'STAITHE_DATA_DIR', 'STAITHE_TEST_BACKGROUND', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].includes(entry[0])))
  app = await electron.launch({ args: [bootstrap], env: { ...env, STAITHE_DATA_DIR: data, STAITHE_TEST_BACKGROUND: '1' } })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByRole('button', { name: '连接 App', exact: true })).toBeEnabled()
})

test.afterEach(async () => {
  try {
    if (app?.process().exitCode === null) {
      const state = await app.evaluate(({ app, BrowserWindow }) => ({
        active: process.platform === 'darwin' && app.isActive(),
        windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })),
        events: (globalThis as unknown as { shadowWindowEvents: string[] }).shadowWindowEvents,
      }))
      expect(state.active).toBe(false)
      expect(state.events).toEqual([])
      expect(state.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
    }
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('macOS 外壳共用半透明底色，浅深主题的内容区保持实色', async () => {
  const platform = await page.locator('.shell').getAttribute('data-platform')
  if (platform === 'darwin') {
    // Electron 44 的 getter 只返回 RGB；alpha 由窗口配置单测与下面的 CSS 断言分别验证。
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor())).toBe('#000000')
  }
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    const surfaces = await page.evaluate(() => {
      const sample = document.createElement('canvas').getContext('2d')!
      const alpha = (selector: string) => {
        const style = getComputedStyle(document.querySelector(selector)!)
        sample.clearRect(0, 0, 1, 1)
        sample.fillStyle = style.backgroundColor
        sample.fillRect(0, 0, 1, 1)
        return { alpha: sample.getImageData(0, 0, 1, 1).data[3], opacity: style.opacity }
      }
      return {
        reduced: matchMedia('(prefers-reduced-transparency: reduce)').matches,
        root: alpha(':root'), shell: alpha('.shell'), sidebar: alpha('.sidebar'), toolbar: alpha('.window-toolbar'),
        // 双行导航模式没有 .topbar；三个实际内容面仍必须存在且不透明。
        content: ['.workspace-card', '.session-pane', '.detail', ...(document.querySelector('.topbar') ? ['.topbar'] : [])].map(alpha),
      }
    })
    expect(surfaces.root.alpha).toBe(platform === 'darwin' ? 0 : 255)
    expect(surfaces.shell.alpha).toBe(platform === 'darwin' && !surfaces.reduced ? 140 : 255)
    expect(surfaces.sidebar).toEqual({ alpha: 0, opacity: '1' })
    expect(surfaces.toolbar).toEqual({ alpha: 0, opacity: '1' })
    expect(surfaces.content.every(surface => surface.alpha === 255 && surface.opacity === '1')).toBe(true)
  }
})

test('工作区外阴影四边实际可见，不被侧栏背景覆盖且保留原有布局', async () => {
  const card = page.locator('main.workspace-card')
  for (const { width, height, colorScheme } of [
    { width: 1440, height: 900, colorScheme: 'light' },
    { width: 1000, height: 680, colorScheme: 'dark' },
  ] as const) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height })
    await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
    await page.emulateMedia({ colorScheme })
    for (const sidebarOpen of [true, false]) {
      const box = (await card.boundingBox())!
      const sidebar = (await page.locator('.sidebar').boundingBox())
      expect(box.x).toBe(sidebarOpen ? sidebar!.x + sidebar!.width : 8)
      expect(width - box.x - box.width).toBe(8)
      expect(height - box.y - box.height).toBe(8)
      await expect(card).toHaveCSS('overflow', 'hidden')
      const samples = {
        left: { x: box.x - 1, y: Math.floor(box.y + box.height / 2) },
        top: { x: Math.floor(box.x + box.width / 2), y: box.y - 1 },
        right: { x: box.x + box.width, y: Math.floor(box.y + box.height / 2) },
        bottom: { x: Math.floor(box.x + box.width / 2), y: box.y + box.height },
      }
      const withShadow = (await page.screenshot({ scale: 'css' })).toString('base64')
      await card.evaluate(element => { element.style.boxShadow = 'none' })
      const withoutShadow = (await page.screenshot({ scale: 'css' })).toString('base64')
      await card.evaluate(element => { element.style.removeProperty('box-shadow') })
      const changedEdges = await app.evaluate(({ nativeImage }, { withShadow, withoutShadow, samples }) => {
        const shadow = nativeImage.createFromBuffer(Buffer.from(withShadow, 'base64'))
        const plain = nativeImage.createFromBuffer(Buffer.from(withoutShadow, 'base64'))
        const imageWidth = shadow.getSize().width
        const shadowPixels = shadow.toBitmap(), plainPixels = plain.toBitmap()
        return Object.fromEntries(Object.entries(samples).map(([edge, { x, y }]) => {
          const index = (Math.round(y) * imageWidth + Math.round(x)) * 4
          return [edge, [0, 1, 2].some(channel => shadowPixels[index + channel] !== plainPixels[index + channel])]
        }))
      }, { withShadow, withoutShadow, samples })
      expect(changedEdges, `${colorScheme} / 侧栏${sidebarOpen ? '展开' : '收起'}`).toEqual({ left: true, top: true, right: true, bottom: true })
      if (sidebarOpen) {
        const handle = page.locator('.sidebar-resize-handle')
        const handleBox = (await handle.boundingBox())!
        expect(await handle.evaluate((element, point) => document.elementFromPoint(point.x, point.y) === element,
          { x: handleBox.x + handleBox.width - 1, y: handleBox.y + handleBox.height / 2 })).toBe(true)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true)
      await page.getByRole('button', { name: sidebarOpen ? '收起侧栏' : '展开侧栏', exact: true }).click()
    }
  }
})
