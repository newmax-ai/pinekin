import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { claudeFixture } from '../fixtures/claude-code'

let app: ElectronApplication, page: Page, root: string, data: string, source: string
async function launch() {
  const bootstrap = join(root, 'start.cjs')
  await writeFile(bootstrap, `const { app, dialog, clipboard } = require('electron');
    app.setPath('home', ${JSON.stringify(root)}); app.setPath('appData', ${JSON.stringify(join(root, 'appData'))});
    globalThis.emptyWindowEvents = [];
    app.on('browser-window-created', (_event, window) => {
      window.on('show', () => globalThis.emptyWindowEvents.push('show'));
      window.on('focus', () => globalThis.emptyWindowEvents.push('focus'));
    });
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    clipboard.writeText = () => { throw new Error('空状态验收不应访问系统剪贴板'); };
    import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});`)
  const excluded = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'EMBER_DATA_DIR', 'STAITHE_DATA_DIR', 'STAITHE_TEST_BACKGROUND', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !excluded.includes(entry[0])))
  app = await electron.launch({ args: [bootstrap], env: { ...env, STAITHE_DATA_DIR: data, STAITHE_TEST_BACKGROUND: '1' } })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByRole('button', { name: '连接 App', exact: true })).toBeEnabled()
}
async function background() {
  const state = await app.evaluate(({ app, BrowserWindow }) => ({ active: process.platform === 'darwin' && app.isActive(),
    windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused() })),
    events: (globalThis as unknown as { emptyWindowEvents: string[] }).emptyWindowEvents }))
  expect(state.active).toBe(false); expect(state.events).toEqual([])
  expect(state.windows.every(window => !window.visible && !window.focused)).toBe(true)
}
async function connect() {
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  await page.getByRole('switch', { name: '连接 Claude Code', exact: true }).click()
  await expect(page.getByRole('switch', { name: '连接 Claude Code', exact: true })).toBeChecked()
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-empty-e2e-')))
  data = join(root, 'pinekin'); source = join(root, '.claude', 'projects')
  await mkdir(data); await mkdir(join(root, 'appData')); await mkdir(source, { recursive: true })
  await launch()
})
test.afterEach(async () => {
  try { if (app?.process().exitCode === null) await background() }
  finally { await app?.close(); await rm(root, { recursive: true, force: true }) }
})

test('未连接在浅深主题、窄窗口只显示一幅主插画，行动可达且没有溢出', async () => {
  const hero = page.locator('.detail > [data-empty-state="disconnected"]')
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    for (const width of [1000, 1380]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 680), width)
      await expect(hero).toBeVisible()
      await expect(page.locator('.workspace .empty-illustration')).toHaveCount(1)
      const image = hero.locator('img')
      await expect(image).toHaveAttribute('alt', '')
      await expect(image).toHaveAttribute('aria-hidden', 'true')
      await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true)
      expect(await hero.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const button = hero.getByRole('button', { name: '连接来源 App', exact: true })
      const bounds = (await button.boundingBox())!, height = await page.evaluate(() => innerHeight)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height)
    }
    await page.screenshot({ path: `test-results/pinekin-empty-state-${colorScheme}.png`, scale: 'css' })
  }
  await hero.getByRole('button', { name: '连接来源 App', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '连接来源 App' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(hero.getByRole('button', { name: '连接来源 App', exact: true })).toBeFocused()
})

