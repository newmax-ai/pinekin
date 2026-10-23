import { afterEach, describe, expect, it, vi } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CodexTarget } from '../src/main/codex-target'
import type { SourceTransfer } from '../src/main/source-transfer'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))) })
const transfer: SourceTransfer = { title: '合成来源', source: 'newmax', snapshot: 'a'.repeat(64), messages: [{ role: 'user', content: '问题' }, { role: 'assistant', content: '回答' }] }
const entryId = 'b'.repeat(64)
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-codex-target-'))); roots.push(root)
  const home = join(root, 'target'), binary = join(root, 'codex'), data = join(root, 'pinekin')
  await mkdir(home); await writeFile(binary, 'synthetic binary')
  const version = vi.fn().mockResolvedValue('0.163.0')
  const verify = vi.fn().mockResolvedValue(undefined)
  const handler = vi.fn().mockResolvedValue('Codex'), openExternal = vi.fn().mockResolvedValue(undefined)
  const service = new CodexTarget(data, { version, verify, handler, openExternal })
  await service.configure(binary, home)
  return { root, home, binary, data, version, verify, handler, openExternal, service }
}
// 原生写入协议仍限定 macOS/POSIX；Windows 的拒绝且无副作用由 codex-target-rpc.test.ts 覆盖。
describe.runIf(process.platform === 'darwin')('Codex 目标写入事务', () => {
  it('验证程序必须对应系统深链实际关联的 App，不能拿另一版 CLI 自证兼容', async () => {
    const s = await setup()
    const bound = new CodexTarget(s.data, { version: s.version, verify: s.verify, handler: s.handler, openExternal: s.openExternal,
      applicationBinary: async () => '/synthetic/another-codex' })
    await expect(bound.configure(s.binary, s.home)).rejects.toThrow('关联')
    await expect(bound.continue(entryId, transfer)).rejects.toThrow('关联')
    expect(s.openExternal).not.toHaveBeenCalled()
  })
  it('版本探测、隔离预演、备份、独占落盘、回读之后才请求打开，重复点击复用同一新会话', async () => {
    const s = await setup()
    const first = await s.service.continue(entryId, transfer)
    expect(first).toMatchObject({ status: 'created', app: 'Codex', messageCount: 2 })
    expect(s.verify).toHaveBeenCalled()
    expect(s.openExternal).toHaveBeenCalledExactlyOnceWith(`codex://threads/${first.threadId}`)
    const second = await s.service.continue(entryId, transfer)
    expect(second.threadId).toBe(first.threadId)
    expect(second.status).toBe('existing')
    const receipt = JSON.parse(await readFile(join(s.data, 'codex-transfers', first.receipt, 'receipt.json'), 'utf8'))
    expect(await readFile(receipt.path, 'utf8')).toBe(await readFile(join(s.data, 'codex-transfers', first.receipt, 'backup.jsonl'), 'utf8'))
    await s.service.rollback(first.receipt)
    await expect(readFile(receipt.path)).rejects.toThrow()
    const next = await s.service.continue(entryId, transfer)
    expect(next.threadId).not.toBe(first.threadId)
  })
  it('目标已继续编辑时不撤销、不覆盖；仍可重新打开已有会话', async () => {
    const s = await setup(), result = await s.service.continue(entryId, transfer)
    const receipt = JSON.parse(await readFile(join(s.data, 'codex-transfers', result.receipt, 'receipt.json'), 'utf8'))
    await writeFile(receipt.path, '目标中的新内容', { flag: 'a' })
    await expect(s.service.rollback(result.receipt)).rejects.toThrow('已变化')
    expect((await s.service.continue(entryId, transfer)).threadId).toBe(result.threadId)
    expect(await readFile(receipt.path, 'utf8')).toContain('目标中的新内容')
  })
  it('隔离验证失败、协议缺失、授权失效时不向目标落盘', async () => {
    const s = await setup()
    s.verify.mockRejectedValueOnce(new Error('投影不匹配'))
    await expect(s.service.continue(entryId, transfer)).rejects.toThrow('投影不匹配')
    expect(s.openExternal).not.toHaveBeenCalled()
    s.handler.mockResolvedValueOnce('Other')
    await expect(s.service.continue(entryId, transfer)).rejects.toThrow('Codex')
    await expect(s.service.continue(entryId, transfer, () => { throw new Error('来源已断开') })).rejects.toThrow('已断开')
    expect(s.openExternal).not.toHaveBeenCalled()
  })
  it('打开失败保留已验证会话，重试不创建第二份', async () => {
    const s = await setup()
    s.openExternal.mockRejectedValueOnce(new Error('系统拒绝'))
    const failed = await s.service.continue(entryId, transfer)
    expect(failed.opened).toBe(false)
    expect(failed.error).toContain('系统拒绝')
    const retry = await s.service.continue(entryId, transfer)
    expect(retry.threadId).toBe(failed.threadId)
    expect(retry.opened).toBe(true)
  })
  it('拒绝目标符号链接、路径参数和同一事务并发', async () => {
    const s = await setup()
    await mkdir(join(s.root, 'outside')); await symlink(join(s.root, 'outside'), join(s.home, 'sessions'))
    await expect(s.service.continue(entryId, transfer)).rejects.toThrow(/链接|授权/)
    await expect(s.service.rollback('../escape')).rejects.toThrow()
    await rm(join(s.home, 'sessions'))
    let release!: () => void
    s.verify.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve }))
    const pending = s.service.continue(entryId, transfer)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await expect(s.service.continue(entryId, transfer)).rejects.toThrow('正在')
    release(); await pending
  })
  it('发布后授权失效会回滚本次文件，仍保留备份，不请求打开', async () => {
    const s = await setup(); let calls = 0
    await expect(s.service.continue(entryId, transfer, () => { if (++calls === 4) throw new Error('授权已撤销') })).rejects.toThrow('已撤销')
    const directory = (await readdir(join(s.data, 'codex-transfers'))).find(name => name !== 'index')!
    const receipt = JSON.parse(await readFile(join(s.data, 'codex-transfers', directory, 'receipt.json'), 'utf8'))
    await expect(readFile(receipt.path)).rejects.toThrow()
    expect(await readFile(join(s.data, 'codex-transfers', directory, 'backup.jsonl'), 'utf8')).toContain('session_meta')
    expect(s.openExternal).not.toHaveBeenCalled()
  })
  it('旧目标消失时新建新ID；身份遭替换时拒绝覆盖或打开', async () => {
    const s = await setup(), first = await s.service.continue(entryId, transfer)
    const original = JSON.parse(await readFile(join(s.data, 'codex-transfers', first.receipt, 'receipt.json'), 'utf8'))
    await rm(original.path)
    const next = await s.service.continue(entryId, transfer)
    expect(next.threadId).not.toBe(first.threadId)
    const receipt = JSON.parse(await readFile(join(s.data, 'codex-transfers', next.receipt, 'receipt.json'), 'utf8'))
    await writeFile(receipt.path, '{"type":"session_meta","payload":{"id":"other"}}\n')
    await expect(s.service.continue(entryId, transfer)).rejects.toThrow('身份已变化')
    expect(s.openExternal).toHaveBeenCalledTimes(2)
  })
  it('验证期间程序被更新时停止，配置不能与创建并发', async () => {
    const s = await setup()
    s.verify.mockImplementationOnce(async () => { await writeFile(s.binary, 'updated binary') })
    await expect(s.service.continue(entryId, transfer)).rejects.toThrow('程序已更新')
    expect(s.openExternal).not.toHaveBeenCalled()
    let release!: (value: string) => void
    s.version.mockReturnValueOnce(new Promise<string>(resolve => { release = resolve }))
    const config = s.service.configure(s.binary, s.home)
    await expect(s.service.configure(s.binary, s.home)).rejects.toThrow('正在')
    await expect(s.service.continue(entryId, transfer)).rejects.toThrow('正在')
    release('0.163.0'); await config
    await expect(s.service.configure(s.binary, s.data)).rejects.toThrow('重叠')
  })
  it('选择的项目成为真实 cwd，同项目重试复用，换项目或独立会话不混用；撤销不碰项目文件', async () => {
    const s = await setup(), path = join(s.root, '中文项目')
    await mkdir(path); await writeFile(join(path, 'AGENTS.md'), '项目已有指令，不复制到接续日志')
    const { dev, ino } = await lstat(path), project = { path, dev, ino }
    const first = await s.service.continue(entryId, transfer, undefined, project)
    const receipt = JSON.parse(await readFile(join(s.data, 'codex-transfers', first.receipt, 'receipt.json'), 'utf8'))
    const text = await readFile(receipt.path, 'utf8')
    expect(JSON.parse(text.split('\n')[0]).payload.cwd).toBe(path)
    expect(text).not.toContain('项目已有指令')
    expect(s.verify).toHaveBeenCalledWith(s.binary, expect.any(String), first.threadId, transfer, path)
    expect((await s.service.continue(entryId, transfer, undefined, project)).threadId).toBe(first.threadId)
    const standalone = await s.service.continue(entryId, transfer)
    expect(standalone.threadId).not.toBe(first.threadId)
    const otherPath = join(s.root, '另一项目'); await mkdir(otherPath)
    const other = await lstat(otherPath)
    expect((await s.service.continue(entryId, transfer, undefined, { path: otherPath, dev: other.dev, ino: other.ino })).threadId).not.toBe(first.threadId)
    await s.service.rollback(first.receipt)
    expect(await readdir(path)).toEqual(['AGENTS.md'])
    expect(await readFile(join(path, 'AGENTS.md'), 'utf8')).toBe('项目已有指令，不复制到接续日志')
  })
  it('项目在隔离预演后被同名目录替换时中止，不回退独立会话或打开目标', async () => {
    const s = await setup(), path = join(s.root, 'project'); await mkdir(path)
    const { dev, ino } = await lstat(path)
    s.verify.mockImplementationOnce(async () => { await rename(path, path + '-old'); await mkdir(path) })
    await expect(s.service.continue(entryId, transfer, undefined, { path, dev, ino })).rejects.toThrow('项目目录已变化')
    expect(s.openExternal).not.toHaveBeenCalled()
    await expect(readdir(join(s.home, 'sessions'))).rejects.toThrow()
  })
  it('重试时旧目标的 cwd 已变化，不自动打开到错误项目', async () => {
    const s = await setup(), path = join(s.root, 'project'); await mkdir(path)
    const { dev, ino } = await lstat(path), project = { path, dev, ino }
    const first = await s.service.continue(entryId, transfer, undefined, project)
    const receipt = JSON.parse(await readFile(join(s.data, 'codex-transfers', first.receipt, 'receipt.json'), 'utf8'))
    const lines = (await readFile(receipt.path, 'utf8')).trim().split('\n')
    const meta = JSON.parse(lines[0]); meta.payload.cwd = '/wrong/project'; lines[0] = JSON.stringify(meta)
    await writeFile(receipt.path, lines.join('\n') + '\n')
    await expect(s.service.continue(entryId, transfer, undefined, project)).rejects.toThrow('工作目录已变化')
    expect(s.openExternal).toHaveBeenCalledOnce()
  })
  it('配置可恢复；取消配置不写目标；替换版本后每次重新预演', async () => {
    const s = await setup()
    const restored = new CodexTarget(s.data, { version: s.version, verify: s.verify, handler: s.handler, openExternal: s.openExternal })
    expect(await restored.configured()).toBe(true)
    s.version.mockResolvedValue('0.164.0')
    await restored.continue(entryId, transfer)
    expect(s.verify).toHaveBeenCalled()
  })
})
