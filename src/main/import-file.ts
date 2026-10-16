import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { MAX_BYTES } from '../core/session'

export async function readImportFile(path: string): Promise<Buffer> {
  // 非阻塞打开避免在 fstat 之前被 FIFO 等特殊文件挂起；仍对实际句柄检查类型。
  const file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK))
  try {
    if (!(await file.stat()).isFile()) throw new Error('请选择普通文件')
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let count = 0
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, null)
      if (bytesRead === 0) break
      count += bytesRead
    }
    if (count > MAX_BYTES) throw new Error('文件过大，最大支持 5 MB')
    return buffer.subarray(0, count)
  } finally { await file.close() }
}
