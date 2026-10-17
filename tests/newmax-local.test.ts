import { describe, expect, it } from 'vitest'
import { parseNewMaxLocal } from '../src/main/newmax-local'
import { newmaxSnapshot } from './fixtures/newmax'
import { makeHandoff } from '../src/core/session'

describe('NewMax 字段白名单快照', () => {
  it('保留当前正文与角色，快照只声明文本档案，不冒充原生恢复', () => {
    const parsed = parseNewMaxLocal(newmaxSnapshot())
    expect(parsed).toMatchObject({ adapterId: 'newmax-local-snapshot', sourceVersion: '1.1.22', originalSessionId: 'newmax-synthetic',
      session: { title: 'NewMax 合成会话', source: 'newmax', demo: false } })
    expect(parsed.session.messages).toEqual([{ role: 'user', content: '合成问题：整理项目计划' }, { role: 'assistant', content: '合成答复：先确认目标。' }])
    expect(parsed.warnings.join('\n')).toMatch(/不是.*原生恢复/)
    expect(parsed.warnings.join('\n')).toMatch(/附件/)
  })
  it('按 seq 保留顺序，用户展示文本优先；内部续轮与空消息不进入交接', () => {
    const snapshot = newmaxSnapshot()
    Object.assign(snapshot.messages[0], { displayContent: '<script>不执行</script> /synthetic' })
    snapshot.messages.push({ ...snapshot.messages[1], id: 'internal', seq: 14, content: '内部续轮不得冒充用户输入', internal: true })
    snapshot.messages.push({ ...snapshot.messages[1], id: 'empty', seq: 16, content: '  ' })
    snapshot.session.messageCount = 4
    const parsed = parseNewMaxLocal(snapshot)
    expect(parsed.session.messages).toHaveLength(2)
    expect(parsed.session.messages[0].content).toBe('<script>不执行</script> /synthetic')
    expect(makeHandoff({ ...parsed.session, archive: { adapterId: parsed.adapterId, adapterVersion: parsed.adapterVersion,
      sha256: 'a'.repeat(64), importedAt: '2026-10-17T00:00:00Z', originalSessionId: null, fidelity: 'text-only', warnings: parsed.warnings } }, '通用')).not.toContain('内部续轮不得冒充用户输入')
  })
  it.each([
    (s: ReturnType<typeof newmaxSnapshot>) => { s.version = 9 },
    (s: ReturnType<typeof newmaxSnapshot>) => { s.sourceVersion = 'future' },
    (s: ReturnType<typeof newmaxSnapshot>) => { s.session.source = 'claude_code' },
    (s: ReturnType<typeof newmaxSnapshot>) => { Object.assign(s.session, { isPrivate: true }) },
    (s: ReturnType<typeof newmaxSnapshot>) => { Object.assign(s.session, { forkedFromConversationId: 'parent' }) },
    (s: ReturnType<typeof newmaxSnapshot>) => { s.session.messageCount = 3 },
    (s: ReturnType<typeof newmaxSnapshot>) => { s.messages[1].seq = 9 },
    (s: ReturnType<typeof newmaxSnapshot>) => { s.messages[1].id = 'u1' },
    (s: ReturnType<typeof newmaxSnapshot>) => { s.messages[1].role = 'tool' },
    (s: ReturnType<typeof newmaxSnapshot>) => { s.messages[1].content = 'x'.repeat(200_001) },
    (s: ReturnType<typeof newmaxSnapshot>) => { s.messages[1].timestamp = -1 },
    (s: ReturnType<typeof newmaxSnapshot>) => { Object.assign(s, { credentials: '不得接受' }) },
  ])('拒绝不支持的版本、来源、隐私或分支、片段、重复和超限字段 %#', patch => {
    const snapshot = newmaxSnapshot(); patch(snapshot)
    expect(() => parseNewMaxLocal(snapshot)).toThrow(/NewMax/)
  })
  it('空白或仅内部消息不能伪造有内容的会话', () => {
    const snapshot = newmaxSnapshot()
    snapshot.messages.forEach(message => { message.internal = true })
    expect(() => parseNewMaxLocal(snapshot)).toThrow(/没有/)
  })
  it('校验错误不回显正文和额外秘密字段', () => {
    const snapshot = newmaxSnapshot()
    Object.assign(snapshot.messages[0], { unexpected: 'PRIVATE_SENTINEL' })
    try { parseNewMaxLocal(snapshot); expect.unreachable() }
    catch (error) { expect(String(error)).not.toContain('PRIVATE_SENTINEL') }
  })
})
