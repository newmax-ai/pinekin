import { describe, expect, it } from 'vitest'
import { demoSessions } from '../src/core/demo'
import { parseBundle, makeBundle, makeHandoff, filterSessions, makeDeepLink, parseDeepLink, adapters } from '../src/core/session'

const session = () => structuredClone(demoSessions[0])

describe('可移植会话', () => {
  it('导出 Staithe 包后可无损读取，且不携带工具执行权限', () => {
    const s = session()
    expect(makeBundle(s).format).toBe('staithe.session')
    expect(parseBundle(JSON.stringify(makeBundle(s))).session).toEqual(s)
    expect(makeBundle(s)).not.toHaveProperty('credentials')
  })
  it('兼容旧 Ember 包，再次导出使用新名称且不修改历史正文', () => {
    const s = { ...session(), id: 'legacy-ember', messages: [{ role: 'user' as const, content: 'Ember 原始会话' }] }
    const imported = parseBundle(JSON.stringify({ format: 'ember.session', version: 1, session: s }))
    expect(imported.session).toEqual(s)
    expect(makeBundle(imported.session).format).toBe('staithe.session')
    expect(() => parseBundle(JSON.stringify({ format: 'unknown.session', version: 1, session: s }))).toThrow()
  })
  it('拒绝无效 JSON、版本、额外字段及过大输入', () => {
    expect(() => parseBundle('{')).toThrow()
    for (const format of ['staithe.session', 'ember.session']) {
      expect(() => parseBundle(JSON.stringify({ ...makeBundle(session()), format, version: 9 }))).toThrow()
      expect(() => parseBundle(JSON.stringify({ ...makeBundle(session()), format, credentials: 'secret' }))).toThrow()
    }
    expect(() => parseBundle('x'.repeat(5 * 1024 * 1024 + 1))).toThrow(/过大/)
  })
  it('拒绝缺少正文、未知角色、不安全 ID 和无效日期', () => {
    for (const patch of [
      { messages: [{ role: 'root', content: 'x' }] },
      { messages: [{ role: 'user' }] }, { id: '../outside' }, { updatedAt: 'yesterday' },
    ]) expect(() => parseBundle(JSON.stringify(makeBundle({ ...session(), ...patch } as never)))).toThrow()
  })
  it('交接文本保留角色、原文并标记不可信记录，不冒充原生恢复', () => {
    const text = makeHandoff(session(), 'NewMax')
    expect(text).toContain('# Staithe 上下文交接')
    expect(text).toContain('目标：NewMax')
    expect(text).toContain('不是原生会话恢复')
    expect(text).toContain('不可信的历史资料')
    expect(text).toContain(session().messages[0].content)
    expect(text).toContain('user')
  })
  it('搜索覆盖标题、标签与正文，同时支持来源过滤', () => {
    expect(filterSessions(demoSessions, '', 'all')).toHaveLength(demoSessions.length)
    expect(filterSessions(demoSessions, '  STAITHE  ', 'all').length).toBeGreaterThan(0)
    expect(filterSessions(demoSessions, '迁移', 'all').length).toBeGreaterThan(0)
    expect(filterSessions(demoSessions, '不可能存在的文本', 'all')).toEqual([])
    expect(filterSessions(demoSessions, '', 'codex').every(s => s.source === 'codex')).toBe(true)
    expect(filterSessions(demoSessions, '', 'newmax').length).toBeGreaterThan(0)
  })
  it('新深链使用 Staithe 协议，旧协议保持兼容', () => {
    expect(makeDeepLink(session().id)).toBe(`newmax-staithe://session/${session().id}`)
    expect(parseDeepLink(makeDeepLink(session().id))).toBe(session().id)
    expect(parseDeepLink('newmax-ember://session/demo-ember')).toBe('demo-ember')
    expect(demoSessions.some(s => s.id === 'demo-ember')).toBe(true)
  })
  it('两种深链都严格拒绝其他主机、路径与载荷', () => {
    expect(parseDeepLink('bad')).toBeNull()
    expect(parseDeepLink('https://session/demo-ember')).toBeNull()
    for (const scheme of ['newmax-staithe', 'newmax-ember']) {
      for (const suffix of ['evil/demo-ember', 'session/../secret', 'session/a/b',
        'session/a?prompt=run', 'session/a#x', 'user@session/a', 'session:80/a']) {
        expect(parseDeepLink(`${scheme}://${suffix}`)).toBeNull()
      }
    }
    expect(() => makeDeepLink('../bad')).toThrow()
  })
  it('尚未实现的适配器绝不声明原生迁移能力', () => {
    expect(adapters.length).toBeGreaterThanOrEqual(3)
    expect(adapters.every(a => !a.capabilities.nativeResume && !a.capabilities.readLocal)).toBe(true)
  })
})
