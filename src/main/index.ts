import { app, BrowserWindow, ipcMain, dialog, clipboard, type IpcMainInvokeEvent } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { open } from 'node:fs/promises'
import { z } from 'zod'
import { Library } from './library'
import { ImportCoordinator } from './imports'
import { readImportFile } from './import-file'
import { getBackgroundTestMode, getTestWindowOptions, getWindowChrome, presentWindow } from './window-options'
import { MAX_BYTES, idSchema, makeBundle, makeHandoff, parseDeepLink } from '../core/session'
import { getAppIconFilename, setDevelopmentDockIcon } from './app-icon'
import { SourceBrowser } from './source-browser'
import { autoConnectSource } from './source-discovery'
import { connectionIdSchema, entryIdSchema, sourceCheckSchema, sourceQuerySchema, sourceSchema } from '../core/sources'

const here = dirname(fileURLToPath(import.meta.url))
const appIconPath = join(here, '../../resources', getAppIconFilename(process.platform))
let window: BrowserWindow | null = null
let rendererReady = false
let pendingId: string | null = null
let importer: ImportCoordinator | undefined
let choosingImport = false
// 显示名与存储身份分离，沿用旧包名对应的目录，不搬动或重写已有档案。
const dataOverride = !app.isPackaged && (process.env.STAITHE_DATA_DIR || process.env.EMBER_DATA_DIR)
app.setPath('userData', dataOverride || join(app.getPath('appData'), '@newmax-ai/ember'))
app.setName('Pinekin')
const backgroundTesting = getBackgroundTestMode(app.isPackaged, process.env.STAITHE_TEST_BACKGROUND)
if (backgroundTesting && process.platform === 'darwin') app.setActivationPolicy('accessory')

