import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants as zstd, createZstdDecompress } from 'node:zlib'

export const LOG_LINE_BYTES = 8 * 1024 * 1024
const chunkBytes = 64 * 1024
export type LogRecord = Record<string, unknown>
export type LogScan = (consume: (record: LogRecord, line: number) => void) => Promise<void>

let activeReaders = 0
const waiting: (() => void)[] = []
async function acquireReader() {
  if (activeReaders < 2) activeReaders += 1
  else {
    if (waiting.length >= 8) throw new Error('日志读取请求较多，请稍后重试；会话仍保留')
    await new Promise<void>(resolve => waiting.push(resolve))
  }
  return () => {
    const next = waiting.shift()
    if (next) next()
    else activeReaders -= 1
  }
}

/** 总文件可以大；每次只保留当前行，同时最多两份索引工作区，防止快速切换叠加内存。 */
export async function withSourceLog<T>(path: string, root: string, compressed: boolean, authorized: () => boolean,
  action: (scan: LogScan, revision: string) => Promise<T>): Promise<T> {
  const release = await acquireReader()
  try {
    if (!authorized()) throw new Error('来源已断开或读取已取消')
    return await readLogFile(path, root, compressed, authorized, action)
  } finally { release() }
}

async function readLogFile<T>(path: string, root: string, compressed: boolean, authorized: () => boolean,
  action: (scan: LogScan, revision: string) => Promise<T>): Promise<T> {
  const part = relative(root, path)
  if (part === '..' || part.startsWith('..' + sep) || isAbsolute(part) || await realpath(path) !== path) throw new Error('日志越出授权范围或经过符号链接')
  const named = await lstat(path)
  if (!named.isFile() || named.isSymbolicLink()) throw new Error('日志不是普通文件')
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.dev !== named.dev || before.ino !== named.ino) throw new Error('日志身份在打开期间变化，未读取')
    const fingerprint = (stat: typeof before) => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])
    const version = fingerprint(before), revision = createHash('sha256').update(version).digest('hex')
    const deadline = Date.now() + 30_000
    function check() {
      if (!authorized()) throw new Error('来源已断开或读取已取消')
      if (Date.now() > deadline) throw new Error('日志流式检查超时，请稍后重试；会话仍保留')
    }
    async function stable() {
      check()
      const current = await lstat(path)
      if (current.isSymbolicLink() || await realpath(path) !== path || fingerprint(current) !== version || fingerprint(await handle.stat()) !== version) throw new Error('日志在读取期间变化，请重新读取；未混合不同版本')
    }
    const scan: LogScan = async consume => {
      check()
      const read = chunks(handle, check)
      async function consumeChunks(stream: AsyncIterable<Uint8Array>) {
        let fragments: Buffer[] = [], length = 0, line = 0
        function finish() {
          line += 1
          const bytes = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, length)
          fragments = []; length = 0
          let text: string
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
          catch { throw new Error(`日志第 ${line} 行 UTF-8 无效；未返回局部成功`) }
          if (!text.trim()) return
          let record: unknown
          try { record = JSON.parse(text) } catch { throw new Error(`日志第 ${line} 行 JSON 无效或截断`) }
          if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`日志第 ${line} 行不是 JSON 对象`)
          consume(record as LogRecord, line)
        }
        for await (const value of stream) {
          check()
          const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          let start = 0
          while (start < buffer.length) {
            const newline = buffer.indexOf(10, start), end = newline < 0 ? buffer.length : newline
            if (length + end - start > LOG_LINE_BYTES) throw new Error('单条日志记录超过 8 MiB 内存预算；会话仍保留，不把它标为不支持')
            if (end > start) { fragments.push(buffer.subarray(start, end)); length += end - start }
            if (newline < 0) break
            finish(); start = newline + 1
          }
        }
        if (length) finish()
      }
      if (compressed) {
        try {
          await pipeline(Readable.from(read), createZstdDecompress({ chunkSize: chunkBytes,
            params: { [zstd.ZSTD_d_windowLogMax]: 23 }, rejectGarbageAfterEnd: true }), consumeChunks)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code) throw new Error('Zstandard 解压失败：损坏、截断、尾随垃圾、外部字典或窗口超过 8 MiB；未返回局部成功')
          throw error
        }
      } else await consumeChunks(read)
      await stable()
    }
    const result = await action(scan, revision)
    await stable()
    return result
  } finally { await handle.close() }
}

async function* chunks(handle: FileHandle, check: () => void) {
  for (let position = 0;;) {
    check()
    const buffer = Buffer.allocUnsafe(chunkBytes)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    if (!bytesRead) return
    position += bytesRead
    yield buffer.subarray(0, bytesRead)
  }
}
