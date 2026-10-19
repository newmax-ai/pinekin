import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, appendFile, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { claudeFixture, claudeRecords } from '../fixtures/claude-code'
import { DatabaseSync } from 'node:sqlite'
import { createCindySchema } from '../fixtures/cindy-database'

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
  await page.getByRole('switch', { name: '连接 Claude Code', exact: true }).click()
  await page.getByRole('button', { name: '完成', exact: true }).click()
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

test('标题下方显示加载描述，刷新图标在请求期间旋转且遵守减少动态效果设置', async () => {
  const heading = page.locator('.list-heading')
  const button = page.getByRole('button', { name: '刷新当前来源', exact: true })
  const icon = button.locator('svg')
  const turn = button.locator('.ds-refresh-turn')
  const progress = button.locator('.ds-refresh-progress')
  for (const width of [1000, 1380]) {
    await app.evaluate(({ BrowserWindow }, width) => { BrowserWindow.getAllWindows()[0].setSize(width, 900) }, width)
    const title = (await heading.locator('h2').boundingBox())!
    const count = (await heading.getByRole('status').boundingBox())!
    const control = (await button.boundingBox())!
    expect(count.y - title.y - title.height).toBeCloseTo(2)
    expect(count.x).toBe(title.x)
    expect(control.x).toBeGreaterThan(title.x + title.width)
    expect(control.width).toBe(28)
    expect(control.height).toBe(28)
    expect(await heading.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  }
  await expect(button).toHaveText('')
  await expect(button).toHaveAttribute('aria-busy', 'false')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(icon).toHaveCSS('transition-duration', '0.35s')
  await expect(icon).toHaveCSS('transition-timing-function', 'cubic-bezier(0.33, 1, 0.68, 1)')
  const idleBackground = await button.evaluate(element => getComputedStyle(element).backgroundColor)
  // 隐藏窗口内合成鼠标事件，只改变隔离页面的 hover，不触发系统 show / focus。
  await button.hover()
  await expect.poll(() => button.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(idleBackground)
  await expect.poll(() => icon.evaluate(element => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform)
    return Math.round(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI)
  })).toBe(-35)
  await expect(page.getByRole('tooltip')).toHaveText('刷新当前来源')
  const snapshot = await page.evaluate(() => window.staithe.sources.page({ offset: 0, limit: 50 }))
  await app.evaluate(({ ipcMain }, snapshot) => {
    ipcMain.removeHandler('pinekin:sources-check')
    ipcMain.handle('pinekin:sources-check', () => new Promise(resolve => {
      Object.assign(globalThis, { finishRefreshButtonTest: () => resolve({ version: snapshot.version, connections: snapshot.connections }) })
    }))
  }, snapshot)
  await button.click()
  await expect(button).toBeDisabled()
  await expect(button).toHaveAttribute('aria-busy', 'true')
  await expect(turn).toHaveCSS('animation-name', 'ds-refresh-turn')
  await expect(turn).toHaveCSS('animation-duration', '0.7s')
  await expect(turn).toHaveCSS('animation-timing-function', 'cubic-bezier(0.68, -0.55, 0.265, 1.55)')
  await expect(progress).toHaveCSS('animation-name', 'source-refresh-spin')
  await expect(progress).toHaveCSS('animation-delay', '0.7s')
  await expect(progress).toHaveCSS('animation-iteration-count', 'infinite')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(turn).toHaveCSS('animation-name', 'none')
  await expect(progress).toHaveCSS('animation-name', 'none')
  await expect(icon).toHaveCSS('transition-property', 'none')
  await expect(button).toHaveAttribute('aria-busy', 'true')
  await app.evaluate(() => { (globalThis as unknown as { finishRefreshButtonTest: () => void }).finishRefreshButtonTest() })
  await expect(button).toBeEnabled()
  await expect(button).toHaveAttribute('aria-busy', 'false')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(progress).toHaveCSS('animation-name', 'none')
  await page.mouse.move(950, 600)
  await expect.poll(() => icon.evaluate(element => getComputedStyle(element).transform)).toBe('none')
})

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
  await expect(page.getByText('此对话有更新', { exact: true })).toHaveCount(0)
  await expect(messages).toContainText('刷新后新增的合成消息')
  await expect(page.locator('.session-card')).toHaveCount(65)
  expect(await page.evaluate(() => ({ list: document.querySelector('.session-list')!.scrollTop, messages: document.querySelector('.messages')!.scrollTop }))).toEqual({ list: 360, messages: 180 })
  await expect(page.locator('.detail-footer')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '重新读取正文', exact: true })).toHaveCount(0)
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
  await expect(page.getByRole('button', { name: '重试读取', exact: true })).toHaveCount(0)
})

