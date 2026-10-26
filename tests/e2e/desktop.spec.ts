import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { cindyFixture } from '../fixtures/cindy'
import { codexFixture, codexThreadId, codexPaginatedFixture } from '../fixtures/codex'
import { zstdCompressSync } from 'node:zlib'
import { deepseekFixture } from '../fixtures/deepseek'
import { cindyLocalFixture } from '../fixtures/cindy-local'
import { newmaxFixture } from '../fixtures/newmax'
import { claudeFixture } from '../fixtures/claude-code'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeBundle } from '../../src/core/session'
import { fixtureSessions as demoSessions } from '../fixtures/sessions'

const test = base.extend<{ seedLibrary: boolean }>({
  seedLibrary: [true, { option: true }],
})

let app: ElectronApplication
let page: Page
let directory: string
async function openArchives() {
  await expect(page.getByRole('button', { name: '连接 App', exact: true })).toBeEnabled()
  // 通过现有深链事件访问隔离档案，不依赖已移除的连接弹窗入口。
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0]!.webContents.send('staithe:open-session', id), demoSessions[0].id)
  await expect(page.getByRole('button', { name: '导入会话文件' })).toBeEnabled()
}
async function selectArchive(title: string) {
  // 重启辅助函数通过种子深链进入档案页；持久化校验须重新选择实际导入的档案。
  await page.locator('.session-card').filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) }).click()
  await expect(page.getByRole('region', { name: '会话详情', exact: true }).getByRole('heading', { level: 2, name: title, exact: true })).toBeVisible()
}
function isolatedEnv(): Record<string, string> {
  return { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STAITHE_DATA_DIR', 'EMBER_DATA_DIR', 'STAITHE_TEST_BACKGROUND'].includes(entry[0]))),
    STAITHE_TEST_BACKGROUND: '1' }
}
async function assertShellSurface(channel: number) {
  const surface = await page.locator('.shell').evaluate(element => {
    const context = document.createElement('canvas').getContext('2d')!
    context.fillStyle = getComputedStyle(element).backgroundColor
    context.fillRect(0, 0, 1, 1)
    return { rgba: Array.from(context.getImageData(0, 0, 1, 1).data), translucent: element.getAttribute('data-platform') === 'darwin'
      && !matchMedia('(prefers-reduced-transparency: reduce)').matches }
  })
  // Canvas 反预乘可能有 1 个色阶的舍入；透明度契约仍严格验证。
  for (const actual of surface.rgba.slice(0, 3)) expect(Math.abs(actual - channel)).toBeLessThanOrEqual(1)
  expect(surface.rgba[3]).toBe(surface.translucent ? 140 : 255)
}
async function assertBackground() {
  const state = await app.evaluate(({ app, BrowserWindow }) => ({
    active: process.platform === 'darwin' ? app.isActive() : false,
    windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })),
    events: (globalThis as unknown as { staitheTestWindowEvents: string[] }).staitheTestWindowEvents,
  }))
  expect(state.active).toBe(false)
  expect(state.windows.length).toBeGreaterThan(0)
  expect(state.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(state.events).toEqual([])
}
async function launch(legacyEnv = false, link?: string, legacyAppData = false) {
  const env = isolatedEnv()
  // 在加载应用前监听原生 show / focus，捕获短暂弹出，而不只检查测试结束时是否隐藏。
  const bootstrap = join(directory, 'background-start.cjs')
  await writeFile(bootstrap, `const { app } = require('electron');
    globalThis.staitheTestWindowEvents = [];
    app.on('browser-window-created', (_event, window) => {
      window.on('show', () => globalThis.staitheTestWindowEvents.push('show'));
      window.on('focus', () => globalThis.staitheTestWindowEvents.push('focus'));
    });
    ${legacyAppData ? `app.setPath('appData', ${JSON.stringify(directory)});` : ''}
    import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});`)
  app = await electron.launch({ args: [bootstrap, ...(link ? [link] : [])],
    env: legacyAppData ? env : { ...env, [legacyEnv ? 'EMBER_DATA_DIR' : 'STAITHE_DATA_DIR']: directory } })
  if (process.env.CI) await app.context().tracing.start({ screenshots: true, snapshots: true })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
  await expect(page.locator('.sidebar .brand-logo')).toHaveText('pinekin.')
  await expect(page).toHaveTitle('Pinekin · 换个地方，继续思考')
  expect(await app.evaluate(({ app }) => app.getName())).toBe('Pinekin')
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(legacyAppData ? join(directory, '@newmax-ai/ember') : directory)
  await assertBackground()
  // 本文件保留档案兼容流程回归；默认来源主流程由 source-browser.spec.ts 覆盖。
  const connectEntry = page.getByRole('button', { name: '连接 App', exact: true })
  if (await connectEntry.count()) await openArchives()
  await expect(page.getByRole('button', { name: '导入会话文件' })).toBeEnabled()
}
test.beforeEach(async ({ seedLibrary }) => {
  directory = await mkdtemp(join(tmpdir(), 'staithe-e2e-'))
  // 仅在首次启动前种入隔离测试档案；重启必须读取测试实际保存的内容。
  if (seedLibrary) await writeFile(join(directory, 'library.json'), JSON.stringify(demoSessions))
  await launch()
})
test.afterEach(async ({}, testInfo) => {
  try {
    if (app && app.process().exitCode === null) {
      if (process.env.CI) {
        const failed = testInfo.status !== testInfo.expectedStatus
        // Electron 使用手工创建的 context，不能依赖 Playwright 的 use.trace 自动采集。
        const tracePath = failed ? testInfo.outputPath('trace.zip') : undefined
        await app.context().tracing.stop({ path: tracePath })
        if (tracePath) await testInfo.attach('electron-trace', { path: tracePath, contentType: 'application/zip' })
      }
      await assertBackground()
    }
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }) }
})

test('所有滚动区域复用 NewMax mask，边界、双轴和动态内容在深浅主题下更新', async () => {
  await app.close()
  const archive = { adapterId: 'fixture', adapterVersion: '1', sha256: 'a'.repeat(64), importedAt: '2026-10-17T00:00:00Z', originalSessionId: null, fidelity: 'text-only',
    warnings: Array.from({ length: 24 }, (_, index) => `合成导入说明 ${index + 1}`) }
  const sessions = Array.from({ length: 40 }, (_, index) => ({ ...demoSessions[0], id: `scroll-${index}`, title: `滚动测试档案 ${index + 1}`, archive,
    messages: [{ role: 'assistant', content: '```ts\n' + 'const synthetic = "只读代码"; '.repeat(40) + '\n```\n' + '合成消息正文。\n'.repeat(50) }] }))
  await writeFile(join(directory, 'library.json'), JSON.stringify(sessions))
  await launch()
  const checkVertical = async (selector: string) => {
    const area = page.locator(selector).first()
    await expect(area).toHaveClass(/ds-scroll-area/)
    expect(await area.evaluate(element => element.scrollHeight > element.clientHeight + 1)).toBe(true)
    await area.evaluate(element => { element.scrollTop = 0 })
    // Chromium 会省略默认的 to bottom 方向；验证实际梯度，不依赖序列化保留默认值。
    await expect(area).toHaveCSS('mask-image', /linear-gradient\((?:to bottom, )?rgb/)
    const start = await area.evaluate(element => getComputedStyle(element).maskImage)
    await area.evaluate(element => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2 })
    await expect.poll(() => area.evaluate(element => getComputedStyle(element).maskImage)).not.toBe(start)
    const middle = await area.evaluate(element => getComputedStyle(element).maskImage)
    await area.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect.poll(() => area.evaluate(element => getComputedStyle(element).maskImage)).not.toBe(middle)
    expect(await area.evaluate(element => getComputedStyle(element).maskImage)).not.toBe(start)
    await area.evaluate(element => { element.scrollTop = 0 })
  }
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await checkVertical('.session-list')
    await checkVertical('.messages')
    await page.locator('.archive-report summary').click()
    await checkVertical('.report-body')
    await page.locator('.archive-report summary').click()
    // 只改变隔离测试的可用高度，覆盖最小窗口通常不溢出的侧栏。
    await page.locator('.sidebar-section').evaluate(element => { element.style.flex = 'none'; element.style.height = '180px' })
    await checkVertical('.sidebar-section')
    const code = page.locator('.code-block pre').first()
    await expect(code).toHaveCSS('mask-image', /linear-gradient\(to right/)
    const left = await code.evaluate(element => getComputedStyle(element).maskImage)
    await code.evaluate(element => { element.scrollLeft = element.scrollWidth })
    await expect.poll(() => code.evaluate(element => getComputedStyle(element).maskImage)).not.toBe(left)
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await checkVertical('.search-results')
    await expect(page.locator('.search-header')).toHaveCSS('mask-image', 'none')
    await page.getByRole('textbox', { name: '搜索会话' }).fill('滚动测试档案 40')
    await expect(page.locator('.search-results')).toHaveCSS('mask-image', 'none')
    await page.getByRole('button', { name: '清空搜索' }).click()
    await expect(page.locator('.search-results')).toHaveCSS('mask-image', /linear-gradient/)
    await page.getByRole('button', { name: '关闭搜索' }).click()
    await page.getByRole('button', { name: 'Pin 走这段对话' }).click()
    await checkVertical('.handoff-preview')
    await page.locator('.dialog-content').evaluate(element => { element.style.maxHeight = '240px' })
    await checkVertical('.dialog-content')
    await expect(page.locator('.dialog-header')).toHaveCSS('mask-image', 'none')
    await expect(page.locator('.dialog-footer')).toHaveCSS('mask-image', 'none')
    await page.getByRole('button', { name: '关闭交接面板' }).click()
    // ResizeObserver 必须响应原地内容变化，而非依赖 React 重新挂载。
    await code.evaluate(element => { element.scrollLeft = 0; element.querySelector('code')!.textContent = 'short' })
    await expect(code).toHaveCSS('mask-image', 'none')
    await code.evaluate(element => { element.querySelector('code')!.textContent = 'long_code '.repeat(200) })
    await expect(code).toHaveCSS('mask-image', /linear-gradient\(to right/)
    await assertBackground()
  }
})

test('NewMax Tooltip 统一图标按钮，支持深浅主题、键盘与原生 modal 顶层', async () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    const searchButton = page.getByRole('button', { name: '搜索', exact: true })
    await searchButton.hover()
    const tooltip = page.getByRole('tooltip')
    await expect(tooltip).toHaveText('搜索')
    await expect(searchButton).not.toHaveAttribute('title')
    await expect(tooltip).toHaveCSS('padding', '8px 12px')
    await expect(tooltip).toHaveCSS('pointer-events', 'none')
    await expect(tooltip).toHaveCSS('background-color', colorScheme === 'dark' ? 'rgb(23, 23, 23)' : 'rgb(255, 255, 255)')
    expect(await tooltip.evaluate(element => element.matches(':popover-open'))).toBe(true)
    const bounds = (await tooltip.boundingBox())!
    const trigger = (await searchButton.boundingBox())!
    expect(bounds.y).toBeCloseTo(trigger.y + trigger.height + 4)
    expect(bounds.x).toBeGreaterThanOrEqual(8)
    await page.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
    await page.mouse.move(700, 400)
    const sidebar = page.getByRole('button', { name: '收起侧栏' })
    await sidebar.focus()
    await expect(tooltip).toHaveText('收起侧栏')
    await page.keyboard.press('Enter')
    await expect(tooltip).toHaveCount(0)
    const expand = page.getByRole('button', { name: '展开侧栏' })
    await expand.hover()
    await expect(tooltip).toHaveText('展开侧栏')
    await expand.click()
    await page.mouse.move(700, 400)
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    const close = page.getByRole('button', { name: '关闭搜索' })
    await close.hover()
    await expect(tooltip).toHaveText('关闭搜索')
    expect(await tooltip.evaluate(element => element.matches(':popover-open'))).toBe(true)
    await close.focus()
    await expect(close).toHaveAttribute('aria-describedby', await tooltip.getAttribute('id') as string)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(close).toHaveCount(0)
    await page.mouse.move(700, 400)
    await searchButton.hover()
    await expect(tooltip).toHaveText('搜索')
    await assertBackground()
  }
})

