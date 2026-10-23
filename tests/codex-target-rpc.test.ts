import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: mocks.spawn }))
import { readCodexThread } from '../src/main/codex-target-runtime'
let root: string
let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }
beforeEach(async () => {
  // 子进程已完全替换，跨平台保留 RPC 状态机测试；不启动 sandbox-exec。
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }))
  root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-rpc-')))
  child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
  mocks.spawn.mockReturnValue(child)
})
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); mocks.spawn.mockClear(); await rm(root, { recursive: true, force: true }) })
it('Windows 在创建验证目录和启动子进程之前明确拒绝原生接续', async () => {
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }))
  await expect(readCodexThread('/synthetic/codex', root, 'thread')).rejects.toThrow('仅支持 macOS')
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})
async function start() {
  const pending = readCodexThread('/synthetic/codex', root, 'thread')
  const observed = pending.then(value => ({ value }), error => ({ error }))
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())
  return { observed }
}
it('初始化后仅请求 thread/read，忽略通知并保留跨块 UTF-8，结束关闭子进程', async () => {
  const { observed } = await start()
  const sent = [child.stdin.read().toString()]
  child.stdout.write('{"method":"notice"}\n{"id":1,"result":{}}\n')
  sent.push(child.stdin.read().toString())
  expect(sent.join('')).toContain('thread/read')
  expect(sent.join('')).not.toMatch(/turn\/start|thread\/start|thread\/resume/)
  const bytes = Buffer.from(JSON.stringify({ id: 2, result: { content: '🙂中文' } }) + '\n')
  const split = bytes.indexOf(Buffer.from('🙂')) + 1
  child.stdout.write(bytes.subarray(0, split)); child.stdout.write(bytes.subarray(split))
  expect(await observed).toEqual({ value: { content: '🙂中文' } })
  expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  child.emit('close', 0)
})
it.each(['invalid-json', 'rpc-error', 'process-error', 'stdin-error', 'close'] as const)('隔离 RPC %s 不误报成功且结束进程', async kind => {
  const { observed } = await start()
  if (kind === 'invalid-json') child.stdout.write('not-json\n')
  if (kind === 'rpc-error') child.stdout.write('{"id":1,"error":{"code":-1}}\n')
  if (kind === 'process-error') child.emit('error', new Error('synthetic'))
  if (kind === 'stdin-error') child.stdin.emit('error', new Error('synthetic'))
  if (kind === 'close') { child.stderr.write('synthetic diagnostic'); child.emit('close', 1) }
  expect(await observed).toHaveProperty('error')
  expect(child.kill).toHaveBeenCalledOnce()
})
it('不响应时达到固定时限就停止，不无限等待', async () => {
  const { observed } = await start()
  // 使用真实启动后的计时器不能由 fake timers 接管，因此重启一个独立的 fake-timer 调用。
  child.emit('close', 1); await observed
  vi.useFakeTimers(); mocks.spawn.mockClear()
  child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
  mocks.spawn.mockReturnValue(child)
  const pending = readCodexThread('/synthetic/codex', root, 'thread').catch(error => error)
  // fs Promise 不依赖假时钟；等待 spawn 建立协议定时器。
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(20_001)
  expect(await pending).toMatchObject({ message: expect.stringContaining('超时') })
})
