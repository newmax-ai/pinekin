// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SourceApp } from '../src/renderer/src/SourceApp'
import { ArchiveApp } from '../src/renderer/src/App'
import { mockSourcesAPI } from './fixtures/source-api'
import { fixtureSessions } from './fixtures/sessions'
import type { SourceConnection, SourceEntry } from '../src/core/sources'

const connection: SourceConnection = { id: 'fixture', source: 'claude-code', label: '合成位置', status: 'ready', discovered: 0, total: 0, issues: 0, ignoredLinks: 0 }
const entry: SourceEntry = { id: 'a'.repeat(64), connectionId: connection.id, source: 'claude-code', title: '合成会话', project: '', updatedAt: '2026-10-18T00:00:00Z', availability: 'unread' }
const emptyPage = { items: [], total: 0, offset: 0, hasMore: false, connections: [connection] }
afterEach(cleanup)
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  window.staithe = {
    platform: 'darwin', sources: mockSourcesAPI(), list: vi.fn().mockResolvedValue([]), previewImport: vi.fn().mockResolvedValue(null),
    confirmImport: vi.fn(), cancelImport: vi.fn(), exportSession: vi.fn(), copy: vi.fn(), onOpenSession: vi.fn().mockReturnValue(() => {}),
  }
})
const detail = () => screen.getByRole('region', { name: '来源会话详情' })
async function sourceReady() { await waitFor(() => expect((screen.getByRole('button', { name: '搜索' }) as HTMLButtonElement).disabled).toBe(false)) }
function search(value: string) {
  fireEvent.click(screen.getByRole('button', { name: '搜索' }))
  fireEvent.change(screen.getByRole('textbox', { name: '搜索会话' }), { target: { value } })
}

