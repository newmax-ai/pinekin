import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { codexFixture, codexThreadId } from '../fixtures/codex'

type State = { opened: string[]; launched: string[]; copied: string[]; files: string[]; events: string[]; handler: boolean; saveCalls: number; openCalls: number }
const isMac = process.platform === 'darwin'
const macTest = isMac ? test : test.skip
const handoffButton = isMac ? '复制接续文件' : '保存接续文件'
let app: ElectronApplication, page: Page, root: string, dbPath: string, output: string
async function connect(name: 'NewMax' | 'Codex' = isMac ? 'NewMax' : 'Codex') {
  await page.getByRole('button', { name: '连接 App', exact: true }).click()
  const control = page.getByRole('switch', { name: `连接 ${name}`, exact: true })
  await control.click(); await expect(control).toBeChecked(); await expect(control).toBeEnabled()
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await page.locator('.session-card').first().click()
  await expect(page.getByRole('button', { name: handoffButton })).toBeEnabled()
  await expect(page.getByRole('button', { name: '在原 App 打开' })).toHaveCount(0)
}
async function more() { await page.getByRole('button', { name: '更多会话操作' }).click() }
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-actions-e2e-')))
  await mkdir(join(root, '.newmax')); await mkdir(join(root, 'appData')); await mkdir(join(root, '.codex', 'sessions'), { recursive: true })
  dbPath = join(root, '.newmax', 'newmax.db'); output = join(root, 'export.md')
  if (isMac) {
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, source TEXT, created_at INTEGER, updated_at INTEGER, forked_from_id TEXT, is_private INTEGER, message_count INTEGER);
    CREATE TABLE messages (seq INTEGER, id TEXT, conversation_id TEXT, role TEXT, content TEXT, timestamp INTEGER, data TEXT);
    INSERT INTO conversations VALUES ('synthetic-one','一次跨工具的思考','app',1000,2000,NULL,0,2);`)
  for (const [index, role, content] of [[0, 'user', '整理项目方案，保留已有结论。'], [1, 'assistant', '先明确目标，再逐项验证实际能力。']] as const) {
    const id = `m-${index}`, message = { id, role, content, timestamp: 2000 }
    db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(index, id, 'synthetic-one', role, content, 2000, JSON.stringify(message))
  }
  db.close()
  }
  await writeFile(join(root, '.codex', 'sessions', 'synthetic.jsonl'), codexFixture())
  const projectPath = join(root, 'synthetic-project'); await mkdir(projectPath)
  await writeFile(join(root, '.codex', '.codex-global-state.json'), JSON.stringify({
    'local-projects': { 'synthetic-project': { id: 'synthetic-project', name: '合成已有项目', rootPaths: [projectPath], createdAt: 1000, updatedAt: 2000 } },
    'project-order': ['synthetic-project'],
  }))
  const bundle = join(root, 'ChatGPT.app'), resources = join(bundle, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS')
  const newmaxBundle = join(root, 'Electron.app')
  if (isMac) {
  await mkdir(resources, { recursive: true }); await writeFile(join(resources, 'codex'), 'synthetic metadata-only fixture; never execute')
  await writeFile(join(bundle, 'Contents/Info.plist'), JSON.stringify({ CFBundleIdentifier: 'com.openai.codex', CFBundleName: 'ChatGPT', CFBundleURLTypes: [{ CFBundleURLSchemes: ['codex'] }] }))
  await mkdir(join(newmaxBundle, 'Contents'), { recursive: true })
  await writeFile(join(newmaxBundle, 'Contents/Info.plist'), JSON.stringify({ CFBundleIdentifier: 'cc.newmax.desktop.cn.dev', CFBundleName: 'Electron' }))
  }
  const bootstrap = join(root, 'start.cjs')
  await writeFile(bootstrap, `const { app, dialog, clipboard, shell, nativeImage } = require('electron');
    app.setPath('home', ${JSON.stringify(root)}); app.setPath('appData', ${JSON.stringify(join(root, 'appData'))});
    globalThis.actionTest = { opened: [], launched: [], copied: [], files: [], events: [], handler: true, saveCalls: 0, openCalls: 0 };
    app.getApplicationNameForProtocol = url => globalThis.actionTest.handler ? (url.startsWith('codex:') ? 'ChatGPT' : 'Electron') : '';
    app.getApplicationInfoForProtocol = async url => { if (!globalThis.actionTest.handler) throw new Error('合成协议已失效'); return { name: url.startsWith('codex:') ? 'ChatGPT' : 'Electron', path: url.startsWith('codex:') ? ${JSON.stringify(bundle)} : ${JSON.stringify(newmaxBundle)}, icon: nativeImage.createEmpty() }; };
    shell.openExternal = async url => { globalThis.actionTest.opened.push(url); };
    shell.openPath = async path => { globalThis.actionTest.launched.push(path); return ''; };
    clipboard.writeText = async text => { globalThis.actionTest.copied.push(text); };
    clipboard.write = async items => {
      const type = 'electron application/osclipboard;format="public.file-url"';
      if (items.length !== 1 || items[0].types.length !== 1 || items[0].types[0] !== type) throw new Error('期望原生文件剪贴板');
      globalThis.actionTest.files.push(await (await items[0].getType(type)).text());
    };
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

