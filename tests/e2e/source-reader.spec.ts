import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { claudeFixture, claudeLocalCommandRecords, claudeRecords } from '../fixtures/claude-code'
import { startElectronDiagnostics, finishElectronDiagnostics } from '../support/electron-diagnostics'

let app: ElectronApplication | undefined, root: string

test.afterEach(async ({}, testInfo) => {
  try {
    if (app) await finishElectronDiagnostics(app, testInfo, Boolean(process.env.CI))
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
  task[1].entrypoint = 'cli'
  task[1].message = { role: 'user', content: 'Task: 验证合成页面\n\nCurrent URL: file:///synthetic/gallery.html\nViewport: 400x800\n\nPage snapshot:\n<script>window.untrustedExecuted=true</script>\n页面隐藏标记' }
  task[3].message = { role: 'assistant', id: 'tool', content: [{ type: 'tool_use', id: 'call', name: 'synthetic_browser', input: { selector: '#synthetic' } }] }
  task[4] = { ...task[1], uuid: 'result', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: '合成工具结果标记' }] } }
  task.push({ ...task[3], uuid: 'after-result', parentUuid: 'result', apiBlockIndex: 1,
    message: { role: 'assistant', id: 'tool', content: [{ type: 'text', text: '工具完成后的真实答复' }] } })
  const taskBytes = claudeFixture(task)
  await writeFile(join(source, 'task.jsonl'), taskBytes)
  const legacy = claudeRecords().map(record => { const { apiBlockIndex: _index, ...rest } = record; return rest })
  await writeFile(join(source, 'legacy.jsonl'), claudeFixture([
    { type: 'mode', mode: 'synthetic', sessionId: legacy[1].sessionId },
    { type: 'permission-mode', permissionMode: 'synthetic-setting-not-message', sessionId: legacy[1].sessionId },
    { type: 'atis-latch', atis: false, sessionId: legacy[1].sessionId },
    ...legacy,
  ]))
  const sdk = claudeRecords(); sdk[1].entrypoint = 'sdk-ts'
  sdk[1].message = { role: 'user', content: 'NewMax 内部 SDK 浏览器任务，不应冒充 Claude Code' }
  const longSdkSidechain = sdk.map(record => record.uuid ? { ...record, isSidechain: true } : record)
  longSdkSidechain.splice(2, 0, ...Array.from({ length: 18 }, () => ({ type: 'file-history-snapshot', snapshot: 'x'.repeat(64_000) })))
  await writeFile(join(source, 'sdk-task.jsonl'), claudeFixture(longSdkSidechain))
  await writeFile(join(source, 'helper.jsonl'), JSON.stringify({ type: 'queue-operation' }) + '\n')
  const commandBytes = claudeFixture(claudeLocalCommandRecords())
  await writeFile(join(source, 'commands.jsonl'), commandBytes)
  const terminal = claudeRecords().slice(1, 2)
  terminal[0].entrypoint = 'cli'
  terminal[0].message = { role: 'user', content: '<bash-input>synthetic-command --version</bash-input>' }
  terminal.push({ ...terminal[0], uuid: 'terminal-output', parentUuid: 'u1', message: { role: 'user', content: '<bash-stdout>合成终端输出</bash-stdout><bash-stderr></bash-stderr>' } })
  const terminalBytes = claudeFixture(terminal)
  await writeFile(join(source, 'terminal.jsonl'), terminalBytes)
  const mixed = claudeRecords(); mixed[1].parentUuid = 'terminal-output'
  await writeFile(join(source, 'mixed-terminal.jsonl'), claudeFixture([
    ...terminal.map(record => ({ ...record, uuid: record.uuid === 'u1' ? 'terminal-input' : record.uuid,
      parentUuid: record.parentUuid === 'u1' ? 'terminal-input' : record.parentUuid })), ...mixed,
    { type: 'custom-title', customTitle: '混合终端与真实问答' },
  ]))
  const answerOnly = claudeRecords().slice(3)
  answerOnly[0].parentUuid = null
  const answerOnlyBytes = claudeFixture(answerOnly)
  await writeFile(join(source, 'assistant-only.jsonl'), answerOnlyBytes)
  const journalBytes = claudeFixture([
    { type: 'launched' },
    { type: 'started', agentId: 'synthetic-agent', key: 'synthetic-key', label: '合成调度任务' },
    { type: 'result', agentId: 'synthetic-agent', key: 'synthetic-key', result: '不是用户助手消息' },
  ])
  for (const name of ['one', 'two', 'three']) {
    const directory = join(source, 'subagents', name); await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'journal.jsonl'), journalBytes)
  }
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
  await startElectronDiagnostics(app, Boolean(process.env.CI))
  const page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.session-card')).toHaveCount(4)
  await expect(page.getByRole('button', { name: /^Claude Code\s*4$/ })).toBeVisible()
  expect(await page.evaluate(() => window.staithe.sources.page({ query: 'SDK 浏览器任务' }).then(result => result.total))).toBe(0)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.getByRole('button', { name: '验证合成页面 .', exact: true }).click()
    const detail = page.getByRole('region', { name: '会话消息', exact: true })
    await expect(page.locator('.detail-meta')).toContainText('浏览器任务')
    await expect(page.locator('.detail-meta')).toContainText('2 条来源消息')
    await expect(page.locator('.detail-meta')).toContainText('2 项工具活动')
    await expect(detail.locator('article')).toHaveCount(2)
    await expect(detail.getByText('工具完成后的真实答复', { exact: true })).toBeVisible()
    await expect(detail.getByText(/页面隐藏标记/)).toHaveCount(0)
    await detail.getByText('页面上下文', { exact: true }).click()
    await expect(detail.getByText(/页面隐藏标记/)).toBeVisible()
    await expect(detail.locator('script, a, img, iframe')).toHaveCount(0)
    await expect(detail.getByText('合成工具结果标记', { exact: true })).toHaveCount(0)
    await expect(detail.getByText('调用 · synthetic_browser', { exact: true })).toBeVisible()
    await detail.getByText('结果 · synthetic_browser', { exact: true }).click()
    await expect(detail.getByText('合成工具结果标记', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => 'untrustedExecuted' in window)).toBe(false)
    await page.getByRole('button', { name: '合成问题：整理项目计划 .', exact: true }).click()
    await expect(detail.locator('article')).toHaveCount(2)
    await expect(detail.getByText('合成答复：先确认目标。', { exact: true })).toBeVisible()
  }
  await expect(page.getByRole('button', { name: 'helper.jsonl .', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => window.staithe.sources.page({ query: 'helper.jsonl' }).then(result => result.total))).toBe(0)
  expect(await page.evaluate(() => window.staithe.sources.page({ query: 'journal.jsonl' }).then(result => result.total))).toBe(0)
  expect(await page.evaluate(() => window.staithe.sources.page({ query: 'commands.jsonl' }).then(result => result.total))).toBe(0)
  expect(await page.evaluate(() => window.staithe.sources.page({ query: 'terminal.jsonl' }).then(result => result.total))).toBe(1)
  expect(await page.evaluate(() => window.staithe.sources.page({ query: 'synthetic-command' }).then(result => result.total))).toBe(0)
  await page.getByRole('button', { name: '混合终端与真实问答 .', exact: true }).click()
  const mixedDetail = page.getByRole('region', { name: '会话消息', exact: true })
  await expect(mixedDetail.locator('article')).toHaveCount(2)
  await expect(page.locator('.detail-meta')).toContainText('2 条来源消息')
  await expect(mixedDetail.getByText('合成答复：先确认目标。', { exact: true })).toBeVisible()
  await expect(mixedDetail.getByText(/synthetic-command|合成终端输出|bash-input|bash-stdout/)).toHaveCount(0)
  const answerOnlyCard = page.getByRole('button', { name: 'assistant-only.jsonl .', exact: true })
  await answerOnlyCard.click()
  const answerOnlyTitle = page.getByRole('region', { name: '来源会话详情' }).getByRole('heading', { level: 2, name: 'assistant-only.jsonl', exact: true })
  await expect(answerOnlyTitle).toBeVisible()
  await expect(answerOnlyCard).toBeVisible()
  await page.getByRole('button', { name: '合成问题：整理项目计划 .', exact: true }).click()
  await answerOnlyCard.click()
  await expect(answerOnlyTitle).toBeVisible()
  expect(await page.evaluate(() => window.staithe.sources.page({ query: 'assistant-only.jsonl' }).then(result => result.items[0].title))).toBe('assistant-only.jsonl')
  expect(await readFile(join(source, 'assistant-only.jsonl'))).toEqual(answerOnlyBytes)
  expect(await readFile(join(source, 'terminal.jsonl'))).toEqual(terminalBytes)
  expect(await readFile(join(source, 'commands.jsonl'))).toEqual(commandBytes)
  expect(await readFile(join(source, 'subagents', 'one', 'journal.jsonl'))).toEqual(journalBytes)
  expect(await readFile(join(source, 'task.jsonl'))).toEqual(taskBytes)
})