describe('来源空占位接入', () => {
  it('初次加载两栏不短暂显示未连接，加载完成仅主空区显示插画和行动', async () => {
    let resolve!: (value: typeof emptyPage) => void
    vi.mocked(window.staithe.sources.page).mockReturnValueOnce(new Promise(done => { resolve = done }))
    render(<SourceApp onArchives={() => {}} />)
    expect(document.querySelector('[data-empty-state="disconnected"]')).toBeNull()
    expect(document.querySelector('.empty-illustration')).toBeNull()
    resolve({ ...emptyPage, connections: [] }); await sourceReady()
    expect(document.querySelectorAll('.workspace .empty-illustration')).toHaveLength(1)
    expect(document.querySelector('.empty-footnote')).toBeNull()
    expect(detail().querySelector('.empty-description')?.textContent).toBe('支持 Claude Code、Codex 等来源。')
    expect(within(detail()).getByRole('heading', { name: '尚未连接会话来源' })).toBeTruthy()
    fireEvent.click(within(detail()).getByRole('button', { name: '连接来源 App' }))
    expect(screen.getByRole('dialog', { name: '连接来源 App' })).toBeTruthy()
    expect(window.staithe.sources.autoConnect).not.toHaveBeenCalled()
  })
  it.each([
    ['scanning', 'scanning'], ['idle', 'needs-refresh'], ['partial', 'partial'], ['cancelled', 'paused'], ['error', 'connection-error'], ['ready', 'empty'],
  ] as const)('%s 无数据时不会展示不适用的“选中一段对话”引导', async (status, kind) => {
    vi.mocked(window.staithe.sources.page).mockResolvedValue({ ...emptyPage, connections: [{ ...connection, status }] })
    render(<SourceApp onArchives={() => {}} />); await sourceReady()
    expect(detail().querySelector('[data-empty-state]')?.getAttribute('data-empty-state')).toBe(kind)
    const listEmpty = document.querySelector('.session-list .empty-state')!
    expect(listEmpty.querySelector('h2, h3, img')).toBeNull()
    expect(listEmpty.querySelectorAll('p')).toHaveLength(1)
    expect(listEmpty.textContent!.length).toBeLessThanOrEqual(16)
    expect(detail().textContent).not.toContain('选中一段对话')
    expect(document.querySelector('.empty-footnote')).toBeNull()
    expect(detail().textContent).not.toContain('本地读取 · 只读浏览 · 按需接续')
    if (status === 'idle') {
      expect(within(detail()).getByRole('heading').textContent).toBe('等待刷新')
      expect(detail().querySelector('.empty-description')?.textContent).toBe('连接位置已保留，会话列表尚未更新。')
    }
    expect(screen.queryByText('检查连接状态，或调整搜索条件。')).toBeNull()
    expect(document.querySelectorAll('.workspace .empty-illustration')).toHaveLength(status === 'scanning' ? 0 : 1)
    if (status === 'idle' || status === 'cancelled' || status === 'partial') {
      fireEvent.click(within(detail()).getByRole('button', { name: '刷新' }))
      await waitFor(() => expect(window.staithe.sources.check).toHaveBeenCalledWith({ mode: 'manual', connectionIds: [connection.id] }))
    }
    if (status === 'error') {
      fireEvent.click(within(detail()).getByRole('button', { name: '管理连接' }))
      expect(screen.getByRole('dialog', { name: '管理连接' })).toBeTruthy()
    }
  })
  it('列表请求失败有独立重试入口，重试的是列表请求而非擅自扫描', async () => {
    vi.mocked(window.staithe.sources.page).mockRejectedValueOnce(new Error('列表请求失败')).mockResolvedValue(emptyPage)
    render(<SourceApp onArchives={() => {}} />)
    await screen.findByText('列表请求失败', { selector: '.detail .empty-description' })
    expect(detail().querySelector('[data-empty-state]')?.getAttribute('data-empty-state')).toBe('list-error')
    fireEvent.click(screen.getByRole('button', { name: '连接 App' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭连接面板' }))
    expect(detail().querySelector('[data-empty-state]')?.getAttribute('data-empty-state')).toBe('list-error')
    fireEvent.click(within(detail()).getByRole('button', { name: '重新加载' }))
    await waitFor(() => expect(detail().querySelector('[data-empty-state]')?.getAttribute('data-empty-state')).toBe('empty'))
    expect(window.staithe.sources.refresh).not.toHaveBeenCalled()
  })
  it('统计轮询失败时保留已发现条目与具体原因，不用空页覆盖结果', async () => {
    vi.mocked(window.staithe.sources.page).mockResolvedValueOnce({ ...emptyPage, items: [entry], total: 1, connections: [{ ...connection, status: 'scanning' }] })
      .mockRejectedValue(new Error('后续目录读取失败'))
    render(<SourceApp onArchives={() => {}} />); await sourceReady()
    await waitFor(() => expect(document.querySelector('.session-list')?.textContent).toContain('后续目录读取失败'))
    expect(screen.getByRole('button', { name: '合成会话' })).toBeTruthy()
    expect(detail().querySelector('[data-empty-state]')?.getAttribute('data-empty-state')).toBe('selection')
    expect(document.querySelector('.session-list .empty-illustration')).toBeNull()
  })
  it('存在会话但未选中时使用等待选择插画，不读取正文', async () => {
    vi.mocked(window.staithe.sources.page).mockResolvedValue({ ...emptyPage, items: [entry], total: 1 })
    render(<SourceApp onArchives={() => {}} />); await sourceReady()
    expect(detail().querySelector('[data-empty-state]')?.getAttribute('data-empty-state')).toBe('selection')
    expect(detail().querySelector('img')?.getAttribute('src')).toContain('/selection.svg')
    expect(window.staithe.sources.read).not.toHaveBeenCalled()
  })
  it('只有完成统计后的有效搜索显示无结果，清空后保持来源', async () => {
    vi.mocked(window.staithe.sources.page).mockImplementation(async request => ({ ...emptyPage, items: request.query ? [] : [entry], total: request.query ? 0 : 1 }))
    render(<SourceApp onArchives={() => {}} />); await sourceReady()
    fireEvent.click(screen.getByRole('button', { name: /^Claude Code/ })); await sourceReady()
    search('不存在'); await sourceReady()
    const dialog = screen.getByRole('dialog', { name: '搜索会话' })
    await waitFor(() => expect(dialog.querySelector('[data-empty-state]')?.getAttribute('data-empty-state')).toBe('no-results'))
    expect(dialog.querySelector('img')?.getAttribute('src')).toContain('/search.svg')
    fireEvent.click(within(dialog).getByRole('button', { name: '清空关键词' }))
    await waitFor(() => expect(window.staithe.sources.page).toHaveBeenLastCalledWith(expect.objectContaining({ query: '', source: 'claude-code' })))
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '搜索会话' }))
  })
  it('搜索中列表失败不伪装为没有匹配', async () => {
    vi.mocked(window.staithe.sources.page).mockImplementation(async request => {
      if (request.query) throw new Error('搜索目录不可访问')
      return { ...emptyPage, items: [entry], total: 1 }
    })
    render(<SourceApp onArchives={() => {}} />); await sourceReady(); search('词')
    const dialog = screen.getByRole('dialog', { name: '搜索会话' })
    await waitFor(() => expect(dialog.querySelector('[data-empty-state]')?.getAttribute('data-empty-state')).toBe('list-error'))
    expect(within(dialog).queryByText('没有匹配的会话')).toBeNull()
  })
  it.each(['unsupported', 'error', 'empty'] as const)('正文 %s 使用不同提示和恢复规则', async state => {
    vi.mocked(window.staithe.sources.page).mockResolvedValue({ ...emptyPage, items: [{ ...entry, availability: state === 'unsupported' ? 'unsupported' : 'unread', reason: '此结构暂未支持' }], total: 1 })
    vi.mocked(window.staithe.sources.read).mockRejectedValue(new Error('文件已被移动'))
    if (state === 'empty') vi.mocked(window.staithe.sources.read).mockResolvedValue({ session: { ...fixtureSessions[0], messages: [] }, warnings: [] })
    render(<SourceApp onArchives={() => {}} />); await sourceReady()
    fireEvent.click(screen.getByRole('button', { name: '合成会话' }))
    await waitFor(() => expect(detail().querySelector('[data-empty-state]')?.getAttribute('data-empty-state')).toBe(state === 'error' ? 'read-error' : state === 'empty' ? 'messages' : 'unsupported'))
    expect(within(detail()).queryByRole('button', { name: '重试读取' }) !== null).toBe(state === 'error')
    if (state === 'error') {
      fireEvent.click(within(detail()).getByRole('button', { name: '重试读取' }))
      await waitFor(() => expect(window.staithe.sources.read).toHaveBeenCalledTimes(2))
    }
    if (state === 'unsupported') expect(window.staithe.sources.read).not.toHaveBeenCalled()
    if (state === 'empty') expect(detail().textContent).not.toContain('对话到这里')
  })
  it('管理连接的空列表复用插画与连接入口', async () => {
    render(<SourceApp onArchives={() => {}} />); await sourceReady()
    fireEvent.click(screen.getByRole('button', { name: '连接 App' }))
    fireEvent.click(screen.getByRole('button', { name: '管理连接' }))
    const dialog = screen.getByRole('dialog', { name: '管理连接' })
    expect(dialog.querySelector('[data-empty-state]')?.getAttribute('data-empty-state')).toBe('connections-empty')
    fireEvent.click(within(dialog).getByRole('button', { name: '连接来源 App' }))
    expect(screen.getByRole('dialog', { name: '连接来源 App' })).toBeTruthy()
  })
})

