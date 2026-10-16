import { fromBuffer, type Entry, type ZipFile } from 'yauzl'
import { crc32 } from 'node:zlib'

export const ZIP_LIMITS = { entries: 1024, entryBytes: 5 * 1024 * 1024, totalBytes: 20 * 1024 * 1024, ratio: 200 }
export function safeArchivePath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && !/[\\\x00-\x1f\x7f:]/.test(path) && !path.startsWith('/') &&
    path.replace(/\/$/, '').split('/').every(part => !!part && part !== '.' && part !== '..')
}

// 只在内存中逐条解压，不将包内路径用于任何磁盘写入。
export async function readBoundedZip(bytes: Buffer): Promise<Map<string, Buffer>> {
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, file) => {
      if (error) reject(error)
      else resolve(file!)
    })
  })
  return new Promise((resolve, reject) => {
    const files = new Map<string, Buffer>(), names = new Set<string>()
    let total = 0, compressedTotal = 0, settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true; zip.close(); reject(error)
    }
    zip.on('error', fail)
    zip.on('end', () => { if (!settled) { settled = true; zip.close(); resolve(files) } })
    zip.on('entry', (entry: Entry) => {
      void (async () => {
        if (!safeArchivePath(entry.fileName) || names.has(entry.fileName)) throw new Error('ZIP 路径不安全或重复')
        names.add(entry.fileName)
        if (names.size > ZIP_LIMITS.entries) throw new Error('ZIP 条目数量超出预算')
        const kind = (entry.externalFileAttributes >>> 16) & 0xf000
        if (kind !== 0 && kind !== 0x8000 && kind !== 0x4000) throw new Error('不支持 ZIP 符号链接或特殊文件')
        if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) throw new Error('不支持 ZIP 加密或压缩算法')
        total += entry.uncompressedSize
        compressedTotal += entry.compressedSize
        // 不只看展开量：中央目录可重复引用同一段空 DEFLATE 流以放大 CPU 工作。
        if (compressedTotal > 5 * 1024 * 1024) throw new Error('ZIP 累计压缩数据处理量超出预算')
        if (entry.uncompressedSize > ZIP_LIMITS.entryBytes || total > ZIP_LIMITS.totalBytes) throw new Error('ZIP 展开大小超出预算')
        if (entry.uncompressedSize > Math.max(1, entry.compressedSize) * ZIP_LIMITS.ratio) throw new Error('ZIP 压缩比超出预算')
        const stream = await new Promise<NodeJS.ReadableStream>((resolveStream, rejectStream) => {
          zip.openReadStream(entry, (error, value) => error ? rejectStream(error) : resolveStream(value!))
        })
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of stream) {
          const buffer = Buffer.from(chunk)
          size += buffer.length
          if (size > ZIP_LIMITS.entryBytes || size > entry.uncompressedSize) throw new Error('ZIP 实际展开大小超出预算')
          chunks.push(buffer)
        }
        const content = Buffer.concat(chunks)
        if (size !== entry.uncompressedSize || crc32(content) !== entry.crc32) throw new Error('ZIP CRC 或长度校验失败')
        if (entry.fileName.endsWith('/')) {
          if (size !== 0) throw new Error('ZIP 目录项不能包含内容')
        } else files.set(entry.fileName, content)
        if (!settled) zip.readEntry()
      })().catch(fail)
    })
    if (zip.entryCount > ZIP_LIMITS.entries) fail(new Error('ZIP 条目数量超出预算'))
    else zip.readEntry()
  })
}
