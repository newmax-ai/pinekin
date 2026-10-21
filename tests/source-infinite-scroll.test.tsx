// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SourceApp } from '../src/renderer/src/SourceApp'
import type { SourceConnection, SourceEntry, SourcePage } from '../src/core/sources'
import { mockSourcesAPI } from './fixtures/source-api'
import { installListIntersectionObserver, intersectSessionList } from './fixtures/list-intersection'

const connection: SourceConnection = { id: '11111111-1111-4111-8111-111111111111', source: 'claude-code', label: '合成目录', status: 'ready', discovered: 130, total: 130, issues: 0, ignoredLinks: 0 }
const rows: SourceEntry[] = Array.from({ length: 130 }, (_, i) => ({ id: i.toString(16).padStart(64, '0'), connectionId: connection.id, source: connection.source, title: `合成会话 ${i}`, project: '.', updatedAt: '2026-10-21T00:00:00Z', availability: 'unread' }))
function page(offset = 0): SourcePage { return { items: rows.slice(offset, offset + 50), total: rows.length, offset, hasMore: offset + 50 < rows.length, connections: [connection], version: 1, snapshot: 'stable' } }
async function ready() { await screen.findByText('50 / 130 条已加载') }
async function reachEnd() { await act(async () => intersectSessionList()) }

beforeEach(() => {
  installListIntersectionObserver()
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  window.staithe = { platform: 'darwin', list: vi.fn(), previewImport: vi.fn(), confirmImport: vi.fn(), cancelImport: vi.fn(), exportSession: vi.fn(), copy: vi.fn(), onOpenSession: vi.fn(),
    sources: { ...mockSourcesAPI(), page: vi.fn().mockImplementation(async query => page(query.offset)) } }
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('主会话列表滚动加载', () => {
  it('不显示分页按钮，未接近底部不预读；接近底部每次只加载 50 条，不读取正文', async () => {
    render(<SourceApp />); await ready()
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull()
    expect(window.staithe.sources.page).toHaveBeenCalledOnce()
    act(() => intersectSessionList(false))
    expect(window.staithe.sources.page).toHaveBeenCalledOnce()
    const list = document.querySelector('.session-list') as HTMLElement
    list.scrollTop = 2800
    const first = document.querySelector('.session-card')
    await reachEnd()
    await screen.findByText('100 / 130 条已加载')
    expect(window.staithe.sources.page).toHaveBeenLastCalledWith({ query: '', offset: 50, limit: 50 })
    expect(document.querySelector('.session-card')).toBe(first)
    expect(list.scrollTop).toBe(2800)
    expect(window.staithe.sources.read).not.toHaveBeenCalled()
    await reachEnd()
    await screen.findByText('130 / 130 条已加载')
    expect(document.querySelector('.session-list-load')).toBeNull()
    await reachEnd()
    expect(window.staithe.sources.page).toHaveBeenCalledTimes(3)
  })

  it('一次事件批次及在途重复回调都不会重复请求；加载时提供状态', async () => {
    let finish!: (value: SourcePage) => void
    vi.mocked(window.staithe.sources.page).mockResolvedValueOnce(page()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    render(<SourceApp />); await ready()
    act(() => { intersectSessionList(); intersectSessionList(); intersectSessionList() })
    await screen.findByLabelText('正在加载更多会话')
    await reachEnd()
    expect(window.staithe.sources.page).toHaveBeenCalledTimes(2)
    await act(async () => finish(page(50)))
    await screen.findByText('100 / 130 条已加载')
  })

  it('请求失败保留已加载会话并停止自动重试，显式重试后继续滚动加载', async () => {
    vi.mocked(window.staithe.sources.page).mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error('合成分页失败')).mockResolvedValueOnce(page(50))
    render(<SourceApp />); await ready(); await reachEnd()
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('合成分页失败'))
    expect(document.querySelectorAll('.session-card')).toHaveLength(50)
    await reachEnd(); await reachEnd()
    expect(window.staithe.sources.page).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: '重试加载会话' }))
    await screen.findByText('100 / 130 条已加载')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['空页', '全重复页'])('%s仍声称有后续时熔断，不因观察器重建无限请求', async kind => {
    vi.mocked(window.staithe.sources.page).mockResolvedValueOnce(page()).mockResolvedValue({ ...page(50), items: kind === '空页' ? [] : page().items })
    render(<SourceApp />); await ready(); await reachEnd()
    await screen.findByRole('button', { name: '重试加载会话' })
    expect(screen.getByRole('alert').textContent).toContain('分页未取得新会话')
    expect(document.querySelectorAll('.session-card')).toHaveLength(50)
    await reachEnd()
    expect(window.staithe.sources.page).toHaveBeenCalledTimes(2)
  })

  it('目录快照变化时不混合新旧页，暂停加载直到用户查看更新', async () => {
    vi.mocked(window.staithe.sources.page).mockResolvedValueOnce(page()).mockResolvedValue({ ...page(50), snapshot: 'changed', version: 2 })
    render(<SourceApp />); await ready(); await reachEnd()
    await screen.findByRole('button', { name: '列表有更新，点击查看' })
    expect(document.querySelectorAll('.session-card')).toHaveLength(50)
    await reachEnd()
    expect(window.staithe.sources.page).toHaveBeenCalledTimes(2)
  })

  it('切换来源后忽略旧页，旧请求完成不会解锁新来源正在加载的页', async () => {
    let finishOld!: (value: SourcePage) => void, finishNew!: (value: SourcePage) => void
    vi.mocked(window.staithe.sources.page).mockResolvedValueOnce(page())
      .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      .mockResolvedValueOnce({ ...page(), snapshot: 'new-source' })
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve }))
    render(<SourceApp />); await ready(); await reachEnd()
    fireEvent.click(screen.getByRole('button', { name: /Claude Code.*130/ }))
    await waitFor(() => expect(window.staithe.sources.page).toHaveBeenCalledTimes(3))
    await screen.findByText('50 / 130 条已加载')
    await reachEnd()
    await act(async () => finishOld(page(50)))
    await reachEnd()
    expect(window.staithe.sources.page).toHaveBeenCalledTimes(4)
    expect(document.querySelectorAll('.session-card')).toHaveLength(50)
    await act(async () => finishNew({ ...page(50), snapshot: 'new-source' }))
    await screen.findByText('100 / 130 条已加载')
    expect(window.staithe.sources.page).toHaveBeenLastCalledWith({ source: 'claude-code', query: '', offset: 50, limit: 50 })
  })

  it('连接弹窗开启时不在后台加载列表，关闭后恢复', async () => {
    render(<SourceApp />); await ready()
    fireEvent.click(screen.getByRole('button', { name: '连接 App' }))
    await reachEnd()
    expect(window.staithe.sources.page).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '关闭连接面板' }))
    await reachEnd()
    await screen.findByText('100 / 130 条已加载')
  })

  it('卸载清理观察器，迟到页不会触发后续加载', async () => {
    let finish!: (value: SourcePage) => void
    vi.mocked(window.staithe.sources.page).mockResolvedValueOnce(page()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = render(<SourceApp />); await ready(); await reachEnd()
    view.unmount()
    await act(async () => finish(page(50)))
    await reachEnd()
    expect(window.staithe.sources.page).toHaveBeenCalledTimes(2)
  })
})
