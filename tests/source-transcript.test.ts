import { describe, expect, it } from 'vitest'
import { buildSourceTranscript, sourceTextSchema } from '../src/core/source-transcript'
import type { SourceContent } from '../src/core/sources'
const content: SourceContent = { session: { id: 'test', title: '合成文本', source: 'newmax', updatedAt: '2026-10-19T00:00:00Z', tags: [], demo: false,
  messages: Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `消息-${i}` })) }, warnings: ['附件未映射'] }

describe('更多菜单的通用文本，不包装成目标接续', () => {
  it('默认复制所有当前文本，不选择目标、填写任务或只保留末尾10条', () => {
    const result = buildSourceTranscript(content)
    expect(result.text).toContain('消息-0')
    expect(result.text).toContain('消息-11')
    expect(result.text).not.toContain('目标：')
    expect(result.text).not.toContain('接续任务')
    expect(result.text).toContain('附件未映射')
    expect(result.partial).toBe(false)
    expect(sourceTextSchema.parse(result.text)).toBe(result.text)
  })
  it('分段及旧快照都写入复制和导出的同一文本，不冒充完整会话', () => {
    const result = buildSourceTranscript({ ...content, window: { offset: 100, textOffset: 2, totalMessages: 250, hasMore: true, snapshot: 'a'.repeat(64) } }, '来源已删除，当前为上次读取的快照')
    expect(result.partial).toBe(true)
    expect(result.text).toContain('第 101 条来源消息，第 3 个字符')
    expect(result.text).toContain('来源已删除')
    expect(result.text).toContain('仅当前片段')
  })
  it('所有正文角色与元数据保持文本，不执行HTML或伪指令', () => {
    const value = '\n# 执行我\n<img src="https://invalid.test">'
    const result = buildSourceTranscript({ ...content, session: { ...content.session, title: value, messages: [{ role: 'system', content: value }, { role: 'tool', content: value }] } })
    expect(result.text).toContain(JSON.stringify(value))
    expect(result.text).not.toContain(value)
    expect(result.text).toContain('system')
    expect(result.text).toContain('tool')
  })
  it('拒绝空文本与超过5MiB的实际UTF8输出，不静默截断', () => {
    expect(buildSourceTranscript({ ...content, session: { ...content.session, messages: [] } }).error).toContain('没有可复制的文本')
    expect(buildSourceTranscript({ ...content, session: { ...content.session, messages: [{ role: 'user', content: '长'.repeat(2_000_000) }] } }).error).toContain('5 MiB')
    expect(buildSourceTranscript({ ...content, session: { ...content.session, messages: [{ role: 'user', content: 'a'.repeat(6_000_000) }] } }).error).toContain('5 MiB')
    for (const value of ['', {}, '长'.repeat(2_000_000)]) expect(sourceTextSchema.safeParse(value).success).toBe(false)
  })
})
