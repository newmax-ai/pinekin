import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { withSourceLog } from '../src/main/source-log-file'
import { PinekinUnsupportedError } from '../src/engine/blocks'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(text: string, compressed: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-stream-errors-')))
  roots.push(root)
  const path = join(root, compressed ? 'session.jsonl.zstd' : 'session.jsonl')
  await writeFile(path, compressed ? zstdCompressSync(text) : text)
  return { path, root }
}

describe.each([false, true])('来源流式读取错误归属（compressed=%s）', compressed => {
  it('保留带 code 的解析器异常，不误报压缩损坏', async () => {
    const { path, root } = await fixture('{"type":"event"}\n', compressed)
    const failure = Object.assign(new Error('合成字段结构校验失败'), { code: 'SYNTHETIC_VALIDATION' })
    await expect(withSourceLog(path, root, compressed, () => true, scan => scan(() => { throw failure }))).rejects.toBe(failure)
  })
  it('保留已知不支持异常的身份，不让管道销毁错误覆盖它', async () => {
    const { path, root } = await fixture('{"type":"unknown-event"}\n' + '{"type":"next"}\n'.repeat(20_000), compressed)
    const failure = new PinekinUnsupportedError('合成未知事件语义尚未支持')
    await expect(withSourceLog(path, root, compressed, () => true, scan => scan(() => { throw failure }))).rejects.toBe(failure)
  })
  it('日志 JSON 错误保持明确行号，不伪装成解压失败', async () => {
    const { path, root } = await fixture('{"type":"event"}\n{broken\n', compressed)
    await expect(withSourceLog(path, root, compressed, () => true, scan => scan(() => {}))).rejects.toThrow('第 2 行 JSON 无效或截断')
  })
})
