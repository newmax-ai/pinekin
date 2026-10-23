import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTextExportIpc } from '../src/main/text-export-ipc'

let root: string, output: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pinekin-text-export-')); output = join(root, 'export.md') })
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }) })
function setup() {
  let call!: (event: object, ...args: unknown[]) => Promise<boolean>
  const choose = vi.fn<() => Promise<string | null>>().mockImplementation(async () => output)
  const assertSender = vi.fn<(event: object) => void>()
  registerTextExportIpc({ handle: (channel, handler) => { expect(channel).toBe('pinekin:source-actions-export-text'); call = handler }, choose, assertSender })
  return { call, choose, assertSender, event: {} }
}
it('通过共享安全保存写入当前文本，取消不落盘', async () => {
  const { call, choose, event } = setup()
  choose.mockResolvedValueOnce(null)
  expect(await call(event, '取消内容')).toBe(false)
  expect(await readdir(root)).toEqual([])
  expect(await call(event, '原文🙂')).toBe(true)
  expect(await readFile(output, 'utf8')).toBe('原文🙂')
})
it('拒绝附加参数、非法正文及不可信发送方，不打开保存框', async () => {
  const { call, choose, assertSender, event } = setup()
  await expect(call(event, '正文', '/arbitrary/path')).rejects.toThrow('参数')
  await expect(call(event, { text: '正文' })).rejects.toThrow()
  assertSender.mockImplementation(() => { throw new Error('拒绝子 frame') })
  await expect(call(event, '正文')).rejects.toThrow('子 frame')
  expect(choose).not.toHaveBeenCalled()
})
it('Windows 文本导出也拒绝最终链接且不改写链接目标', async () => {
  const { call, event } = setup(), original = join(root, 'keep.txt')
  await writeFile(original, '保持原文'); await symlink(original, output, 'file')
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }))
  await expect(call(event, '覆盖')).rejects.toThrow('普通文件')
  expect(await readFile(original, 'utf8')).toBe('保持原文')
})
it('保存框返回后复核发送方，失败后释放并发锁', async () => {
  const { call, choose, assertSender, event } = setup()
  await writeFile(output, '旧内容')
  choose.mockImplementationOnce(async () => {
    assertSender.mockImplementation(() => { throw new Error('页面已变化') })
    return output
  })
  await expect(call(event, '不得覆盖')).rejects.toThrow('页面已变化')
  expect(await readFile(output, 'utf8')).toBe('旧内容')
  assertSender.mockReset()
  expect(await call(event, '新内容')).toBe(true)
  expect(await readFile(output, 'utf8')).toBe('新内容')
})
it('保存框在途时不重复打开，取消后可再次使用', async () => {
  const { call, choose, event } = setup()
  let finish!: (path: string | null) => void
  choose.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const pending = call(event, '首次')
  await expect(call(event, '重复')).rejects.toThrow('正在处理')
  finish(null)
  expect(await pending).toBe(false)
  expect(await call(event, '再次')).toBe(true)
  expect(choose).toHaveBeenCalledTimes(2)
})
