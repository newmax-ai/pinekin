// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SourceApp } from '../src/renderer/src/SourceApp'
import { mockSourcesAPI } from './fixtures/source-api'
import { fixtureSessions } from './fixtures/sessions'
import type { SourceCheckResult, SourceContent, SourceEntry, SourcePage } from '../src/core/sources'

const connection = { id: '11111111-1111-4111-8111-111111111111', source: 'claude-code' as const, label: 'synthetic', status: 'ready' as const, discovered: 120, total: 120, issues: 0, ignoredLinks: 0 }
const entry: SourceEntry = { id: 'a'.repeat(64), connectionId: connection.id, source: connection.source, title: '原会话', project: '.', updatedAt: '2026-10-18T00:00:00Z', availability: 'unread', revision: 'v1' }
const entries = Array.from({ length: 120 }, (_, i) => ({ ...entry, id: i ? i.toString(16).padStart(64, '0') : entry.id, title: i ? `会话 ${i}` : entry.title }))
const content: SourceContent = { session: { ...fixtureSessions[0], id: entry.id, title: entry.title }, warnings: [], revision: 'v1' }
let version: number, rows: SourceEntry[]
function page(offset = 0, limit = 50, source?: string, query = ''): SourcePage {
  const filtered = rows.filter(item => (!source || item.source === source) && item.title.includes(query))
  return { items: filtered.slice(offset, offset + limit), total: filtered.length, offset, hasMore: offset + limit < filtered.length, connections: [connection], version, snapshot: JSON.stringify(filtered) }
}
function checked(): SourceCheckResult { return { version, connections: [connection], selected: rows.find(item => item.id === entry.id) ?? null } }
beforeEach(() => {
  version = 1; rows = [...entries]
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLElement.prototype.showPopover = function () { this.style.display = 'block' }
  HTMLElement.prototype.hidePopover = function () { this.style.display = 'none' }
  window.staithe = { platform: 'darwin', list: vi.fn(), previewImport: vi.fn(), confirmImport: vi.fn(), cancelImport: vi.fn(), exportSession: vi.fn(), copy: vi.fn(), onOpenSession: vi.fn(),
    sources: { ...mockSourcesAPI(), page: vi.fn().mockImplementation(async query => page(query.offset, query.limit, query.source, query.query)), read: vi.fn().mockResolvedValue(content), check: vi.fn().mockImplementation(async () => checked()) } }
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })
async function open() {
  render(<SourceApp onArchives={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: '原会话 .' }))
  return screen.findByRole('region', { name: '会话消息' })
}
async function refresh() {
  fireEvent.click(screen.getByRole('button', { name: '刷新当前来源' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '刷新当前来源' }).hasAttribute('disabled')).toBe(false))
}

