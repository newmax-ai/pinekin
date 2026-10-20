import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { codexFixture, codexThreadId } from '../fixtures/codex'

type State = { opened: string[]; copied: string[]; events: string[]; handler: boolean; saveCalls: number; openCalls: number }
let app: ElectronApplication, page: Page, root: string, dbPath: string, output: string
async function connect(name: 'NewMax' | 'Codex' = 'NewMax') {
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  const control = page.getByRole('switch', { name: `连接 ${name}`, exact: true })
  await control.click(); await expect(control).toBeChecked(); await expect(control).toBeEnabled()
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await page.locator('.session-card').first().click()
  await expect(page.getByRole('button', { name: '在原 App 打开' })).toBeEnabled()
}
async function more() { await page.getByRole('button', { name: '更多会话操作' }).click() }
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-actions-e2e-')))
  await mkdir(join(root, '.newmax')); await mkdir(join(root, 'appData')); await mkdir(join(root, '.codex', 'sessions'), { recursive: true })
  dbPath = join(root, '.newmax', 'newmax.db'); output = join(root, 'export.md')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, source TEXT, created_at INTEGER, updated_at INTEGER, forked_from_id TEXT, is_private INTEGER, message_count INTEGER);
    CREATE TABLE messages (seq INTEGER, id TEXT, conversation_id TEXT, role TEXT, content TEXT, timestamp INTEGER, data TEXT);
    INSERT INTO conversations VALUES ('synthetic-one','一次跨工具的思考','app',1000,2000,NULL,0,2);`)
  for (const [index, role, content] of [[0, 'user', '整理项目方案，保留已有结论。'], [1, 'assistant', '先明确目标，再逐项验证实际能力。']] as const) {
    const id = `m-${index}`, message = { id, role, content, timestamp: 2000 }
    db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(index, id, 'synthetic-one', role, content, 2000, JSON.stringify(message))
  }
  db.close()
  await writeFile(join(root, '.codex', 'sessions', 'synthetic.jsonl'), codexFixture())
  const projectPath = join(root, 'synthetic-project'); await mkdir(projectPath)
  await writeFile(join(root, '.codex', '.codex-global-state.json'), JSON.stringify({
    'local-projects': { 'synthetic-project': { id: 'synthetic-project', name: '合成已有项目', rootPaths: [projectPath], createdAt: 1000, updatedAt: 2000 } },
    'project-order': ['synthetic-project'],
  }))
  const bundle = join(root, 'ChatGPT.app'), resources = join(bundle, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS')
  await mkdir(resources, { recursive: true }); await writeFile(join(resources, 'codex'), 'synthetic metadata-only fixture; never execute')
  await writeFile(join(bundle, 'Contents/Info.plist'), JSON.stringify({ CFBundleIdentifier: 'com.openai.codex', CFBundleName: 'ChatGPT', CFBundleURLTypes: [{ CFBundleURLSchemes: ['codex'] }] }))
  const newmaxBundle = join(root, 'Electron.app')
  await mkdir(join(newmaxBundle, 'Contents'), { recursive: true })
  await writeFile(join(newmaxBundle, 'Contents/Info.plist'), JSON.stringify({ CFBundleIdentifier: 'cc.newmax.desktop.cn.dev', CFBundleName: 'Electron' }))
  const bootstrap = join(root, 'start.cjs')
  await writeFile(bootstrap, `const { app, dialog, clipboard, shell, nativeImage } = require('electron');
    app.setPath('home', ${JSON.stringify(root)}); app.setPath('appData', ${JSON.stringify(join(root, 'appData'))});
    globalThis.actionTest = { opened: [], copied: [], events: [], handler: true, saveCalls: 0, openCalls: 0 };
    app.getApplicationNameForProtocol = url => globalThis.actionTest.handler ? (url.startsWith('codex:') ? 'ChatGPT' : 'Electron') : '';
    app.getApplicationInfoForProtocol = async url => { if (!globalThis.actionTest.handler) throw new Error('合成协议已失效'); return { name: url.startsWith('codex:') ? 'ChatGPT' : 'Electron', path: url.startsWith('codex:') ? ${JSON.stringify(bundle)} : ${JSON.stringify(newmaxBundle)}, icon: nativeImage.createEmpty() }; };
    shell.openExternal = async url => { globalThis.actionTest.opened.push(url); };
    clipboard.writeText = async text => { globalThis.actionTest.copied.push(text); };
    dialog.showOpenDialog = async () => { globalThis.actionTest.openCalls++; return { canceled: true, filePaths: [] }; };
    dialog.showSaveDialog = async () => { globalThis.actionTest.saveCalls++; return { canceled: false, filePath: ${JSON.stringify(output)} }; };
    app.on('browser-window-created', (_event, window) => { window.on('show', () => globalThis.actionTest.events.push('show')); window.on('focus', () => globalThis.actionTest.events.push('focus')); });
    import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});`)
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'EMBER_DATA_DIR', 'STAITHE_DATA_DIR', 'STAITHE_TEST_BACKGROUND', 'NEWMAX_USER_DATA_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'DSH_HOME'].includes(entry[0])))
  app = await electron.launch({ args: [bootstrap], env: { ...env, STAITHE_DATA_DIR: join(root, 'pinekin'), STAITHE_TEST_BACKGROUND: '1' } })
  page = await app.firstWindow(); await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByRole('button', { name: '连接 App', exact: true })).toBeEnabled()
})
test.afterEach(async () => {
  try {
    if (app?.process().exitCode === null) expect(await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest.events)).toEqual([])
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }) }
})

test('明确选择独立会话或项目；取消项目不创建，安装与数据位置只留在设置', async () => {
  const before = await readFile(dbPath)
  await connect()
  await page.getByRole('button', { name: '在其他 App 继续' }).click()
  await page.getByRole('button', { name: '在 Codex 继续' }).click()
  await expect(page.getByRole('group', { name: '在哪里继续？' })).toBeVisible()
  await expect(page.getByRole('button', { name: '独立会话继续' })).toBeEnabled()
  await expect(page.getByRole('button', { name: `在 合成已有项目 继续：${join(root, 'synthetic-project')}` })).toBeEnabled()
  const selected = await page.evaluate(async () => {
    const api = window.staithe.sourceActions!, entry = (await window.staithe.sources.page({})).items[0]
    const list = await api.listCodexProjects!(entry.id)
    return api.chooseCodexProject!(entry.id, list.projects[0].id)
  })
  expect(selected).toMatchObject({ name: '合成已有项目', path: join(root, 'synthetic-project') })
  expect(await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest.openCalls)).toBe(0)
  await expect(page.locator('.source-target-path')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '连接并继续' })).toHaveCount(0)
  expect(await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest.openCalls)).toBe(0)
  await page.getByRole('button', { name: '选择其他文件夹' }).click()
  await expect(page.getByRole('button', { name: '选择其他文件夹' })).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest.openCalls)).toBe(1)
  await expect(readFile(join(root, 'pinekin', 'codex-target.json'))).rejects.toThrow()
  await page.getByRole('button', { name: '关闭接续面板' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await more(); await page.getByRole('menuitem', { name: '接续目标设置' }).click()
  await page.getByRole('button', { name: '选择 Codex' }).click()
  const application = page.getByRole('button', { name: '应用：ChatGPT', exact: true })
  const applicationPath = page.locator('.source-target-program > code')
  const customLocation = page.getByRole('button', { name: '使用自定义位置', exact: true })
  await expect(application).toBeVisible()
  await expect(application).toHaveClass(/ds-button-ghost/)
  await expect(customLocation).toHaveClass(/ds-button-tertiary/)
  await expect(application).toHaveAttribute('aria-expanded', 'false')
  await expect(applicationPath).toBeHidden()
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect(customLocation).toHaveCSS('height', '28px')
    await expect(application).toHaveCSS('height', '28px')
    await expect(page.locator('.source-target-path')).toHaveCSS('user-select', 'text')
    await expect(page.locator('.source-target-path')).toHaveCSS('overflow-wrap', 'anywhere')
    expect(await page.locator('.source-target-setting-heading').evaluate(element => {
      const label = element.querySelector('span')!.getBoundingClientRect()
      const button = element.querySelector('button')!.getBoundingClientRect()
      return Math.abs(label.top + label.height / 2 - button.top - button.height / 2) < 1
    })).toBe(true)
    await application.focus(); await application.press('Enter')
    await expect(application).toHaveAttribute('aria-expanded', 'true')
    await expect(applicationPath).toBeVisible()
    await expect(applicationPath).toHaveText(join(root, 'ChatGPT.app'))
    await expect(applicationPath).toHaveCSS('user-select', 'text')
    expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await application.press('Space')
    await expect(application).toHaveAttribute('aria-expanded', 'false')
    await expect(applicationPath).toBeHidden()
  }
  await expect(page.locator('.source-target-path')).toHaveText(join(root, '.codex'))
  await expect(page.getByRole('button', { name: '保存位置' })).toBeEnabled()
  expect(await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest.openCalls)).toBe(1)
  await page.getByRole('button', { name: '使用自定义位置' }).click()
  await expect(page.getByRole('button', { name: '保存位置' })).toBeEnabled()
  expect(await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest.openCalls)).toBe(2)
  await expect(page.locator('.source-target-path')).toHaveText(join(root, '.codex'))
  await page.getByRole('button', { name: '关闭接续面板' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.source-actions-feedback')).toHaveCount(0)
  await expect(readFile(join(root, 'pinekin', 'codex-target.json'))).rejects.toThrow()
  const results = await page.evaluate(async () => {
    const api = window.staithe.sourceActions!
    const id = (await window.staithe.sources.page({})).items[0].id
    return Promise.all([
      api.continueInCodex!('file:///etc/passwd', { kind: 'standalone' }).then(() => false, () => true),
      api.continueInCodex!(id, { kind: 'project', token: '11111111-1111-4111-8111-111111111111' }).then(() => false, () => true),
      api.rollbackTransfer!('../escape').then(() => false, () => true),
      api.configureCodex!('/arbitrary/path').then(() => false, () => true),
    ])
  })
  expect(results).toEqual([true, true, true, true])
  expect(await readFile(dbPath)).toEqual(before)
  expect(await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest.opened)).toEqual([])
})

test('主操作直接请求NewMax原会话，辅助复制和导出不再有目标或敏感表单', async () => {
  const before = await readFile(dbPath)
  await connect()
  await expect(page.getByRole('button', { name: '在另一个 App 继续' })).toHaveCount(0)
  await expect(page.locator('.detail-header').getByText('来源直读')).toHaveCount(0)
  await page.getByRole('button', { name: '在原 App 打开' }).click()
  await expect(page.locator('.source-actions-feedback')).toContainText('已请求 NewMax 打开原会话')
  expect(await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest.opened)).toEqual(['newmax://open?conversation=synthetic-one'])
  await page.getByRole('button', { name: '关闭操作提示' }).click()
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800), colorScheme === 'light' ? 1440 : 1000)
    await more()
    await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('checkbox')).toHaveCount(0); await expect(page.getByRole('combobox')).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: '复制会话文本' })).toBeFocused()
    expect(await page.locator('.detail-header').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.getByRole('menuitem', { name: '复制会话文本' }).click()
    await expect(page.locator('.source-actions-feedback')).toContainText('已复制会话文本')
    await page.getByRole('button', { name: '关闭操作提示' }).click()
    await more(); await page.getByRole('menuitem', { name: '导出 Markdown' }).click()
    await expect(page.locator('.source-actions-feedback')).toContainText('已导出 Markdown')
    const copied = await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest.copied.at(-1))
    expect(await readFile(output, 'utf8')).toBe(copied)
    expect(copied).not.toContain('目标：')
    await page.getByRole('button', { name: '关闭操作提示' }).click()
  }
  expect(await readFile(dbPath)).toEqual(before)
  await page.emulateMedia({ colorScheme: 'light' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1380, 860))
  await more()
  await page.screenshot({ path: 'test-results/source-actions-newmax.png', scale: 'css' })
})

test('长标题优先分配宽度，窄窗口操作另起一行；协议不可用不显示死按钮', async () => {
  const title = 'newmax://open?conversation=synthetic-long-title 继续完成 Electron 升级并核对桌面兼容性'
  const db = new DatabaseSync(dbPath)
  db.prepare('UPDATE conversations SET title = ?').run(title); db.close()
  await connect()
  const header = page.locator('.detail-header')
  for (const width of [1440, 1000]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800), width)
    await page.emulateMedia({ colorScheme: width === 1440 ? 'light' : 'dark' })
    await expect(header.getByRole('heading', { name: title })).toBeVisible()
    const group = (await header.locator('.detail-title-group').boundingBox())!
    const actions = (await header.locator('.source-actions').boundingBox())!
    expect(group.width).toBeGreaterThan(actions.width)
    if (width === 1440) expect(actions.x).toBeGreaterThanOrEqual(group.x + group.width)
    else expect(actions.y).toBeGreaterThanOrEqual(group.y + group.height)
    expect(await header.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await more()
    const menu = (await page.getByRole('menu').boundingBox())!
    expect(menu.x).toBeGreaterThanOrEqual(0)
    expect(menu.x + menu.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth))
    await page.keyboard.press('Escape')
    await page.screenshot({ path: `test-results/source-header-${width}.png`, scale: 'css' })
  }
  await app.evaluate(() => { (globalThis as unknown as { actionTest: State }).actionTest.handler = false })
  await page.reload()
  await page.locator('.session-card').first().click()
  await more()
  await expect(page.getByRole('note')).toContainText('未找到已关联此协议的 NewMax 客户端')
  await expect(header.getByRole('button', { name: '在原 App 打开' })).toHaveCount(0)
  await expect(header.getByRole('button', { name: '在另一个 App 继续' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: '复制会话文本' })).toBeEnabled()
  await page.getByRole('menuitem', { name: '复制会话文本' }).click()
  await expect(page.locator('.source-actions-feedback')).toContainText('已复制会话文本')
  expect(await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest.opened)).toEqual([])
})

test('Codex只打开既有UUID线程，不创建、不注入或触发模型请求', async () => {
  await connect('Codex')
  await page.getByRole('button', { name: '在原 App 打开' }).click()
  await expect(page.locator('.source-actions-feedback')).toContainText('已请求 Codex 打开原会话')
  expect(await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest.opened)).toEqual([`codex://threads/${codexThreadId}`])
})

