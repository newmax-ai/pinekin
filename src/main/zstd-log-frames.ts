import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants as zstd, createZstdDecompress } from 'node:zlib'

/** 只缓存输入的一个块及至多 14 字节帧头；块正文直接切片，不缓存整个文件或整帧。 */
class Cursor {
  private iterator: AsyncIterator<Uint8Array>
  private chunk: Buffer = Buffer.alloc(0)
  private offset = 0
  constructor(input: AsyncIterable<Uint8Array>) { this.iterator = input[Symbol.asyncIterator]() }
  async available(): Promise<boolean> {
    while (this.offset >= this.chunk.length) {
      const next = await this.iterator.next()
      if (next.done) return false
      this.chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength)
      this.offset = 0
    }
    return true
  }
  async *take(length: number): AsyncGenerator<Buffer> {
    while (length > 0) {
      if (!await this.available()) throw new Error('Zstandard 帧被截断，未返回局部成功')
      const size = Math.min(length, this.chunk.length - this.offset)
      yield this.chunk.subarray(this.offset, this.offset + size)
      this.offset += size; length -= size
    }
  }
  async small(length: number): Promise<Buffer> {
    const parts: Buffer[] = []
    for await (const part of this.take(length)) parts.push(part)
    return Buffer.concat(parts, length)
  }
  async close() { await this.iterator.return?.() }
}

/** 从压缩格式本身确定帧边界，不能扫描正文里的 magic 猜边界，也不能信任解码器会读到后续帧。 */
async function* frame(cursor: Cursor): AsyncGenerator<Buffer> {
  const magic = await cursor.small(4)
  if (magic.readUInt32LE() !== 0xfd2fb528) throw new Error('Zstandard 包含未知帧或尾随垃圾，未返回局部成功')
  yield magic
  const descriptor = await cursor.small(1)
  const flags = descriptor[0]
  if (flags & 0x08) throw new Error('Zstandard 帧头使用保留位，未返回局部成功')
  yield descriptor
  const singleSegment = !!(flags & 0x20)
  const contentSizeFlag = flags >>> 6
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][contentSizeFlag]
  const dictionaryBytes = [0, 1, 2, 4][flags & 3]
  yield await cursor.small((singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes)
  while (true) {
    const header = await cursor.small(3)
    const value = header.readUIntLE(0, 3), kind = (value >>> 1) & 3, size = value >>> 3
    if (kind === 3 || size > 128 * 1024) throw new Error('Zstandard 块头无效，未返回局部成功')
    yield header
    yield* cursor.take(kind === 1 ? 1 : size)
    if (value & 1) break
  }
  if (flags & 4) yield await cursor.small(4)
}

/**
 * Electron 自带的旧 Node 只解码第一帧，严格模式还会把后续合法帧当作垃圾。
 * 对每个格式校验后的独立帧使用严格解码；解压结果拼为同一字节流，JSONL 行可跨帧。
 */
export async function* decodeZstdLogFrames(input: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  const cursor = new Cursor(input)
  let count = 0
  try {
    while (await cursor.available()) {
      count += 1
      const encoded = Readable.from(frame(cursor))
      const decoded = createZstdDecompress({ chunkSize: 64 * 1024,
        params: { [zstd.ZSTD_d_windowLogMax]: 23 }, rejectGarbageAfterEnd: true })
      // 立即连接完成/失败处理，消费者提前停止时仍等待管道真实关闭，不能留下迟到 AbortError。
      const completion = pipeline(encoded, decoded).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
      try {
        for await (const chunk of decoded) yield chunk as Buffer
        const result = await completion
        if (!result.ok) throw result.error
      } finally {
        encoded.destroy(); decoded.destroy()
        // 正常路径已传播错误；提前 return 时只完成本帧取消，不用清理错误覆盖消费者原始异常。
        await completion
      }
    }
    if (count === 0) throw new Error('Zstandard 日志为空，未返回局部成功')
  } finally { await cursor.close() }
}
