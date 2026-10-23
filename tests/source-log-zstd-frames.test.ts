import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { withSourceLog } from '../src/main/source-log-file'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const compress = (text: string) => zstdCompressSync(text, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
async function scan(input: Buffer) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-zstd-frames-')))
  roots.push(root)
  const path = join(root, 'session.jsonl.zstd')
  await writeFile(path, input)
  const rows: unknown[] = []
  await withSourceLog(path, root, true, () => true, consume => consume(row => rows.push(row)))
  return rows
}

describe('逐帧读取 Harness Zstandard 日志（覆盖 Electron 自带旧 Node）', () => {
  it('完整读取头部与后续批次的多个独立校验帧，不能只返回首帧', async () => {
    const frames = ['{"type":"session"}\n', '{"type":"user/message"}\n', '{"type":"assistant/message"}\n'].map(compress)
    expect(await scan(Buffer.concat(frames))).toEqual([{ type: 'session' }, { type: 'user/message' }, { type: 'assistant/message' }])
  })
  it('一行跨多个帧也只解析一次，不把帧边界当作行边界', async () => {
    expect(await scan(Buffer.concat(['{"type":', '"message"}', '\n'].map(compress)))).toEqual([{ type: 'message' }])
  })
  it('跨读取块的大压缩帧和空内容帧保持完整', async () => {
    let seed = 17
    const text = Array.from({ length: 180_000 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return String.fromCharCode(33 + seed % 90) }).join('')
    const row = { type: 'text', text }
    expect(await scan(Buffer.concat([compress(''), compress(JSON.stringify(row) + '\n'), compress('')]))).toEqual([row])
  })
  it('尾随垃圾不得因旧运行时只处理首帧而被忽略', async () => {
    await expect(scan(Buffer.concat([compress('{"type":"ok"}\n'), Buffer.from('not-a-frame')]))).rejects.toThrow(/Zstandard|解压/)
  })
  it.each([1, 5, 8])('末帧截断 %s 字节时拒绝整份结果', async cut => {
    const last = compress('{"type":"last"}\n')
    await expect(scan(Buffer.concat([compress('{"type":"first"}\n'), last.subarray(0, last.length - cut)]))).rejects.toThrow(/Zstandard|解压/)
  })
  it('末帧校验和损坏时拒绝，不交付已解析的首帧局部成功', async () => {
    const last = compress('{"type":"last"}\n'); last[last.length - 1] ^= 255
    await expect(scan(Buffer.concat([compress('{"type":"first"}\n'), last]))).rejects.toThrow(/Zstandard|解压/)
  })
  it('空输入、非帧头与保留块类型失败关闭', async () => {
    await expect(scan(Buffer.alloc(0))).rejects.toThrow(/Zstandard|解压/)
    await expect(scan(Buffer.from('invalid'))).rejects.toThrow(/Zstandard|解压/)
    const frame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0, 0x07, 0, 0])
    await expect(scan(frame)).rejects.toThrow(/Zstandard|解压/)
  })
})