describe('档案空占位接入', () => {
  it('档案读取失败不显示还没有档案，重新加载可恢复', async () => {
    vi.mocked(window.staithe.list).mockRejectedValueOnce(new Error('合成读取失败')).mockResolvedValue([])
    render(<ArchiveApp />)
    await screen.findByText('合成读取失败', { selector: '.detail .empty-description' })
    expect(screen.queryByText('还没有会话档案')).toBeNull()
    fireEvent.click(within(screen.getByRole('region', { name: '会话详情' })).getByRole('button', { name: '重新加载' }))
    await screen.findByText('暂无会话档案')
    expect(document.querySelectorAll('.workspace .empty-illustration')).toHaveLength(1)
  })
  it('空库通过已有预览入口导入，不直接确认或打开新流程', async () => {
    render(<ArchiveApp />)
    await screen.findByText('暂无会话档案')
    expect(document.querySelector('.empty-footnote')).toBeNull()
    expect(document.querySelector('.detail .empty-description')?.textContent).toBe('导入前可预览内容与兼容性。')
    expect(document.querySelector('.detail')?.textContent).not.toContain('本地归档 · 只读浏览 · 文本交接')
    fireEvent.click(screen.getByRole('button', { name: '选择会话文件' }))
    await waitFor(() => expect(window.staithe.previewImport).toHaveBeenCalledOnce())
    expect(window.staithe.confirmImport).not.toHaveBeenCalled()
  })
  it('筛选来源为空不同于全库为空，清空筛选恢复已有档案', async () => {
    vi.mocked(window.staithe.list).mockResolvedValue([fixtureSessions[0]])
    render(<ArchiveApp />); await screen.findByRole('heading', { name: fixtureSessions[0].title, level: 2 })
    fireEvent.click(screen.getByRole('button', { name: /^Codex/ }))
    expect(document.querySelector('.detail [data-empty-state]')?.getAttribute('data-empty-state')).toBe('source-empty')
    fireEvent.click(screen.getByRole('button', { name: '清空筛选' }))
    await screen.findByRole('heading', { name: fixtureSessions[0].title, level: 2 })
  })
})
