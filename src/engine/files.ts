import { createHash } from 'node:crypto'
import { createReadStream, type Stats } from 'node:fs'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createZstdDecompress, constants as zstd } from 'node:zlib'
import { ENGINE_LIMITS } from './blocks'

export function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('读取已取消')
}

/** 与 Pinekin 来源浏览同口径：只看大小与修改时间，不读取内容。 */
export function fileRevision(stat: Pick<Stats, 'size' | 'mtimeMs'>): string {
  return createHash('sha256').update(`${stat.size}:${Math.trunc(stat.mtimeMs)}`).digest('hex')
}

export interface FoundLog { path: string; root: string; compressed: boolean; stat: Stats }

function absent(error: unknown) {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
}

/**
 * 有界遍历授权根目录下的 JSONL 日志：跳过符号链接，不跟随越界路径。
 * descend 决定是否进入子目录，accept 决定文件是否属于该来源。
 */
export async function* walkLogs(root: string, options: {
  descend: (directory: string, name: string, depth: number) => boolean
  accept: (directory: string, name: string) => boolean
  maxDepth: number
  signal?: AbortSignal
}): AsyncGenerator<FoundLog> {
  if (!isAbsolute(root)) throw new Error('来源位置必须是绝对路径')
  let base: Stats
  try {
    base = await lstat(root)
  } catch (error) {
    if (absent(error)) return
    throw error
  }
  if (base.isSymbolicLink() || !base.isDirectory() || await realpath(root) !== resolve(root)) return
  const queue: { directory: string; depth: number }[] = [{ directory: root, depth: 0 }]
  while (queue.length) {
    aborted(options.signal)
    const { directory, depth } = queue.shift()!
    let handle
    try { handle = await opendir(directory) } catch (error) { if (absent(error)) continue; throw error }
    for await (const entry of handle) {
      aborted(options.signal)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (depth < options.maxDepth && options.descend(directory, entry.name, depth)) queue.push({ directory: join(directory, entry.name), depth: depth + 1 })
        continue
      }
      if (!entry.isFile() || !options.accept(directory, entry.name)) continue
      const path = join(directory, entry.name)
      const part = relative(root, path)
      if (part.startsWith('..' + sep) || isAbsolute(part)) continue
      try {
        const stat = await lstat(path)
        if (!stat.isFile()) continue
        yield { path, root, compressed: /\.(?:zst|zstd)$/.test(entry.name), stat }
      } catch (error) { if (!absent(error)) throw error }
    }
  }
}

/** 读取首个非空行，只解压到需要的位置；超过预算返回 undefined，由调用方标记不可读。 */
export async function readFirstRecord(path: string, compressed: boolean): Promise<Record<string, unknown> | undefined> {
  const file = createReadStream(path, { highWaterMark: 64 * 1024 })
  const stream = compressed
    ? file.pipe(createZstdDecompress({ params: { [zstd.ZSTD_d_windowLogMax]: 23 } }))
    : file
  const chunks: Buffer[] = []
  let length = 0
  try {
    for await (const value of stream) {
      const chunk = value as Buffer
      let start = 0
      while (start <= chunk.length) {
        const newline = chunk.indexOf(10, start)
        const end = newline < 0 ? chunk.length : newline
        chunks.push(chunk.subarray(start, end)); length += end - start
        if (length > ENGINE_LIMITS.firstLineBytes) return undefined
        if (newline < 0) break
        const line = Buffer.concat(chunks).toString('utf8')
        chunks.length = 0; length = 0
        if (line.trim()) return parseObject(line)
        start = newline + 1
      }
    }
    const rest = Buffer.concat(chunks).toString('utf8')
    return rest.trim() ? parseObject(rest) : undefined
  } catch {
    return undefined
  } finally {
    file.destroy()
    if (stream !== file) (stream as NodeJS.ReadableStream & { destroy(): void }).destroy()
  }
}

function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

/** 规范化绝对工作目录；拒绝相对路径和空值。 */
export function workingDirectory(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) return undefined
  if (!isAbsolute(value) && !/^[a-zA-Z]:[\\/]/.test(value)) return undefined
  return value
}
