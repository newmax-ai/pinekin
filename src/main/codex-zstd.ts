import { constants, zstdDecompress } from 'node:zlib'
import { MAX_BYTES } from '../core/session'
import { isCodexRollout, parseCodex } from './codex'
import type { ParsedArchive } from '../core/types'
import { isDeepSeekLog, parseDeepSeek } from './deepseek'

export function isZstandard(input: Buffer): boolean {
  return input.length >= 4 && input.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
}
export async function decodeCompressedLog(input: Buffer): Promise<string> {
  if (input.byteLength > MAX_BYTES) throw new Error('文件过大，最大支持 5 MB')
  const decoded = await new Promise<Buffer>((resolve, reject) => {
    zstdDecompress(input, {
      maxOutputLength: MAX_BYTES,
      params: { [constants.ZSTD_d_windowLogMax]: 23 }, // 最大 8 MiB 解码窗口，与展开大小限制分开控制。
      rejectGarbageAfterEnd: true,
    }, (error, output) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code
        reject(new Error(code === 'ERR_BUFFER_TOO_LARGE'
          ? 'Zstandard 展开内容超过 5 MiB，未截断导入'
          : 'Zstandard 解压失败：文件损坏、被截断或超出窗口预算；不支持外部字典'))
      } else resolve(output)
    })
  })
  const text = new TextDecoder('utf-8', { fatal: true }).decode(decoded)
  if (!isCodexRollout(text) && !isDeepSeekLog(text)) throw new Error('Zstandard 内容不是已支持的 Codex rollout 或 DeepSeek Harness 日志；不递归解压或尝试其他格式')
  return text
}
export async function parseCompressedCodex(input: Buffer): Promise<ParsedArchive> {
  const text = await decodeCompressedLog(input)
  const parsed = isDeepSeekLog(text) ? parseDeepSeek(text) : parseCodex(text)
  return { ...parsed, sourceName: `${parsed.sourceName} · Zstandard`,
    warnings: [...parsed.warnings, '输入为 Zstandard 压缩日志；本地保存压缩原件，展示有界展开后的文本投影，不随交接导出压缩原件。'] }
}
