import { describe, expect, it } from 'vitest'
import { zstdCompressSync } from 'node:zlib'
import { parseArchive } from '../src/main/imports'
import { deepseekFixture, deepseekRecords } from './fixtures/deepseek'

describe('DeepSeek Harness v4 只读文本归档', () => {
  it.each([false, true])('读取日志（压缩 %s），只展示用户输入与最终文本块', async compressed => {
    const plain = deepseekFixture()
    const parsed = await parseArchive(compressed ? zstdCompressSync(plain) : plain)
    expect(parsed).toMatchObject({ adapterId: 'deepseek-harness-v4', originalSessionId: 'session-synthetic', sourceVersion: 'session-v4', session: { source: 'deepseek', title: 'DeepSeek 合成会话', demo: false } })
    expect(parsed.session.messages).toEqual([{ role: 'user', content: '合成问题：整理项目计划' }, { role: 'assistant', content: '合成答复：先确认目标。' }])
    expect(parsed.warnings.join('\n')).toMatch(/推理/)
    expect(parsed.warnings.join('\n')).toMatch(/运行时/)
  })
  it.each([
    { version: 5 }, { isSeeded: true }, { delegationDepth: 1 }, { parentSession: 'parent' }, { origin: 'subagent' }, { createdAt: -1 },
  ])('拒绝未支持头部 %j', async change => {
    const records = deepseekRecords(); Object.assign(records[0], change)
    await expect(parseArchive(deepseekFixture(records))).rejects.toThrow()
  })
  it('拒绝序号缺口、重复头部、重写表面、截断、空消息与损坏结构', async () => {
    for (const change of [
      (r: Record<string, unknown>[]) => { r[2].seq = 3 },
      (r: Record<string, unknown>[]) => { r.push(r[0]) },
      (r: Record<string, unknown>[]) => { r[4].surfaceOp = 'replace' },
      (r: Record<string, unknown>[]) => { r[1].data = {} },
      (r: Record<string, unknown>[]) => { r.splice(1) },
    ]) {
      const records = deepseekRecords(); change(records)
      await expect(parseArchive(deepseekFixture(records))).rejects.toThrow()
    }
    await expect(parseArchive(Buffer.concat([deepseekFixture(), Buffer.from('{')]))).rejects.toThrow()
  })
  it('无标题时使用首条用户文本；未知内容块报告但不执行，不把工具专用回复变成空白消息', async () => {
    const records = deepseekRecords()
    records[3] = { type: 'step/start', seq: 2, time: 1_790_000_000_000, data: {} }
    records.push({ type: 'assistant/message', seq: 5, time: 1_790_000_000_001, surfaceOp: 'append', data: { message: { id: 'a2', role: 'assistant', content: [{ type: 'image', url: 'https://invalid.example/private' }] } } })
    const parsed = await parseArchive(deepseekFixture(records))
    expect(parsed.session.title).toBe('合成问题：整理项目计划')
    expect(parsed.session.messages).toHaveLength(2)
    expect(parsed.warnings.join('\n')).toMatch(/未映射/)
  })
  it('压缩内容预算与尾部损坏仍被拒绝', async () => {
    await expect(parseArchive(zstdCompressSync(Buffer.alloc(5 * 1024 * 1024 + 1, 32)))).rejects.toThrow(/5 MiB/)
    await expect(parseArchive(Buffer.concat([zstdCompressSync(deepseekFixture()), Buffer.from('broken')]))).rejects.toThrow(/解压失败/)
  })
})