test('IPC拒绝任意URL、未知ID及断开后的打开请求；协议失效不调用系统打开', async () => {
  await connect()
  const entry = await page.evaluate(async () => (await window.staithe.sources.page({})).items[0])
  const rejected = await page.evaluate(async id => {
    const api = window.staithe.sourceActions!
    const results = []
    for (const value of ['https://evil.test', 'file:///etc/passwd', 'b'.repeat(64)]) {
      results.push(await api.openOriginal(value).then(() => false, () => true))
    }
    return { results, inspected: (await api.inspect(id)).original.available }
  }, entry.id)
  expect(rejected).toEqual({ results: [true, true, true], inspected: true })
  await app.evaluate(() => { (globalThis as unknown as { actionTest: State }).actionTest.handler = false })
  await page.getByRole('button', { name: '在原 App 打开' }).click()
  await expect(page.locator('.source-actions-feedback')).toContainText('未找到已关联此协议')
  await page.evaluate(async id => window.staithe.sources.disconnect(id), entry.connectionId)
  expect(await page.evaluate(async id => window.staithe.sourceActions!.openOriginal(id).then(() => false, () => true), entry.id)).toBe(true)
  expect(await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest.opened)).toEqual([])
})

test('导出取消不落盘，错误扩展名、链接与超限文本不写入', async () => {
  await connect()
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }) })
  await more(); await page.getByRole('menuitem', { name: '导出 Markdown' }).click()
  await expect(page.getByRole('button', { name: '更多会话操作' })).toBeEnabled()
  await expect(page.locator('.source-actions-feedback')).toHaveCount(0)
  await expect(readFile(output)).rejects.toThrow()
  const protectedPath = join(root, 'protected.txt'); await writeFile(protectedPath, '保持原文')
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, protectedPath)
  expect(await page.evaluate(async () => window.staithe.sourceActions!.exportText('合成文本').then(() => false, () => true))).toBe(true)
  expect(await readFile(protectedPath, 'utf8')).toBe('保持原文')
  await symlink(protectedPath, output)
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, output)
  expect(await page.evaluate(async () => window.staithe.sourceActions!.exportText('合成文本').then(() => false, () => true))).toBe(true)
  expect(await readFile(protectedPath, 'utf8')).toBe('保持原文')
  expect(await page.evaluate(async () => window.staithe.sourceActions!.exportText('长'.repeat(2_000_000)).then(() => false, () => true))).toBe(true)
})
