import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { codexFixture, codexMeta, codexMessage } from '../fixtures/codex'

let app: ElectronApplication | undefined, root: string

test.afterEach(async () => {
  try { await app?.close() }
  finally { if (root) await rm(root, { recursive: true, force: true }) }
})

test('Codex ID 冲突条目在点击前过滤，列表和搜索计数一致，正常子会话可读', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-codex-visible-e2e-')))
  const data = join(root, 'data'), source = join(root, 'source'), appData = join(root, 'appData')
  await mkdir(data); await mkdir(source); await mkdir(appData)
  const parent = '11111111-2222-4333-8444-555555555555'
  const conflict = codexFixture([codexMeta({ session_id: parent, source: { subagent: 'review' } }),
    codexMessage('user', [{ type: 'input_text', text: 'The following is the Codex agent history whose request action you are assessing.' }])])
  for (const extension of ['jsonl', 'jsonl.zst', 'jsonl.zstd']) {
    await writeFile(join(source, `conflict.${extension}`), extension === 'jsonl' ? conflict : zstdCompressSync(conflict))
  }
  await writeFile(join(source, 'normal.jsonl'), codexFixture([codexMeta(),
    codexMessage('user', [{ type: 'input_text', text: '普通合成会话' }])]))
  await writeFile(join(source, 'subagent.jsonl.zstd'), zstdCompressSync(codexFixture([codexMeta({ parent_thread_id: parent }),
    codexMessage('user', [{ type: 'input_text', text: '可读合成子会话' }])])))
  await writeFile(join(source, 'broken.jsonl'), 'not-json')
  await writeFile(join(data, 'connections.json'), JSON.stringify({ version: 1,
    connections: [{ id: parent, source: 'codex', path: source }] }))
  const bootstrap = join(root, 'start.cjs')
  await writeFile(bootstrap, `const {app, dialog, clipboard}=require('electron');
    app.setPath('home',${JSON.stringify(root)}); app.setPath('appData',${JSON.stringify(appData)});
    dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});
    dialog.showSaveDialog=async()=>({canceled:true});
    clipboard.readText=()=>{throw new Error('测试不得访问剪贴板')};
    clipboard.writeText=()=>{throw new Error('测试不得访问剪贴板')};
    import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});`)
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined &&
    !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'EMBER_DATA_DIR', 'STAITHE_DATA_DIR', 'STAITHE_TEST_BACKGROUND', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME', 'NEWMAX_USER_DATA_DIR'].includes(entry[0])))
  app = await electron.launch({ args: [bootstrap], env: { ...env, STAITHE_DATA_DIR: data, STAITHE_TEST_BACKGROUND: '1' } })
  const page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.session-card')).toHaveCount(3)
  await expect(page.getByRole('button', { name: /^Codex\s*3$/ })).toBeVisible()
  await expect(page.getByText(/The following is the Codex agent history/)).toHaveCount(0)
  expect(await page.evaluate(() => window.staithe.sources.page({ query: 'conflict' }).then(result => result.total))).toBe(0)
  expect(await page.evaluate(() => window.staithe.sources.page({ query: 'The following is the Codex agent history' }).then(result => result.total))).toBe(0)
  await page.getByRole('button', { name: '普通合成会话 .', exact: true }).click()
  const detail = page.getByRole('region', { name: '会话消息', exact: true })
  await expect(detail.locator('article')).toHaveCount(1)
  await expect(detail.getByText('普通合成会话', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '可读合成子会话 .', exact: true }).click()
  await expect(detail.locator('article')).toHaveCount(1)
  await expect(page.locator('.detail-meta')).toContainText('子会话')
  await expect(detail.getByText('可读合成子会话', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.staithe.sources.page({ query: 'broken' }).then(result => result.total))).toBe(1)
  expect(await readFile(join(source, 'conflict.jsonl'))).toEqual(conflict)
  const state = await app.evaluate(({ BrowserWindow, app }) => ({ active: process.platform === 'darwin' && app.isActive(),
    visible: BrowserWindow.getAllWindows().some(window => window.isVisible() || window.isFocused()) }))
  expect(state).toEqual({ active: false, visible: false })
})
