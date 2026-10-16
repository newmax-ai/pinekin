import { zstdCompressSync, constants } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { MAX_BYTES } from '../src/core/session'
import { parseArchive } from '../src/main/imports'
import { codexFixture, codexMessage, codexMeta } from './fixtures/codex'

// 仅仿照本机观察到的结构重新合成；没有真实正文、路径或会话 ID。
export function paginatedFixture(patch: Record<string, unknown> = {}) {
  return [codexMeta({ history_mode: 'paginated', ...patch }), codexMessage(),
    codexMessage('assistant', [{ type: 'output_text', text: '分页根日志的合成答复' }])]
    .map((row, ordinal) => ({ ...row, ordinal }))
}
describe('本机布局的合成回归：独立分页日志与 Zstandard', () => {
  it('接受从 0 连续编号、无继承或子会话边界的分页根日志', async () => {
    const parsed = await parseArchive(codexFixture(paginatedFixture()))
    expect(parsed.session.messages).toHaveLength(2)
    expect(parsed.adapterVersion).toBe('0.2.0')
    expect(parsed.warnings.join('\n')).toMatch(/分页.*单文件/)
    expect(parsed.warnings.join('\n')).toMatch(/不是原生恢复/)
  })
  it('分页记录缺序号、不从 0 起步、重复、跳号或乱序均拒绝', async () => {
    for (const ordinals of [[undefined, 1, 2], [0, undefined, 2], [1, 2, 3], [0, 1, 1], [0, 2, 3], [0, 2, 1], [0, null, 2]]) {
      const rows = paginatedFixture().map((row, i) => ({ ...row, ordinal: ordinals[i] }))
      await expect(parseArchive(codexFixture(rows))).rejects.toThrow(/分页.*序号/)
    }
  })
  it('即使序号连续，也不放开引用、fork 或子会话限制', async () => {
    for (const patch of [{ history_base: { rollout_id: 'do-not-read', ordinal_exclusive: 10 } },
      { parent_thread_id: '0199e6ba-0000-7000-8000-000000000002' }, { subagent_history_start_ordinal: 1 },
      { forked_from_id: '0199e6ba-0000-7000-8000-000000000002' }]) {
      await expect(parseArchive(codexFixture(paginatedFixture(patch)))).rejects.toThrow(/继承|子会话/)
    }
  })
  it('根据 Zstandard 魔数识别而非扩展名，保留相同消息并报告压缩原件', async () => {
    const plain = codexFixture(paginatedFixture())
    const parsed = await parseArchive(zstdCompressSync(plain))
    expect(parsed.session.messages).toEqual((await parseArchive(plain)).session.messages)
    expect(parsed.sourceName).toBe('Codex JSONL · Zstandard')
    expect(parsed.warnings.join('\n')).toMatch(/压缩原件/)
    expect((await parseArchive(zstdCompressSync(codexFixture()))).session.messages).toHaveLength(2)
  })
  it('损坏、截断、尾随垃圾、非 Codex 数据和非法 UTF-8 均拒绝', async () => {
    const compressed = zstdCompressSync(codexFixture())
    for (const bytes of [compressed.subarray(0, 10), Buffer.concat([compressed, Buffer.from('trailing-garbage')]),
      zstdCompressSync(Buffer.from('{"not":"codex"}')), zstdCompressSync(Buffer.from([255]))]) {
      await expect(parseArchive(bytes)).rejects.toThrow()
    }
  })
  it('压缩输入、展开内容与解码窗口均有独立上限', async () => {
    const tooLargeInput = Buffer.alloc(MAX_BYTES + 1); tooLargeInput.set([0x28, 0xb5, 0x2f, 0xfd])
    await expect(parseArchive(tooLargeInput)).rejects.toThrow(/过大/)
    await expect(parseArchive(zstdCompressSync(Buffer.alloc(MAX_BYTES + 1)))).rejects.toThrow(/展开.*5 MiB/)
    const largeWindow = zstdCompressSync(Buffer.alloc(10 * 1024 * 1024), {
      params: { [constants.ZSTD_c_windowLog]: 24, [constants.ZSTD_c_contentSizeFlag]: 0 },
    })
    await expect(parseArchive(largeWindow)).rejects.toThrow(/窗口/)
  })
})
