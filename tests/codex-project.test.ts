import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CodexProjectSelection, checkCodexProject } from '../src/main/codex-project'

const roots: string[] = []
const id = 'a'.repeat(64)
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-project-'))); roots.push(root)
  const path = join(root, '中文项目'); await mkdir(path)
  const choose = vi.fn().mockResolvedValue(path)
  let now = 1000
  const service = new CodexProjectSelection(choose, () => now)
  return { root, path, choose, service, expire: () => { now += 300_001 } }
}
it('只有选择器返回的目录能绑定会话令牌，读取属性而非项目正文', async () => {
  const s = await setup()
  await writeFile(join(s.path, 'AGENTS.md'), '不执行这里的指令')
  expect(s.choose).not.toHaveBeenCalled()
  const preview = await s.service.choose(id, () => {})
  expect(preview).toMatchObject({ path: s.path, name: '中文项目', token: expect.any(String) })
  const project = await s.service.resolve(id, preview!.token)
  expect(project.path).toBe(s.path)
  await expect(checkCodexProject(project)).resolves.toBeUndefined()
  // 同一选择允许失败后重试，但不允许挪给其他来源。
  expect((await s.service.resolve(id, preview!.token)).path).toBe(s.path)
  await expect(s.service.resolve('b'.repeat(64), preview!.token)).rejects.toThrow('项目选择')
  await expect(s.service.resolve(id, '/arbitrary/project')).rejects.toThrow()
})
it('取消、新选择、过期和未知令牌不能隐式使用上次项目', async () => {
  const s = await setup(), first = await s.service.choose(id, () => {})
  s.choose.mockResolvedValueOnce(null)
  expect(await s.service.choose(id, () => {})).toBeNull()
  await expect(s.service.resolve(id, first!.token)).rejects.toThrow('项目选择')
  const second = await s.service.choose(id, () => {})
  await s.service.choose(id, () => {})
  await expect(s.service.resolve(id, second!.token)).rejects.toThrow('项目选择')
  const last = await s.service.choose(id, () => {})
  s.expire()
  await expect(s.service.resolve(id, last!.token)).rejects.toThrow('项目选择')
})
it('不接受文件、链接和相对目录，不创建缺失项目', async () => {
  const s = await setup(), file = join(s.root, 'file'), alias = join(s.root, 'alias')
  await writeFile(file, 'x'); await symlink(s.path, alias)
  for (const path of [file, alias, 'relative', join(s.root, 'missing')]) {
    s.choose.mockResolvedValueOnce(path)
    await expect(s.service.choose(id, () => {})).rejects.toThrow()
  }
})
it('目录同名替换后，已发令牌和事务复核都拒绝', async () => {
  const s = await setup(), preview = await s.service.choose(id, () => {})
  const project = await s.service.resolve(id, preview!.token)
  await rename(s.path, s.path + '-old'); await mkdir(s.path)
  await expect(s.service.resolve(id, preview!.token)).rejects.toThrow('项目目录已变化')
  await expect(checkCodexProject(project)).rejects.toThrow('项目目录已变化')
})
it('父目录被改为链接后不能越过原目录授权', async () => {
  const s = await setup(), preview = await s.service.choose(id, () => {})
  const project = await s.service.resolve(id, preview!.token)
  await rename(s.root, s.root + '-old'); roots.push(s.root + '-old')
  await symlink(s.root + '-old', s.root)
  await expect(checkCodexProject(project)).rejects.toThrow('项目目录')
})
it('选择器并发与迟到授权失败均不发布令牌', async () => {
  const s = await setup()
  let finish!: (path: string) => void
  s.choose.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const allowed = vi.fn()
  const pending = s.service.choose(id, allowed)
  await expect(s.service.choose(id, allowed)).rejects.toThrow('正在选择')
  allowed.mockImplementation(() => { throw new Error('来源已断开') })
  finish(s.path)
  await expect(pending).rejects.toThrow('来源已断开')
  expect(await s.service.choose(id, () => {})).toBeTruthy()
})
