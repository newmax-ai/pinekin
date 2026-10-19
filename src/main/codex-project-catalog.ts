import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, posix } from 'node:path'
import { z } from 'zod'
import type { CodexCatalogItem, CodexProjectCatalog } from './codex-project'

const MAX_STATE_BYTES = 16 * 1024 * 1024
const localProjectSchema = z.object({ id: z.string().min(1).max(512), name: z.string().max(512),
  rootPaths: z.array(z.string().max(4096)).max(64), createdAt: z.number(), updatedAt: z.number() })
const stateSchema = z.object({ 'local-projects': z.record(z.string().max(512), localProjectSchema),
  'project-order': z.array(z.string().max(512)).max(1000).optional(),
  'remote-projects': z.array(z.unknown()).max(1000).optional() })
const localPath = (path: string) => path.startsWith('/') && !path.startsWith('//') && !/[\x00-\x1f]/.test(path)
const normalize = (path: string) => posix.normalize(path).replace(/\/$/, '') || '/'

/** 对应已核对桌面 local-projects 读模型；不将旧根、信任目录或历史 cwd 当作项目。 */
export function parseCodexProjectCatalog(value: unknown): Omit<CodexProjectCatalog, 'source'> {
  const parsed = stateSchema.safeParse(value)
  if (!parsed.success) throw new Error('当前 Codex 项目列表格式尚未支持，请选择其他文件夹。')
  const records = Object.entries(parsed.data['local-projects'])
  if (records.length > 1000 || records.some(([key, item]) => key !== item.id)) throw new Error('Codex 项目列表格式或数量无效，未猜测项目归属。')
  // 对齐桌面列表：未写入 project-order 的新项目在前，其余按已保存顺序排列。
  const order = new Map((parsed.data['project-order'] ?? []).map((key, index) => [key, index]))
  records.sort(([a], [b]) => (order.get(a) ?? -1) - (order.get(b) ?? -1))
  const owners = new Map<string, Set<string>>()
  for (const [key, item] of records) for (const path of item.rootPaths) {
    if (!localPath(path)) continue
    const normalized = normalize(path), ids = owners.get(normalized) ?? new Set<string>()
    ids.add(key); owners.set(normalized, ids)
  }
  const projects: CodexCatalogItem[] = records.map(([key, item]) => {
    const raw = item.rootPaths[0] ?? '', path = localPath(raw) ? normalize(raw) : raw
    const reason = !raw || !localPath(raw) ? '未设置可用的本地目录，不能在本机接续。'
      : item.rootPaths.length !== 1 ? '此项目包含多个目录，暂不自动绑定；可另选一个文件夹继续。'
        : (owners.get(path)?.size ?? 0) > 1 ? '多个项目共用此目录，无法准确自动归属；请在 Codex 中明确项目。' : undefined
    return { key, name: item.name.trim() || item.id, path, ...(reason ? { reason } : {}) }
  })
  const warning = parsed.data['remote-projects']?.length ? '远程项目不在本地项目列表中；当前接续仅支持本机目录。' : undefined
  return { projects, ...(warning ? { warning } : {}) }
}

function unchanged(a: Stats, b: Stats) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}
/** 固定文件、有界只读、禁止链接；只返回项目字段，不展示或保存状态中的其他数据。 */
export async function readCodexProjectCatalog(home: string): Promise<CodexProjectCatalog> {
  if (!isAbsolute(home) || /[\x00-\x1f]/.test(home) || home.length > 4096) throw new Error('Codex 数据目录无效。')
  const root = await lstat(home)
  if (!root.isDirectory() || root.isSymbolicLink() || await realpath(home) !== home) throw new Error('Codex 数据目录不是可用的实际目录。')
  const path = join(home, '.codex-global-state.json')
  let before: Stats
  try { before = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { source: home, projects: [], warning: '尚未找到 Codex 已保存的项目列表，可选择其他文件夹。' }
    throw error
  }
  if (before.isSymbolicLink()) throw new Error('项目列表文件是符号链接，未读取授权外的位置。')
  if (!before.isFile()) throw new Error('项目列表必须是普通文件。')
  if (before.size > MAX_STATE_BYTES) throw new Error('项目列表文件超过 16 MiB 读取上限，未返回截断列表。')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const held = await file.stat()
    if (!unchanged(before, held)) throw new Error('项目列表在读取期间变化，请刷新。')
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await file.stat(), current = await lstat(path), currentRoot = await lstat(home)
    if (offset !== before.size || !unchanged(before, after) || !unchanged(before, current) || current.isSymbolicLink() ||
      currentRoot.dev !== root.dev || currentRoot.ino !== root.ino || await realpath(home) !== home) throw new Error('项目列表在读取期间变化，请刷新。')
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))) }
    catch { throw new Error('Codex 项目列表文件损坏，请刷新或选择其他文件夹。') }
    return { source: home, ...parseCodexProjectCatalog(value) }
  } finally { await file.close() }
}