test('后台检查仍只提示正文更新，主动查看才加载且不改变阅读位置', async () => {
  await page.getByRole('button', { name: '刷新验收会话 .', exact: true }).click()
  const messages = page.getByRole('region', { name: '会话消息' })
  await expect(messages).toBeVisible()
  await messages.evaluate(element => { element.scrollTop = 180 })
  await appendFile(selectedPath, JSON.stringify({ ...claudeRecords()[1], uuid: 'u2', parentUuid: 'a2', message: { role: 'user', content: '后台发现的合成新消息' } }) + '\n')
  await page.clock.install()
  // 推进隔离主进程时钟以越过首次扫描后的 15 秒冷却，不等待真实时间。
  await app.evaluate(() => { const now = Date.now; Date.now = () => now() + 60_000 })
  // 仅合成隔离页面的可见性和 focus 事件，不显示或聚焦测试窗口。
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    window.dispatchEvent(new Event('focus'))
  })
  await page.clock.fastForward(1000)
  await expect(page.getByText('此对话有更新', { exact: true })).toBeVisible()
  await expect(messages).not.toContainText('后台发现的合成新消息')
  expect(await messages.evaluate(element => element.scrollTop)).toBe(180)
  await page.getByRole('button', { name: '查看更新', exact: true }).click()
  await expect(messages).toContainText('后台发现的合成新消息')
  expect(await messages.evaluate(element => element.scrollTop)).toBe(180)
  await expect(page.getByText('此对话有更新', { exact: true })).toHaveCount(0)
})