test.describe('全新空库', () => {
  test.use({ seedLibrary: false })

  test('首次启动与重启不生成演示档案，无档案类型筛选且可选择会话文件', async () => {
    const assertEmptyLibrary = async () => {
      await expect(page.locator('.session-list .empty-description')).toHaveText('暂无会话档案')
      await expect(page.getByRole('button', { name: '选择会话文件', exact: true })).toBeVisible()
      await expect(page.locator('.session-card')).toHaveCount(0)
      await expect(page.locator('.scope-filter')).toHaveCount(0)
      await expect(page.getByRole('group', { name: '档案类型' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^(全部|已导入|演示)$/ })).toHaveCount(0)
      await expect(page.locator('body')).not.toContainText('演示')
      for (const session of demoSessions) await expect(page.getByText(session.title, { exact: true })).toHaveCount(0)
      expect(await page.evaluate(() => window.staithe.list())).toEqual([])
      expect(await readdir(directory)).not.toContain('library.json')
      expect(await readdir(directory)).not.toContain('imports')
    }
    await assertEmptyLibrary()
    await page.screenshot({ scale: 'css', path: 'test-results/pinekin-empty-library-no-demo.png' })
    await app.evaluate(({ dialog }) => {
      ;(globalThis as unknown as { testOpenDialogCalls: number }).testOpenDialogCalls = 0
      dialog.showOpenDialog = async () => {
        ;(globalThis as unknown as { testOpenDialogCalls: number }).testOpenDialogCalls++
        return { canceled: true, filePaths: [] }
      }
    })
    const chooseFile = page.getByRole('button', { name: '选择会话文件', exact: true })
    await chooseFile.click()
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { testOpenDialogCalls: number }).testOpenDialogCalls)).toBe(1)
    await expect(chooseFile).toBeEnabled()
    await expect(chooseFile).toBeFocused()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await assertEmptyLibrary()
    await assertBackground()
    await app.close()
    await launch()
    await assertEmptyLibrary()
  })
})

test('应用图标可由 Electron 解码，像素与用户定稿一致且保留透明边角', async () => {
  const result = await app.evaluate(({ nativeImage }, paths) => {
    const image = nativeImage.createFromPath(paths.icon)
    const approved = nativeImage.createFromPath(paths.approved)
    const size = image.getSize()
    const bitmap = image.toBitmap()
    const alpha = (x: number, y: number) => bitmap[(y * size.width + x) * 4 + 3]
    return { empty: image.isEmpty(), sourceEmpty: approved.isEmpty(), size,
      matchesApproved: bitmap.equals(approved.toBitmap()), centerAlpha: alpha(512, 512),
      corners: [alpha(0, 0), alpha(1023, 0), alpha(0, 1023), alpha(1023, 1023)] }
  }, { icon: resolve('resources/pinekin.png'), approved: resolve('design/brand/pinekin-icon-approved.png') })
  expect(result.empty).toBe(false)
  expect(result.sourceEmpty).toBe(false)
  expect(result.size).toEqual({ width: 1024, height: 1024 })
  expect(result.matchesApproved).toBe(true)
  expect(result.corners).toEqual([0, 0, 0, 0])
  expect(result.centerAlpha).toBe(255)
})

test('macOS 图标底板收进安全留白，低透明度阴影向下且不裁边', async () => {
  const result = await app.evaluate(({ nativeImage }, iconPath) => {
    const image = nativeImage.createFromPath(iconPath)
    const bitmap = image.toBitmap()
    const alpha = (x: number, y: number) => bitmap[(y * 1024 + x) * 4 + 3]
    function bounds(pixels: Buffer, size: number) {
      let left = size, top = size, right = -1, bottom = -1
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (pixels[(y * size + x) * 4 + 3] < 250) continue
        left = Math.min(left, x); top = Math.min(top, y)
        right = Math.max(right, x); bottom = Math.max(bottom, y)
      }
      return { left, top, width: right - left + 1, height: bottom - top + 1 }
    }
    const small = image.resize({ width: 96, height: 96, quality: 'best' })
    return { empty: image.isEmpty(), size: image.getSize(), bounds: bounds(bitmap, 1024), smallBounds: bounds(small.toBitmap(), 96),
      upperShadow: alpha(512, 84), lowerShadow: alpha(512, 940),
      edges: [alpha(512, 0), alpha(512, 1023), alpha(0, 512), alpha(1023, 512)] }
  }, resolve('resources/pinekin-macos.png'))
  expect(result.empty).toBe(false)
  expect(result.size).toEqual({ width: 1024, height: 1024 })
  expect(result.bounds).toEqual({ left: 100, top: 100, width: 824, height: 824 })
  expect(result.edges).toEqual([0, 0, 0, 0])
  expect(result.lowerShadow).toBeGreaterThan(0)
  expect(result.lowerShadow).toBeLessThan(64)
  expect(result.lowerShadow).toBeGreaterThan(result.upperShadow)
  expect(result.smallBounds.width).toBeGreaterThanOrEqual(76)
  expect(result.smallBounds.width).toBeLessThanOrEqual(78)
  expect(result.smallBounds.height).toBeGreaterThanOrEqual(76)
  expect(result.smallBounds.height).toBeLessThanOrEqual(78)
})

test('原生红绿灯整合进 macOS 页头，拖动区不覆盖操作按钮', async () => {
  const chrome = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { platform: process.platform, buttons: process.platform === 'darwin' ? window.getWindowButtonPosition() : null,
      bounds: window.getBounds(), content: window.getContentBounds() }
  })
  await expect(page.locator('.shell')).toHaveAttribute('data-platform', chrome.platform)
  expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined')
  if (chrome.platform === 'darwin') {
    expect(chrome.buttons).toEqual({ x: 12, y: 12 })
    expect(chrome.content.height).toBe(chrome.bounds.height)
    await expect(page.locator('.window-toolbar')).toHaveCSS('-webkit-app-region', 'drag')
    await expect(page.locator('.window-controls-space')).toHaveCSS('-webkit-app-region', 'drag')
    await expect(page.locator('.brand')).toHaveCSS('-webkit-app-region', 'drag')
    await expect(page.locator('.topbar')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '导入会话文件' })).toHaveCSS('-webkit-app-region', 'no-drag')
    const toolbar = (await page.locator('.window-toolbar').boundingBox())!
    const controls = (await page.locator('.window-controls-space').boundingBox())!
    expect(toolbar.height).toBe(38)
    const header = (await page.locator('.list-heading').boundingBox())!
    const logo = (await page.locator('.brand > span').boundingBox())!
    const navLabel = (await page.locator('.sidebar-section .nav-label').first().boundingBox())!
    expect(controls.y).toBe(0)
    expect(controls.height).toBe(toolbar.height)
    expect(header.y).toBe(controls.y + controls.height)
    expect(header.height).toBe(48)
    const buttons = page.getByRole('navigation', { name: '浏览导航' }).getByRole('button')
    await expect(buttons).toHaveCount(3)
    let previousRight: number | undefined
    for (const button of await buttons.all()) {
      await expect(button).toHaveCSS('-webkit-app-region', 'no-drag')
      const box = (await button.boundingBox())!
      expect(box.x).toBe(previousRight === undefined ? controls.x + controls.width : previousRight + 1)
      expect(box.y + box.height / 2).toBe(19)
      previousRight = box.x + box.width
    }
    const searchButton = page.getByRole('button', { name: '搜索', exact: true })
    const search = (await searchButton.boundingBox())!
    const brandSidebar = (await page.locator('.sidebar').boundingBox())!
    expect(search.x).toBeGreaterThan(logo.x + logo.width)
    expect(search.x + search.width).toBeLessThanOrEqual(brandSidebar.x + brandSidebar.width)
    expect(Math.abs(search.y + search.height / 2 - (logo.y + logo.height / 2))).toBeLessThanOrEqual(1)
    await expect(searchButton).toHaveCSS('-webkit-app-region', 'no-drag')
    await expect(page.locator('.sidebar .brand')).toHaveCount(1)
    await expect(page.locator('.topbar .brand, .topbar input')).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: '搜索会话' })).toHaveCount(0)
    expect(logo.x).toBe(24)
    expect(logo.x).toBe(navLabel.x)
    expect(logo.y).toBeGreaterThanOrEqual(controls.y + controls.height)
    expect(logo.y).toBeLessThanOrEqual(toolbar.height + 10)
    await expect(page.locator('.brand')).toHaveCSS('height', '36px')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
    const narrowLogo = (await page.locator('.brand > span').boundingBox())!
    const sidebar = (await page.locator('.sidebar').boundingBox())!
    expect(narrowLogo.x).toBe(24)
    expect(narrowLogo.y).toBeGreaterThanOrEqual(toolbar.height)
    expect(narrowLogo.y).toBeLessThanOrEqual(toolbar.height + 10)
    expect(narrowLogo.x + narrowLogo.width).toBeLessThanOrEqual(sidebar.x + sidebar.width - 8)
    // 悬浮和收起状态都显示按钮底板，必须与顶行上下边缘各保持 5px。
    for (const collapsed of [false, true]) {
      if (collapsed) await page.getByRole('button', { name: '收起侧栏' }).click()
      await page.getByRole('button', { name: collapsed ? '展开侧栏' : '收起侧栏' }).hover()
      const row = (await page.locator('.window-toolbar').boundingBox())!
      for (const button of await buttons.all()) {
        const box = (await button.boundingBox())!
        expect(box.y - row.y).toBe(5)
        expect(row.y + row.height - box.y - box.height).toBe(5)
      }
      const card = (await page.locator('.workspace-card').boundingBox())!
      expect(card.y).toBe(row.y + row.height)
    }
    await page.screenshot({ scale: 'css', clip: { x: 0, y: 0, width: 560, height: 110 }, path: 'test-results/pinekin-toolbar-balanced-insets.png' })
    await page.getByRole('button', { name: '展开侧栏' }).click()
  }
  await page.getByRole('button', { name: 'Pin 走这段对话' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Pin 走这段对话' })).toBeFocused()
})

