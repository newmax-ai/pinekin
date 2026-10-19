import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'

export type WorkbuddyMetadata = { isForkedCompactionSession?: unknown; forkedFrom?: unknown; forkedAt?: unknown }
function fingerprint(stat: Stats) { return createHash('sha256').update(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])).digest('hex') }
export function workbuddyRevision(log: string, metadata: string) { return createHash('sha256').update(log).update('\0').update(metadata).digest('hex') }
export function workbuddyMetaSubset(value: Record<string, unknown>): WorkbuddyMetadata {
  return { isForkedCompactionSession: value.isForkedCompactionSession, forkedFrom: value.forkedFrom, forkedAt: value.forkedAt }
}
/** 只读取同目录、同名的会话侧车；不跟随链接，不读取 App 配置或数据库。 */
export async function readWorkbuddyMetadata(logPath: string, root: string, authorized: () => boolean = () => true): Promise<{ revision: string; meta: WorkbuddyMetadata }> {
  const assertAuthorized = () => { if (!authorized()) throw new Error('WorkBuddy 来源已断开，停止读取') }
  assertAuthorized()
  const path = logPath.replace(/\.jsonl$/, '.meta.json'), part = relative(root, path)
  if (path === logPath || part === '..' || part.startsWith('..' + sep) || isAbsolute(part) || await realpath(dirname(path)) !== dirname(path)) throw new Error('WorkBuddy 侧车越出授权位置或经过链接')
  let stat: Stats
  try { stat = await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    assertAuthorized()
    return { revision: 'absent', meta: {} }
  }
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error('WorkBuddy 侧车不是普通文件或经过符号链接')
  if (stat.size > 64 * 1024) throw new Error('WorkBuddy 侧车超过 64 KiB 安全读取预算；保留错误，可重试')
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || fingerprint(before) !== fingerprint(stat)) throw new Error('WorkBuddy 侧车身份在读取期间变化')
    const bytes = Buffer.alloc(stat.size + 1)
    let count = 0
    while (count < bytes.length) {
      assertAuthorized()
      const result = await handle.read(bytes, count, bytes.length - count, count)
      if (!result.bytesRead) break
      count += result.bytesRead
    }
    const after = await handle.stat(), current = await lstat(path)
    if (count !== stat.size || fingerprint(after) !== fingerprint(stat) || fingerprint(current) !== fingerprint(stat) || await realpath(path) !== path) throw new Error('WorkBuddy 侧车在读取期间变化，请刷新')
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WorkBuddy 侧车必须是元数据对象')
    assertAuthorized()
    return { revision: fingerprint(stat), meta: workbuddyMetaSubset(value as Record<string, unknown>) }
  } finally { await handle.close() }
}
