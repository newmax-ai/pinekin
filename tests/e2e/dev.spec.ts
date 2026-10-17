import { test, expect, chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureSessions as demoSessions } from '../fixtures/sessions'

test('开发入口隔离宿主环境并在后台真正渲染 React', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'staithe-dev-test-'))
  await writeFile(join(directory, 'library.json'), JSON.stringify(demoSessions))
  const child = spawn(process.execPath, ['scripts/desktop.mjs', 'dev'], {
    detached: process.platform !== 'win32',
    env: { ...process.env, STAITHE_DATA_DIR: directory, EMBER_DATA_DIR: join(directory, 'unused-legacy'), STAITHE_TEST_BACKGROUND: '1', REMOTE_DEBUGGING_PORT: '0',
      ELECTRON_EXEC_PATH: 'invalid-parent-electron', ELECTRON_RENDERER_URL: 'http://localhost:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  let timer: NodeJS.Timeout | undefined
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`开发启动超时：${log}`)), 20_000)
      const consume = (data: Buffer) => {
        log += data.toString()
        const match = log.match(/DevTools listening on (ws:\/\/\S+)/)
        if (match) { clearTimeout(timer); resolve(match[1]) }
      }
      child.stdout.on('data', consume); child.stderr.on('data', consume)
      child.on('error', reject)
      child.on('exit', code => reject(new Error(`开发入口退出 ${code}：${log}`)))
    })
    const browser = await chromium.connectOverCDP(endpoint)
    try {
      const context = browser.contexts()[0]
      const page = context.pages()[0] ?? await context.waitForEvent('page')
      await expect(page.getByRole('heading', { level: 2, name: '让思考跨越工具，继续生长' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Pin 走这段对话' })).toBeVisible()
    } finally { await browser.close() }
  } finally {
    clearTimeout(timer)
    if (child.pid) {
      if (process.platform === 'win32') child.kill()
      else { try { process.kill(-child.pid, 'SIGTERM') } catch { /* 子进程可能已经退出。 */ } }
    }
    if (child.exitCode === null) await new Promise<void>(resolve => child.once('exit', () => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
