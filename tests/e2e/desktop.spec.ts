import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { makeBundle } from '../../src/core/session'
import { demoSessions } from '../../src/core/demo'

let app: ElectronApplication
let page: Page
let directory: string
async function launch() {
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env
  app = await electron.launch({ args: [resolve('out/main/index.js')], env: { ...env, EMBER_DATA_DIR: directory } })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByRole('heading', { level: 2, name: '让思考跨越工具，继续生长' })).toBeVisible()
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ember-e2e-'))
  await launch()
})
test.afterEach(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }) })

test('桌面启动、全文搜索、来源筛选与视觉检查', async () => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByLabel('搜索会话').fill('安全边界')
  await expect(page.getByRole('heading', { level: 2, name: '迁移前，先画清安全边界' })).toBeVisible()
  await page.getByLabel('搜索会话').fill('完全不存在')
  await expect(page.getByText('没有找到匹配的会话')).toBeVisible()
  await page.getByLabel('搜索会话').fill('')
  await page.getByRole('complementary').getByRole('button', { name: /Claude Code/ }).click()
  await expect(page.getByRole('heading', { level: 2, name: '一份不丢失来源的适配器契约' })).toBeVisible()
  await page.getByRole('button', { name: /所有会话/ }).click()
  await page.getByRole('button', { name: /让思考跨越工具/ }).click()
  await page.screenshot({ path: 'test-results/ember-desktop.png' })
  expect(errors).toEqual([])
  expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined')
})

test('原生文件对话框路径下的导入、持久化及无效输入保护', async () => {
  const file = join(directory, 'import.ember.json')
  const imported = { ...demoSessions[0], title: '从文件带来的火种', messages: [{ role: 'user' as const, content: '<script>alert("不执行")</script>' }] }
  await writeFile(file, JSON.stringify(makeBundle(imported)))
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
  }, file)
  await page.getByRole('button', { name: '导入 Ember 包' }).click()
  await expect(page.getByRole('heading', { level: 2, name: imported.title })).toBeVisible()
  await expect(page.locator('.message-body p')).toHaveText(imported.messages[0].content)
  const stored = JSON.parse(await readFile(join(directory, 'library.json'), 'utf8'))
  expect(stored).toHaveLength(1)
  expect(stored[0].demo).toBe(false)
  await writeFile(file, '{"invalid":true}')
  await page.getByRole('button', { name: '导入 Ember 包' }).click()
  await expect(page.getByRole('status')).toBeVisible()
  expect(JSON.parse(await readFile(join(directory, 'library.json'), 'utf8'))).toHaveLength(1)
  await app.close()
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env
  app = await electron.launch({ args: [resolve('out/main/index.js')], env: { ...env, EMBER_DATA_DIR: directory } })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByRole('heading', { level: 2, name: imported.title })).toBeVisible()
})

test('交接包与 Markdown 真实导出，复制不改动系统剪贴板', async () => {
  const output = join(directory, 'handoff.json')
  await app.evaluate(({ dialog, clipboard }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    clipboard.writeText = async text => { (globalThis as unknown as { testClipboard: string }).testClipboard = text }
  }, output)
  await page.getByRole('button', { name: '带走这段对话' }).click()
  await page.getByLabel('接续目标').selectOption('NewMax')
  await page.getByRole('button', { name: '导出 Ember 包', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('已导出到你选择的位置')
  expect(JSON.parse(await readFile(output, 'utf8')).format).toBe('ember.session')
  await page.getByRole('button', { name: '导出 Markdown' }).click()
  await expect(page.getByRole('status')).toHaveText('已导出到你选择的位置')
  expect(await readFile(output, 'utf8')).toContain('目标：NewMax')
  await page.getByRole('button', { name: '复制交接文本' }).click()
  await expect(page.getByRole('status')).toContainText('已复制交接文本')
  expect(await app.evaluate(() => (globalThis as unknown as { testClipboard: string }).testClipboard)).toContain('不是原生会话恢复')
  await page.screenshot({ path: 'test-results/ember-handoff.png' })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).not.toBeVisible()
})

test('接收本地深链，只定位会话而不执行任意链接', async () => {
  await app.evaluate(({ app }) => app.emit('open-url', { preventDefault() {} }, 'newmax-ember://session/demo-migration'))
  await expect(page.getByRole('heading', { level: 2, name: '迁移前，先画清安全边界' })).toBeVisible()
  await app.evaluate(({ app }) => app.emit('open-url', { preventDefault() {} }, 'newmax-ember://session/unknown'))
  await expect(page.getByRole('status')).toContainText('本机没有这段会话')
})