test('微型流动点替代列表文字，保持紧凑布局并支持静态降级', async () => {
  const snapshot = await page.evaluate(() => window.staithe.sources.page({ offset: 0, limit: 50 }))
  await app.evaluate(({ ipcMain }, snapshot) => {
    let done = false
    const waiting: (() => void)[] = []
    ipcMain.removeHandler('pinekin:sources-page')
    ipcMain.handle('pinekin:sources-page', async () => {
      if (!done) await new Promise<void>(resolve => waiting.push(resolve))
      return snapshot
    })
    Object.assign(globalThis, { finishLoadingMarkTest: () => { done = true; waiting.splice(0).forEach(resolve => resolve()) } })
  }, snapshot)
  await page.reload()
  const mark = page.locator('.list-heading .loading-mark')
  await expect(mark).toBeVisible()
  await expect(mark).toHaveAccessibleName('正在读取')
  await expect(page.locator('.list-heading [role="status"]')).toHaveText('')
  await expect(mark.locator('i')).toHaveCount(3)
  await expect(page.locator('.session-list .empty-state .loading-mark')).toBeVisible()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1000, 1380]) {
      await app.evaluate(({ BrowserWindow }, width) => { BrowserWindow.getAllWindows()[0].setSize(width, 900) }, width)
      await expect(mark.locator('i').first()).toHaveCSS('animation-name', 'loading-dot-flow')
      await expect(mark.locator('i').first()).toHaveCSS('animation-duration', '1.2s')
      await expect(mark.locator('i').first()).toHaveCSS('animation-timing-function', 'cubic-bezier(0.37, 0, 0.63, 1)')
      for (const [index, delay] of ['-0.18s', '-1.2s', '-1.02s'].entries()) {
        await expect(mark.locator('i').nth(index)).toHaveCSS('animation-delay', delay)
        await expect(mark.locator('i').nth(index)).toHaveCSS('animation-fill-mode', 'both')
      }
      const wave = await mark.locator('i').evaluateAll(dots => {
        const animations = dots.map(dot => dot.getAnimations()[0])
        animations.forEach(animation => animation.pause())
        const keyframes = (animations[0].effect as KeyframeEffect).getKeyframes()
        const frames = Array.from({ length: 41 }, (_, index) => index * 30).map(time => {
          animations.forEach(animation => { animation.currentTime = time })
          return dots.map(dot => ({ width: dot.getBoundingClientRect().width, opacity: Number(getComputedStyle(dot).opacity) }))
        })
        animations.forEach(animation => animation.play())
        return { offsets: keyframes.map(frame => frame.offset), frames }
      })
      expect(wave.offsets).toEqual([0, 0.15, 0.4, 0.85, 1])
      for (let dot = 0; dot < 3; dot++) {
        expect(Math.min(...wave.frames.map(frame => frame[dot].width))).toBeCloseTo(1.5, 3)
      }
      for (const [index, time] of [0, 180, 360].entries()) {
        const dots = wave.frames[time / 30]
        expect(dots[index].width).toBeCloseTo(3.45, 2)
        expect(dots[index].opacity).toBeCloseTo(1, 3)
        for (const [other, dot] of dots.entries()) {
          if (other !== index) {
            expect(dots[index].width - dot.width).toBeGreaterThan(0.5)
            expect(dots[index].opacity - dot.opacity).toBeGreaterThan(0.3)
          }
        }
      }
      for (const [index, dots] of wave.frames.entries()) {
        // 允许尾部渐退，但整组不可静止；相邻帧及循环边界均需连续。
        if (index) {
          const changes = dots.map((dot, item) => Math.abs(dot.width - wave.frames[index - 1][item].width))
          expect(Math.max(...changes) / (3.45 - 1.5)).toBeLessThan(0.29)
          expect(changes.reduce((sum, change) => sum + change, 0)).toBeGreaterThan(0.0001)
        }
      }
      for (let dot = 0; dot < 3; dot++) {
        expect(wave.frames[0][dot].width).toBeCloseTo(wave.frames[40][dot].width, 3)
        expect(wave.frames[0][dot].opacity).toBeCloseTo(wave.frames[40][dot].opacity, 3)
      }
      const size = (await mark.boundingBox())!
      expect(size.width).toBe(18)
      expect(size.height).toBe(12)
      await expect(mark.locator('i').first()).toHaveCSS('width', '3px')
      await expect(mark.locator('i').first()).toHaveCSS('height', '3px')
      const samples = await mark.locator('i').evaluateAll(dots => dots.flatMap(dot => {
        const animation = dot.getAnimations()[0]
        animation.pause()
        const style = getComputedStyle(dot)
        const parent = dot.parentElement!.getBoundingClientRect()
        const centerX = parent.x + parseFloat(style.left) + parseFloat(style.width) / 2
        const centerY = parent.y + parseFloat(style.top) + parseFloat(style.height) / 2
        const sizes = [0, 75, 150, 200, 350, 400, 550, 790, 1499].map(time => {
          animation.currentTime = time
          const { x, y, width, height } = dot.getBoundingClientRect()
          return { width, height, radius: style.borderRadius, deltaX: x + width / 2 - centerX, deltaY: y + height / 2 - centerY }
        })
        animation.play()
        return sizes
      }))
      for (const sample of samples) {
        expect(sample.width).toBeCloseTo(sample.height, 3)
        expect(sample.width).toBeLessThanOrEqual(3.451)
        expect(sample.deltaX).toBeCloseTo(0, 3)
        expect(sample.deltaY).toBeCloseTo(0, 3)
        expect(sample.radius).toBe('50%')
      }
      expect(await page.locator('.list-heading').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(mark.locator('i').first()).toHaveCSS('animation-name', 'none')
  await expect(mark).toBeVisible()
  await app.evaluate(() => { (globalThis as unknown as { finishLoadingMarkTest: () => void }).finishLoadingMarkTest() })
  await expect(mark).toHaveCount(0)
  await expect(page.locator('.session-card')).toHaveCount(50)
})

test('扫描在侧栏右侧数量位置显示微型流动点，不影响其他来源或行高', async () => {
  const snapshot = await page.evaluate(() => window.staithe.sources.page({ offset: 0, limit: 50 }))
  await app.evaluate(({ ipcMain }, snapshot) => {
    let scanning = true
    ipcMain.removeHandler('pinekin:sources-page')
    ipcMain.handle('pinekin:sources-page', () => ({ ...snapshot, connections: [
      ...snapshot.connections.map(connection => scanning ? { ...connection, status: 'scanning', total: null } : connection),
      { ...snapshot.connections[0], id: 'cindy-synthetic', source: 'cindy', status: 'ready', total: 3, discovered: 3 },
    ] }))
    Object.assign(globalThis, { finishSidebarLoadingTest: () => { scanning = false } })
  }, snapshot)
  await page.reload()
  const source = page.locator('.sidebar-section .nav-item').filter({ hasText: 'Claude Code' })
  const other = page.locator('.sidebar-section .nav-item').filter({ hasText: 'Cindy' })
  const count = source.locator('.count')
  const mark = count.locator('.loading-mark')
  await expect(mark).toBeVisible()
  await expect(count).toHaveText('')
  await expect(other.locator('.count')).toHaveText('3')
  await expect(other.locator('.loading-mark')).toHaveCount(0)
  const rowHeight = (await source.boundingBox())!.height
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    const rect = (await mark.boundingBox())!
    expect(rect.width).toBe(18)
    expect(rect.height).toBe(12)
    expect(rect.x).toBeGreaterThan((await source.locator('span').first().boundingBox())!.x + (await source.locator('span').first().boundingBox())!.width)
    const colors = await count.evaluate(element => ({ count: getComputedStyle(element).color, mark: getComputedStyle(element.firstElementChild!).color }))
    expect(colors.mark).toBe(colors.count)
    await expect(mark.locator('i').first()).toHaveCSS('animation-name', 'loading-dot-flow')
    expect((await source.boundingBox())!.height).toBe(rowHeight)
    if (theme === 'dark') {
      const sidebar = (await page.locator('.sidebar-section').boundingBox())!
      const label = (await page.locator('.sources-label').boundingBox())!
      const lastRow = (await other.boundingBox())!
      await page.screenshot({ path: resolve('outputs/loading-sidebar-dark.png'), scale: 'css', clip: {
        x: sidebar.x, y: label.y - 12, width: sidebar.width, height: lastRow.y + lastRow.height - label.y + 24,
      } })
    }
  }
  await app.evaluate(() => { (globalThis as unknown as { finishSidebarLoadingTest: () => void }).finishSidebarLoadingTest() })
  await expect(mark).toHaveCount(0)
  await expect(count).toHaveText('65')
  expect((await source.boundingBox())!.height).toBe(rowHeight)
})