test('Windows 保持双行页头结构，导航靠左且不预留红绿灯空白', async () => {
  // 仅在隔离测试窗口模拟 win32 的 renderer 分支，不声称 Windows 原生控件实机验收。
  const preload = join(directory, 'windows-layout-preload.cjs')
  await writeFile(preload, `const { contextBridge, ipcRenderer } = require('electron');
    contextBridge.exposeInMainWorld('staithe', {
      platform: 'win32', list: async () => ${JSON.stringify(demoSessions)},
      sources: { page: async () => ({ items: [], total: 0, offset: 0, hasMore: false, connections: [] }) },
      previewImport: async () => null, confirmImport: async () => { throw new Error('此布局夹具不执行导入') },
      cancelImport: async () => {}, exportSession: async () => false, copy: async () => {},
      onOpenSession: callback => {
        const listener = (_event, id) => callback(id);
        ipcRenderer.on('staithe:open-session', listener);
        return () => ipcRenderer.removeListener('staithe:open-session', listener);
      }
    });`)
  const created = app.waitForEvent('window')
  const previewWindowId = await app.evaluate(({ BrowserWindow }, paths) => {
    const preview = new BrowserWindow({ width: 1000, height: 700, show: false, focusable: false, skipTaskbar: true, paintWhenInitiallyHidden: true,
      webPreferences: { preload: paths.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, focusOnNavigation: false } })
    void preview.loadFile(paths.html)
    return preview.id
  }, { preload, html: resolve('out/renderer/index.html') })
  const preview = await created
  await preview.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
  await expect(preview.getByRole('button', { name: '连接 App', exact: true })).toBeEnabled()
  await app.evaluate(({ BrowserWindow }, { windowId, id }) => {
    BrowserWindow.fromId(windowId)!.webContents.send('staithe:open-session', id)
  }, { windowId: previewWindowId, id: demoSessions[0].id })
  await expect(preview.getByRole('heading', { level: 2, name: demoSessions[0].title })).toBeVisible()
  await expect(preview.locator('.shell')).toHaveAttribute('data-platform', 'win32')
  await expect(preview.locator('.window-controls-space')).toHaveCount(0)
  await expect(preview.locator('.window-toolbar')).toHaveCount(1)
  await expect(preview.locator('.window-toolbar')).toHaveCSS('height', '32px')
  await expect(preview.locator('.window-toolbar')).not.toHaveCSS('-webkit-app-region', 'drag')
  await expect(preview.locator('.topbar .header-navigation')).toHaveCount(0)
  await expect(preview.getByRole('navigation', { name: '浏览导航' })).toBeVisible()
  await expect(preview.locator('.brand')).toHaveCSS('height', '36px')
  await expect(preview.locator('.topbar')).toHaveCount(0)
  await expect(preview.locator('.list-heading')).not.toHaveCSS('-webkit-app-region', 'drag')
  const toolbar = (await preview.locator('.window-toolbar').boundingBox())!
  const navigation = (await preview.getByRole('navigation', { name: '浏览导航' }).boundingBox())!
  const buttons = preview.getByRole('navigation', { name: '浏览导航' }).getByRole('button')
  await expect(buttons).toHaveCount(3)
  let previousRight: number | undefined
  for (const button of await buttons.all()) {
    const box = (await button.boundingBox())!
    expect(box.x).toBe(previousRight === undefined ? navigation.x : previousRight + 1)
    previousRight = box.x + box.width
    expect(box.y + box.height / 2).toBe(toolbar.y + toolbar.height / 2)
    expect(box.y - toolbar.y).toBe(2)
    expect(toolbar.y + toolbar.height - box.y - box.height).toBe(2)
  }
  expect(toolbar.y).toBe(0)
  expect(navigation.x).toBe(12)
  const brand = (await preview.locator('.brand').boundingBox())!
  const logo = (await preview.locator('.brand > span').boundingBox())!
  const header = (await preview.locator('.list-heading').boundingBox())!
  const importButton = (await preview.getByRole('button', { name: '导入会话文件' }).boundingBox())!
  expect(brand.y).toBe(toolbar.y + toolbar.height)
  expect(header.y).toBe(toolbar.y + toolbar.height)
  await expect(preview.locator('.sidebar')).toHaveCSS('border-right-width', '0px')
  const resizeHandle = preview.getByRole('separator', { name: '调整侧栏宽度' })
  await expect(resizeHandle).toHaveAttribute('aria-orientation', 'vertical')
  await expect(resizeHandle).toHaveCSS('-webkit-app-region', 'no-drag')
  await expect(preview.locator('aside.sidebar')).toHaveCSS('width', '240px')
  await expect(resizeHandle).toHaveAttribute('aria-valuemin', '240')
  const maximumWidth = await preview.evaluate(() => Math.max(240, Math.min(360, innerWidth - (innerWidth <= 1150 ? 280 : 310) - 408)))
  await resizeHandle.focus()
  for (const [key, width] of [
    ['ArrowRight', 250], ['ArrowLeft', 240], ['ArrowLeft', 240],
    ['End', maximumWidth], ['ArrowRight', maximumWidth], ['ArrowLeft', maximumWidth - 10], ['Home', 240],
  ] as const) {
    await preview.keyboard.press(key)
    await expect(preview.locator('aside.sidebar')).toHaveCSS('width', `${width}px`)
    await expect(resizeHandle).toBeFocused()
    await expect.poll(() => preview.evaluate(() => localStorage.getItem('pinekin.sidebar-width'))).toBe(String(width))
  }
  await resizeHandle.dblclick()
  await expect(preview.locator('aside.sidebar')).toHaveCSS('width', '240px')
  await expect.poll(() => preview.evaluate(() => localStorage.getItem('pinekin.sidebar-width'))).toBeNull()
  await expect(preview.locator('.workspace-card')).toHaveCSS('overflow', 'hidden')
  expect(await preview.locator('.workspace-card').evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeCloseTo(18 * 1.348, 3)
  expect(logo.y + logo.height / 2).toBeCloseTo(brand.y + brand.height / 2, 0)
  await expect(preview.locator('.sidebar .brand')).toHaveCount(1)
  await expect(preview.locator('.topbar .brand, .topbar input')).toHaveCount(0)
  const searchButton = preview.getByRole('button', { name: '搜索', exact: true })
  const search = (await searchButton.boundingBox())!
  expect(search.x).toBeGreaterThan(logo.x + logo.width)
  expect(search.x + search.width).toBeLessThanOrEqual(brand.x + brand.width)
  expect(search.y + search.height / 2).toBeCloseTo(logo.y + logo.height / 2, 0)
  await expect(preview.getByRole('textbox', { name: '搜索会话' })).toHaveCount(0)
  await searchButton.click()
  await expect(preview.getByRole('dialog', { name: '搜索会话' })).toBeVisible()
  await expect(preview.getByRole('textbox', { name: '搜索会话' })).toBeFocused()
  await preview.keyboard.press('Escape')
  await expect(searchButton).toBeFocused()
  await preview.getByRole('button', { name: '收起侧栏' }).click()
  await expect(preview.getByRole('complementary', { name: '档案导航' })).not.toBeVisible()
  await expect(preview.locator('.brand')).toBeHidden()
  await preview.keyboard.press('Control+k')
  await expect(preview.getByRole('textbox', { name: '搜索会话' })).toBeFocused()
  await preview.keyboard.press('Escape')
  await preview.getByRole('button', { name: '展开侧栏' }).click()
  expect(importButton.height).toBe(36)
  expect(importButton.x).toBe(brand.x + 12)
  expect(importButton.x + importButton.width).toBeLessThanOrEqual(brand.x + brand.width - 12)
  expect(importButton.y).toBeGreaterThanOrEqual(brand.y + brand.height)
  await expect(preview.locator('.topbar').getByRole('button', { name: '导入会话文件' })).toHaveCount(0)
  expect(await preview.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await preview.getByRole('button', { name: 'Pin 走这段对话' }).click()
  await expect(preview.getByRole('dialog')).toBeVisible()
  await preview.keyboard.press('Escape')
  await expect(preview.getByRole('button', { name: 'Pin 走这段对话' })).toBeFocused()
  await preview.screenshot({ scale: 'css', path: 'test-results/staithe-windows-two-row-header.png' })
  await preview.close()
})

test('隐藏桌面侧栏拖拽、临时限宽与持久化，DeepSeek 单行文字按溢出渐隐', async () => {
  // 复用已有合成 DeepSeek 档案，只向本测试的隔离目录读写并替换文件选择框。
  const file = join(directory, 'sidebar-synthetic.jsonl.zstd')
  await writeFile(file, zstdCompressSync(deepseekFixture()))
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
  }, file)
  await page.getByRole('button', { name: '导入会话文件' }).click()
  await page.getByRole('button', { name: '确认保存到本地' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'DeepSeek 合成会话' })).toBeVisible()

  const sidebar = page.locator('aside.sidebar')
  const handle = page.getByRole('separator', { name: '调整侧栏宽度' })
  const deepseek = sidebar.getByRole('button', { name: /^DeepSeek Harness/ })
  const label = deepseek.locator('span.ds-fade-text')
  const preference = () => page.evaluate(() => localStorage.getItem('pinekin.sidebar-width'))
  const expectWidth = async (width: number) => {
    await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(width)
    const side = (await sidebar.boundingBox())!
    const card = (await page.locator('main.workspace-card').boundingBox())!
    expect(side.x).toBe(0)
    expect(card.x).toBe(side.x + side.width)
    expect(card.y).toBe(side.y)
  }
  const resizeWindow = async (width: number) => {
    // 用内容尺寸保证跨平台 innerWidth 一致，不让原生窗口边框影响 1000px 的上限断言。
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 800), width)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
  }
  const dragTo = async (requestedWidth: number, expectedWidth: number, previousPreference: string | null) => {
    const side = (await sidebar.boundingBox())!
    const grip = (await handle.boundingBox())!
    expect(grip.width).toBe(6)
    expect(grip.x).toBeGreaterThanOrEqual(side.x + side.width - 6)
    expect(grip.x).toBeLessThanOrEqual(side.x + side.width)
    expect(grip.x + grip.width).toBeGreaterThanOrEqual(side.x + side.width)
    expect(grip.x + grip.width).toBeLessThanOrEqual(side.x + side.width + 3)
    const startX = grip.x + grip.width / 2, y = grip.y + grip.height / 2
    // Playwright 的鼠标输入走真实 pointerdown/move/up，验证命中区和 pointer capture。
    await page.mouse.move(startX, y)
    await page.mouse.down()
    try {
      await page.mouse.move(startX + requestedWidth - side.width, y, { steps: 8 })
      await expectWidth(expectedWidth)
      expect(await preference()).toBe(previousPreference)
    } finally {
      await page.mouse.up()
    }
    await expect.poll(preference).toBe(String(expectedWidth))
  }
  const expectFade = async (overflow: boolean) => {
    await expect(label).toHaveText('DeepSeek Harness')
    await expect(label).toHaveAttribute('title', 'DeepSeek Harness')
    await expect(label).toHaveAttribute('data-overflow', String(overflow))
    await expect(label).toHaveCSS('white-space', 'nowrap')
    await expect(label).toHaveCSS('text-overflow', 'clip')
    expect(await label.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(overflow)
    if (overflow) {
      await expect(label).toHaveCSS('mask-image', /linear-gradient\(.*16px/)
    } else {
      await expect(label).toHaveCSS('mask-image', 'none')
    }
    const lines = await label.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return range.getClientRects().length
    })
    expect(lines).toBe(1)
    await expect(deepseek).toHaveCSS('height', '36px')
  }

  await resizeWindow(1440)
  await expectWidth(240)
  expect(await preference()).toBeNull()
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical')
  await expect(handle).toHaveCSS('-webkit-app-region', 'no-drag')
  await dragTo(300, 300, null)
  await expectFade(false)
  await dragTo(900, 360, '300')
  await expectFade(false)
  await resizeWindow(1000)
  await expectWidth(312)
  expect(await preference()).toBe('360')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth)).toBe(true)
  await expect(page.getByRole('button', { name: 'Pin 走这段对话' })).toBeInViewport()
  // 窄窗口刷新仍只临时 clamp；恢复大窗口后必须找回 360，而不是保存后的 312。
  await page.reload()
  await openArchives()
  await expectWidth(312)
  expect(await preference()).toBe('360')
  await resizeWindow(1440)
  await expectWidth(360)
  await page.reload()
  await openArchives()
  await expectWidth(360)
  expect(await preference()).toBe('360')
  await expectFade(false)
  await page.getByRole('button', { name: '收起侧栏' }).click()
  await expect(sidebar).toBeHidden()
  await expect(handle).not.toBeVisible()
  expect(await preference()).toBe('360')
  await page.getByRole('button', { name: '展开侧栏' }).click()
  await expectWidth(360)
  await expect(handle).toBeVisible()
  await handle.dblclick()
  await expectWidth(240)
  await expect.poll(preference).toBeNull()
  await resizeWindow(1000)
  await expectWidth(240)
  expect(await preference()).toBeNull()
  await resizeWindow(1440)
  await expectWidth(240)
  await dragTo(80, 240, null)
  await expectFade(false)
  // 新下限已能容纳完整来源名；仅在隔离测试中收窄文字容器，继续验证溢出 mask。
  await label.evaluate(element => { element.style.maxWidth = '80px' })
  await expectFade(true)

  const icon = deepseek.locator('.source-icon')
  const count = deepseek.locator('.count')
  await expect(icon).toBeVisible()
  await expect(icon.locator('img')).toBeVisible()
  await expect.poll(() => icon.locator('img').evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true)
  await expect(count).toHaveText('1')
  await expect(count).toBeVisible()
  const row = (await deepseek.boundingBox())!
  const text = (await label.boundingBox())!
  const iconBox = (await icon.boundingBox())!, countBox = (await count.boundingBox())!
  expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(text.x)
  expect(text.x + text.width).toBeLessThanOrEqual(countBox.x)
  for (const item of [icon, count]) {
    const box = (await item.boundingBox())!
    expect(box.width).toBeGreaterThan(0)
    expect(box.x).toBeGreaterThanOrEqual(row.x)
    expect(box.x + box.width).toBeLessThanOrEqual(row.x + row.width)
    expect(box.y).toBeGreaterThanOrEqual(row.y)
    expect(box.y + box.height).toBeLessThanOrEqual(row.y + row.height)
    // mask 不得放在文字与图标共用的祖先上；仅检查子节点本身会漏掉这种回归。
    expect(await item.evaluate(element => {
      const row = element.closest('.nav-item')!
      for (let current: Element | null = element; current && current !== row.parentElement; current = current.parentElement) {
        if (getComputedStyle(current).maskImage !== 'none') return false
      }
      return true
    })).toBe(true)
  }
  // 分别点击图标、文字渐隐尾端和计数，确认整行没有被 mask 或拖拽命中区截断。
  for (const x of [iconBox.x + iconBox.width / 2, text.x + text.width - 2, countBox.x + countBox.width / 2]) {
    await sidebar.getByRole('button', { name: /^所有会话/ }).click()
    await expect(deepseek).toHaveAttribute('aria-pressed', 'false')
    await deepseek.click({ position: { x: x - row.x, y: row.height / 2 } })
    await expect(deepseek).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.session-card')).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 2, name: 'DeepSeek 合成会话' })).toBeVisible()
  }
  await expectFade(true)
  await label.evaluate(element => { element.style.maxWidth = '' })
  await expectFade(false)
  // 旧版本保存的窄宽度在刷新后也必须遵守 240px 下限，不主动重写偏好。
  await page.evaluate(() => localStorage.setItem('pinekin.sidebar-width', '200'))
  await page.reload()
  await openArchives()
  await expectWidth(240)
  await expect(handle).toHaveAttribute('aria-valuemin', '240')
  expect(await preference()).toBe('200')
  await expectFade(false)
  await assertBackground()
  await page.screenshot({ scale: 'css', path: 'test-results/pinekin-resizable-sidebar.png' })
})

