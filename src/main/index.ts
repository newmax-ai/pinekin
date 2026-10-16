import { app, BrowserWindow, ipcMain, dialog, clipboard, type IpcMainInvokeEvent } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { open } from 'node:fs/promises'
import { z } from 'zod'
import { Library } from './library'
import { MAX_BYTES, idSchema, makeBundle, makeHandoff, parseDeepLink } from '../core/session'

const here = dirname(fileURLToPath(import.meta.url))
let window: BrowserWindow | null = null
let rendererReady = false
let pendingId: string | null = null
// 显示名与存储身份分离，沿用旧包名对应的目录，不搬动或重写已有档案。
const dataOverride = !app.isPackaged && (process.env.STAITHE_DATA_DIR || process.env.EMBER_DATA_DIR)
app.setPath('userData', dataOverride || join(app.getPath('appData'), '@newmax-ai/ember'))
app.setName('Staithe')

function deliverLink(value: string) {
  const id = parseDeepLink(value)
  if (!id) return
  if (window && rendererReady) window.webContents.send('staithe:open-session', id)
  else pendingId = id
  if (window?.isMinimized()) window.restore()
  window?.show()
  window?.focus()
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
    title: 'Staithe', backgroundColor: '#f5f2eb',
    webPreferences: { preload: join(here, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.on('closed', () => { window = null; rendererReady = false })
  if (import.meta.env.DEV && process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(here, '../renderer/index.html'))
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('open-url', (event, url) => { event.preventDefault(); deliverLink(url) })
  app.on('second-instance', (_event, argv) => {
    argv.forEach(deliverLink)
    window?.show(); window?.focus()
  })
  process.argv.forEach(deliverLink)
  void app.whenReady().then(() => {
    const library = new Library(app.getPath('userData'))
    ipcMain.handle('staithe:list', event => { assertSender(event); return library.list() })
    ipcMain.handle('staithe:ready', event => {
      assertSender(event); rendererReady = true
      if (pendingId) { window!.webContents.send('staithe:open-session', pendingId); pendingId = null }
    })
    ipcMain.handle('staithe:copy', (event, text: unknown) => {
      assertSender(event); return clipboard.writeText(z.string().max(MAX_BYTES * 2).parse(text))
    })
    ipcMain.handle('staithe:import', async event => {
      assertSender(event)
      const result = await dialog.showOpenDialog(window!, {
        title: '导入 Staithe 会话包（兼容 Ember）', properties: ['openFile'], filters: [{ name: 'Staithe / Ember 会话包', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePaths[0]) return null
      const file = await open(result.filePaths[0], 'r')
      try {
        if (!(await file.stat()).isFile()) throw new Error('请选择普通文件')
        // 有界读取，避免文件选择后被替换或增长而造成无界内存分配。
        const buffer = Buffer.alloc(MAX_BYTES + 1)
        let count = 0
        while (count < buffer.length) {
          const { bytesRead } = await file.read(buffer, count, buffer.length - count, null)
          if (bytesRead === 0) break
          count += bytesRead
        }
        if (count > MAX_BYTES) throw new Error('文件过大，最大支持 5 MB')
        return await library.importText(buffer.subarray(0, count).toString('utf8'))
      } finally { await file.close() }
    })
    ipcMain.handle('staithe:export', async (event, rawId: unknown, rawFormat: unknown, rawTarget: unknown) => {
      assertSender(event)
      const id = idSchema.parse(rawId)
      const format = z.enum(['bundle', 'markdown']).parse(rawFormat)
      const target = z.enum(['通用', 'NewMax', 'Claude Code', 'Codex']).parse(rawTarget)
      const session = (await library.list()).find(s => s.id === id)
      if (!session) throw new Error('未找到会话')
      const isBundle = format === 'bundle'
      const result = await dialog.showSaveDialog(window!, {
        title: '导出前请检查是否包含敏感内容', defaultPath: `staithe-${id}.${isBundle ? 'staithe.json' : 'md'}`,
        filters: [{ name: isBundle ? 'Staithe 会话包' : 'Markdown', extensions: [isBundle ? 'json' : 'md'] }],
      })
      if (result.canceled || !result.filePath) return false
      const content = isBundle ? JSON.stringify(makeBundle(session), null, 2) : makeHandoff(session, target)
      const file = await open(result.filePath, 'w', 0o600)
      try { await file.writeFile(content, 'utf8') } finally { await file.close() }
      return true
    })
    // 开发模式不注册系统协议；旧协议保留为兼容入口。
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient('newmax-staithe')
      app.setAsDefaultProtocolClient('newmax-ember')
    }
    createWindow()
    app.on('activate', () => { if (!window) createWindow() })
  })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}
