import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseCodexProjectCatalog, readCodexProjectCatalog } from '../src/main/codex-project-catalog'

const project = (id: string, roots = [`/synthetic/${id}`], name = id) => ({ id, name, rootPaths: roots, createdAt: 1, updatedAt: 2 })
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-project-catalog-'))); roots.push(home)
  return { home, path: join(home, '.codex-global-state.json') }
}
it('按当前桌面列表语义读取本地项目名称、主目录和顺序，忽略其他字段', () => {
  const result = parseCodexProjectCatalog({
    'local-projects': { a: project('a', undefined, '项目甲'), b: project('b'), c: project('c') },
    'project-order': ['c', 'missing', 'a'],
    'remote-projects': [{ id: 'remote', hostId: 'remote-host', remotePath: '/same-looking/local/path', label: '远程' }],
    'electron-saved-workspace-roots': ['/stale'], 'prompt-history': ['NEVER_EXPOSE_PROMPT'], auth: 'NEVER_EXPOSE_CREDENTIAL',
  })
  expect(result.projects.map(p => p.name)).toEqual(['b', 'c', '项目甲'])
  expect(result.projects.map(p => p.path)).toEqual(['/synthetic/b', '/synthetic/c', '/synthetic/a'])
  expect(JSON.stringify(result)).not.toMatch(/NEVER_EXPOSE|stale|same-looking/)
  expect(result.warning).toContain('远程')
})
it('本地新表为空时不复活旧根，空白名称按真实项目 ID 回退', () => {
  expect(parseCodexProjectCatalog({ 'local-projects': {}, 'electron-saved-workspace-roots': ['/deleted'] }).projects).toEqual([])
  expect(parseCodexProjectCatalog({ 'local-projects': { a: project('a', undefined, '  ') } }).projects[0].name).toBe('a')
})
it('多根、空根以及共享目录项目保留说明，不冒充可准确归属的单根项目', () => {
  const result = parseCodexProjectCatalog({ 'local-projects': {
    a: project('a', ['/shared']), b: project('b', ['/shared/']),
    multi: project('multi', ['/unique', '/extra']), empty: project('empty', []), normal: project('normal'),
  } })
  expect(result.projects.find(p => p.key === 'a')?.reason).toContain('多个项目')
  expect(result.projects.find(p => p.key === 'b')?.reason).toContain('多个项目')
  expect(result.projects.find(p => p.key === 'multi')?.reason).toContain('多个目录')
  expect(result.projects.find(p => p.key === 'empty')?.reason).toContain('本地目录')
  expect(result.projects.find(p => p.key === 'normal')?.reason).toBeUndefined()
})
it('同名但不同目录不合并；单根被另一多根项目包含时也不猜归属', () => {
  const result = parseCodexProjectCatalog({ 'local-projects': {
    a: project('a', ['/a'], '同名'), b: project('b', ['/b'], '同名'), multi: project('multi', ['/other', '/a']),
  } })
  expect(result.projects).toHaveLength(3)
  expect(result.projects.find(p => p.key === 'a')?.reason).toContain('多个项目')
  expect(result.projects.find(p => p.key === 'b')?.reason).toBeUndefined()
})
it.each([undefined, null, [], { 'saved-project-roots': ['/guess'] }, { 'electron-saved-workspace-roots': ['/legacy'] },
  { 'local-projects': { wrong: project('different') } }, { 'local-projects': { a: { id: 'a', name: '坏记录', rootPaths: '/not-array' } } },
  { 'local-projects': {}, 'project-order': 'not-array' },
])('未知或畸形项目格式明确失败，不猜项目或静默返回成功空列表', value => {
  expect(() => parseCodexProjectCatalog(value)).toThrow('项目列表格式')
})
it.each(['relative/path', 'ssh://host/project', '//host/share', '/path\0invalid'])('非本地可用路径 %s 保留为不可用项，不用于文件访问', path => {
  const result = parseCodexProjectCatalog({ 'local-projects': { a: project('a', [path]) } })
  expect(result.projects[0].reason).toContain('本地目录')
})
it('只打开固定状态文件，不写入状态、不扫描项目文件或读取 auth/config', async () => {
  const s = await setup()
  const bytes = JSON.stringify({ 'local-projects': { a: project('a', ['/does-not-exist/project']) } })
  await writeFile(s.path, bytes)
  await writeFile(join(s.home, 'auth.json'), 'PRIVATE_AUTH'); await writeFile(join(s.home, 'config.toml'), 'PRIVATE_CONFIG')
  const result = await readCodexProjectCatalog(s.home)
  expect(result.projects).toMatchObject([{ key: 'a', path: '/does-not-exist/project' }])
  expect(result.source).toBe(s.home)
  expect(await readFile(s.path, 'utf8')).toBe(bytes)
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_/)
})
it('缺少状态文件、坏 JSON、过大文件分别给出明确结果，不泄漏其他字段片段', async () => {
  const s = await setup()
  expect(await readCodexProjectCatalog(s.home)).toMatchObject({ projects: [], warning: expect.any(String) })
  await writeFile(s.path, '{"auth":"SECRET_SHOULD_NOT_APPEAR"')
  await expect(readCodexProjectCatalog(s.home)).rejects.toThrow('项目列表文件损坏')
  await truncate(s.path, 16 * 1024 * 1024 + 1)
  await expect(readCodexProjectCatalog(s.home)).rejects.toThrow('读取上限')
})
it('拒绝状态文件及数据根链接、目录冒充状态文件', async () => {
  const s = await setup(), outside = join(s.home, 'outside')
  await writeFile(outside, 'private'); await symlink(outside, s.path)
  await expect(readCodexProjectCatalog(s.home)).rejects.toThrow('链接')
  await rm(s.path); await mkdir(s.path)
  await expect(readCodexProjectCatalog(s.home)).rejects.toThrow('普通文件')
  const alias = s.home + '-alias'; roots.push(alias); await symlink(s.home, alias)
  await expect(readCodexProjectCatalog(alias)).rejects.toThrow('数据目录')
  expect(await readFile(outside, 'utf8')).toBe('private')
})