test('会话栏内容对齐，12px 列表圆角与双侧 1px 行间距保持紧凑', async () => {
  for (const { width, height, colorScheme } of [
    { width: 1440, height: 900, colorScheme: 'light' },
    { width: 1000, height: 680, colorScheme: 'dark' },
  ] as const) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width, height })
    await page.emulateMedia({ colorScheme })
    // 窗口 resize 后，等待 React 提交响应式侧栏宽度，再读取同一帧的对齐基线。
    await expect(page.locator('.sidebar')).toHaveCSS('width', '240px')
    const pane = page.locator('.session-pane')
    const left = (await pane.boundingBox())!.x + 20
    for (const selector of ['.list-heading h2', '.session-card h3', '.session-card .card-meta']) {
      const boxes = await pane.locator(selector).evaluateAll(elements => elements.map(element => element.getBoundingClientRect().left))
      expect(boxes.length).toBeGreaterThan(0)
      for (const x of boxes) expect(x).toBeCloseTo(left, 1)
    }
    const cards = page.locator('.session-card')
    expect(await cards.first().evaluate(element => parseFloat(getComputedStyle(element).borderTopLeftRadius))).toBeCloseTo(12 * 1.348, 3)
    for (const card of await cards.all()) {
      await expect(card).toHaveCSS('padding', '8px 12px')
      await expect(card.locator('.card-meta')).toHaveCSS('line-height', '16px')
      await expect(card.locator('.card-meta')).toHaveCSS('margin-bottom', '4px')
      await expect(card.locator('h3')).toHaveCSS('font-weight', '400')
      const layout = await card.evaluate(element => {
        const title = element.querySelector('h3')!
        const meta = element.querySelector('.card-meta')!
        const style = getComputedStyle(title)
        return { gap: title.getBoundingClientRect().top - meta.getBoundingClientRect().bottom,
          lineHeight: parseFloat(style.lineHeight), fontSize: parseFloat(style.fontSize) }
      })
      expect(layout.gap).toBe(4)
      expect(layout.lineHeight).toBeCloseTo(layout.fontSize * 1.5)
    }
    const cardBoxes = await cards.evaluateAll(elements => elements.map(element => {
      const { top, bottom } = element.getBoundingClientRect(); return { top, bottom }
    }))
    for (let index = 1; index < cardBoxes.length; index++) expect(cardBoxes[index].top - cardBoxes[index - 1].bottom).toBe(1)
    const navItems = page.locator('.nav-item')
    for (const item of await navItems.all()) await expect(item).toHaveCSS('margin-bottom', '1px')
    // 全局操作与来源分组之间保留留白；仅比较分组标题后的连续来源项。
    const navBoxes = await page.locator('.sources-label ~ .nav-item').evaluateAll(elements => elements.map(element => {
      const { top, bottom } = element.getBoundingClientRect(); return { top, bottom }
    }))
    for (let index = 1; index < navBoxes.length; index++) expect(navBoxes[index].top - navBoxes[index - 1].bottom).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ scale: 'css', path: `test-results/pinekin-list-alignment-${colorScheme}-v1.png` })
  }
})

test('连续圆角应用到容器，胶囊和正圆例外不改变布局或向子节点扩散', async () => {
  expect(await page.evaluate(() => CSS.supports('corner-shape', 'superellipse(1.5)'))).toBe(true)
  const rounded = async (selector: string, logicalRadius: number) => {
    const item = page.locator(selector).first()
    await expect(item).toHaveCSS('corner-shape', 'superellipse(1.5)')
    expect(await item.evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeCloseTo(logicalRadius * 1.348, 3)
  }
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await rounded('.workspace-card', 18)
    await rounded('.nav-item', 12)
    await rounded('.session-card', 12)
    await rounded('.message-bubble', 18)
    await expect(page.locator('.nav-item').first()).toHaveCSS('height', '36px')
    await expect(page.locator('.message-bubble').first()).toHaveCSS('padding', '8px 16px')
    await expect(page.locator('.ds-button').first()).toHaveCSS('corner-shape', /^(?:round|superellipse\(1\))$/)
    await expect(page.locator('.ds-button').first()).toHaveCSS('border-radius', '9999px')
    await expect(page.locator('.local-state')).toHaveCount(0)
    const trigger = page.getByRole('button', { name: '搜索', exact: true })
    await trigger.click()
    await rounded('.ds-dialog', 18)
    await rounded('.search', 12)
    await rounded('.search-result', 12)
    await expect(page.locator('.search')).toHaveCSS('height', '40px')
    await expect(page.locator('.search')).not.toHaveCSS('box-shadow', 'none')
    await expect(page.getByRole('textbox', { name: '搜索会话' })).toBeFocused()
    const inherited = await page.locator('.search .ds-button').first().evaluate(button => {
      const child = document.createElement('span')
      child.style.borderRadius = 'var(--ds-radius-sm)'
      button.append(child)
      const result = { pseudo: getComputedStyle(button, '::before').getPropertyValue('corner-shape'),
        child: getComputedStyle(child).getPropertyValue('corner-shape') }
      child.remove()
      return result
    })
    // Chromium 将 round 的计算值规范化为等价的 superellipse(1)。
    expect(inherited.pseudo).toMatch(/^(?:round|superellipse\(1\))$/)
    expect(inherited.child).toBe('superellipse(1.5)')
    await page.getByRole('dialog').screenshot({ scale: 'css', path: `test-results/pinekin-continuous-corners-${colorScheme}.png` })
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
  }
})

test('禁用连续圆角能力规则后回退原始半径，胶囊和焦点行为保留', async () => {
  const removed = await page.evaluate(() => {
    let count = 0
    const visit = (sheet: CSSStyleSheet | CSSGroupingRule) => {
      for (let index = sheet.cssRules.length - 1; index >= 0; index--) {
        const rule = sheet.cssRules[index]
        if (rule instanceof CSSSupportsRule && rule.conditionText.includes('corner-shape')) {
          sheet.deleteRule(index); count++
        } else if (rule instanceof CSSGroupingRule) visit(rule)
      }
    }
    for (const sheet of document.styleSheets) visit(sheet)
    return count
  })
  expect(removed).toBeGreaterThan(0)
  await expect(page.locator('.workspace-card')).toHaveCSS('border-radius', '18px')
  await expect(page.locator('.message-bubble').first()).toHaveCSS('border-radius', '18px')
  await expect(page.locator('.message-bubble').first()).toHaveCSS('corner-shape', /^(?:round|superellipse\(1\))$/)
  await expect(page.locator('.session-card').first()).toHaveCSS('border-radius', '12px')
  await expect(page.locator('.nav-item').first()).toHaveCSS('border-radius', '12px')
  await expect(page.locator('.ds-button').first()).toHaveCSS('border-radius', '9999px')
  const trigger = page.getByRole('button', { name: '搜索', exact: true })
  await trigger.click()
  await expect(page.locator('.ds-dialog')).toHaveCSS('border-radius', '18px')
  await expect(page.locator('.search')).toHaveCSS('border-radius', '12px')
  await expect(page.locator('.search')).not.toHaveCSS('box-shadow', 'none')
  await expect(page.getByRole('textbox', { name: '搜索会话' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
})

test('导航保留 small relaxed，弹窗关闭组件统一默认尺寸，正文操作保持原尺寸', async () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.mouse.move(700, 300)
    // 滚动到底部属于阅读区浮动操作，仅在正文超出一屏时出现（Windows 原生边框与双行页头使内容区更矮）。
    const scrollToBottom = page.locator('.scroll-to-bottom')
    if (await scrollToBottom.count()) {
      await expect(scrollToBottom).not.toHaveClass(/ds-button-small|ds-button-icon-relaxed/)
      await expect(scrollToBottom).toHaveCSS('width', '36px')
      await expect(scrollToBottom).toHaveCSS('height', '36px')
    }
    for (const button of await page.locator('.ds-button-icon:not(.scroll-to-bottom)').all()) {
      await expect(button).toHaveClass(/ds-button-small/)
      await expect(button).toHaveClass(/ds-button-icon-relaxed/)
      await expect(button).toHaveCSS('height', '28px')
      await expect(button).toHaveCSS('width', '35px')
      await expect(button).toHaveCSS('padding-left', '10px')
      await expect(button).toHaveCSS('padding-right', '10px')
      await expect(button.locator('svg')).toHaveCSS('width', '15px')
      await expect(button.locator('svg')).toHaveCSS('height', '15px')
      await expect(button).toHaveAttribute('data-ds-pill-control', 'true')
    }
    const back = page.getByRole('button', { name: '返回', exact: true })
    await expect(back).toBeDisabled()
    await back.hover()
    await expect(back).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    const search = page.getByRole('button', { name: '搜索', exact: true })
    await search.hover()
    await expect(search).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await page.screenshot({ scale: 'css', path: `test-results/pinekin-small-relaxed-buttons-${colorScheme}-v1.png` })
    await search.click()
    const close = page.getByRole('button', { name: '关闭搜索' })
    await expect(close).toHaveClass(/ds-dialog-close/)
    await expect(close).toHaveCSS('height', '32px')
    await expect(close).toHaveCSS('width', '42px')
    await expect(close.locator('svg')).toHaveCSS('width', '18px')
    await page.keyboard.press('Escape')
    await expect(search).toBeFocused()
    const handoff = page.getByRole('button', { name: 'Pin 走这段对话' })
    await expect(handoff).toHaveCSS('height', '32px')
    await handoff.click()
    await expect(page.locator('.dialog-header h2')).toHaveText('让这段思考，有下文。')
    await expect(page.locator('.dialog-header .dialog-icon')).toHaveCount(0)
    await expect(page.locator('.dialog-header svg')).toHaveCount(1)
    await expect(page.getByRole('button', { name: '关闭交接面板' })).toHaveClass(/ds-dialog-close/)
    await expect(page.getByRole('button', { name: '关闭交接面板' })).toHaveCSS('height', '32px')
    await expect(page.getByRole('button', { name: '复制交接文本' })).toHaveCSS('height', '36px')
    await page.keyboard.press('Escape')
  }
})

test('搜索弹窗不显示标题，浅深色聚焦阴影不被裁切', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  const trigger = page.getByRole('button', { name: '搜索', exact: true })
  const dialog = page.getByRole('dialog', { name: '搜索会话' })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await trigger.click()
    await expect(dialog.getByRole('textbox', { name: '搜索会话' })).toBeFocused()
    await expect(dialog.locator('.search')).not.toHaveCSS('box-shadow', 'none')
    const clipped = await dialog.locator('.search').evaluate(field => {
      const box = field.getBoundingClientRect()
      const issues: string[] = []
      // 两个主题的最大聚焦环为 4px；额外保留 2px 安全距离，逐个检查真实裁切祖先。
      const gutter = 6
      for (let parent = field.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        const clipX = /auto|hidden|scroll|clip/.test(style.overflowX)
        const clipY = /auto|hidden|scroll|clip/.test(style.overflowY)
        const rect = parent.getBoundingClientRect()
        const left = rect.left + parent.clientLeft, top = rect.top + parent.clientTop
        if (clipX && (box.left - left < gutter || left + parent.clientWidth - box.right < gutter)) issues.push(`${parent.className}: horizontal`)
        if (clipY && (box.top - top < gutter || top + parent.clientHeight - box.bottom < gutter)) issues.push(`${parent.className}: vertical`)
      }
      return issues
    })
    expect(clipped).toEqual([])
    await expect(dialog.locator('#search-title')).toHaveCSS('clip-path', 'inset(50%)')
    await expect(dialog.locator('.dialog-header')).toHaveCount(0)
    await expect(dialog.locator('.search-content input')).toHaveCount(0)
    const input = (await dialog.locator('.search').boundingBox())!
    const closeButton = dialog.getByRole('button', { name: '关闭搜索' })
    const close = (await closeButton.boundingBox())!
    const textbox = (await dialog.getByRole('textbox', { name: '搜索会话' }).boundingBox())!
    expect(close.x).toBeGreaterThan(input.x)
    expect(close.x + close.width).toBeLessThan(input.x + input.width)
    expect(textbox.x + textbox.width).toBeLessThanOrEqual(close.x)
    expect(Math.abs(input.y + input.height / 2 - (close.y + close.height / 2))).toBeLessThanOrEqual(1)
    await expect(dialog.locator('.search').getByRole('button', { name: '关闭搜索' })).toHaveCount(1)
    await dialog.screenshot({ scale: 'css', path: `test-results/staithe-search-inline-close-${colorScheme}.png` })
    await closeButton.click()
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
  }
})

