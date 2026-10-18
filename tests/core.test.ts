import { describe, expect, it } from 'vitest'
import { fixtureSessions as demoSessions } from './fixtures/sessions'
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
    expect(text).toContain('# Pinekin 上下文交接')
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
  it('带来源报告的文本快照使用 v2，兼容 v1 但不隐式降级', () => {
    const s = { ...session(), source: 'cindy' as const, archive: {
      adapterId: 'cindy-cshare', adapterVersion: '0.1.0', sha256: 'a'.repeat(64),
      importedAt: '2026-10-16T00:00:00.000Z', originalSessionId: 'source-session',
      fidelity: 'text-only' as const, warnings: ['附件未映射'],
    } }
    const bundle = makeBundle(s)
    expect(bundle.version).toBe(2)
    expect(parseBundle(JSON.stringify(bundle)).session).toEqual(s)
    expect(() => parseBundle(JSON.stringify({ ...bundle, version: 1 }))).toThrow()
    expect(() => parseBundle(JSON.stringify({ ...bundle, format: 'ember.session' }))).toThrow()
    expect(makeHandoff(s, '通用')).toContain('附件未映射')
    expect(makeHandoff(s, '通用')).toContain('原始文件不随交接导出')
  })
  it('发现、正文直读、文件归档分别声明，不把 Harness 等同于网页聊天', () => {
    expect(adapters.find(adapter => adapter.id === 'codex')).toMatchObject({ archiveStatus: 'fixture-tested',
      capabilities: { importArchive: true, listLocal: true, readLocal: true, nativeResume: false, deepLink: false } })
    expect(adapters.find(adapter => adapter.id === 'deepseek')).toMatchObject({ archiveStatus: 'fixture-tested',
      capabilities: { importArchive: true, listLocal: true, readLocal: true, nativeResume: false, deepLink: false } })
    expect(adapters.find(adapter => adapter.id === 'deepseek')?.constraints).toMatch(/Harness.*v4/)
    expect(adapters.find(adapter => adapter.id === 'deepseek')?.constraints).toMatch(/网页聊天.*不支持/)
    expect(adapters.find(adapter => adapter.id === 'cindy')?.constraints).toMatch(/本地快照/)
    for (const id of ['newmax', 'claude-code']) expect(adapters.find(adapter => adapter.id === id)).toMatchObject({
      archiveStatus: 'fixture-tested', capabilities: { importArchive: true, listLocal: true, readLocal: true, nativeResume: false, deepLink: false },
    })
    expect(adapters.find(adapter => adapter.id === 'newmax')?.constraints).toMatch(/白名单快照/)
    expect(adapters.find(adapter => adapter.id === 'claude-code')?.constraints).toMatch(/父链/)
  })
  it('尚未实现的适配器绝不声明原生迁移能力', () => {
    expect(adapters.length).toBeGreaterThanOrEqual(3)
    expect(adapters.every(a => !a.capabilities.nativeResume && !a.capabilities.deepLink)).toBe(true)
    expect(adapters.find(a => a.id === 'cindy')?.capabilities).toMatchObject({ listLocal: true, readLocal: false })
  })
})
