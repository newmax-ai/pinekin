import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CodexProjectSelection } from '../src/main/codex-project'

const roots: string[] = [], id = 'a'.repeat(64)
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-saved-projects-'))); roots.push(root)
  const path = join(root, 'project'); await mkdir(path)
  const catalog = { source: 'synthetic-target', projects: [{ key: 'saved-one', name: '已有项目', path }] }
  const read = vi.fn().mockImplementation(async () => catalog), choose = vi.fn().mockResolvedValue(null)
  let now = 1000
  const service = new CodexProjectSelection(choose, () => now, read)
  return { root, path, catalog, read, choose, service, expire: () => { now += 300_001 } }
}
it('列表只给项目元数据和 opaque ID；点选已有项目不弹目录选择器', async () => {
  const s = await setup(), list = await s.service.list(id, () => {})
  expect(list.projects).toEqual([{ id: expect.any(String), name: '已有项目', path: s.path }])
  expect(s.choose).not.toHaveBeenCalled()
  const selected = await s.service.choose(id, () => {}, list.projects[0].id)
  expect(selected).toMatchObject({ name: '已有项目', path: s.path, token: expect.any(String) })
  expect((await s.service.resolve(id, selected!.token)).path).toBe(s.path)
  expect(s.read).toHaveBeenCalledTimes(2)
  expect(s.choose).not.toHaveBeenCalled()
})
it('未列出、跨会话、过期、刷新前的 ID 或任意路径都不能选择', async () => {
  const s = await setup(), list = await s.service.list(id, () => {})
  const projectId = list.projects[0].id
  for (const bad of ['/arbitrary/path', '11111111-1111-4111-8111-111111111111']) {
    await expect(s.service.choose(id, () => {}, bad)).rejects.toThrow()
  }
  await expect(s.service.choose('b'.repeat(64), () => {}, projectId)).rejects.toThrow('项目列表')
  s.expire()
  await expect(s.service.choose(id, () => {}, projectId)).rejects.toThrow('项目列表')
  const next = await s.service.list(id, () => {})
  await s.service.list(id, () => {})
  await expect(s.service.choose(id, () => {}, next.projects[0].id)).rejects.toThrow('项目列表')
  expect(s.choose).not.toHaveBeenCalled()
})
it.each(['removed', 'moved', 'target-changed'])('点选时复核实际项目列表：%s 不使用旧路径', async change => {
  const s = await setup(), list = await s.service.list(id, () => {})
  if (change === 'removed') s.catalog.projects = []
  else if (change === 'moved') s.catalog.projects[0].path = join(s.root, 'another')
  else s.catalog.source = 'different-target'
  await expect(s.service.choose(id, () => {}, list.projects[0].id)).rejects.toThrow('项目列表已变化')
  expect(s.choose).not.toHaveBeenCalled()
})
it('列出不会遍历项目目录；选择已删除目录明确失败，不回退选择器', async () => {
  const s = await setup(); await rm(s.path, { recursive: true })
  const list = await s.service.list(id, () => {})
  expect(list.projects).toHaveLength(1)
  await expect(s.service.choose(id, () => {}, list.projects[0].id)).rejects.toThrow()
  expect(s.choose).not.toHaveBeenCalled()
})
it('不可用项目即使直接调用选择 API 也拒绝，不能靠伪造点击绕过', async () => {
  const s = await setup()
  Object.assign(s.catalog.projects[0], { reason: '多个项目共用此目录' })
  const list = await s.service.list(id, () => {})
  expect(list.projects[0].reason).toContain('多个项目')
  await expect(s.service.choose(id, () => {}, list.projects[0].id)).rejects.toThrow('多个项目')
  expect(s.choose).not.toHaveBeenCalled()
})
it('没有列表提供器时不能猜列表；并发读取不会覆盖有效请求', async () => {
  const s = await setup(), missing = new CodexProjectSelection(s.choose)
  await expect(missing.list(id, () => {})).rejects.toThrow('未提供项目列表')
  let finish!: () => void
  s.read.mockReturnValueOnce(new Promise(resolve => { finish = () => resolve(s.catalog) }))
  const pending = s.service.list(id, () => {})
  await expect(s.service.list(id, () => {})).rejects.toThrow('正在读取')
  finish(); expect((await pending).projects).toHaveLength(1)
})
it('列表读取失败或来源失效不发放新列表，并可重新读取', async () => {
  const s = await setup()
  s.read.mockRejectedValueOnce(new Error('项目列表暂不可读'))
  await expect(s.service.list(id, () => {})).rejects.toThrow('暂不可读')
  let allowed = true
  s.read.mockImplementationOnce(async () => { allowed = false; return s.catalog })
  await expect(s.service.list(id, () => { if (!allowed) throw new Error('来源已断开') })).rejects.toThrow('来源已断开')
  expect((await s.service.list(id, () => {})).projects).toHaveLength(1)
})