test('搜索点击遮罩关闭，内部点击或拖出不误关且保留查询与焦点', async () => {
  const trigger = page.getByRole('button', { name: '搜索', exact: true })
  const dialog = page.getByRole('dialog', { name: '搜索会话' })
  const input = dialog.getByRole('textbox', { name: '搜索会话' })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await trigger.click()
    await input.fill('安全边界')
    await input.click()
    const box = (await dialog.boundingBox())!
    const outside = { x: box.x - 12, y: box.y + box.height / 2 }
    await page.mouse.click(box.x + 8, box.y + 8)
    await expect(dialog).toBeVisible()
    await input.hover()
    await page.mouse.down()
    await page.mouse.move(outside.x, outside.y)
    await page.mouse.up()
    await expect(dialog).toBeVisible()
    await page.mouse.click(outside.x, outside.y)
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await expect(input).toHaveValue('安全边界')
    await page.keyboard.press('Escape')
  }
})

test('页头搜索、浏览历史与侧栏展开收起保持布局和键盘可用', async () => {
  const back = page.getByRole('button', { name: '返回', exact: true })
  const forward = page.getByRole('button', { name: '前进', exact: true })
  await expect(back).toBeDisabled()
  await expect(forward).toBeDisabled()
  await expect(page.locator('.session-pane input')).toHaveCount(0)
  await page.getByRole('button', { name: new RegExp(demoSessions[1].title) }).click()
  await page.getByRole('complementary').getByRole('button', { name: /^Codex/ }).click()
  await back.click()
  await expect(page.getByRole('heading', { level: 2, name: demoSessions[1].title })).toBeVisible()
  await forward.click()
  await expect(page.getByRole('heading', { level: 2, name: demoSessions[2].title })).toBeVisible()
  await page.getByRole('button', { name: '收起侧栏' }).click()
  await expect(page.locator('.sidebar')).toBeHidden()
  const list = (await page.locator('.session-pane').boundingBox())!
  expect(list.x).toBe(8)
  await expect(page.locator('.brand')).toBeHidden()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('textbox', { name: '搜索会话' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '展开侧栏' })).toBeFocused()
  await expect(page.locator('.sidebar').getByRole('button', { name: '导入会话文件', includeHidden: true })).toBeHidden()
  await expect(page.locator('.session-pane').getByRole('button', { name: '导入会话文件' })).toHaveCount(0)
  await page.screenshot({ scale: 'css', path: 'test-results/staithe-header-sidebar-collapsed.png' })
  await page.getByRole('button', { name: '展开侧栏' }).click()
  await expect(page.getByRole('complementary').getByRole('button', { name: /^Codex/ })).toHaveAttribute('aria-pressed', 'true')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.getByRole('button', { name: '导入会话文件' })).toBeInViewport()
  await expect(page.getByRole('button', { name: '搜索', exact: true })).toBeInViewport()
  await expect(page.getByRole('textbox', { name: '搜索会话' })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ scale: 'css', path: 'test-results/staithe-header-navigation-dark.png' })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.getByRole('button', { name: '所有会话 3' }).click()
  await page.getByRole('button', { name: new RegExp(demoSessions[0].title) }).click()
  await page.screenshot({ scale: 'css', path: 'test-results/staithe-header-navigation-light.png' })
})

test('侧栏 spring 保持固定画布、工作区联动与开关位置，系统减少动画可中途生效', async () => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const sidebar = page.locator('.sidebar')
  const canvas = page.locator('.sidebar-content')
  const toggle = page.locator('.sidebar-toggle')
  const toggleBox = await toggle.boundingBox()
  await expect(sidebar).toHaveCSS('width', '240px')
  await expect(toggle.locator('svg')).not.toHaveClass(/lucide/)
  await toggle.click()
  await page.waitForFunction(() => {
    const width = document.querySelector('.sidebar')!.getBoundingClientRect().width
    return width > 0 && width < 240
  })
  await expect(canvas).toHaveCSS('width', '240px')
  await expect(canvas).toHaveCSS('transform', 'none')
  await expect(sidebar).toHaveAttribute('inert', '')
  await expect(sidebar).toHaveCSS('width', '0px')
  await expect(sidebar).toBeHidden()
  expect((await page.locator('.workspace-card').boundingBox())!.x).toBe(8)
  expect(await toggle.boundingBox()).toEqual(toggleBox)
  await toggle.click()
  await page.waitForFunction(() => {
    const width = document.querySelector('.sidebar')!.getBoundingClientRect().width
    return width > 0 && width < 240
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(sidebar).toHaveCSS('width', '240px')
  await expect(sidebar).toBeVisible()
  await expect(canvas).toHaveCSS('opacity', '1')
  await expect(page.getByRole('button', { name: '搜索', exact: true })).toBeInViewport()
  expect(await toggle.boundingBox()).toEqual(toggleBox)
})

test('本地收纳插画有独立展示宽度，放大后在深浅主题及最窄侧栏仍不挤压文案', async () => {
  // Windows runner 的默认工作区可能仅 1024px，自动限宽时侧栏上限不是 360px。
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1380, 900))
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1380)
  await expect(page.getByRole('separator', { name: '调整侧栏宽度' })).toHaveAttribute('aria-valuemax', '360')
  const note = page.getByRole('region', { name: '本地存储与隐私' })
  const illustration = note.locator('img.storage-illustration')
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect(note).toHaveCSS('padding-top', '6px')
    await expect(note).toHaveCSS('padding-bottom', '6px')
    await expect(note).toHaveCSS('padding-left', '12px')
    await expect(note).toHaveCSS('padding-right', '0px')
    await expect(note.locator('.local-info')).toHaveCSS('font-size', '13px')
    await expect(note.locator('.local-info')).toHaveCSS('font-weight', '600')
    await expect(note.locator('.storage-description')).toHaveCSS('font-size', '11px')
    await expect(note.locator('.storage-description')).toHaveCSS('font-weight', '400')
    const contrasts = await note.evaluate(element => {
      const context = document.createElement('canvas').getContext('2d')!
      // 这是明确主题底板上的 CSS 对比度，不是原生 vibrancy 背后的桌面截图验收。
      // 先铺不透明底板，再按祖先顺序合成；不能忽略透明 canvas 的 alpha 直接算亮度。
      context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--ds-surface-300')
      context.fillRect(0, 0, 1, 1)
      const ancestors: Element[] = []
      for (let node: Element | null = element; node; node = node.parentElement) ancestors.unshift(node)
      for (const ancestor of ancestors) {
        context.fillStyle = getComputedStyle(ancestor).backgroundColor
        context.fillRect(0, 0, 1, 1)
      }
      const luminance = (channels: Uint8ClampedArray) => Array.from(channels).slice(0, 3)
        .map(channel => channel / 255)
        .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
        .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0)
      const surface = context.getImageData(0, 0, 1, 1)
      const background = luminance(surface.data)
      return ['.local-info', '.storage-description', '.storage-boundaries'].map(selector => {
        context.putImageData(surface, 0, 0)
        context.fillStyle = getComputedStyle(element.querySelector(selector)!).color
        context.fillRect(0, 0, 1, 1)
        const foreground = luminance(context.getImageData(0, 0, 1, 1).data)
        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
      })
    })
    expect(contrasts[0]).toBeGreaterThan(contrasts[1])
    expect(contrasts[1]).toBeGreaterThan(contrasts[2])
    for (const contrast of contrasts.slice(0, 2)) expect(contrast).toBeGreaterThanOrEqual(4.5)
    expect(contrasts[2]).toBeGreaterThanOrEqual(2.5)
    for (const [sidebarWidth, illustrationSize] of [[240, 92], [280, 100], [360, 100]] as const) {
      const resizeHandle = page.getByRole('separator', { name: '调整侧栏宽度' })
      await resizeHandle.press('Home')
      for (let width = 240; width < sidebarWidth; width += 10) await resizeHandle.press('ArrowRight')
      await expect(page.locator('.sidebar')).toHaveCSS('width', `${sidebarWidth}px`)
      await expect(illustration).toHaveCSS('width', `${illustrationSize}px`)
      await expect(illustration).toHaveCSS('height', `${illustrationSize}px`)
      await expect(note).toBeInViewport()
      const copy = (await note.locator('.storage-copy').boundingBox())!
      const image = (await illustration.boundingBox())!
      const card = (await note.boundingBox())!
      expect(image.x - copy.x - copy.width).toBeGreaterThanOrEqual(4)
      expect(card.x + card.width - image.x - image.width).toBeCloseTo(0)
      expect(image.y).toBeGreaterThanOrEqual(card.y + 6)
      expect(image.y + image.height).toBeLessThanOrEqual(card.y + card.height - 6)
      expect(card.height).toBeLessThanOrEqual(116)
      expect(await note.evaluate(element => Array.from(element.querySelectorAll('p, .local-info, .storage-boundaries'))
        .every(child => child.scrollWidth <= child.clientWidth))).toBe(true)
      if (sidebarWidth === 240) {
        expect(copy.width).toBeGreaterThanOrEqual(108)
        await expect(note.locator('.local-info')).toHaveCSS('height', '20px')
        await expect(note.locator('.storage-description')).toHaveCSS('height', '18px')
        await expect(note.locator('.storage-boundaries')).toHaveCSS('height', '18px')
      }
      await expect(note).toContainText('仅保存在本机')
      await expect(note).toContainText('仅导入你选择的文件')
      await expect(note).toContainText('不自动扫描')
      await expect(note).toContainText('不上传')
      await note.screenshot({ scale: 'css', path: `test-results/pinekin-privacy-note-hierarchy-${colorScheme}-${sidebarWidth}.png` })
    }
  }
})