test('读取说明收进更多菜单，正常阅读不显示报告，关闭后恢复焦点和阅读位置', async () => {
  await connect()
  const detail = page.getByRole('region', { name: '来源会话详情' })
  const messages = page.getByRole('region', { name: '会话消息' })
  const trigger = page.getByRole('button', { name: '更多会话操作' })
  await expect(detail.locator('.archive-report')).toHaveCount(0)
  await expect(detail.getByRole('status', { name: '内容完整性提示' })).toHaveCount(0)
  const scrollTop = await messages.evaluate(element => element.scrollTop)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await more()
    const item = page.getByRole('menuitem', { name: '读取说明', exact: true })
    await item.focus(); await item.press('Enter')
    const dialog = page.getByRole('dialog', { name: '读取说明', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('不等于完整原生会话恢复')
    const rawNotes = dialog.getByRole('region', { name: '原始读取说明', exact: true })
    await expect(rawNotes).toBeHidden()
    await dialog.getByRole('button', { name: '展开原始读取说明', exact: true }).click()
    await expect(rawNotes).toBeVisible()
    await expect(rawNotes).toContainText('正文直接读取来源')
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    if (colorScheme === 'light') await dialog.press('Escape')
    else await dialog.getByRole('button', { name: '关闭读取说明' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(await messages.evaluate(element => element.scrollTop)).toBe(scrollTop)
  }
  const state = await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest)
  expect(state.opened).toEqual([]); expect(state.copied).toEqual([]); expect(state.files).toEqual([])
  expect(state.openCalls).toBe(0); expect(state.saveCalls).toBe(0)
})

test('通用日志可保存完整接续文件与导出文本，不访问文件剪贴板或原生目标', async () => {
  const path = join(root, '.codex', 'sessions', 'synthetic.jsonl'), before = await readFile(path)
  await connect('Codex')
  if (isMac) { await more(); await page.getByRole('menuitem', { name: '保存完整接续文件' }).click() }
  else await page.getByRole('button', { name: '保存接续文件', exact: true }).click()
  await expect(page.locator('.source-actions-feedback')).toContainText('文件已保存')
  const handoff = await readFile(output, 'utf8')
  expect(handoff).toContain('不是原生会话恢复')
  expect(handoff).toContain('合成')
  await page.getByRole('button', { name: '关闭操作提示' }).click()
  await more(); await page.getByRole('menuitem', { name: '复制会话文本' }).click()
  await expect(page.locator('.source-actions-feedback')).toContainText('已复制会话文本')
  await page.getByRole('button', { name: '关闭操作提示' }).click()
  await more(); await page.getByRole('menuitem', { name: '导出聊天记录' }).click()
  await expect(page.locator('.source-actions-feedback')).toContainText('已导出聊天记录')
  const state = await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest)
  expect(await readFile(output, 'utf8')).toBe(state.copied.at(-1))
  expect(state.files).toEqual([]); expect(state.opened).toEqual([]); expect(state.launched).toEqual([])
  expect(state.saveCalls).toBe(2)
  expect(await readFile(path)).toEqual(before)
})

test('两条导出路径都拒绝保存框返回的符号链接，不改原件且允许重试', async () => {
  const original = join(root, 'keep.txt')
  await writeFile(original, '必须保留的合成原文'); await symlink(original, output, 'file')
  await connect('Codex')
  for (const label of ['保存完整接续文件', '导出聊天记录']) {
    await more(); await page.getByRole('menuitem', { name: label, exact: true }).click()
    await expect(page.locator('.source-actions-feedback')).toContainText('不允许符号链接')
    expect(await readFile(original, 'utf8')).toBe('必须保留的合成原文')
    await page.getByRole('button', { name: '关闭操作提示' }).click()
  }
  await rm(output)
  await more(); await page.getByRole('menuitem', { name: '保存完整接续文件', exact: true }).click()
  await expect(page.locator('.source-actions-feedback')).toContainText('文件已保存')
  expect(await readFile(original, 'utf8')).toBe('必须保留的合成原文')
  expect(await readFile(output, 'utf8')).toContain('不是原生会话恢复')
})

macTest('默认一次点击复制通用 Markdown 文件，经真实 preload 和文件 IPC，不打开目标', async () => {
  const before = await readFile(dbPath)
  await connect()
  const copyButton = page.getByRole('button', { name: handoffButton })
  const size = await copyButton.boundingBox()
  await copyButton.click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const copied = page.getByRole('button', { name: '已复制', exact: true })
  await expect(copied).toBeVisible()
  expect(await copied.boundingBox()).toEqual(size)
  const toast = page.locator('.source-messages-region > [data-toast]')
  await expect(toast).toHaveText('文件已复制')
  await expect(page.locator('.detail-header [data-toast]')).toHaveCount(0)
  const regionBounds = (await page.locator('.source-messages-region').boundingBox())!
  const toastBounds = (await toast.boundingBox())!
  expect(toastBounds.x + toastBounds.width / 2).toBeCloseTo(regionBounds.x + regionBounds.width / 2, 0)
  const state = await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest)
  expect(state.opened).toEqual([]); expect(state.launched).toEqual([]); expect(state.copied).toEqual([])
  expect(state.files).toHaveLength(1)
  const text = await readFile(new URL(state.files[0]), 'utf8')
  expect(text).toContain('整理项目方案，保留已有结论。')
  expect(text).toContain('先明确目标，再逐项验证实际能力。')
  expect(text).toContain('不是原生会话恢复'); expect(text).not.toContain('目标：')
  await page.getByRole('button', { name: '关闭操作提示' }).click()
  await more(); await page.getByRole('menuitem', { name: '保存完整接续文件' }).click()
  await expect(toast).toHaveText('文件已保存')
  expect(await readFile(output, 'utf8')).toContain('先明确目标，再逐项验证实际能力。')
  expect(await readFile(new URL(state.files[0]), 'utf8')).toBe(text)
  expect(await readFile(dbPath)).toEqual(before)
  await expect(readFile(join(root, 'pinekin', 'codex-target.json'))).rejects.toThrow()
  const rejected = await page.evaluate(async () => {
    const api = window.staithe.sourceActions!
    return Promise.all([
      api.prepareHandoffFile!('file:///etc/passwd').then(() => false, () => true),
      api.prepareHandoffFile!('b'.repeat(64)).then(() => false, () => true),
      api.deliverHandoffFile!('/arbitrary/path', 'copy-file').then(() => false, () => true),
      api.prepareHandoffFile!('https://evil.test').then(() => false, () => true),
    ])
  })
  expect(rejected).toEqual([true, true, true, true])
})