test('空占位在浅深主题均为弱强调，文字可读且操作反馈完整', async () => {
  const hero = page.locator('.detail > [data-empty-state="disconnected"]')
  await expect(hero.getByRole('heading')).toHaveText('尚未连接会话来源')
  await expect(hero.locator('.empty-description')).toHaveText('支持 Claude Code、Codex 等来源。')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 740))
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.mouse.move(0, 0)
    await expect(hero).toBeVisible()
    await expect(hero).toHaveCSS('opacity', '1')
    await expect(hero.locator('img')).toHaveCSS('opacity', '0.5')
    await expect(hero.locator('img')).toHaveCSS('filter', 'saturate(0.4)')
    const text = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
      const context = canvas.getContext('2d')!
      function luminance(foreground: string, background: string) {
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = background; context.fillRect(0, 0, 1, 1)
        context.fillStyle = foreground; context.fillRect(0, 0, 1, 1)
        const channels = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map(channel => {
          const value = channel / 255
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
        })
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
      }
      function contrast(a: string, b: string) {
        const values = [luminance(a, b), luminance(b, b)].sort((a, b) => b - a)
        return (values[0] + 0.05) / (values[1] + 0.05)
      }
      const primary = getComputedStyle(document.documentElement).color
      const tertiary = getComputedStyle(document.documentElement).getPropertyValue('--ds-text-tertiary').trim()
      return Array.from(document.querySelectorAll('.empty-state h2, .empty-state h3, .empty-description')).map(element => {
        const style = getComputedStyle(element)
        let surface: Element | null = element
        while (surface && ['transparent', 'rgba(0, 0, 0, 0)'].includes(getComputedStyle(surface).backgroundColor)) surface = surface.parentElement
        const background = getComputedStyle(surface ?? document.documentElement).backgroundColor
        return { heading: element.matches('h2, h3'), weight: style.fontWeight, color: style.color, opacity: style.opacity,
          contrast: contrast(style.color, background), tertiaryContrast: contrast(tertiary, background), primaryContrast: contrast(primary, background) }
      })
    })
    expect(text.length).toBeGreaterThanOrEqual(3)
    for (const item of text) {
      expect(item.weight).toBe('400'); expect(item.opacity).toBe('1')
      expect(item.contrast).toBeGreaterThanOrEqual(2.5)
      expect(item.contrast).toBeCloseTo(item.tertiaryContrast, 5)
      expect(item.contrast).toBeLessThan(item.primaryContrast)
    }
    const action = hero.getByRole('button', { name: '连接来源 App', exact: true })
    await expect(action).toHaveClass(/ds-button-tertiary/)
    await expect(action).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await action.hover()
    await expect(action).toHaveCSS('opacity', '0.8')
    await page.mouse.move(0, 0)
    await page.keyboard.press('Tab'); await action.focus()
    expect(await action.evaluate(element => element.matches(':focus-visible'))).toBe(true)
    await expect(action).toBeFocused()
    await expect(action).toHaveCSS('outline-style', 'none')
    await action.evaluate(element => (element as HTMLButtonElement).blur())
    await expect(action).toHaveCSS('opacity', '1')
    await page.screenshot({ path: `test-results/pinekin-empty-centered-${colorScheme}.png`, scale: 'css' })
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    const compact = page.getByRole('dialog', { name: '搜索会话' }).locator('.empty-state')
    await expect(compact.locator('h3')).toHaveCSS('font-weight', '400')
    await compact.locator('h3').evaluate(element => {
      const description = document.createElement('p'); description.className = 'empty-description'
      description.textContent = '合成补充说明'; element.after(description)
    })
    const copyGap = await compact.evaluate(element => element.querySelector('.empty-description')!.getBoundingClientRect().top - element.querySelector('h3')!.getBoundingClientRect().bottom)
    expect(copyGap).toBeCloseTo(4, 1)
    await expect(compact.locator('img')).toHaveCSS('opacity', '0.5')
    await expect(compact.getByRole('button', { name: '连接来源 App' })).toHaveClass(/ds-button-tertiary/)
    await page.keyboard.press('Escape')
  }
})

