import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { cindyFixture } from '../fixtures/cindy'
import { codexFixture, codexThreadId } from '../fixtures/codex'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeBundle } from '../../src/core/session'
import { demoSessions } from '../../src/core/demo'

let app: ElectronApplication
let page: Page
let directory: string
function isolatedEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !['ELECTRON_RUN_AS_NODE', 'STAITHE_DATA_DIR', 'EMBER_DATA_DIR'].includes(entry[0])))
}
async function launch(legacyEnv = false, link?: string) {
  const env = isolatedEnv()
  app = await electron.launch({ args: [resolve('out/main/index.js'), ...(link ? [link] : [])],
    env: { ...env, [legacyEnv ? 'EMBER_DATA_DIR' : 'STAITHE_DATA_DIR']: directory } })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.brand > span:last-child')).toHaveText('staithe.')
  await expect(page).toHaveTitle('Staithe · 换个地方，继续思考')
  expect(await app.evaluate(({ app }) => app.getName())).toBe('Staithe')
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(directory)
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'staithe-e2e-'))
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
  await page.screenshot({ path: 'test-results/staithe-desktop.png' })
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
    await expect(page.getByRole('heading', { level: 2, name: imported.title })).toBeVisible()
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
  await page.keyboard.press('Escape')
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
  await page.getByRole('button', { name: '带走这段对话' }).click()
  await expect(page.locator('.handoff-preview')).toContainText('原始文件不随交接导出')
  await page.keyboard.press('Escape')
  const badToken = await page.evaluate(async () => {
    try { await window.staithe.confirmImport('../outside'); return false } catch { return true }
  })
  expect(badToken).toBe(true)
  await app.close(); await launch()
  await expect(page.getByRole('heading', { level: 2, name: 'Cindy 合成档案' })).toBeVisible()
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
  await page.getByRole('button', { name: '带走这段对话' }).click()
  await expect(page.locator('.handoff-preview')).toContainText('工具')
  await page.getByRole('button', { name: '导出 Staithe 包', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('已导出到你选择的位置')
  const exported = JSON.parse(await readFile(output, 'utf8'))
  expect(exported.version).toBe(2)
  expect(exported.session.archive.originalSessionId).toBe(codexThreadId)
  expect(exported.session.messages).toHaveLength(2)
  await page.keyboard.press('Escape')
  await app.close(); await launch()
  await expect(page.getByRole('heading', { level: 2, name: `Codex · ${codexThreadId.slice(0, 8)}` })).toBeVisible()
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
  await page.getByRole('button', { name: '带走这段对话' }).click()
  await page.getByLabel('接续目标').selectOption('NewMax')
  await page.getByRole('button', { name: '导出 Staithe 包', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('已导出到你选择的位置')
  expect(JSON.parse(await readFile(output, 'utf8')).format).toBe('staithe.session')
  expect(await app.evaluate(() => (globalThis as unknown as { testDefaultPath: string }).testDefaultPath)).toBe(`staithe-${demoSessions[0].id}.staithe.json`)
  await page.getByRole('button', { name: '导出 Markdown' }).click()
  await expect(page.getByRole('status')).toHaveText('已导出到你选择的位置')
  const markdown = await readFile(output, 'utf8')
  expect(markdown).toContain('目标：NewMax')
  expect(markdown).toContain('# Staithe 上下文交接')
  await page.getByRole('button', { name: '复制交接文本' }).click()
  await expect(page.getByRole('status')).toContainText('已复制交接文本')
  expect(await app.evaluate(() => (globalThis as unknown as { testClipboard: string }).testClipboard)).toContain('不是原生会话恢复')
  await page.screenshot({ path: 'test-results/staithe-handoff.png' })
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
  // 先重定向 appData，再加载主进程；绝不读取用户的真实目录。
  const bootstrap = join(directory, 'isolated-start.cjs')
  await writeFile(bootstrap, `const { app } = require('electron'); app.setPath('appData', ${JSON.stringify(directory)}); import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});`)
  app = await electron.launch({ args: [bootstrap], env: isolatedEnv() })
  page = await app.firstWindow()
  await expect(page.getByRole('heading', { level: 2, name: previous.title })).toBeVisible()
  expect(await app.evaluate(({ app }) => app.getName())).toBe('Staithe')
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