describe('不打断阅读的来源刷新', () => {
  it('来源详情保留来源直读标签，不显示只读文案和锁图标', async () => {
    await open()
    const header = screen.getByRole('region', { name: '来源会话详情' }).querySelector('.detail-header')!
    expect(header.querySelector('.reader-state')?.textContent).toBe('来源直读')
    expect(header.querySelector('.read-only, .reader-state svg')).toBeNull()
  })
  it('手动刷新保留正文、选择、分页及两个滚动位置；向下翻找时仅提示列表更新', async () => {
    const messages = await open()
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    await screen.findByText('100 / 120 条已加载')
    const list = document.querySelector('.session-list') as HTMLElement
    list.scrollTop = 350; messages.scrollTop = 160
    rows = [{ ...entry, id: 'f'.repeat(64), title: '新会话' }, ...rows]; version++
    await refresh()
    expect(window.staithe.sources.check).toHaveBeenCalledWith(expect.objectContaining({ mode: 'manual', selectedId: entry.id }))
    expect(document.querySelectorAll('.session-card')).toHaveLength(100)
    expect(document.querySelector('.session-list')).toBe(list)
    expect(screen.getByRole('region', { name: '会话消息' })).toBe(messages)
    expect(list.scrollTop).toBe(350); expect(messages.scrollTop).toBe(160)
    expect(screen.queryByRole('button', { name: '新会话 .' })).toBeNull()
    expect(window.staithe.sources.read).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '列表有更新，点击查看' }))
    await screen.findByRole('button', { name: '新会话 .' })
    expect(document.querySelectorAll('.session-card')).toHaveLength(100)
    expect(messages.scrollTop).toBe(160)
    expect(screen.getByRole('button', { name: '原会话 .' }).getAttribute('aria-pressed')).toBe('true')
  })
  it('正文变化只提示，点击查看更新保留正文容器及阅读位置，失败保留原文', async () => {
    const messages = await open(); messages.scrollTop = 120
    rows = rows.map(item => item.id === entry.id ? { ...item, revision: 'v2' } : item); version++
    await refresh()
    expect(screen.getByText('此对话有更新')).toBeTruthy()
    expect(window.staithe.sources.read).toHaveBeenCalledOnce()
    vi.mocked(window.staithe.sources.read).mockRejectedValueOnce(new Error('来源仍在写入'))
    fireEvent.click(screen.getByRole('button', { name: '查看更新' }))
    await screen.findByText('来源仍在写入')
    expect(screen.getByRole('region', { name: '会话消息' })).toBe(messages)
    expect(messages.scrollTop).toBe(120)
    vi.mocked(window.staithe.sources.read).mockResolvedValue({ ...content, revision: 'v2', session: { ...content.session, messages: [...content.session.messages, { role: 'assistant', content: '新追加正文' }] } })
    fireEvent.click(screen.getByRole('button', { name: '查看更新' }))
    await screen.findByText('新追加正文')
    expect(messages.scrollTop).toBe(120)
    expect(screen.queryByText('此对话有更新')).toBeNull()
    expect(screen.getByRole('button', { name: '跳到新增消息' })).toBeTruthy()
  })
  it('来源删除保留带明确提示的阅读快照，不再把旧内容当作最新或自动读取', async () => {
    const messages = await open()
    rows = rows.filter(item => item.id !== entry.id); version++
    await refresh()
    expect(screen.getByText('来源会话已删除，当前显示的是上次读取的内容')).toBeTruthy()
    expect(screen.getByRole('region', { name: '会话消息' })).toBe(messages)
    expect(window.staithe.sources.read).toHaveBeenCalledOnce()
  })
  it('失败不清空列表或正文；无变化时不重新分页', async () => {
    const messages = await open()
    vi.mocked(window.staithe.sources.page).mockClear()
    await refresh()
    expect(window.staithe.sources.page).not.toHaveBeenCalled()
    vi.mocked(window.staithe.sources.check).mockRejectedValueOnce(new Error('合成检查失败'))
    await refresh()
    expect(screen.getByText(/合成检查失败/)).toBeTruthy()
    expect(document.querySelectorAll('.session-card')).toHaveLength(50)
    expect(screen.getByRole('region', { name: '会话消息' })).toBe(messages)
  })
  it('可见时低频检查，聚焦防抖合并；隐藏暂停，恢复可见补查；卸载清理', async () => {
    const messages = await open(); expect(messages).toBeTruthy()
    vi.useFakeTimers()
    for (let i = 0; i < 5; i++) fireEvent.focus(window)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(window.staithe.sources.check).toHaveBeenCalledTimes(1)
    fireEvent.focus(window)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(window.staithe.sources.check).toHaveBeenCalledTimes(1)
    vi.mocked(window.staithe.sources.check).mockClear()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000) })
    expect(window.staithe.sources.check).not.toHaveBeenCalled()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(window.staithe.sources.check).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(window.staithe.sources.check).toHaveBeenCalledTimes(2)
    cleanup()
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000) })
    expect(window.staithe.sources.check).toHaveBeenCalledTimes(2)
  })
  it('搜索结果更新先提示，保留关键词、已加载范围和滚动位置', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await screen.findByRole('button', { name: '打开会话：原会话' })
    fireEvent.click(screen.getByRole('button', { name: '加载更多结果' }))
    await waitFor(() => expect(document.querySelectorAll('.search-result')).toHaveLength(100))
    const results = document.querySelector('.search-results') as HTMLElement; results.scrollTop = 250
    rows = [{ ...entry, id: 'f'.repeat(64), title: '搜索新增' }, ...rows]; version++
    fireEvent.focus(window)
    await screen.findByRole('button', { name: '搜索结果有更新，点击查看' })
    expect(document.querySelectorAll('.search-result')).toHaveLength(100)
    expect(results.scrollTop).toBe(250)
    fireEvent.click(screen.getByRole('button', { name: '搜索结果有更新，点击查看' }))
    await screen.findByRole('button', { name: '打开会话：搜索新增' })
    expect(document.querySelectorAll('.search-result')).toHaveLength(100)
  })
  it('手动无变化不提示搜索更新，关键词之外及其他来源的变化也不误提示', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    fireEvent.change(screen.getByRole('textbox', { name: '搜索会话' }), { target: { value: '原会话' } })
    await screen.findByRole('button', { name: '打开会话：原会话' })
    await refresh()
    expect(screen.queryByRole('button', { name: '搜索结果有更新，点击查看' })).toBeNull()
    rows = [...rows, { ...entry, id: 'f'.repeat(64), title: '无关关键词', source: 'cindy' }]; version++
    await refresh()
    await waitFor(() => expect(window.staithe.sources.page).toHaveBeenCalledWith(expect.objectContaining({ query: '原会话', limit: 1 })))
    expect(screen.queryByRole('button', { name: '搜索结果有更新，点击查看' })).toBeNull()
    rows = rows.map(item => item.id === entry.id ? { ...item, revision: 'v2' } : item); version++
    await refresh()
    await screen.findByRole('button', { name: '搜索结果有更新，点击查看' })
  })
  it('来源列表不会因其他 App 的全局变化误提示，分页仍可继续加载', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: /Claude Code.*120/ }))
    await screen.findByText('50 / 120 条已加载')
    const list = document.querySelector('.session-list') as HTMLElement; list.scrollTop = 250
    rows = [...rows, { ...entry, id: 'f'.repeat(64), source: 'cindy', title: '其他 App 新会话' }]; version++
    await refresh()
    expect(screen.queryByRole('button', { name: '列表有更新，点击查看' })).toBeNull()
    expect(list.scrollTop).toBe(250)
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    await screen.findByText('100 / 120 条已加载')
    rows = rows.map((item, index) => index === 119 ? { ...item, title: '末页更新' } : item); version++
    await refresh()
    await screen.findByRole('button', { name: '列表有更新，点击查看' })
  })
  it('分页只遇到全局变化且筛选结果相同时继续合并', async () => {
    await open(); version++
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    await screen.findByText('100 / 120 条已加载')
    expect(screen.queryByRole('button', { name: '列表有更新，点击查看' })).toBeNull()
  })
  it('分页发现目录版本变化时不混合新旧顺序，明确提示查看更新', async () => {
    await open(); rows = [{ ...entry, id: 'f'.repeat(64), title: '分页期间新增' }, ...rows]; version++
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    await screen.findByRole('button', { name: '列表有更新，点击查看' })
    expect(document.querySelectorAll('.session-card')).toHaveLength(50)
  })
  it('自动检查期间可切换来源，迟到结果不覆盖新来源或正文', async () => {
    await open()
    let finish!: (result: SourceCheckResult) => void
    vi.mocked(window.staithe.sources.check).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: '刷新当前来源' }))
    fireEvent.click(screen.getByRole('button', { name: /Claude Code.*120/ }))
    await waitFor(() => expect(window.staithe.sources.page).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'claude-code' })))
    await act(async () => { finish({ ...checked(), version: 2 }) })
    expect(screen.queryByRole('region', { name: '会话消息' })).toBeNull()
    expect(screen.getByRole('button', { name: /Claude Code.*120/ }).getAttribute('aria-pressed')).toBe('true')
  })
})
