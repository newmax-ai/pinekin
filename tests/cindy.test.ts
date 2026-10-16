import { describe, expect, it } from 'vitest'
import { parseArchive } from '../src/main/imports'
import { cindyEntries, cindyFixture, cindyMessage, sharedEmptyZipFixture, zipFixture } from './fixtures/cindy'

describe('固定源码格式的 Cindy 分享包', () => {
  it('读取魔数而非扩展名，提取 JSON 文本块和 JSON 字符串', async () => {
    const result = await parseArchive(cindyFixture())
    expect(result).toMatchObject({ adapterId: 'cindy-cshare', sourceName: 'Cindy', session: {
      title: 'Cindy 合成档案', source: 'cindy', demo: false, updatedAt: '2026-10-16T00:00:00.000Z',
      messages: [{ role: 'user', content: '<script>不执行</script> 合成的 Cindy 会话' }, { role: 'assistant', content: '可以从这里继续。' }],
    } })
    expect(result.warnings.join('\n')).toMatch(/原生恢复/)
    expect(result.warnings.join('\n')).toMatch(/db-only/)
  })
  it('未知块、媒体、工具关联及回退状态明确报告，不冒充恢复', async () => {
    const result = await parseArchive(cindyFixture(cindyEntries({ messages: [cindyMessage({
      content: JSON.stringify([{ type: 'text', text: '文字' }, { type: 'image', source: { url: 'https://invalid.example/private.png' } },
        { type: 'tool_use', name: 'bash', input: { command: 'do-not-run' } }]), toolUseId: 'tool-1', rewindAt: 1792108800000,
      agentMeta: JSON.stringify({ autoReviewUserText: '不构成授权' }),
    })], media: [{ url: 'private://image', scheme: 'private', kind: 'image', zipPath: null }] })))
    expect(result.session.messages[0].content).toContain('文字')
    expect(result.session.messages[0].content).toContain('未映射')
    expect(result.session.messages[0].content).not.toContain('do-not-run')
    expect(result.warnings.join('\n')).toMatch(/媒体/)
    expect(result.warnings.join('\n')).toMatch(/回退/)
  })
  it('裸文本保留，未知 JSON 结构显式占位，空会话可以读取', async () => {
    for (const content of ['直接文本', '{"unknown":true}']) {
      const parsed = await parseArchive(cindyFixture(cindyEntries({ messages: [cindyMessage({ content })] })))
      expect(parsed.session.messages[0].content).toContain(content.startsWith('{') ? '未映射' : content)
    }
    expect((await parseArchive(cindyFixture(cindyEntries({ messages: [] })))).session.messages).toEqual([])
  })
  it('拒绝加密、未知头版本、保留位与损坏 ZIP，不尝试解密', async () => {
    for (const [offset, value] of [[8, 0], [8, 2], [9, 1], [9, 9], [10, 1], [11, 1]]) {
      const input = cindyFixture(); input[offset] = value
      await expect(parseArchive(input)).rejects.toThrow()
    }
    const invalidMagic = cindyFixture(); invalidMagic[0] |= 0x80
    await expect(parseArchive(invalidMagic)).rejects.toThrow()
    await expect(parseArchive(Buffer.from('XDTSHARE'))).rejects.toThrow(/头/)
    await expect(parseArchive(cindyFixture().subarray(0, 40))).rejects.toThrow()
  })
  it('拒绝未来格式、Orca 协同包及不完整清单', async () => {
    for (const manifest of [{ formatVersion: 2, minReaderVersion: 2 }, { minReaderVersion: 2 },
      { orca: { workers: [] } }, { entries: [] }, { counts: { messages: 99, media: 0 } }, { agentKind: 'unknown' }]) {
      await expect(parseArchive(cindyFixture(cindyEntries({ manifest })))).rejects.toThrow()
    }
  })
  it('核对每条清单的字节数和 SHA-256，拒绝缺件和未列出的文件', async () => {
    const original = cindyEntries()
    for (const field of ['sha256', 'bytes', 'path']) {
      const entries = cindyEntries()
      const manifest = JSON.parse(entries.at(-1)!.content.toString())
      manifest.entries[0][field] = field === 'bytes' ? 1 : field === 'sha256' ? 'a'.repeat(64) : 'missing.json'
      entries.at(-1)!.content = Buffer.from(JSON.stringify(manifest))
      await expect(parseArchive(cindyFixture(entries))).rejects.toThrow()
    }
    await expect(parseArchive(cindyFixture(original.filter(entry => entry.name !== 'session.json')))).rejects.toThrow()
    await expect(parseArchive(cindyFixture([...original, { name: 'undeclared.txt', content: Buffer.from('x') }]))).rejects.toThrow()
  })
  it('拒绝非法角色、重复消息 ID、错误时间及截断 JSONL', async () => {
    for (const messages of [[cindyMessage({ role: 'root' })], [cindyMessage(), cindyMessage()],
      [cindyMessage({ createdAt: 'yesterday' })], [cindyMessage({ content: null })]]) {
      await expect(parseArchive(cindyFixture(cindyEntries({ messages })))).rejects.toThrow()
    }
    await expect(parseArchive(cindyFixture(cindyEntries({ session: { updatedAt: null } })))).rejects.toThrow()
    const entries = cindyEntries()
    entries.find(entry => entry.name === 'messages.jsonl')!.content = Buffer.from('{')
    const manifest = JSON.parse(entries.at(-1)!.content.toString())
    const { createHash } = await import('node:crypto')
    const item = manifest.entries.find((entry: { path: string }) => entry.path === 'messages.jsonl')
    item.bytes = 1; item.sha256 = createHash('sha256').update('{').digest('hex')
    entries.at(-1)!.content = Buffer.from(JSON.stringify(manifest))
    await expect(parseArchive(cindyFixture(entries))).rejects.toThrow()
  })
  it('ZIP 不落盘，拒绝穿越、绝对路径、反斜杠、重复路径和符号链接', async () => {
    for (const name of ['../escape', '/absolute', 'C:/absolute', 'a\\b', 'a/./b', 'a//b', 'messages.jsonl']) {
      await expect(parseArchive(cindyFixture(cindyEntries({ extra: [{ name, content: Buffer.from('x') }] })))).rejects.toThrow()
    }
    await expect(parseArchive(cindyFixture(cindyEntries({ extra: [{ name: 'link', content: Buffer.from('../outside'), attributes: 0xa1ff0000 }] })))).rejects.toThrow()
  })
  it('限制累计压缩数据处理量，阻止重复引用空流放大解压工作', async () => {
    const header = cindyFixture().subarray(0, 12)
    await expect(parseArchive(Buffer.concat([header, sharedEmptyZipFixture()]))).rejects.toThrow(/压缩数据.*预算/)
  })
  it('拒绝压缩炸弹、过多条目与错误 CRC；允许正常目录项', async () => {
    await expect(parseArchive(cindyFixture(cindyEntries({ extra: [{ name: 'bomb', content: Buffer.alloc(1024 * 1024) }] })))).rejects.toThrow(/压缩比|预算/)
    const many = Array.from({ length: 1025 }, (_, i) => ({ name: `item-${i}/`, content: Buffer.alloc(0) }))
    await expect(parseArchive(cindyFixture(many))).rejects.toThrow(/条目/)
    expect((await parseArchive(cindyFixture(cindyEntries({ extra: [{ name: 'media/', content: Buffer.alloc(0) }] })))).session.source).toBe('cindy')
    const entries = cindyEntries().map(entry => ({ ...entry, stored: true }))
    const zip = zipFixture(entries)
    const firstData = 30 + Buffer.byteLength(entries[0].name)
    zip[firstData] ^= 1
    const header = cindyFixture().subarray(0, 12)
    await expect(parseArchive(Buffer.concat([header, zip]))).rejects.toThrow(/CRC/)
  })
})
