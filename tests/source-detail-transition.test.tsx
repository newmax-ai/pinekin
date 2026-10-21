// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDetailTransition } from '../src/renderer/src/components/useDetailTransition'
import { SourceApp } from '../src/renderer/src/SourceApp'
import { fixtureSessions } from './fixtures/sessions'
import { mockSourcesAPI } from './fixtures/source-api'
import type { SourceContent } from '../src/core/sources'

function Harness() {
  const [value, setValue] = useState('初始正文')
  const transition = useDetailTransition()
  return <><button onClick={() => transition(() => setValue('会话 A'))}>A</button>
    <button onClick={() => transition(() => setValue('会话 B'))}>B</button><p>{value}</p></>
}
function deferred() {
  let resolve!: () => void, reject!: (reason: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function mockTransitions() {
  const transitions: Array<{ commit: () => void; skipTransition: ReturnType<typeof vi.fn>; ready: ReturnType<typeof deferred>; finished: ReturnType<typeof deferred>; updated: ReturnType<typeof deferred> }> = []
  const start = vi.fn((update: () => void) => {
    const ready = deferred(), finished = deferred(), updated = deferred()
    const item = { commit: () => { update(); updated.resolve() }, skipTransition: vi.fn(), ready, finished, updated }
    transitions.push(item)
    return { ready: ready.promise, finished: finished.promise, updateCallbackDone: updated.promise, skipTransition: item.skipTransition }
  })
  Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start })
  return { transitions, start }
}
let media: MediaQueryList
beforeEach(() => {
  const events = new EventTarget()
  media = { matches: false, addEventListener: vi.fn(events.addEventListener.bind(events)), removeEventListener: vi.fn(events.removeEventListener.bind(events)), dispatchEvent: events.dispatchEvent.bind(events) } as unknown as MediaQueryList
  vi.stubGlobal('matchMedia', vi.fn(() => media))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'startViewTransition')
  document.documentElement.removeAttribute('data-detail-transition')
})
function reduceMotion() {
  Object.defineProperty(media, 'matches', { configurable: true, value: true })
  act(() => { media.dispatchEvent(new Event('change')) })
}

const sessions = fixtureSessions.slice(0, 2)
const connection = { id: '11111111-1111-4111-8111-111111111111', source: 'claude-code' as const, label: 'synthetic', status: 'ready' as const, discovered: 2, total: 2, issues: 0, ignoredLinks: 0 }
const entries = sessions.map(session => ({ id: session.id, connectionId: connection.id, source: connection.source, title: session.title, project: 'synthetic', updatedAt: session.updatedAt, availability: 'readable' as const }))
function setupSourceApp() {
  window.staithe = { platform: 'darwin', list: vi.fn(), previewImport: vi.fn(), confirmImport: vi.fn(), cancelImport: vi.fn(), exportSession: vi.fn(), copy: vi.fn(), onOpenSession: vi.fn().mockReturnValue(() => {}),
    sources: { ...mockSourcesAPI(), page: vi.fn().mockResolvedValue({ items: entries, total: 2, offset: 0, hasMore: false, connections: [connection] }),
      read: vi.fn().mockImplementation(async id => ({ session: sessions.find(session => session.id === id)!, warnings: [] })) } }
  return render(<SourceApp />)
}

describe('来源会话切换接入', () => {
  it('点击、返回和前进走同一画面过渡，重复选中不启动；页头和按钮始终复用', async () => {
    const { start, transitions } = mockTransitions()
    setupSourceApp()
    fireEvent.click(await screen.findByRole('button', { name: `${entries[0].title} synthetic` }))
    expect(start).toHaveBeenCalledOnce()
    await act(async () => transitions[0].commit())
    const header = document.querySelector('.detail-header')!
    const button = screen.getByRole('button', { name: '更多会话操作' })
    fireEvent.click(screen.getByRole('button', { name: `${entries[0].title} synthetic` }))
    expect(start).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: `${entries[1].title} synthetic` }))
    await act(async () => transitions[1].commit())
    expect(document.querySelector('.detail-header')).toBe(header)
    expect(screen.getByRole('button', { name: '更多会话操作' })).toBe(button)
    expect(screen.getByRole('heading', { level: 2, name: entries[1].title })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await act(async () => transitions[2].commit())
    expect(screen.getByRole('heading', { level: 2, name: entries[0].title })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '前进' }))
    await act(async () => transitions[3].commit())
    expect(screen.getByRole('heading', { level: 2, name: entries[1].title })).toBeTruthy()
    expect(start).toHaveBeenCalledTimes(4)
    expect(document.querySelectorAll('.detail-header')).toHaveLength(1)
  })
  it('慢读取也立即隔离旧正文和按钮能力，后到正文不等动画结束，迟到旧结果不能回写', async () => {
    const { transitions } = mockTransitions()
    setupSourceApp()
    let finishFirst!: (value: SourceContent) => void, finishSecond!: (value: SourceContent) => void
    vi.mocked(window.staithe.sources.read)
      .mockReturnValueOnce(new Promise(resolve => { finishFirst = resolve }))
      .mockReturnValueOnce(new Promise(resolve => { finishSecond = resolve }))
    fireEvent.click(await screen.findByRole('button', { name: `${entries[0].title} synthetic` }))
    await act(async () => transitions[0].commit())
    fireEvent.click(screen.getByRole('button', { name: `${entries[1].title} synthetic` }))
    await act(async () => transitions[1].commit())
    expect(screen.getByRole('heading', { level: 2, name: entries[1].title })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '会话消息' })).toBeNull()
    expect((screen.getByRole('button', { name: '更多会话操作' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { finishSecond({ session: { ...sessions[1], messages: [{ role: 'user', content: '目标合成正文' }] }, warnings: [] }) })
    const viewport = screen.getByRole('region', { name: '会话消息' })
    viewport.scrollTop = 140
    await act(async () => { finishFirst({ session: { ...sessions[0], messages: [{ role: 'user', content: '迟到旧正文' }] }, warnings: [] }); transitions[0].finished.resolve() })
    expect(screen.getByText('目标合成正文')).toBeTruthy()
    expect(screen.queryByText('迟到旧正文')).toBeNull()
    expect(screen.getByRole('region', { name: '会话消息' })).toBe(viewport)
    expect(viewport.scrollTop).toBe(140)
  })
})