test('接续文件在等待与失败时不改变按钮位置，不弹目标选择', async () => {
  await connect()
  await app.evaluate(({ ipcMain }) => {
    const control = { finish: () => {} }
    Object.assign(globalThis, { handoffLayout: control })
    ipcMain.removeHandler('pinekin:handoff-file-prepare')
    ipcMain.handle('pinekin:handoff-file-prepare', () => new Promise((_resolve, reject) => {
      control.finish = () => reject(new Error('合成读取失败'))
    }))
  })
  const button = page.getByRole('button', { name: handoffButton })
  const before = await button.boundingBox()
  await button.click()
  await expect(button).toBeDisabled()
  await expect(button).toHaveCSS('opacity', '1')
  expect(await button.boundingBox()).toEqual(before)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await app.evaluate(() => { (globalThis as unknown as { handoffLayout: { finish(): void } }).handoffLayout.finish() })
  await expect(page.getByRole('alert')).toContainText('合成读取失败')
  await expect(button).toBeEnabled()
  expect(await button.boundingBox()).toEqual(before)
  expect(await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest.files)).toEqual([])
})

macTest('高级原生入口仍可明确选择独立会话或项目；取消项目不创建', async () => {
  const before = await readFile(dbPath)
  await connect()
  await more()
  const menu = page.getByRole('menu', { name: '更多会话操作' })
  await expect(menu.getByRole('group')).toHaveCount(3)
  await expect(menu.getByRole('group', { name: '复制与导出' }).getByRole('menuitem')).toHaveCount(2)
  await expect(menu.getByRole('group', { name: '接续与迁移' }).getByRole('menuitem')).toHaveCount(2)
  await expect(menu.getByRole('group', { name: '设置与说明' }).getByRole('menuitem')).toHaveCount(3)
  await expect(menu.getByRole('separator')).toHaveCount(2)
  await expect(menu.getByRole('separator').first()).toHaveCSS('height', '1px')
  await expect(menu.getByRole('menuitem', { name: '原生历史迁移（高级）' }).locator('svg.lucide-history')).toBeVisible()
  await page.getByRole('menuitem', { name: '原生历史迁移（高级）' }).click()
  await expect(page.getByRole('button', { name: '在 NewMax 继续' })).toBeEnabled()
  await expect(page.locator('.source-target-card')).toHaveCount(2)
  await expect(page.locator('.source-target-unavailable')).toHaveCount(0)
  const targets = await page.evaluate(async () => {
    const entry = (await window.staithe.sources.page({})).items[0]
    return (await window.staithe.sourceActions!.inspect(entry.id)).targets
  })
  expect(targets.map(target => target.id)).toEqual(['newmax', 'codex'])
  expect(targets.every(target => target.implemented)).toBe(true)
  await page.getByRole('button', { name: '在 Codex 继续' }).click()
  const dialog = page.getByRole('dialog', { name: '原生历史迁移（高级）' })
  await expect(dialog.locator('.source-target-card')).toHaveCount(1)
  await expect(dialog.locator('.source-target-unavailable')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '在 NewMax 继续' })).toHaveCount(0)
  await expect(page.getByRole('group', { name: '在哪里继续？' })).toBeVisible()
  await page.getByRole('button', { name: '更换 App' }).click()
  await expect(page.getByRole('group', { name: '在哪里继续？' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '在 NewMax 继续' })).toBeFocused()
  await expect(page.getByRole('button', { name: '在 Codex 继续' })).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: '在 Codex 继续' }).click()
  await expect(dialog.locator('.source-target-card')).toHaveCount(1)
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
      api.continueInTarget!(id, 'newmax', { kind: 'standalone' }).then(() => false, () => true),
      api.deliverHandoffFile!('11111111-1111-4111-8111-111111111111', 'copy-open' as never).then(() => false, () => true),
      api.configureTarget!('newmax', '11111111-1111-4111-8111-111111111111').then(() => false, () => true),
      api.continueInTarget!(id, 'codex', { kind: 'standalone', path: '/arbitrary' } as never).then(() => false, () => true),
      api.continueInTarget!('file:///etc/passwd', 'codex', { kind: 'standalone' }).then(() => false, () => true),
    ])
  })
  expect(results).toEqual(Array(9).fill(true))
  expect(await readFile(dbPath)).toEqual(before)
  expect(await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest.opened)).toEqual([])
})