test('空占位在各自可用区域居中，长诊断在低窗口仍可滚动操作', async () => {
  async function centered(selector: string, hostSelector: string, headerSelector?: string) {
    const offsets = await page.locator(selector).evaluate((element, { hostSelector, headerSelector }) => {
      const host = document.querySelector(hostSelector)! as HTMLElement
      const bounds = host.getBoundingClientRect(), style = getComputedStyle(host)
      const box = element.getBoundingClientRect()
      const header = headerSelector ? host.querySelector(headerSelector) : null
      const top = header ? header.getBoundingClientRect().bottom + parseFloat(getComputedStyle(header).marginBottom)
        : bounds.top + host.clientTop + parseFloat(style.paddingTop)
      const bottom = bounds.top + host.clientTop + host.clientHeight - parseFloat(style.paddingBottom)
      const left = bounds.left + host.clientLeft + parseFloat(style.paddingLeft)
      const right = bounds.left + host.clientLeft + host.clientWidth - parseFloat(style.paddingRight)
      return { x: Math.abs(box.x + box.width / 2 - (left + right) / 2), y: Math.abs(box.y + box.height / 2 - (top + bottom) / 2) }
    }, { hostSelector, headerSelector })
    expect(offsets.x, selector).toBeLessThanOrEqual(2)
    expect(offsets.y, selector).toBeLessThanOrEqual(2)
  }
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    for (const [width, height] of [[1000, 680], [1380, 820]]) {
      await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setSize(width, height), [width, height])
      await expect(page.locator('.detail > .empty-state img')).toHaveCSS('width', height <= 700 ? '144px' : '184px')
      await expect(page.locator('.detail > .empty-state h2')).toHaveCSS('font-size', '16px')
      await expect(page.locator('.detail > .empty-state .empty-description')).toHaveCSS('font-size', '12px')
      const copyGap = await page.locator('.detail > .empty-state').evaluate(element => {
        const title = element.querySelector('h2')!.getBoundingClientRect()
        return element.querySelector('.empty-description')!.getBoundingClientRect().top - title.bottom
      })
      expect(copyGap).toBeCloseTo(4, 1)
      await centered('.detail > .empty-state', '.detail')
      await centered('.session-list > .empty-state', '.session-list')
    }
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await centered('.search-content > .empty-state', '.search-content', '.search-context')
    await page.keyboard.press('Escape')
  }
  await connect()
  await expect(page.locator('.detail > [data-empty-state="empty"]')).toBeVisible()
  const file = join(source, 'centering.jsonl')
  await writeFile(file, claudeFixture())
  await page.locator('.detail').getByRole('button', { name: '刷新', exact: true }).click()
  await expect(page.locator('.session-card')).toHaveCount(1)
  await rm(file)
  await page.locator('.session-card').click()
  const failure = page.locator('.detail > [data-empty-state="read-error"]')
  await expect(failure).toBeVisible()
  await expect(failure.locator('.empty-description')).toHaveCSS('color', 'rgba(255, 255, 255, 0.4)')
  expect(await failure.getAttribute('data-empty-tone')).toBeNull()
  await centered('.detail > [data-empty-state="read-error"]', '.detail', '.detail-header')
  await expect(failure.getByRole('button', { name: '重试读取' })).toHaveClass(/ds-button-tertiary/)
  await failure.locator('.empty-description').evaluate(element => { element.textContent = '合成长诊断：来源暂时不可访问，请检查后重试。'.repeat(180) })
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(900, 360); window.setSize(1000, 420) })
  const viewport = page.locator('.detail')
  await expect.poll(() => viewport.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await viewport.evaluate(element => { element.scrollTop = 0 })
  const heading = (await failure.getByRole('heading').boundingBox())!, area = (await viewport.boundingBox())!
  expect(heading.y).toBeGreaterThanOrEqual(area.y)
  const retry = failure.getByRole('button', { name: '重试读取' })
  await retry.scrollIntoViewIfNeeded()
  await expect(retry).toBeEnabled()
  const action = (await retry.boundingBox())!
  expect(action.y + action.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight))
})