test('右侧整体包入圆角卡片，侧栏无竖线且收起后保留外边距', async () => {
  for (const { width, height, colorScheme } of [
    { width: 1440, height: 900, colorScheme: 'light' },
    { width: 1000, height: 680, colorScheme: 'dark' },
  ] as const) {
    // 验证的是网页内边距，不能把 Windows 原生边框和标题栏算进内容尺寸。
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height })
    await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
    await page.emulateMedia({ colorScheme })
    const card = page.locator('main.workspace-card')
    await expect(card.locator(':scope > .topbar')).toHaveCount(0)
    await expect(card.locator('.session-pane > .topbar')).toHaveCount(0)
    await expect(card.locator(':scope > .workspace > .session-pane')).toHaveCount(1)
    await expect(card.locator(':scope > .workspace > .detail')).toHaveCount(1)
    await expect(page.locator('.sidebar')).toHaveCSS('border-right-width', '0px')
    await expect(card).toHaveCSS('overflow', 'hidden')
    await expect(card).toHaveCSS('box-shadow', colorScheme === 'light'
      ? 'rgba(0, 0, 0, 0.06) 0px 0px 0px 0.5px, rgba(0, 0, 0, 0.1) 0px 0.5px 1px 0px'
      : 'rgba(255, 255, 255, 0.08) 0px 0px 0px 0.5px, rgba(0, 0, 0, 0.28) 0px 0.5px 1px 0px')
    const note = page.getByRole('region', { name: '本地存储与隐私' })
    await expect(note).toBeInViewport()
    await expect(note).toContainText('仅导入你选择的文件')
    await expect(note.locator('.design-icon')).toHaveCount(0)
    const illustration = note.locator('img.storage-illustration')
    await expect(illustration).toBeVisible()
    await expect(illustration).toHaveAttribute('src', /(?:\.svg$|^data:image\/svg\+xml)/)
    expect(await illustration.evaluate(async (element, scheme) => {
      const image = element as HTMLImageElement
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 128
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0, 128, 128)
      const corner = context.getImageData(0, 0, 1, 1).data
      const box = Array.from(context.getImageData(42, 86, 1, 1).data)
      const expected = scheme === 'dark' ? [117, 96, 71, 255] : [238, 215, 179, 255]
      return image.complete && image.naturalWidth === 1024 && image.naturalHeight === 1024
        && corner[3] === 0 && box.every((channel, index) => channel === expected[index])
    }, colorScheme)).toBe(true)
    await expect(illustration).toHaveAttribute('alt', '')
    await expect(illustration).toHaveAttribute('aria-hidden', 'true')
    await expect(illustration).toHaveAttribute('draggable', 'false')
    await expect(illustration).toHaveCSS('pointer-events', 'none')
    await expect(illustration).toHaveCSS('object-fit', 'contain')
    await expect(illustration).toHaveCSS('mix-blend-mode', 'normal')
    await expect(illustration).toHaveCSS('filter', 'none')
    await expect(note).toHaveCSS('isolation', 'isolate')
    await expect(note.locator('svg, button, a, [tabindex]')).toHaveCount(0)
    const copyBox = (await note.locator('.storage-copy').boundingBox())!
    const illustrationBox = (await illustration.boundingBox())!
    expect(illustrationBox.x - copyBox.x - copyBox.width).toBeGreaterThanOrEqual(4)
    expect(Math.abs(illustrationBox.y + illustrationBox.height / 2 - copyBox.y - copyBox.height / 2)).toBeLessThanOrEqual(1)
    const textFits = await note.evaluate(el => Array.from(el.querySelectorAll('p, .local-info, .storage-boundaries')).every(child => child.scrollWidth <= child.clientWidth))
    expect(textFits).toBe(true)
    const sidebar = (await page.locator('.sidebar').boundingBox())!
    const box = (await card.boundingBox())!
    expect(box.x).toBe(sidebar.x + sidebar.width)
    expect(box.y).toBe(sidebar.y)
    expect(width - box.x - box.width).toBe(8)
    expect(height - box.y - box.height).toBe(8)
    await expect(page.locator('.list-heading')).toHaveCSS('box-shadow', 'none')
    await expect(page.getByRole('button', { name: 'Pin 走这段对话' })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true)
    const noteBox = (await note.boundingBox())!
    expect(noteBox.x - sidebar.x).toBe(12)
    expect(sidebar.x + sidebar.width - noteBox.x - noteBox.width).toBe(12)
    expect(noteBox.height).toBeLessThanOrEqual(128)
    expect(illustrationBox.x + illustrationBox.width).toBeLessThanOrEqual(noteBox.x + noteBox.width)
    await page.screenshot({ scale: 'css', path: `test-results/pinekin-workspace-shadow-spread-${colorScheme}-v2.png` })
    await note.screenshot({ scale: 'css', path: `test-results/pinekin-privacy-note-${colorScheme}-svg.png` })
    const vector = await illustration.evaluateHandle(element => {
      const preview = element.cloneNode() as HTMLImageElement
      preview.className = ''
      preview.style.cssText = 'position:fixed;left:0;top:0;width:384px;height:384px;z-index:99999;pointer-events:none'
      preview.style.backgroundColor = getComputedStyle(document.querySelector('.sidebar')!).backgroundColor
      document.body.append(preview)
      return preview
    })
    await vector.asElement()!.screenshot({ scale: 'css', path: `test-results/pinekin-local-storage-vector-${colorScheme}.png` })
    await vector.evaluate(element => element.remove())
    await page.getByRole('button', { name: '收起侧栏' }).click()
    expect((await card.boundingBox())!.x).toBe(8)
    await expect(page.locator('.session-pane')).toBeInViewport()
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('textbox', { name: '搜索会话' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '展开侧栏' })).toBeFocused()
    await page.getByRole('button', { name: '展开侧栏' }).click()
  }
})

test('紧凑阅读留白不变，导入改为左侧图标加文字菜单且键盘可用', async () => {
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  })
  for (const { width, height, colorScheme } of [
    { width: 1440, height: 900, colorScheme: 'light' },
    { width: 1000, height: 680, colorScheme: 'dark' },
  ] as const) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width, height })
    await page.emulateMedia({ colorScheme })
    await expect(page.locator('.local-state, .reader-toolbar, .detail-kicker')).toHaveCount(0)
    const detail = (await page.locator('.detail').boundingBox())!
    const header = (await page.locator('.detail-header').boundingBox())!
    const messages = page.getByRole('region', { name: '会话消息' })
    const first = (await messages.getByRole('article').first().boundingBox())!
    expect(header.y).toBe(detail.y)
    expect(header.height).toBeLessThanOrEqual(104)
    expect(first.y - detail.y).toBeLessThanOrEqual(128)
    await expect(messages).toHaveCSS('padding-top', '24px')
    await expect(messages).toHaveCSS('padding-bottom', '24px')
    await expect(page.locator('.detail-footer')).toHaveCSS('padding-top', '12px')
    await expect(page.locator('.detail-footer')).toHaveCSS('padding-bottom', '12px')
    await expect(page.locator('.detail-header .read-only')).toHaveCount(0)
    await expect(page.locator('.detail-header .reader-state')).toHaveText('本地档案')
    const titleGroup = page.locator('.detail-title-group')
    await expect(titleGroup).toHaveCSS('gap', '8px')
    const titleBox = (await titleGroup.locator('h2').boundingBox())!, badgeBox = (await titleGroup.locator('.archive-badge').boundingBox())!
    expect(badgeBox.x - titleBox.x - titleBox.width).toBeCloseTo(8, 0)
    await expect(page.locator('.detail-header').getByRole('button', { name: 'Pin 走这段对话' })).toBeVisible()
    await expect(page.locator('.detail-footer').getByRole('button', { name: 'Pin 走这段对话' })).toHaveCount(0)
    await expect(page.locator('.detail-meta')).toContainText('仅文本 · 非原生会话')
    const pane = page.getByRole('region', { name: '会话列表' })
    await expect(pane.getByRole('heading', { name: '会话库' })).toHaveCount(0)
    await expect(page.locator('.topbar')).toHaveCount(0)
    const listHeading = pane.locator(':scope > .list-heading')
    await expect(listHeading.getByRole('heading', { name: '所有会话', exact: true })).toBeVisible()
    await expect(listHeading).toContainText(`${demoSessions.length} 段会话`)
    await expect(listHeading).toHaveCSS('box-shadow', 'none')
    await expect(listHeading).toHaveCSS('border-bottom-width', '0px')
    await expect(page.locator('.detail-header')).toHaveCSS('box-shadow', 'none')
    await expect(page.locator('.detail-header')).toHaveCSS('border-bottom-width', '0px')
    const headingBox = (await listHeading.boundingBox())!
    const paneBox = (await pane.boundingBox())!
    const card = (await page.locator('.workspace-card').boundingBox())!
    expect(headingBox.y).toBe(card.y)
    expect(detail.y).toBe(card.y)
    expect(headingBox.x).toBe(paneBox.x)
    expect(headingBox.width).toBe(paneBox.width - 1)
    await expect(pane.getByRole('button', { name: '导入会话文件' })).toHaveCount(0)
    const sidebar = page.getByRole('complementary', { name: '档案导航' })
    const importButton = sidebar.getByRole('button', { name: '导入会话文件' })
    await expect(importButton).toHaveText('导入会话')
    await expect(importButton).toHaveClass('nav-item')
    await expect(importButton).toHaveAttribute('aria-haspopup', 'dialog')
    await expect(importButton).not.toHaveAttribute('aria-pressed')
    await importButton.hover()
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await expect(importButton).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await page.mouse.move(700, 400)
    await expect(importButton).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(importButton.locator('svg.lucide-plus')).toHaveCount(1)
    await expect(importButton.locator('.count')).toHaveCount(0)
    await expect(importButton).toHaveCSS('height', '36px')
    await expect(importButton).toHaveCSS('-webkit-app-region', process.platform === 'darwin' ? 'no-drag' : 'none')
    const button = (await importButton.boundingBox())!
    const sidebarBox = (await sidebar.boundingBox())!
    const allSessions = (await sidebar.getByRole('button', { name: /所有会话/ }).boundingBox())!
    const sources = (await sidebar.locator('.sources-label').boundingBox())!
    expect(button.x).toBe(allSessions.x)
    expect(button.width).toBe(allSessions.width)
    expect(button.x).toBe(sidebarBox.x + 12)
    expect(button.x + button.width).toBe(sidebarBox.x + sidebarBox.width - 12)
    expect(sources.y - button.y - button.height).toBeGreaterThanOrEqual(24)
    expect(allSessions.y).toBeGreaterThanOrEqual(sources.y + sources.height)
    const firstSource = (await sidebar.getByRole('button', { name: /^NewMax/ }).boundingBox())!
    expect(firstSource.y - allSessions.y - allSessions.height).toBe(1)
    const labels = await sidebar.locator('.sidebar-section > *').evaluateAll(elements => elements.slice(0, 4).map(element => element.textContent))
    expect(labels).toEqual(['导入会话', '会话来源', `所有会话${demoSessions.length}`, 'NewMax1'])
    await sidebar.getByRole('button', { name: /^Codex/ }).click()
    await importButton.focus()
    await page.keyboard.press('Enter')
    await expect(importButton).toBeEnabled()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(importButton).toBeFocused()
    await expect(sidebar.getByRole('button', { name: /^Codex/ })).toHaveAttribute('aria-pressed', 'true')
    await sidebar.getByRole('button', { name: /所有会话/ }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
})

