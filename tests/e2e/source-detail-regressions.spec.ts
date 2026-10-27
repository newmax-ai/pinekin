import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { deepseekFixture, deepseekRecords } from '../fixtures/deepseek'
import { codexFixture, codexMeta, codexMessage, codexPluginContext, codexFilesPrompt, codexActualRequest } from '../fixtures/codex'
import { createCindyDatabase } from '../fixtures/cindy-database'

let app: ElectronApplication | undefined, root: string

test.afterEach(async () => {
  try {
    if (app?.process().exitCode === null) expect(await app.evaluate(({ BrowserWindow, app }) => ({ active: process.platform === 'darwin' && app.isActive(),
      visible: BrowserWindow.getAllWindows().some(window => window.isVisible() || window.isFocused()),
      events: (globalThis as unknown as { windowEvents: string[] }).windowEvents }))).toEqual({ active: false, visible: false, events: [] })
  } finally { await app?.close(); if (root) await rm(root, { recursive: true, force: true }) }
})

test('压缩 DeepSeek 首次标题、Codex 子会话、Cindy 普通正文与安全 Markdown 联动', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-detail-e2e-')))
  const data = join(root, 'data'), deepseek = join(root, 'deepseek'), codex = join(root, 'codex'), database = join(root, 'synthetic.db')
  for (const path of [data, deepseek, codex, join(root, 'appData')]) await mkdir(path)
  const records = deepseekRecords()
  ;((records[4].data as { message: { content: unknown[] } }).message).content = [{ type: 'text', text: '## 合成 Markdown 标题\n\n**重要结论**与`inline`\n\n1. 第一项\n2. 第二项\n\n| 项目 | 状态 |\n| --- | --- |\n| 合成 | 完成 |\n\n> 引用说明\n\n```ts\nconst value = 1\n```\n\n![不加载图片](https://invalid.example/image.png)\n\n[外部标签](javascript:alert(1))\n\n<script>window.untrustedExecuted=true</script>' }]
  const compressed = zstdCompressSync(deepseekFixture(records))
  await writeFile(join(deepseek, 'session.v4.jsonl.zstd'), compressed)
  const meta = codexMeta(); meta.payload = { ...meta.payload as object, source: { subagent: 'review' } }
  const codexBytes = codexFixture([meta,
    codexMessage('user', [{ type: 'input_text', text: codexPluginContext }]),
    codexMessage('user', [{ type: 'input_text', text: codexFilesPrompt + '\n<image 1>' },
      { type: 'input_image', image_url: 'file:///synthetic/attachments/screenshot.png' },
      { type: 'input_text', text: '</image 1>' }]),
    codexMessage('assistant', [{ type: 'output_text', text: '子会话的实际答复' }])])
  await writeFile(join(codex, 'subagent.jsonl'), codexBytes)
  const withSqlite = process.platform === 'darwin'
  let beforeDatabase: Buffer | undefined
  if (withSqlite) {
  const writer = new DatabaseSync(database); createCindyDatabase(writer)
  writer.exec(`INSERT INTO sessions(id,title,parent_session_id,updated_at) VALUES('fork','不支持的分叉会话','parent',2100);
    INSERT INTO sessions(id,title,source,updated_at) VALUES('bot','不支持的 Bot 会话','bot',2200);
    INSERT INTO sessions(id,title,updated_at) VALUES('worker','不支持的协作会话',2300);
    INSERT INTO orca_workers VALUES('worker');
    INSERT INTO sessions(id,title,updated_at) VALUES('large','分段阅读合成大会话',2400);`)
  writer.exec('BEGIN')
  const insert = writer.prepare('INSERT INTO messages VALUES(?,?,?,?,?,NULL)')
  for (let index = 0; index < 101; index++) insert.run(`large-${index}`, 'large', 'assistant', `第 ${index + 1} 条合成消息\n` + 'x'.repeat(60_000), 2500 + index)
  writer.exec('COMMIT')
  writer.close()
  beforeDatabase = await readFile(database)
  }
  await writeFile(join(data, 'connections.json'), JSON.stringify({ version: 1, connections: [
    { id: '11111111-2222-4333-8444-555555555551', source: 'deepseek', path: deepseek },
    { id: '11111111-2222-4333-8444-555555555552', source: 'codex', path: codex },
    ...(withSqlite ? [{ id: '11111111-2222-4333-8444-555555555553', source: 'cindy', path: database }] : []),
  ] }))
  const bootstrap = join(root, 'start.cjs')
  await writeFile(bootstrap, `const {app,dialog,clipboard}=require('electron');
    app.setPath('home',${JSON.stringify(root)});app.setPath('appData',${JSON.stringify(join(root, 'appData'))});
    globalThis.windowEvents=[];app.on('browser-window-created',(_event,window)=>{window.on('show',()=>globalThis.windowEvents.push('show'));window.on('focus',()=>globalThis.windowEvents.push('focus'))});
    dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});clipboard.writeText=()=>{throw new Error('不得访问系统剪贴板')};
    import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});`)
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined &&
    !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'EMBER_DATA_DIR', 'STAITHE_DATA_DIR', 'STAITHE_TEST_BACKGROUND', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME', 'NEWMAX_USER_DATA_DIR'].includes(entry[0])))
  app = await electron.launch({ args: [bootstrap], env: { ...env, STAITHE_DATA_DIR: data, STAITHE_TEST_BACKGROUND: '1' } })
  const page = await app.firstWindow(); await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.session-card')).toHaveCount(withSqlite ? 4 : 2)
  if (withSqlite) await expect(page.getByRole('button', { name: /^Cindy\s*2$/ })).toBeVisible()
  await expect(page.locator('.session-card').filter({ hasText: '不支持' })).toHaveCount(0)
  expect(await page.evaluate(() => window.staithe.sources.page({ query: '不支持' }).then(result => result.total))).toBe(0)
  // 尚未点击正文时，压缩文件已显示真实标题。
  await expect(page.locator('.session-card').filter({ hasText: 'DeepSeek 合成会话' })).toHaveCount(1)
  await expect(page.locator('.session-card').filter({ hasText: 'session.v4.jsonl.zstd' })).toHaveCount(0)
  const detail = page.getByRole('region', { name: '会话消息', exact: true })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.locator('.session-card').filter({ hasText: 'DeepSeek 合成会话' }).click()
    await expect(detail.getByRole('heading', { name: '合成 Markdown 标题' })).toBeVisible()
    await expect(detail.locator('strong')).toHaveText('重要结论')
    await expect(detail.locator('ol li')).toHaveCount(2)
    await expect(detail.locator('table tbody tr')).toHaveCount(1)
    await expect(detail.locator('blockquote')).toHaveText('引用说明')
    await expect(detail.locator('.code-block code')).toHaveText('const value = 1')
    // 排除应用自带的装饰插画（空 alt、aria-hidden），历史内容渲染出的任何图片、链接与脚本仍须为 0。
    await expect(detail.locator('a,img:not(.conversation-end-illustration),script,iframe,[href],[src]:not(.conversation-end-illustration)')).toHaveCount(0)
    expect(await page.evaluate(() => 'untrustedExecuted' in window)).toBe(false)
    await expect(page.locator('.session-card').filter({ hasText: 'recommended_plugins' })).toHaveCount(0)
    await page.locator('.session-card').filter({ hasText: codexActualRequest }).click()
    await expect(page.locator('.detail-meta')).toContainText('子会话')
    await expect(detail.locator('article')).toHaveCount(2)
    await expect(detail.getByText(codexActualRequest, { exact: true })).toBeVisible()
    await expect(detail.getByText('附件预览暂未支持；未读取附件路径。', { exact: true })).toBeVisible()
    await expect(detail).not.toContainText('Files mentioned by the user:')
    await expect(detail).not.toContainText('未映射内容块')
    await detail.getByText('附件与上下文', { exact: true }).click()
    await expect(detail).toContainText('Files mentioned by the user:')
    await expect(detail).toContainText('未映射内容块')
    await expect(detail.locator('h1,h2,h3,a,img:not(.conversation-end-illustration),script,iframe,[src]:not(.conversation-end-illustration),[href]')).toHaveCount(0)
    await expect(detail.getByText('子会话的实际答复', { exact: true })).toBeVisible()
    // 仅数据库部分需要 macOS；DeepSeek/Codex 的实际日志和安全 Markdown 在 Windows 仍验证。
    if (withSqlite) {
    await page.locator('.session-card').filter({ hasText: 'Cindy 合成正文' }).click()
    await expect(detail.locator('article')).toHaveCount(2)
    await expect(detail.getByText('合成用户问题', { exact: true })).toBeVisible()
    await expect(detail.getByRole('heading', { name: '合成回答' })).toBeVisible()
    await expect(detail).not.toContainText('DO_NOT_PROJECT')
    await page.locator('.session-card').filter({ hasText: '分段阅读合成大会话' }).click()
    await expect(page.locator('.detail-meta')).toContainText('101 条来源消息')
    await expect(detail.locator('article')).toHaveCount(1)
    await expect(detail).toContainText('第 1 条合成消息')
    await expect(detail.getByText('展开当前片段', { exact: true })).toBeVisible()
    await expect(page.locator('.conversation-ending')).toHaveCount(0)
    await page.getByRole('button', { name: '下一段', exact: true }).click()
    await expect(page.getByRole('navigation', { name: '正文分段导航' })).toContainText('第 16385 个字符')
    await expect(detail).not.toContainText('第 1 条合成消息')
    await page.getByRole('button', { name: '上一段', exact: true }).click()
    await expect(detail).toContainText('第 1 条合成消息')
    }
    await expect(page.locator('.session-card')).toHaveCount(withSqlite ? 4 : 2)
  }
  if (beforeDatabase) expect(await readFile(database)).toEqual(beforeDatabase)
  expect(await readFile(join(deepseek, 'session.v4.jsonl.zstd'))).toEqual(compressed)
  expect(await readFile(join(codex, 'subagent.jsonl'))).toEqual(codexBytes)
  expect(await readdir(data)).not.toContain('imports')
})