test('六张生产 SVG 实际解码，透明边角与深浅主题均正常，不依赖位图或外网', async () => {
  const directory = resolve('out/renderer/assets')
  const names = ['disconnected', 'empty', 'search', 'selection', 'unavailable', 'messages']
  const files = await readdir(directory)
  const urls = names.map(name => {
    const file = files.find(file => file.startsWith(`${name}-`) && file.endsWith('.svg'))
    expect(file, name).toBeTruthy()
    return pathToFileURL(join(directory, file!)).href
  })
  const samples: number[][] = []
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    samples.push(await page.evaluate(async urls => {
      const results = []
      for (const url of urls) {
        const image = new Image(); image.src = url; await image.decode()
        const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512
        const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0, 512, 512)
        const pixels = context.getImageData(0, 0, 512, 512).data
        const corners = [0, 511, 511 * 512, 512 * 512 - 1]
        if (corners.some(index => pixels[index * 4 + 3] !== 0)) throw new Error('插画边角不透明')
        let opaque = 0, sum = 0
        for (let index = 0; index < pixels.length; index += 4) if (pixels[index + 3] > 240) { opaque++; sum += pixels[index] + pixels[index + 1] + pixels[index + 2] }
        if (opaque < 300) throw new Error('插画没有实际内容')
        results.push(Math.round(sum / opaque))
      }
      return results
    }, urls))
  }
  expect(samples[0]).toHaveLength(6)
  names.forEach((_name, index) => expect(samples[1][index]).not.toBe(samples[0][index]))
})

test('空来源、等待选择、搜索无结果有正确占位，重启自动加载并恢复等待选择', async () => {
  await connect()
  await expect(page.locator('.detail > [data-empty-state="empty"]')).toBeVisible()
  await expect(page.locator('.empty-footnote')).toHaveCount(0)
  await expect(page.locator('.detail')).not.toContainText('选中一段对话')
  await writeFile(join(source, 'synthetic.jsonl'), claudeFixture())
  await page.locator('.detail').getByRole('button', { name: '刷新', exact: true }).click()
  await expect(page.locator('.session-card')).toHaveCount(1)
  const selection = page.locator('.detail > [data-empty-state="selection"]')
  await expect(selection).toBeVisible()
  await expect(selection.getByRole('heading')).toHaveText('尚未选择会话')
  await expect(selection.locator('.empty-description')).toHaveText('正文与来源信息将在这里显示。')
  await expect(selection.locator('.empty-footnote')).toHaveCount(0)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  const input = page.getByRole('textbox', { name: '搜索会话' })
  await input.fill('完全不存在的关键词')
  const dialog = page.getByRole('dialog', { name: '搜索会话' })
  await expect(dialog.locator('[data-empty-state="no-results"]')).toBeVisible()
  await expect(dialog.locator('.empty-description, .empty-footnote')).toHaveCount(0)
  await dialog.getByRole('button', { name: '清空关键词', exact: true }).click()
  await expect(input).toBeFocused(); await expect(input).toHaveValue('')
  await expect(dialog.locator('.search-result')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await background(); await app.close(); await launch()
  await expect(page.locator('.session-card')).toHaveCount(1)
  await expect(page.getByRole('button', { name: /^Claude Code\s*1$/ })).toBeVisible()
  await expect(page.locator('[data-empty-state="needs-refresh"]')).toHaveCount(0)
  const restoredSelection = page.locator('.detail > [data-empty-state="selection"]')
  await expect(restoredSelection).toBeVisible()
  await expect(restoredSelection.getByRole('heading')).toHaveText('尚未选择会话')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    expect(await restoredSelection.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    const base = colorScheme === 'light' ? '0, 0, 0' : '255, 255, 255'
    const tertiary = `rgba(${base}, 0.4)`
    await expect(page.locator('html')).toHaveCSS('color', `rgba(${base}, 0.88)`)
    await expect(page.locator('.storage-description')).toHaveCSS('color', `rgba(${base}, 0.65)`)
    for (const selector of ['html', '.storage-description', '.session-card .card-meta']) {
      await expect(page.locator(selector)).toHaveCSS('opacity', '1')
    }
    await expect(restoredSelection.getByRole('heading')).toHaveCSS('color', tertiary)
    await expect(restoredSelection.locator('.empty-description')).toHaveCSS('color', tertiary)
    await expect(page.locator('.session-card .card-meta')).toHaveCSS('color', tertiary)
    await expect(page.locator('.sidebar .count').first()).toHaveCSS('color', tertiary)
    expect(await restoredSelection.getAttribute('data-empty-tone')).toBeNull()
    if (colorScheme === 'light') await page.screenshot({ path: 'test-results/pinekin-text-alpha-light.png', scale: 'css' })
  }
  await expect(page.locator('.detail')).not.toContainText('还没有可浏览的会话')
})