test('长标题与长会话不会挤占阅读空间，首尾内边距完整且切换后回到顶部', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  const file = join(directory, 'long-reading.staithe.json')
  const imported = { ...demoSessions[0], title: '用于检查窄窗口阅读排版的长标题'.repeat(5),
    messages: Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `合成消息 ${index + 1}：用于检查滚动阅读的上下间距。`.repeat(4) })) }
  await writeFile(file, JSON.stringify(makeBundle(imported)))
  await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }) }, file)
  await page.getByRole('button', { name: '导入会话文件' }).click()
  await page.getByRole('button', { name: '确认保存到本地' }).click()
  const heading = page.getByRole('heading', { level: 2, name: imported.title })
  await expect(heading).toBeVisible()
  expect((await heading.boundingBox())!.height).toBeLessThanOrEqual(48)
  expect((await page.locator('.detail-header').boundingBox())!.height).toBeLessThanOrEqual(128)
  const messages = page.getByRole('region', { name: '会话消息' })
  await expect(messages).toHaveCSS('padding-top', '24px')
  await expect(messages).toHaveCSS('padding-bottom', '24px')
  await expect(messages.getByRole('article').first()).toBeInViewport()
  await messages.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(page.locator('.conversation-end')).toBeInViewport()
  const viewport = (await messages.boundingBox())!, end = (await page.locator('.conversation-end').boundingBox())!
  expect(viewport.y + viewport.height - end.y - end.height).toBeCloseTo(24, 0)
  await page.getByRole('button', { name: new RegExp(demoSessions[1].title) }).click()
  await page.getByRole('button', { name: imported.title }).click()
  expect(await messages.evaluate(element => element.scrollTop)).toBe(0)
  expect(await messages.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
})

test('桌面启动、全文搜索、来源筛选与视觉检查', async () => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await expect(page.locator('.brand-logo svg, .brand-logo img, .brand-mark, .source-dot, .sidebar-version')).toHaveCount(0)
  await expect(page.locator('.sidebar .brand .lucide-search')).toHaveCount(1)
  await expect(page.locator('.sidebar-toggle .design-icon:not(.lucide)')).toHaveCount(1)
  await expect(page.locator('.design-icon:not(.lucide):not(.sidebar-toggle .design-icon)')).toHaveCount(0)
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await assertShellSurface(244)
  await expect(page.locator('.detail')).toHaveCSS('background-color', 'rgb(250, 250, 250)')
  await expect(page.getByRole('button', { name: '导入会话文件' })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.getByRole('button', { name: 'Pin 走这段对话' })).toHaveCSS('background-color', 'rgb(23, 23, 23)')
  await expect(page.getByRole('button', { name: 'Pin 走这段对话' })).toHaveCSS('color', 'rgb(255, 255, 255)')
  const clientIcons = page.getByRole('complementary').locator('.source-icon img')
  await expect(clientIcons).toHaveCount(5)
  await expect.poll(() => clientIcons.evaluateAll(images => images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true)
  const userBubble = page.locator('.message-bubble').first()
  const assistant = page.locator('.chat-assistant-content').first()
  const cornerScale = await page.evaluate(() => CSS.supports('corner-shape', 'superellipse(1.5)') ? 1.348 : 1)
  expect(await userBubble.evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeCloseTo(18 * cornerScale, 3)
  await expect(userBubble).toHaveCSS('padding', '8px 16px')
  await expect(userBubble).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(assistant).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  const userBox = (await userBubble.boundingBox())!, assistantBox = (await assistant.boundingBox())!
  expect(userBox.x).toBeGreaterThan(assistantBox.x)
  expect(userBox.x + userBox.width).toBeCloseTo(assistantBox.x + assistantBox.width, 0)
  expect(userBox.width).toBeLessThanOrEqual(assistantBox.width * 0.85 + 1)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索会话' }).fill('安全边界')
  const searchDialog = page.getByRole('dialog', { name: '搜索会话' })
  await expect(searchDialog.getByRole('button', { name: /^打开档案：/ })).toHaveCount(1)
  await searchDialog.getByRole('button', { name: '打开档案：迁移前，先画清安全边界' }).click()
  await expect(searchDialog).toBeHidden()
  await expect(page.getByRole('heading', { level: 2, name: '迁移前，先画清安全边界' })).toBeVisible()
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索会话' }).fill('完全不存在')
  await expect(searchDialog.getByText('没有匹配的档案')).toBeVisible()
  await page.getByRole('textbox', { name: '搜索会话' }).fill('')
  await page.keyboard.press('Escape')
  await page.getByRole('complementary').getByRole('button', { name: /Claude Code/ }).click()
  await expect(page.getByRole('heading', { level: 2, name: '一份不丢失来源的适配器契约' })).toBeVisible()
  await page.getByRole('button', { name: /所有会话/ }).click()
  await page.getByRole('button', { name: /让思考跨越工具/ }).click()
  await page.screenshot({ scale: 'css', path: 'test-results/staithe-desktop.png' })
  expect(errors).toEqual([])
  expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined')
})

for (const format of ['staithe.session', 'ember.session']) {
  test(`${format} 文件导入、持久化及无效输入保护`, async () => {
    const file = join(directory, format === 'ember.session' ? 'import.ember.json' : 'import.staithe.json')
    const imported = { ...demoSessions[0], title: '从文件接续的思考', messages: [{ role: 'user' as const, content: '<script>alert("不执行")</script>' }] }
    await writeFile(file, JSON.stringify({ ...makeBundle(imported), format }))
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
    }, file)
    await page.getByRole('button', { name: '导入会话文件' }).click()
    await expect(page.getByRole('dialog', { name: '确认导入档案' })).toBeVisible()
    await expect(page.locator('.dialog-header h2')).toHaveText('确认导入档案')
    await expect(page.locator('.dialog-header .dialog-icon')).toHaveCount(0)
    await expect(page.locator('.dialog-header svg')).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 2, name: imported.title })).not.toBeVisible()
    await page.getByRole('button', { name: '确认保存到本地' }).click()
    await expect(page.getByRole('heading', { level: 2, name: imported.title })).toBeVisible()
    await expect(page.locator('.message-body p')).toHaveText(imported.messages[0].content)
    const folders = await readdir(join(directory, 'imports'))
    expect(folders).toHaveLength(1)
    const stored = JSON.parse(await readFile(join(directory, 'imports', folders[0], 'record.json'), 'utf8'))
    expect(stored.session.demo).toBe(false)
    await writeFile(file, '{"invalid":true}')
    await page.getByRole('button', { name: '导入会话文件' }).click()
    await expect(page.getByRole('status')).toBeVisible()
    expect(await readdir(join(directory, 'imports'))).toEqual(folders)
    await app.close()
    await launch(format === 'ember.session')
    await selectArchive(imported.title)
    await expect(page.locator('.message-body p')).toHaveText(imported.messages[0].content)
  })
}

test('Cindy 文件预览、取消、快照确认、去重与文本交接', async () => {
  const file = join(directory, 'synthetic.cshare')
  const bytes = cindyFixture()
  await writeFile(file, bytes)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
  }, file)
  await page.getByRole('button', { name: '导入会话文件' }).click()
  await expect(page.getByRole('dialog')).toContainText('Cindy · 2 条消息')
  await page.screenshot({ scale: 'css', path: 'test-results/staithe-import.png' })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '导入会话文件' })).toBeFocused()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  expect(await readdir(directory)).not.toContain('imports')
  await page.getByRole('button', { name: '导入会话文件' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await writeFile(file, '选择后被修改的文件不能替代预览快照')
  await page.getByRole('button', { name: '确认保存到本地' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Cindy 合成档案' })).toBeVisible()
  await expect(page.locator('.message-body p').first()).toHaveText('<script>不执行</script> 合成的 Cindy 会话')
  const folders = await readdir(join(directory, 'imports'))
  expect(folders).toHaveLength(1)
  expect(await readFile(join(directory, 'imports', folders[0], 'original.bin'))).toEqual(bytes)
  await writeFile(file, bytes)
  await page.getByRole('button', { name: '导入会话文件' }).click()
  await expect(page.getByRole('dialog')).toContainText('这个文件已导入')
  await page.getByRole('button', { name: '打开已有档案' }).click()
  await expect(page.getByRole('status')).toContainText('未创建副本')
  await page.getByRole('complementary').getByRole('button', { name: /^Cindy/ }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Cindy 合成档案' })).toBeVisible()
  await page.getByText('导入报告 · 仅文本档案').click()
  await expect(page.locator('.archive-report')).toContainText('db-only')
  await page.getByRole('button', { name: 'Pin 走这段对话' }).click()
  await expect(page.locator('.handoff-preview')).toContainText('原始文件不随交接导出')
  await page.keyboard.press('Escape')
  const badToken = await page.evaluate(async () => {
    try { await window.staithe.confirmImport('../outside'); return false } catch { return true }
  })
  expect(badToken).toBe(true)
  await app.close(); await launch()
  await selectArchive('Cindy 合成档案')
  await expect(page.locator('.message-body p').first()).toHaveText('<script>不执行</script> 合成的 Cindy 会话')
})

test('Codex JSONL 只读导入不重复事件副本，可导出带损失报告的 v2 包', async () => {
  const file = join(directory, 'synthetic-rollout.jsonl'), output = join(directory, 'codex.staithe.json')
  await writeFile(file, codexFixture())
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async (...args: [Electron.BaseWindow, Electron.OpenDialogOptions] | [Electron.OpenDialogOptions]) => {
      const options = args.length === 2 ? args[1] : args[0]
      if (!options.filters?.some(filter => filter.extensions.includes('jsonl'))) throw new Error('选择框缺少 JSONL 类型')
      return { canceled: false, filePaths: [paths.file] }
    }
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.output })
  }, { file, output })
  await page.getByRole('button', { name: '导入会话文件' }).click()
  await expect(page.getByRole('dialog')).toContainText('Codex JSONL · 2 条消息')
  await expect(page.getByRole('dialog')).toContainText('工具')
  expect(await readdir(directory)).not.toContain('imports')
  await page.getByRole('button', { name: '确认保存到本地' }).click()
  await expect(page.getByRole('heading', { level: 2, name: `Codex · ${codexThreadId.slice(0, 8)}` })).toBeVisible()
  await expect(page.locator('.message-body p')).toHaveCount(2)
  await expect(page.locator('.message-body p').first()).toHaveText('<script>不执行</script> 合成 Codex 问题')
  await page.getByRole('complementary').getByRole('button', { name: /^Codex/ }).click()
  await page.getByText('导入报告 · 仅文本档案').click()
  await expect(page.locator('.archive-report')).toContainText('事件记录')
  await page.getByRole('button', { name: 'Pin 走这段对话' }).click()
  await expect(page.locator('.handoff-preview')).toContainText('工具')
  await page.getByRole('button', { name: '导出 Pinekin 包', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('已导出到你选择的位置')
  const exported = JSON.parse(await readFile(output, 'utf8'))
  expect(exported.version).toBe(2)
  expect(exported.session.archive.originalSessionId).toBe(codexThreadId)
  expect(exported.session.messages).toHaveLength(2)
  await page.keyboard.press('Escape')
  await app.close(); await launch()
  await selectArchive(`Codex · ${codexThreadId.slice(0, 8)}`)
  await expect(page.locator('.message-body p')).toHaveCount(2)
  await expect(page.locator('.message-body p').first()).toHaveText('<script>不执行</script> 合成 Codex 问题')
})

test('Codex 压缩分页根日志经 Electron 有界解码与确认，原件不被展开替换', async () => {
  const file = join(directory, 'synthetic-rollout.jsonl.zst')
  const bytes = zstdCompressSync(codexPaginatedFixture())
  await writeFile(file, bytes)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async (...args: [Electron.BaseWindow, Electron.OpenDialogOptions] | [Electron.OpenDialogOptions]) => {
      const options = args.length === 2 ? args[1] : args[0]
      if (!options.filters?.some(filter => filter.extensions.includes('zst'))) throw new Error('选择框缺少 Zstandard 类型')
      return { canceled: false, filePaths: [filePath] }
    }
  }, file)
  await page.getByRole('button', { name: '导入会话文件' }).click()
  await expect(page.getByRole('dialog')).toContainText('Zstandard · 2 条消息')
  await expect(page.getByRole('dialog')).toContainText('分页')
  await page.getByRole('button', { name: '确认保存到本地' }).click()
  await expect(page.getByRole('heading', { level: 2, name: `Codex · ${codexThreadId.slice(0, 8)}` })).toBeVisible()
  const folders = await readdir(join(directory, 'imports'))
  expect(folders).toHaveLength(1)
  expect((await readFile(join(directory, 'imports', folders[0], 'original.bin'))).equals(bytes)).toBe(true)
})

