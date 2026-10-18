import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { claudeFixture, claudeRecords } from '../fixtures/claude-code'

let app: ElectronApplication | undefined, root: string

test.afterEach(async () => {
  try {
    if (app?.process().exitCode === null) {
      const state = await app.evaluate(({ BrowserWindow, app }) => ({ active: process.platform === 'darwin' && app.isActive(),
        visible: BrowserWindow.getAllWindows().some(window => window.isVisible() || window.isFocused()),
        events: (globalThis as unknown as { windowEvents: string[] }).windowEvents }))
      expect(state).toEqual({ active: false, visible: false, events: [] })
    }
  } finally { await app?.close(); if (root) await rm(root, { recursive: true, force: true }) }
})

test('来源阅读区分任务、工具和问答，折叠页面上下文，兼容旧日志且不执行历史内容', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-reader-e2e-')))
  const data = join(root, 'data'), source = join(root, 'source')
  await mkdir(data); await mkdir(source); await mkdir(join(root, 'appData'))
  const task = claudeRecords()
  task[1].message = { role: 'user', content: 'Task: 验证合成页面\n\nCurrent URL: http://localhost/synthetic\nViewport: 400x800\n\nPage snapshot:\n<script>window.untrustedExecuted=true</script>\n页面隐藏标记' }
  task[3].message = { role: 'assistant', id: 'tool', content: [{ type: 'tool_use', id: 'call', name: 'synthetic_browser', input: { selector: '#synthetic' } }] }
  task[4] = { ...task[1], uuid: 'result', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: '合成工具结果标记' }] } }
  const taskBytes = claudeFixture(task)
  await writeFile(join(source, 'task.jsonl'), taskBytes)
  const legacy = claudeRecords().map(record => { const { apiBlockIndex: _index, ...rest } = record; return rest })
  await writeFile(join(source, 'legacy.jsonl'), claudeFixture(legacy))
  await writeFile(join(source, 'helper.jsonl'), JSON.stringify({ type: 'queue-operation' }) + '\n')
  await writeFile(join(data, 'connections.json'), JSON.stringify({ version: 1, connections: [{ id: '11111111-2222-4333-8444-555555555555', source: 'claude-code', path: source }] }))
  const bootstrap = join(root, 'start.cjs')
  await writeFile(bootstrap, `const {app, dialog, clipboard}=require('electron');
    app.setPath('home',${JSON.stringify(root)}); app.setPath('appData',${JSON.stringify(join(root, 'appData'))});
    globalThis.windowEvents=[]; app.on('browser-window-created',(_event,window)=>{
      window.on('show',()=>globalThis.windowEvents.push('show'));window.on('focus',()=>globalThis.windowEvents.push('focus'));
    });
    dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]}); clipboard.writeText=()=>{throw new Error('测试不得访问剪贴板')};
    import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});`)
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined &&
    !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'EMBER_DATA_DIR', 'STAITHE_DATA_DIR', 'STAITHE_TEST_BACKGROUND', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME', 'NEWMAX_USER_DATA_DIR'].includes(entry[0])))
  app = await electron.launch({ args: [bootstrap], env: { ...env, STAITHE_DATA_DIR: data, STAITHE_TEST_BACKGROUND: '1' } })
  const page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.session-card')).toHaveCount(3)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.getByRole('button', { name: '验证合成页面 .', exact: true }).click()
    const detail = page.getByRole('region', { name: '会话消息', exact: true })
    await expect(page.locator('.detail-meta')).toContainText('浏览器任务')
    await expect(page.locator('.detail-meta')).toContainText('1 条消息')
    await expect(page.locator('.detail-meta')).toContainText('2 项工具活动')
    await expect(detail.locator('article')).toHaveCount(1)
    await expect(detail.getByText(/页面隐藏标记/)).toHaveCount(0)
    await detail.getByText('页面上下文', { exact: true }).click()
    await expect(detail.getByText(/页面隐藏标记/)).toBeVisible()
    await expect(detail.locator('script, a, img, iframe')).toHaveCount(0)
    await expect(detail.getByText('合成工具结果标记', { exact: true })).toHaveCount(0)
    await detail.getByText('工具活动 · 1 次调用 · 1 条结果', { exact: true }).click()
    await detail.getByText('结果 · synthetic_browser', { exact: true }).click()
    await expect(detail.getByText('合成工具结果标记', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => 'untrustedExecuted' in window)).toBe(false)
    await page.getByRole('button', { name: '合成问题：整理项目计划 .', exact: true }).click()
    await expect(detail.locator('article')).toHaveCount(2)
    await expect(detail.getByText('合成答复：先确认目标。', { exact: true })).toBeVisible()
  }
  await page.getByRole('button', { name: 'helper.jsonl .', exact: true }).click()
  await expect(page.locator('.detail')).toContainText('仅含辅助运行记录')
  expect(await readFile(join(source, 'task.jsonl'))).toEqual(taskBytes)
})