macTest('更多菜单查看NewMax原会话，辅助复制和导出不再有目标或敏感表单', async () => {
  const before = await readFile(dbPath)
  await connect()
  await expect(page.getByRole('button', { name: '在另一个 App 继续' })).toHaveCount(0)
  await expect(page.locator('.detail-header').getByText('来源直读')).toHaveCount(0)
  await more()
  await page.getByRole('menuitem', { name: '查看原会话' }).click()
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
    await more(); await page.getByRole('menuitem', { name: '导出聊天记录' }).click()
    await expect(page.locator('.source-actions-feedback')).toContainText('已导出聊天记录')
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

macTest('长标题优先分配宽度，窄窗口操作另起一行；协议不可用不显示死按钮', async () => {
  const title = 'newmax://open?conversation=synthetic-long-title 继续完成 Electron 升级并核对桌面兼容性'
  const db = new DatabaseSync(dbPath)
  db.prepare('UPDATE conversations SET title = ?').run(title); db.close()
  await connect()
  const header = page.locator('.detail-header')
  for (const width of [1440, 1000]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800), width)
    await page.emulateMedia({ colorScheme: width === 1440 ? 'light' : 'dark' })
    const heading = header.getByRole('heading', { name: title })
    await expect(heading).toBeVisible()
    await expect(heading).toHaveAttribute('title', title)
    const overflow = await heading.evaluate(element => element.scrollWidth > element.clientWidth)
    await expect(heading).toHaveAttribute('data-overflow', String(overflow))
    const typography = await heading.evaluate(element => {
      const style = getComputedStyle(element)
      return { whiteSpace: style.whiteSpace, mask: style.maskImage, height: element.getBoundingClientRect().height, text: element.textContent }
    })
    expect(typography.whiteSpace).toBe('nowrap')
    if (overflow) expect(typography.mask).toContain('linear-gradient')
    else expect(typography.mask).toBe('none')
    expect(typography.height).toBeCloseTo(24, 0)
    expect(typography.text).toBe(title)
    await expect(heading).toHaveAttribute('data-scroll-on-hover', 'true')
    const track = heading.locator('.ds-fade-text-content')
    if (overflow) {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await heading.hover()
      await expect(track).toHaveCSS('animation-name', 'ds-fade-text-scroll')
      await expect.poll(() => track.evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).m41)).toBeLessThan(0)
      const end = await track.evaluate(element => {
        element.getAnimations()[0].finish()
        return { x: new DOMMatrixReadOnly(getComputedStyle(element).transform).m41,
          distance: parseFloat(getComputedStyle(element.parentElement!).getPropertyValue('--fade-scroll-distance')) }
      })
      expect(end.x).toBeCloseTo(-end.distance, 1)
      await page.mouse.move(0, 0)
      await expect(track).toHaveCSS('animation-name', 'none')
      await expect(track).toHaveCSS('transform', 'none')
      await heading.hover()
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect(track).toHaveCSS('animation-name', 'none')
      await expect(track).toHaveCSS('transform', 'none')
      await page.mouse.move(0, 0)
    } else await expect(track).toHaveCSS('animation-name', 'none')
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
  await expect(page.getByRole('note')).toHaveCount(0)
  await expect(page.getByText('原会话打开方式')).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: '查看原会话' })).toHaveCount(0)
  await expect(header.getByRole('button', { name: '在原 App 打开' })).toHaveCount(0)
  await expect(header.getByRole('button', { name: '在另一个 App 继续' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: '复制会话文本' })).toBeEnabled()
  await page.getByRole('menuitem', { name: '复制会话文本' }).click()
  await expect(page.locator('.source-actions-feedback')).toContainText('已复制会话文本')
  expect(await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest.opened)).toEqual([])
})

macTest('Codex只打开既有UUID线程，不创建、不注入或触发模型请求', async () => {
  await connect('Codex')
  await more()
  await page.getByRole('menuitem', { name: '查看原会话' }).click()
  await expect(page.locator('.source-actions-feedback')).toContainText('已请求 Codex 打开原会话')
  expect(await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest.opened)).toEqual([`codex://threads/${codexThreadId}`])
})

macTest('IPC拒绝任意URL、未知ID及断开后的打开请求；协议失效不调用系统打开', async () => {
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
  await more()
  await page.getByRole('menuitem', { name: '查看原会话' }).click()
  await expect(page.locator('.source-actions-feedback')).toContainText('未找到已关联此协议')
  await page.evaluate(async id => window.staithe.sources.disconnect(id), entry.connectionId)
  expect(await page.evaluate(async id => window.staithe.sourceActions!.openOriginal(id).then(() => false, () => true), entry.id)).toBe(true)
  expect(await app.evaluate(() => (globalThis as unknown as { actionTest: State }).actionTest.opened)).toEqual([])
})

test('导出取消不落盘，错误扩展名、链接与超限文本不写入', async () => {
  await connect()
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }) })
  await more(); await page.getByRole('menuitem', { name: '导出聊天记录' }).click()
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
