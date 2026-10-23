import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import { NewMaxTarget } from '../src/main/newmax-target'
import type { SourceTransfer } from '../src/main/source-transfer'

vi.mock('node:net', async importOriginal => {
  const original = await importOriginal<typeof import('node:net')>()
  return { ...original, connect: vi.fn(original.connect) }
})
const digest = (messages: unknown) => createHash('sha256').update(JSON.stringify(messages)).digest('hex')
const transfer: SourceTransfer = { source: 'codex', snapshot: 'snapshot-1', title: '合成历史', messages: [
  { role: 'user', content: '原文\n 空白 🦊' }, { role: 'assistant', content: '历史工具仅作为文本，不执行。' },
] }
let root: string, dataPath: string, server: Server, socketPath: string, instanceId: string
let target: NewMaxTarget
const calls: string[] = []
const receipts = new Map<string, { receipt: string; conversationId: string; digest: string; messageCount: number; workspaceId: string }>()
let invalidDigest = false, failOpen = false, afterPreview: (() => void) | undefined
const guard = vi.fn()
// Unix socket 与 POSIX 私有权限不是 Windows 已验证能力。
describe.skipIf(process.platform === 'win32')('NewMax 原生目标客户端', () => {
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-newmax-target-')))
  dataPath = root; socketPath = join(root, 'api.sock'); instanceId = randomUUID()
  calls.length = 0; receipts.clear(); invalidDigest = false; failOpen = false; afterPreview = undefined; guard.mockReset()
  server = createServer(socket => {
    let text = ''
    socket.on('data', chunk => {
      text += chunk.toString()
      if (!text.endsWith('\n')) return
      void (async () => {
        const envelope = JSON.parse(text), body = envelope.body
        calls.push(body.action)
        if (envelope.token !== 'a'.repeat(64) || envelope.instanceId !== instanceId) throw new Error('wrong endpoint')
        let result: unknown
        if (body.action === 'capabilities') result = { protocol: 'newmax.native-transfer', version: 1, appVersion: '1.1.22',
          dataPath, historyMode: 'text-history', runtimeResume: false, arbitraryDirectories: false,
          features: ['preview', 'backup', 'commit', 'read', 'rollback', 'open', 'workspaces'] }
        else if (body.action === 'workspaces') result = { projects: [{ token: '11111111-1111-4111-8111-111111111111', name: '已有工作区', path: join(root, 'workspace') }] }
        else if (body.action === 'preview') {
          const value = { receipt: body.transfer.requestId, conversationId: randomUUID(), digest: digest(body.transfer.messages), messageCount: body.transfer.messages.length, workspaceId: 'ws' }
          if (!receipts.has(value.receipt)) receipts.set(value.receipt, value)
          result = { ...receipts.get(value.receipt), token: randomUUID(), ...(invalidDigest ? { digest: '0'.repeat(64) } : {}) }
          afterPreview?.()
        } else if (body.action === 'commit') result = { ...[...receipts.values()].at(-1), status: calls.filter(item => item === 'commit').length > 1 ? 'existing' : 'created', backupPath: 'owned-by-newmax' }
        else if (body.action === 'read') result = receipts.get(body.receipt)
        else if (body.action === 'open') result = { opened: !failOpen, ...(failOpen ? { error: '尚未确认目标界面' } : {}) }
        else if (body.action === 'rollback') result = { rolledBack: true }
        else throw new Error('unsupported action')
        socket.end(JSON.stringify({ ok: true, result }))
      })().catch(error => socket.end(JSON.stringify({ ok: false, error: error.message })))
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve)); await chmod(socketPath, 0o600)
  await writeFile(join(dataPath, 'native-transfer.json'), JSON.stringify({ protocol: 'newmax.native-transfer', version: 1,
    appVersion: '1.1.22', dataPath, socketPath, instanceId, token: 'a'.repeat(64) }), { mode: 0o600 })
  target = new NewMaxTarget({ storePath: join(root, 'pinekin'), defaultDataPath: dataPath, chooseDirectory: async () => dataPath })
})
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
})
async function configure() {
  const preview = await target.inspect('automatic', guard)
  expect(preview).toMatchObject({ app: 'NewMax', dataPath, configured: false, canChooseApplication: false })
  await target.configure(preview!.token!, guard)
}

  it('正式能力探测后配置，Pinekin 只保存授权数据根，不保存端点令牌或写 NewMax 数据库', async () => {
    await configure()
    expect(await target.configured()).toBe(true)
    const config = await readFile(join(root, 'pinekin', 'newmax-target.json'), 'utf8')
    expect(config).toContain(dataPath)
    expect(config).not.toContain('a'.repeat(64))
    expect(calls.every(action => action === 'capabilities')).toBe(true)
  })
  it('完整文本预演、复核来源、提交、回读、再打开；正文不发给渲染进程', async () => {
    await configure(); calls.length = 0
    const assertSource = vi.fn(async () => undefined)
    const result = await target.continue('entry', transfer, assertSource, undefined, guard)
    expect(result).toMatchObject({ app: 'NewMax', status: 'created', messageCount: 2, opened: true })
    expect(calls.filter(action => action !== 'capabilities')).toEqual(['preview', 'commit', 'read', 'open'])
    expect(assertSource.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(result).not.toHaveProperty('messages')
    await target.rollback(result.receipt, guard)
    expect(calls.at(-1)).toBe('rollback')
  })
  it('创建成功但打开未确认保留回执，重试复用相同 requestId', async () => {
    await configure(); failOpen = true
    const first = await target.continue('entry', transfer, async () => {}, undefined, guard)
    expect(first).toMatchObject({ opened: false, error: '尚未确认目标界面' })
    const second = await target.continue('entry', transfer, async () => {}, undefined, guard)
    expect(second).toMatchObject({ receipt: first.receipt, threadId: first.threadId, status: 'existing' })
    expect(receipts.size).toBe(1)
  })
  it('来源在预演后变化或预演摘要不一致，绝不提交', async () => {
    await configure(); invalidDigest = true
    await expect(target.continue('entry', transfer, async () => {}, undefined, guard)).rejects.toThrow(/回读|预演|一致/)
    expect(calls).not.toContain('commit')
    invalidDigest = false; let changed = false; afterPreview = () => { changed = true }
    await expect(target.continue('entry', transfer, async () => { if (changed) throw new Error('来源已变化') }, undefined, guard)).rejects.toThrow('来源已变化')
    expect(calls).not.toContain('commit')
  })
  it('实例替换、私有文件权限失效及不支持版本均拒绝接续', async () => {
    await configure()
    const descriptor = JSON.parse(await readFile(join(dataPath, 'native-transfer.json'), 'utf8'))
    await writeFile(join(dataPath, 'native-transfer.json'), JSON.stringify({ ...descriptor, version: 2 }))
    await expect(target.continue('entry', transfer, async () => {}, undefined, guard)).rejects.toThrow(/版本|协议/)
    await writeFile(join(dataPath, 'native-transfer.json'), JSON.stringify(descriptor)); await chmod(join(dataPath, 'native-transfer.json'), 0o644)
    await expect(target.inspect('automatic', guard)).rejects.toThrow(/权限/)
  })
  it('已有工作区令牌与来源条目绑定，不允许任意新目录或跨条目令牌', async () => {
    await configure()
    const list = await target.listProjects('entry', guard)
    expect(list.projects).toHaveLength(1)
    const project = await target.chooseProject('entry', list.projects[0].id, guard)
    expect(project).toMatchObject({ name: '已有工作区', path: join(root, 'workspace') })
    await expect(target.chooseProject('entry', undefined, guard)).rejects.toThrow(/已有工作区/)
    await expect(target.continue('another-entry', transfer, async () => {}, project!.token, guard)).rejects.toThrow(/工作区/)
    await expect(target.continue('entry', transfer, async () => {}, project!.token, guard)).resolves.toMatchObject({ app: 'NewMax', opened: true })
  })
})

it('Windows 明确拒绝正式接续，不连接 socket、不选择目录或保存授权', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-newmax-unsupported-')))
  const chooseDirectory = vi.fn(), connect = vi.spyOn(net, 'connect').mockClear()
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }))
  try {
    const unsupported = new NewMaxTarget({ storePath: join(directory, 'pinekin'), defaultDataPath: directory, chooseDirectory })
    await expect(unsupported.inspect('automatic')).rejects.toThrow('尚未支持 NewMax 正式接续协议')
    expect(connect).not.toHaveBeenCalled()
    expect(chooseDirectory).not.toHaveBeenCalled()
    expect(await readdir(directory)).toEqual([])
  } finally {
    vi.unstubAllGlobals(); connect.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})
