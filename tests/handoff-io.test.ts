import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { copyHandoffFile, fileClipboardData, HANDOFF_STORAGE_BYTES, saveHandoffFile } from '../src/main/handoff-io'
import { registerHandoffIpc } from '../src/main/handoff-ipc'

const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function directory() { const path = await mkdtemp(join(tmpdir(), 'pinekin-handoff-')); roots.push(path); return path }
const fileType = 'electron application/osclipboard;format="public.file-url"'
describe('复制真实 Markdown 文件，不复制正文或路径文本', () => {
  it('macOS 使用原生文件 URL，空格和 Unicode 路径安全编码', () => {
    const path = '/synthetic/空 格 #/%history.md'
    expect(fileClipboardData(path, 'darwin')).toEqual({ [fileType]: pathToFileURL(path).href })
    expect(fileClipboardData(path, 'darwin')).not.toHaveProperty('text/plain')
    expect(() => fileClipboardData('relative.md', 'darwin')).toThrow()
    for (const platform of ['win32', 'linux']) expect(() => fileClipboardData(path, platform)).toThrow('保存完整接续文件')
  })
  it('先写完整私有文件再提交文件剪贴板，成功后不删除文件', async () => {
    const root = join(await directory(), 'copies'), content = '# 通用接续\n' + '长文本🙂'.repeat(220_000)
    let copiedPath = ''
    const write = vi.fn(async (data: Record<string, string>) => {
      copiedPath = fileURLToPath(data[fileType])
      expect(await readFile(copiedPath, 'utf8')).toBe(write.mock.calls.length === 1 ? content : '第二份')
    })
    await copyHandoffFile(content, root, write, async () => {}, 'darwin')
    expect(write).toHaveBeenCalledOnce()
    expect(copiedPath).toMatch(/pinekin-handoff-[\w-]+\.md$/)
    expect(await readFile(copiedPath, 'utf8')).toBe(content)
    if (process.platform !== 'win32') {
      expect((await stat(copiedPath)).mode & 0o777).toBe(0o600)
      expect((await stat(root)).mode & 0o777).toBe(0o700)
    }
    await copyHandoffFile('第二份', root, write, async () => {}, 'darwin')
    expect(await readdir(root)).toHaveLength(2)
  })
  it('撤权或复制失败清理本次文件，不改已有副本', async () => {
    const root = await directory(), keep = join(root, 'keep.md')
    await writeFile(keep, '保留')
    const write = vi.fn().mockRejectedValueOnce(new Error('剪贴板失败'))
    await expect(copyHandoffFile('正文', root, write, async () => {}, 'darwin')).rejects.toThrow('剪贴板失败')
    expect(await readdir(root)).toEqual(['keep.md'])
    let checks = 0
    await expect(copyHandoffFile('正文', root, write, async () => { if (++checks === 2) throw new Error('已撤权') }, 'darwin')).rejects.toThrow('已撤权')
    expect(write).toHaveBeenCalledOnce()
    expect(await readFile(keep, 'utf8')).toBe('保留')
    expect(await readdir(root)).toEqual(['keep.md'])
  })
  it('未支持系统不落盘；拒绝符号链接目录和超额存储，不删除旧文件', async () => {
    const root = await directory(), link = join(root, 'link'), destination = join(root, 'copies')
    const write = vi.fn()
    await expect(copyHandoffFile('正文', destination, write, async () => {}, 'linux')).rejects.toThrow('保存完整接续文件')
    expect(await readdir(root)).toEqual([])
    await symlink(root, link)
    await expect(copyHandoffFile('正文', link, write, async () => {}, 'darwin')).rejects.toThrow('目录')
    await rm(link)
    const full = await open(join(root, 'existing.md'), 'wx')
    await full.truncate(HANDOFF_STORAGE_BYTES); await full.close()
    await expect(copyHandoffFile('正文', root, write, async () => {}, 'darwin')).rejects.toThrow('保存完整接续文件')
    expect(await readdir(root)).toEqual(['existing.md'])
    expect(write).not.toHaveBeenCalled()
  })
})
describe('显式保存完整接续文件', () => {
  it('Windows 分支也拒绝最终符号链接，不截断链接目标', async () => {
    const root = await directory(), original = join(root, 'keep.txt'), link = join(root, 'linked.md')
    await writeFile(original, '必须保留的原文'); await symlink(original, link, 'file')
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }))
    const result = await saveHandoffFile('不得写入', async () => link, async () => {}).then(() => 'saved', () => 'rejected')
    expect(await readFile(original, 'utf8')).toBe('必须保留的原文')
    expect(result).toBe('rejected')
  })
  it('只写系统选择的 Markdown 路径，取消不落盘', async () => {
    const root = await directory(), path = join(root, 'context.md')
    const choose = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(path)
    expect(await saveHandoffFile('原文', choose, async () => {})).toBe(false)
    expect(await saveHandoffFile('完整原文🙂', choose, async () => {})).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('完整原文🙂')
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    await saveHandoffFile('短', choose, async () => {})
    expect(await readFile(path, 'utf8')).toBe('短')
  })
  it('拒绝错误扩展名、符号链接和选择期间撤权', async () => {
    const root = await directory(), original = join(root, 'keep.txt'), link = join(root, 'linked.md')
    await writeFile(original, '保持原文'); await symlink(original, link)
    await expect(saveHandoffFile('覆盖', async () => original, async () => {})).rejects.toThrow('Markdown')
    await expect(saveHandoffFile('覆盖', async () => link, async () => {})).rejects.toThrow()
    let checks = 0
    await expect(saveHandoffFile('覆盖', async () => join(root, 'cancelled.md'), async () => { if (++checks === 2) throw new Error('已断开') })).rejects.toThrow('已断开')
    expect(await readFile(original, 'utf8')).toBe('保持原文')
  })
})
describe('文件交接具名 IPC', () => {
  it('只注册文件通道，拒绝附加目标参数，每个阶段验证主窗口', async () => {
    const handlers = new Map<string, (event: object, ...args: unknown[]) => Promise<unknown>>()
    const service = { prepare: vi.fn().mockResolvedValue({ token: 'test' }),
      deliver: vi.fn().mockResolvedValue({ status: 'file-copied' }), discard: vi.fn() }
    const assertSender = vi.fn(), event = {}
    registerHandoffIpc({ handle: (name, handler) => { handlers.set(name, handler) }, assertSender, service })
    expect([...handlers.keys()]).toEqual(['pinekin:handoff-file-prepare', 'pinekin:handoff-file-deliver', 'pinekin:handoff-file-discard'])
    const call = (name: string, ...args: unknown[]) => handlers.get(`pinekin:handoff-file-${name}`)!(event, ...args)
    await call('prepare', 'id'); await call('deliver', 'token', 'copy-file'); await call('discard', 'token')
    expect(service.prepare).toHaveBeenCalledWith('id', expect.any(Function))
    expect(service.deliver).toHaveBeenCalledWith('token', 'copy-file', expect.any(Function))
    expect(service.discard).toHaveBeenCalledWith('token')
    await expect(call('prepare', 'id', 'codex')).rejects.toThrow('参数')
    await expect(call('deliver', 'token', 'copy-file', '/path')).rejects.toThrow('参数')
    await expect(call('discard', 'token', '/path')).rejects.toThrow('参数')
    assertSender.mockImplementation(() => { throw new Error('拒绝子 frame') })
    expect(service.prepare.mock.calls[0][1]).toThrow('拒绝子 frame')
    for (const name of ['prepare', 'deliver', 'discard']) await expect(call(name)).rejects.toThrow('子 frame')
    expect(service.prepare).toHaveBeenCalledOnce()
    assertSender.mockReset()
    service.prepare.mockImplementationOnce(async () => { assertSender.mockImplementation(() => { throw new Error('页面已变化') }); return { token: 'test' } })
    await expect(call('prepare', 'id')).rejects.toThrow('页面已变化')
  })
})