test('Cindy 旧会话不受其他 App 更新影响，真正变化才提示且保留滚动和正文', async () => {
  const directory = join(root, 'appData', 'Cindy'); await mkdir(directory, { recursive: true })
  const db = new DatabaseSync(join(directory, 'cindy-synthetic.db'))
  try {
    createCindySchema(db)
    const insert = db.prepare('INSERT INTO sessions(id,title,updated_at) VALUES(?,?,?)')
    for (let index = 0; index < 65; index++) insert.run(`old-${index}`, `旧 Cindy 会话 ${index}`, 1000 + index)
    db.exec("INSERT INTO messages(id,session_id,role,content,created_at) VALUES('u','old-64','user','合成旧问题',1050),('a','old-64','assistant','合成旧回答',1060)")
    await page.getByRole('button', { name: '连接 App', exact: true }).click()
    await page.getByRole('switch', { name: '连接 Cindy', exact: true }).click()
    await expect(page.getByRole('switch', { name: '连接 Cindy', exact: true })).toBeChecked()
    await page.getByRole('button', { name: '完成', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: '旧 Cindy 会话 64', exact: true }).click()
    const messages = page.getByRole('region', { name: '会话消息' })
    await expect(messages).toBeVisible()
    await page.locator('.session-list').evaluate(element => { element.scrollTop = 240 })
    const claude = await page.evaluate(async () => (await window.staithe.sources.connections()).find(item => item.source === 'claude-code')!)
    await writeFile(join(source, 'unrelated.jsonl'), claudeFixture([...claudeRecords(), { type: 'custom-title', customTitle: '其他 App 的新会话' }]))
    // 只推进隔离来源的目录，再由正常刷新入口核对全局版本；不唤起系统窗口。
    await page.evaluate(id => window.staithe.sources.check({ mode: 'manual', connectionIds: [id] }), claude.id)
    await refresh()
    await expect(page.getByRole('button', { name: '列表有更新，点击查看' })).toHaveCount(0)
    await expect(page.getByText('此对话有更新', { exact: true })).toHaveCount(0)
    expect(await page.locator('.session-list').evaluate(element => element.scrollTop)).toBe(240)
    await expect(messages).toBeVisible()
    await page.getByRole('button', { name: '加载更多', exact: true }).click()
    await expect(page.locator('.session-card')).toHaveCount(65)
    // 点击分页按钮会自然滚到按钮所在位置；重新设定本轮要验证的阅读位置。
    await page.locator('.session-list').evaluate(element => { element.scrollTop = 240 })
    db.exec("UPDATE sessions SET title='Cindy 真正有变化',updated_at=2000 WHERE id='old-64'")
    await refresh()
    await expect(page.getByRole('button', { name: '列表有更新，点击查看' })).toBeVisible()
    await expect(page.getByText('此对话有更新', { exact: true })).toHaveCount(0)
    expect(await page.locator('.session-list').evaluate(element => element.scrollTop)).toBe(240)
    await expect(page.getByRole('heading', { level: 2, name: 'Cindy 真正有变化', exact: true })).toBeVisible()
    await expect(page.getByText('此对话有更新', { exact: true })).toHaveCount(0)
  } finally { db.close() }
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
