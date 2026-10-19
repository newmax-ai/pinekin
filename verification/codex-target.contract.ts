import { expect, it } from 'vitest'
import { lstat, mkdtemp, realpath, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { buildCodexRollout, verifyCodexThread } from '../src/main/codex-target-format'
import { codexVersion, readCodexThread } from '../src/main/codex-target-runtime'
import { CodexTarget } from '../src/main/codex-target'

it('官方 Codex 离线进程能发现新线程并逐字回读已完成的可见历史，重启后仍一致', async () => {
  const binary = process.env.PINEKIN_CODEX_TEST_BINARY
  if (!binary) throw new Error('必须显式指定已核验的隔离 Codex CLI 副本（下载包或完整程序包副本），禁止挂载真实会话目录。')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-codex-contract-run-')))
  try {
    const version = await codexVersion(binary, root).catch(error => {
      console.error('隔离版本探测失败', { code: error.code, signal: error.signal, stderr: error.stderr })
      throw error
    })
    const id = randomUUID(), messages = [{ role: 'user' as const, content: '合成用户问题🙂\n保留换行和空格  '.repeat(10_000) }, { role: 'assistant' as const, content: '合成回答：不运行历史命令。' }, { role: 'user' as const, content: '仅记录，不自动发送。' }]
    const directory = join(root, 'codex/sessions/2026/10/19'); await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `rollout-2026-10-19T00-00-00-${id}.jsonl`), buildCodexRollout({ id, title: '合成接续', cwd: join(root, 'workspace'), version, timestamp: '2026-10-19T00:00:00.000Z', messages }), { flag: 'wx', mode: 0o600 })
    for (let attempt = 0; attempt < 2; attempt++) verifyCodexThread(await readCodexThread(binary, root, id), id, messages)
    const home = join(root, 'target'); await mkdir(home)
    const opened: string[] = []
    const target = CodexTarget.create(join(root, 'pinekin'), { handler: async () => 'Codex', openExternal: async url => { opened.push(url) } })
    await target.configure(binary, home)
    const transfer = { title: '真实适配器合成接续', source: 'newmax' as const, snapshot: 'a'.repeat(64), messages }
    const created = await target.continue('b'.repeat(64), transfer)
    expect(created.opened).toBe(true)
    expect(opened).toEqual([`codex://threads/${created.threadId}`])
    expect((await target.continue('b'.repeat(64), transfer)).threadId).toBe(created.threadId)
    const projectPath = join(root, '合成项目'); await mkdir(projectPath)
    await writeFile(join(projectPath, 'AGENTS.md'), '合成项目指令，不应被接续导入或执行。')
    const stamp = await lstat(projectPath), project = { path: projectPath, dev: stamp.dev, ino: stamp.ino }
    // 生产预演的沙箱临时根与项目是不同目录；不把项目加入沙箱读取白名单。
    const inProject = await target.continue('b'.repeat(64), transfer, undefined, project)
    expect(inProject.threadId).not.toBe(created.threadId)
    expect((await target.continue('b'.repeat(64), transfer, undefined, project)).threadId).toBe(inProject.threadId)
    const receipt = JSON.parse(await readFile(join(root, 'pinekin', 'codex-transfers', inProject.receipt, 'receipt.json'), 'utf8'))
    const meta = JSON.parse((await readFile(receipt.path, 'utf8')).split('\n')[0])
    expect(meta.payload.cwd).toBe(projectPath)
    await target.rollback(inProject.receipt)
    expect(await readdir(projectPath)).toEqual(['AGENTS.md'])
    expect(await readFile(join(projectPath, 'AGENTS.md'), 'utf8')).toBe('合成项目指令，不应被接续导入或执行。')
    await target.rollback(created.receipt)
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
    console.info(`官方 Codex ${version}：隔离创建、可见历史逐字回读与重启回读通过；未发送模型请求。`)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 50_000)