describe('会话详情画面过渡', () => {
  it('初始不播放；切换由原生快照淡出衔接，同步提交新正文而不复制或重建节点', async () => {
    const { start, transitions } = mockTransitions()
    render(<Harness />)
    const paragraph = screen.getByText('初始正文')
    expect(start).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    expect(document.documentElement.hasAttribute('data-detail-transition')).toBe(true)
    expect(paragraph.textContent).toBe('初始正文')
    act(() => transitions[0].commit())
    expect(screen.getByText('会话 A')).toBe(paragraph)
    expect(document.querySelectorAll('p')).toHaveLength(1)
    await act(async () => { transitions[0].finished.resolve() })
    expect(document.documentElement.hasAttribute('data-detail-transition')).toBe(false)
  })
  it('快速连续切换取消旧动画，旧回调及结束事件均不能覆盖新目标', async () => {
    const { transitions } = mockTransitions()
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    fireEvent.click(screen.getByRole('button', { name: 'B' }))
    expect(transitions[0].skipTransition).toHaveBeenCalledOnce()
    act(() => { transitions[1].commit(); transitions[0].commit() })
    expect(screen.getByText('会话 B')).toBeTruthy()
    await act(async () => { transitions[0].finished.resolve() })
    expect(document.documentElement.hasAttribute('data-detail-transition')).toBe(true)
    await act(async () => { transitions[1].finished.resolve() })
    expect(document.documentElement.hasAttribute('data-detail-transition')).toBe(false)
  })
  it.each(['无 API', '减少动态效果', '后台窗口'])('%s 时立即切换，不依赖动画结束', scenario => {
    const { start } = mockTransitions()
    if (scenario === '无 API') Reflect.deleteProperty(document, 'startViewTransition')
    if (scenario === '减少动态效果') reduceMotion()
    if (scenario === '后台窗口') vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    expect(screen.getByText('会话 A')).toBeTruthy()
    expect(start).not.toHaveBeenCalled()
    expect(document.documentElement.hasAttribute('data-detail-transition')).toBe(false)
  })
  it('运行中减少动态效果会跳过动画，但仍提交这次导航，并移除媒体监听', () => {
    const { transitions } = mockTransitions()
    const view = render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    reduceMotion()
    expect(transitions[0].skipTransition).toHaveBeenCalledOnce()
    act(() => transitions[0].commit())
    expect(screen.getByText('会话 A')).toBeTruthy()
    view.unmount()
    expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    expect(document.documentElement.hasAttribute('data-detail-transition')).toBe(false)
  })
  it('原生 API 启动失败直接提交导航并清理标记', () => {
    const { start } = mockTransitions()
    start.mockImplementationOnce(() => { throw new Error('合成快照失败') })
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    expect(screen.getByText('会话 A')).toBeTruthy()
    expect(document.documentElement.hasAttribute('data-detail-transition')).toBe(false)
  })
  it('快照或更新失败不产生未处理拒绝，也不丢失或重复导航', async () => {
    const { transitions } = mockTransitions()
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    await act(async () => {
      const error = new Error('合成动画跳过')
      transitions[0].ready.reject(error); transitions[0].updated.reject(error); transitions[0].finished.reject(error)
    })
    expect(screen.getByText('会话 A')).toBeTruthy()
    expect(document.documentElement.hasAttribute('data-detail-transition')).toBe(false)
    act(() => transitions[0].commit())
    expect(screen.getByText('会话 A')).toBeTruthy()
  })
  it('卸载取消动画，迟到回调不再提交状态', () => {
    const { transitions } = mockTransitions()
    const view = render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    view.unmount()
    expect(transitions[0].skipTransition).toHaveBeenCalledOnce()
    act(() => transitions[0].commit())
    expect(document.documentElement.hasAttribute('data-detail-transition')).toBe(false)
  })
  it('没有 matchMedia 时仍可切换', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { transitions } = mockTransitions()
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    act(() => transitions[0].commit())
    expect(screen.getByText('会话 A')).toBeTruthy()
  })
  it('样式仅对详情做透明度过渡，正文后到时独立淡入，减少动态效果关闭全部过渡', () => {
    const css = readFileSync('src/renderer/src/components/DetailTransition.css', 'utf8')
    expect(css).toContain('view-transition-name: none')
    expect(css).toMatch(/\.detail\s*\{[^}]*view-transition-name: session-detail/)
    expect(css).toContain('::view-transition-old(session-detail)')
    expect(css).toContain('::view-transition-new(session-detail)')
    expect(css).toContain('pointer-events: none')
    expect(css).toMatch(/\.source-messages-region[^}]*\.message-column\s*\{[^}]*animation:/)
    expect(css).not.toMatch(/transform:|transition:\s*(?:all|height|width)/)
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