for (const fixture of [
  { name: 'DeepSeek Harness', filename: 'session.v4.jsonl.zstd', title: 'DeepSeek 合成会话', bytes: () => zstdCompressSync(deepseekFixture()), adapter: 'deepseek-harness-v4' },
  { name: 'Cindy 本地快照', filename: 'cindy.local.json', title: 'Cindy 本地合成会话', bytes: cindyLocalFixture, adapter: 'cindy-local-snapshot' },
  { name: 'NewMax 本地快照', filename: 'newmax.local.json', title: 'NewMax 合成会话', bytes: newmaxFixture, adapter: 'newmax-local-snapshot' },
  { name: 'Claude Code JSONL', filename: 'claude.jsonl', title: 'Claude Code · 合成问题：整理项目计划', bytes: claudeFixture, adapter: 'claude-code-jsonl' },
]) test(`${fixture.name} 合成文件经桌面预览、保存、去重与重启读取`, async () => {
  const file = join(directory, fixture.filename), bytes = fixture.bytes()
  await writeFile(file, bytes)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async (...args: [Electron.BaseWindow, Electron.OpenDialogOptions] | [Electron.OpenDialogOptions]) => {
      const options = args.length === 2 ? args[1] : args[0]
      if (!options.filters?.some(filter => filter.extensions.includes('zstd'))) throw new Error('选择框缺少 DeepSeek Zstandard 扩展名')
      return { canceled: false, filePaths: [filePath] }
    }
  }, file)
  await page.getByRole('button', { name: '导入会话文件' }).click()
  await expect(page.getByRole('dialog')).toContainText('2 条消息')
  expect(await readdir(directory)).not.toContain('imports')
  await page.getByRole('button', { name: '确认保存到本地' }).click()
  await expect(page.getByRole('heading', { level: 2, name: fixture.title })).toBeVisible()
  await expect(page.locator('.message')).toHaveCount(2)
  const folders = await readdir(join(directory, 'imports'))
  expect(folders).toHaveLength(1)
  expect(await readFile(join(directory, 'imports', folders[0], 'original.bin'))).toEqual(bytes)
  const record = JSON.parse(await readFile(join(directory, 'imports', folders[0], 'record.json'), 'utf8'))
  expect(record.session.archive.adapterId).toBe(fixture.adapter)
  await page.getByRole('button', { name: '导入会话文件' }).click()
  await expect(page.getByRole('dialog')).toContainText('这个文件已导入')
  await page.getByRole('button', { name: '打开已有档案' }).click()
  await app.close(); await launch()
  await selectArchive(fixture.title)
  await expect(page.locator('.message')).toHaveCount(2)
})

test('本地批次新增档案后，后台模拟窗口 focus 回读计数且保留当前会话', async () => {
  const sidebar = page.getByRole('complementary')
  await expect(page.getByRole('button', { name: '搜索', exact: true })).toBeEnabled()
  await sidebar.getByRole('button', { name: /^Codex/ }).click()
  const selected = demoSessions.find(session => session.source === 'codex')!
  await expect(page.getByRole('heading', { level: 2, name: selected.title })).toBeVisible()
  await writeFile(join(directory, 'library.json'), JSON.stringify([...demoSessions, { ...selected, id: 'batch-new', title: '批次合成新档案' }]))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(sidebar.getByRole('button', { name: /^Codex\s*2$/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('heading', { level: 2, name: selected.title })).toBeVisible()
  await expect(page.getByRole('button', { name: /批次合成新档案/ })).toBeVisible()
})

test('取消文件选择与加密包拒绝不写入档案', async () => {
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })
  await page.getByRole('button', { name: '导入会话文件' }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  const file = join(directory, 'encrypted.cshare'), bytes = cindyFixture()
  bytes[9] = 1; await writeFile(file, bytes)
  await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }) }, file)
  await page.getByRole('button', { name: '导入会话文件' }).click()
  await expect(page.getByRole('status')).toContainText('暂不支持加密')
  expect(await readdir(directory)).not.toContain('imports')
})

test('紧凑工作台的键盘导航、焦点返回、主题与窄窗口布局', async () => {
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('textbox', { name: '搜索会话' })).toBeFocused()
  await page.keyboard.press('Escape')
  await page.getByRole('complementary', { name: '档案导航' }).getByRole('button', { name: /^Cindy/ }).click()
  await expect(page.locator('.session-list .empty-description')).toHaveText('此来源暂无档案')
  await expect(page.getByText('还没有会话档案', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '清空筛选' }).click()
  await page.getByRole('button', { name: 'Pin 走这段对话' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: '复制交接文本' }).focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: '关闭交接面板' })).toBeFocused()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('textbox', { name: '搜索会话' })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: '搜索会话' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Pin 走这段对话' })).toBeFocused()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700))
  await expect(page.getByRole('button', { name: 'Pin 走这段对话' })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.emulateMedia({ colorScheme: 'dark' })
  await assertShellSurface(38)
  await expect(page.locator('.workspace-card')).toHaveCSS('background-color', 'rgb(29, 29, 29)')
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.getByRole('button', { name: '导入会话文件' })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.getByRole('button', { name: 'Pin 走这段对话' })).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(page.getByRole('button', { name: 'Pin 走这段对话' })).toHaveCSS('color', 'rgb(23, 23, 23)')
  await expect(page.getByRole('complementary').locator('[data-source="newmax"] img')).toHaveCSS('filter', 'invert(1)')
  await expect(page.getByRole('complementary').locator('[data-source="codex"] img')).toHaveCSS('filter', 'invert(1)')
  const narrowMessages = await page.locator('.message-column').evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth }))
  expect(narrowMessages.scrollWidth).toBeLessThanOrEqual(narrowMessages.width)
  await page.screenshot({ scale: 'css', path: 'test-results/staithe-desktop-dark.png' })
  await page.emulateMedia({ colorScheme: 'light' })
  await assertShellSurface(244)
  await expect(page.locator('.workspace-card')).toHaveCSS('background-color', 'rgb(250, 250, 250)')
})

test('交接包与 Markdown 真实导出，复制不改动系统剪贴板', async () => {
  const output = join(directory, 'handoff.json')
  await app.evaluate(({ dialog, clipboard }, filePath) => {
    dialog.showSaveDialog = async (...args: [Electron.BaseWindow, Electron.SaveDialogOptions] | [Electron.SaveDialogOptions]) => {
      const options = args.length === 2 ? args[1] : args[0]
      ;(globalThis as unknown as { testDefaultPath: string }).testDefaultPath = options.defaultPath ?? ''
      return { canceled: false, filePath }
    }
    clipboard.writeText = async text => { (globalThis as unknown as { testClipboard: string }).testClipboard = text }
  }, output)
  await page.getByRole('button', { name: 'Pin 走这段对话' }).click()
  await page.getByLabel('接续目标').selectOption('NewMax')
  await page.getByRole('button', { name: '导出 Pinekin 包', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('已导出到你选择的位置')
  expect(JSON.parse(await readFile(output, 'utf8')).format).toBe('staithe.session')
  expect(await app.evaluate(() => (globalThis as unknown as { testDefaultPath: string }).testDefaultPath)).toBe(`pinekin-${demoSessions[0].id}.staithe.json`)
  await page.getByRole('button', { name: '导出 Markdown' }).click()
  await expect(page.getByRole('status')).toHaveText('已导出到你选择的位置')
  const markdown = await readFile(output, 'utf8')
  expect(markdown).toContain('目标：NewMax')
  expect(markdown).toContain('# Pinekin 上下文交接')
  await page.getByRole('button', { name: '复制交接文本' }).click()
  await expect(page.getByRole('status')).toContainText('已复制交接文本')
  expect(await app.evaluate(() => (globalThis as unknown as { testClipboard: string }).testClipboard)).toContain('不是原生会话恢复')
  await page.screenshot({ scale: 'css', path: 'test-results/staithe-handoff.png' })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).not.toBeVisible()
})

test('更名后沿用旧默认档案目录，不重写会话和 ID', async () => {
  await app.close()
  const legacyDirectory = join(directory, '@newmax-ai/ember')
  await mkdir(legacyDirectory, { recursive: true })
  const previous = { ...demoSessions[0], id: 'before-rename', title: 'Ember 中保存的真实格式夹具', demo: false }
  const original = JSON.stringify([previous])
  await writeFile(join(legacyDirectory, 'library.json'), original)
  // 先重定向 appData，再加载主进程；复用隐藏启动与原生事件监控，不读取真实目录。
  await launch(false, undefined, true)
  await expect(page.getByRole('heading', { level: 2, name: previous.title })).toBeVisible()
  expect(await app.evaluate(({ app }) => app.getName())).toBe('Pinekin')
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(legacyDirectory)
  expect(await readFile(join(legacyDirectory, 'library.json'), 'utf8')).toBe(original)
})

for (const scheme of ['newmax-staithe', 'newmax-ember']) {
  test(`${scheme} 深链支持冷启动、应用事件与第二实例定位`, async () => {
    await app.close()
    await launch(false, `${scheme}://session/demo-migration`)
    await expect(page.getByRole('heading', { level: 2, name: '迁移前，先画清安全边界' })).toBeVisible()
    await app.evaluate(({ app }, link) => app.emit('open-url', { preventDefault() {} }, link), `${scheme}://session/demo-ember`)
    await expect(page.getByRole('heading', { level: 2, name: '让思考跨越工具，继续生长' })).toBeVisible()
    await app.evaluate(({ app }, link) => app.emit('second-instance', {}, ['staithe', link]), `${scheme}://session/demo-adapter`)
    await expect(page.getByRole('heading', { level: 2, name: '一份不丢失来源的适配器契约' })).toBeVisible()
    await app.evaluate(({ app }, link) => app.emit('open-url', { preventDefault() {} }, link), `${scheme}://session/unknown`)
    await expect(page.getByRole('status')).toContainText('本机没有这段会话')
  })
}