function deliverLink(value: string) {
  const id = parseDeepLink(value)
  if (!id) return
  if (window && rendererReady) window.webContents.send('staithe:open-session', id)
  else pendingId = id
  presentWindow(window, backgroundTesting)
}
function assertSender(event: IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('拒绝不可信的请求来源')
  }
}
function createWindow() {
  rendererReady = false
  window = new BrowserWindow({
    width: 1380, height: 900, minWidth: 1000, minHeight: 680,
    ...getWindowChrome(process.platform),
    ...getTestWindowOptions(backgroundTesting),
    title: 'Pinekin', icon: appIconPath, backgroundColor: '#f5f2eb',
    webPreferences: { preload: join(here, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      ...(backgroundTesting ? { backgroundThrottling: false, focusOnNavigation: false } : {}) },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('did-start-loading', () => importer?.clear())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.on('closed', () => { window = null; rendererReady = false; importer?.clear() })
  if (import.meta.env.DEV && process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(here, '../renderer/index.html'))
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('open-url', (event, url) => { event.preventDefault(); deliverLink(url) })
  app.on('second-instance', (_event, argv) => {
    argv.forEach(deliverLink)
    presentWindow(window, backgroundTesting)
  })
  process.argv.forEach(deliverLink)
  void app.whenReady().then(async () => {
    setDevelopmentDockIcon(app.dock, appIconPath, { platform: process.platform, isPackaged: app.isPackaged, backgroundTesting })
    const library = new Library(app.getPath('userData'))
    const imports = new ImportCoordinator(library)
    importer = imports
    const sourceBrowser = new SourceBrowser(app.getPath('userData'))
    let choosingSource = false
    ipcMain.handle('pinekin:sources-connections', event => { assertSender(event); return sourceBrowser.connections() })
    ipcMain.handle('pinekin:sources-page', (event, query: unknown) => { assertSender(event); return sourceBrowser.page(sourceQuerySchema.parse(query)) })
    ipcMain.handle('pinekin:sources-read', (event, id: unknown) => { assertSender(event); return sourceBrowser.read(entryIdSchema.parse(id)) })
    ipcMain.handle('pinekin:sources-refresh', (event, id: unknown) => { assertSender(event); return sourceBrowser.refresh(connectionIdSchema.parse(id)) })
    ipcMain.handle('pinekin:sources-check', (event, query: unknown) => { assertSender(event); return sourceBrowser.check(sourceCheckSchema.parse(query)) })
    ipcMain.handle('pinekin:sources-cancel', (event, id: unknown) => { assertSender(event); return sourceBrowser.cancel(connectionIdSchema.parse(id)) })
    ipcMain.handle('pinekin:sources-disconnect', (event, id: unknown) => { assertSender(event); return sourceBrowser.disconnect(connectionIdSchema.parse(id)) })
    ipcMain.handle('pinekin:sources-auto-connect', async (event, rawSource: unknown) => {
      assertSender(event)
      const source = sourceSchema.parse(rawSource)
      if (choosingSource) throw new Error('已有来源连接正在处理')
      choosingSource = true
      try {
        return await autoConnectSource(sourceBrowser, source, {
          home: app.getPath('home'), appData: app.getPath('appData'), platform: process.platform, env: process.env,
        }, () => assertSender(event))
      } finally { choosingSource = false }
    })
    ipcMain.handle('pinekin:sources-connect', async (event, rawSource: unknown) => {
      assertSender(event)
      const source = sourceSchema.parse(rawSource)
      if (choosingSource) throw new Error('已有来源位置选择正在处理')
      choosingSource = true
      try {
        const result = await dialog.showOpenDialog(window!, {
          title: '授权只读浏览所选位置的全部会话；不导入正文、不写入来源',
          properties: [source === 'newmax' || source === 'cindy' ? 'openFile' : 'openDirectory'],
        })
        assertSender(event)
        if (result.canceled || !result.filePaths[0]) return null
        const connection = await sourceBrowser.connect(source, result.filePaths[0])
        if (connection.status !== 'scanning') await sourceBrowser.refresh(connection.id)
        await sourceBrowser.waitForScan(connection.id)
        assertSender(event)
        return (await sourceBrowser.connections()).find(item => item.id === connection.id) ?? connection
      } finally { choosingSource = false }
    })
    ipcMain.handle('staithe:list', event => { assertSender(event); return library.list() })
    ipcMain.handle('staithe:ready', event => {
      assertSender(event); rendererReady = true
      if (pendingId) { window!.webContents.send('staithe:open-session', pendingId); pendingId = null }
    })
    ipcMain.handle('staithe:copy', (event, text: unknown) => {
      assertSender(event); return clipboard.writeText(z.string().max(MAX_BYTES * 2).parse(text))
    })
    ipcMain.handle('staithe:import-preview', async event => {
      assertSender(event)
      if (choosingImport) throw new Error('已有文件选择或导入预览正在处理')
      choosingImport = true
      imports.clear()
      try {
        const result = await dialog.showOpenDialog(window!, {
          title: '选择会话文件，只读预览后确认导入', properties: ['openFile'],
          filters: [{ name: 'Pinekin / Staithe / Ember / NewMax / Claude Code / Cindy / Codex / DeepSeek Harness 会话文件', extensions: ['json', 'jsonl', 'zst', 'zstd', 'cshare', 'xdtshare'] }],
        })
        assertSender(event)
        if (result.canceled || !result.filePaths[0]) return null
        const buffer = await readImportFile(result.filePaths[0])
        assertSender(event)
        return await imports.prepare(buffer)
      } finally { choosingImport = false }
    })
    ipcMain.handle('staithe:import-confirm', (event, token: unknown) => {
      assertSender(event); return imports.commit(z.uuid().parse(token))
    })
    ipcMain.handle('staithe:import-cancel', (event, token: unknown) => {
      assertSender(event); imports.cancel(z.uuid().parse(token))
    })
    ipcMain.handle('staithe:export', async (event, rawId: unknown, rawFormat: unknown, rawTarget: unknown) => {
      assertSender(event)
      const id = idSchema.parse(rawId)
      const format = z.enum(['bundle', 'markdown']).parse(rawFormat)
      const target = z.enum(['通用', 'NewMax', 'Claude Code', 'Codex']).parse(rawTarget)
      const session = (await library.list()).find(s => s.id === id)
      if (!session) throw new Error('未找到会话')
      const isBundle = format === 'bundle'
      const content = isBundle ? JSON.stringify(makeBundle(session), null, 2) : makeHandoff(session, target)
      if (isBundle && Buffer.byteLength(content) > MAX_BYTES) throw new Error('文本包超过 5 MB，无法保证重新导入；请改用 Markdown')
      const result = await dialog.showSaveDialog(window!, {
        title: '导出前请检查是否包含敏感内容', defaultPath: `pinekin-${id}.${isBundle ? 'staithe.json' : 'md'}`,
        filters: [{ name: isBundle ? 'Pinekin 会话包' : 'Markdown', extensions: [isBundle ? 'json' : 'md'] }],
      })
      if (result.canceled || !result.filePath) return false
      const file = await open(result.filePath, 'w', 0o600)
      try { await file.writeFile(content, 'utf8') } finally { await file.close() }
      return true
    })
    // 开发模式不注册系统协议；旧协议保留为兼容入口。
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient('newmax-staithe')
      app.setAsDefaultProtocolClient('newmax-ember')
    }
    // 先将已有连接置为加载中，再创建窗口；扫描在后台继续，不阻塞首屏。
    // 配置读取失败仍会由 page/connections API 反馈给界面，不隐藏错误或覆盖配置。
    try { await sourceBrowser.restoreConnections() }
    catch (error) { console.error('恢复已授权来源失败：', error) }
    createWindow()
    app.on('activate', () => { if (!window) createWindow() })
  })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}
