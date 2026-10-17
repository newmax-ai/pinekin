import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fixtureSessions as demoSessions } from './fixtures/sessions'
import { makeBundle, makeDeepLink, makeHandoff, parseBundle } from '../src/core/session'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('Pinekin 品牌与兼容身份', () => {
  it('包元数据和锁文件使用新品牌，但不更换安装身份或协议', () => {
    const pkg = JSON.parse(read('../package.json'))
    const lock = JSON.parse(read('../package-lock.json'))
    expect(pkg.name).toBe('@newmax-ai/pinekin')
    expect(pkg.description).toBe('Pinekin — 换个地方，继续思考。')
    expect(lock.name).toBe(pkg.name)
    expect(lock.packages[''].name).toBe(pkg.name)
    expect(pkg.build.productName).toBe('Pinekin')
    expect(pkg.build.appId).toBe('ai.newmax.staithe')
    expect(pkg.build.protocols).toEqual([{ name: 'Pinekin 本地会话', schemes: ['newmax-staithe', 'newmax-ember'] }])
  })
  it('窗口页面标题使用 Pinekin', () => {
    expect(read('../src/renderer/index.html')).toContain('<title>Pinekin · 换个地方，继续思考</title>')
  })
  it('新交接标题不改写格式、正文、标签与会话 ID', () => {
    const session = { ...structuredClone(demoSessions[0]), id: 'staithe-before-rename', tags: ['Staithe', 'Ember'],
      messages: [{ role: 'user' as const, content: 'Staithe 与 Ember 的原始记录，不要替换。' }] }
    const original = structuredClone(session)
    const bundle = makeBundle(session)
    expect(bundle.format).toBe('staithe.session')
    expect(parseBundle(JSON.stringify(bundle)).session).toEqual(original)
    expect(makeDeepLink(session.id)).toBe('newmax-staithe://session/staithe-before-rename')
    const text = makeHandoff(session, '通用')
    expect(text).toMatch(/^# Pinekin 上下文交接/)
    expect(text).toContain(session.messages[0].content)
    expect(session).toEqual(original)
  })
})
