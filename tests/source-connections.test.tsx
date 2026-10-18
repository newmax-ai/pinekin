// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from '../src/renderer/src/App'
import { browsableSources, sourceNames, type SourceConnection } from '../src/core/sources'

const connection: SourceConnection = { id: '11111111-1111-4111-8111-111111111111', source: 'claude-code', label: 'projects', status: 'ready', discovered: 0, total: 0, issues: 0, ignoredLinks: 0 }
let connections: SourceConnection[]
afterEach(cleanup)
beforeEach(() => {
  connections = []
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  window.staithe = {
    platform: 'darwin', list: vi.fn().mockResolvedValue([]), previewImport: vi.fn(), confirmImport: vi.fn(), cancelImport: vi.fn(),
    exportSession: vi.fn(), copy: vi.fn(), onOpenSession: vi.fn().mockReturnValue(() => {}),
    sources: { connections: vi.fn(), autoConnect: vi.fn().mockImplementation(async source => {
      const added = { ...connection, id: source, source }; connections = [...connections, added]
      return { connections: [added], warnings: [] }
    }), connect: vi.fn(), refresh: vi.fn(), check: vi.fn().mockImplementation(async () => ({ version: 0, connections })), cancel: vi.fn(), disconnect: vi.fn().mockImplementation(async id => { connections = connections.filter(item => item.id !== id) }),
    page: vi.fn().mockImplementation(async () => ({ items: [], total: 0, offset: 0, hasMore: false, connections })), read: vi.fn() },
  }
})
async function ready() { await waitFor(() => expect((screen.getByRole('button', { name: '连接 App' }) as HTMLButtonElement).disabled).toBe(false)) }
function sidebar() { return within(document.querySelector('.sidebar-section') as HTMLElement) }
function openConnections() { fireEvent.click(screen.getByRole('button', { name: '连接 App' })) }
async function manage() { openConnections(); fireEvent.click(screen.getByRole('button', { name: '管理连接' })) }

describe('已连接来源与多选添加', () => {
  it('未连接时侧栏仅保留所有会话，打开多选列表不自动连接', async () => {
    render(<App />); await ready()
    expect(sidebar().getAllByRole('button').map(item => item.textContent)).toEqual(['连接 App', '所有会话'])
    expect(sidebar().queryByText('未连接')).toBeNull()
    openConnections()
    const list = screen.getByRole('list', { name: '可连接的 App' })
    expect(within(list).getAllByRole('checkbox')).toHaveLength(5)
    for (const source of browsableSources) expect(within(list).getByRole('checkbox', { name: `选择 ${sourceNames[source]}` })).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect((screen.getByRole('button', { name: '连接所选 App' }) as HTMLButtonElement).disabled).toBe(true)
    expect(window.staithe.sources.autoConnect).not.toHaveBeenCalled()
    expect(window.staithe.sources.connect).not.toHaveBeenCalled()
  })
  it.each(browsableSources)('仅选择 %s 时完成后进入该来源，并从可连接列表移除', async source => {
    render(<App />); await ready(); openConnections()
    fireEvent.click(screen.getByRole('checkbox', { name: `选择 ${sourceNames[source]}` }))
    expect(window.staithe.sources.autoConnect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '连接所选 App' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); await ready()
    expect(window.staithe.sources.autoConnect).toHaveBeenCalledExactlyOnceWith(source)
    expect((await sidebar().findByRole('button', { name: new RegExp(`^${sourceNames[source]}.*0$`) })).getAttribute('aria-pressed')).toBe('true')
    expect(window.staithe.sources.page).toHaveBeenLastCalledWith(expect.objectContaining({ source, query: '' }))
    openConnections()
    expect(within(screen.getByRole('list', { name: '可连接的 App' })).queryByRole('checkbox', { name: `选择 ${sourceNames[source]}` })).toBeNull()
  })
  it('多选成功后统一进入所有会话，侧栏只增加本批成功连接的来源', async () => {
    render(<App />); await ready(); openConnections()
    for (const name of ['NewMax', 'Cindy']) fireEvent.click(screen.getByRole('checkbox', { name: `选择 ${name}` }))
    fireEvent.click(screen.getByRole('button', { name: '连接所选 App' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); await ready()
    expect(sidebar().getByRole('button', { name: /^所有会话/ }).getAttribute('aria-pressed')).toBe('true')
    expect(sidebar().getAllByRole('button').map(item => item.textContent)).toEqual(['连接 App', '所有会话0', 'NewMax0', 'Cindy0'])
    expect(window.staithe.sources.page).toHaveBeenLastCalledWith({ query: '', offset: 0, limit: 50 })
  })
  it.each(['idle', 'scanning', 'partial', 'cancelled', 'error'] as const)('已授权的 %s 来源继续显示，多个位置不重复显示 App', async status => {
    connections = [{ ...connection, status, total: null }, { ...connection, id: 'another' }]
    render(<App />); await ready()
    expect(sidebar().getAllByRole('button', { name: /^Claude Code/ })).toHaveLength(1)
    expect(sidebar().queryByRole('button', { name: /^NewMax/ })).toBeNull()
    openConnections()
    expect(screen.queryByRole('checkbox', { name: '选择 Claude Code' })).toBeNull()
  })
  it('所有 App 已连接时显示完成状态，仍可管理连接与进入已有档案', async () => {
    connections = browsableSources.map((source, index) => ({ ...connection, id: String(index), source }))
    render(<App />); await ready(); openConnections()
    expect(screen.getByText('所有支持的 App 均已连接')).toBeTruthy()
    expect(screen.queryByRole('list', { name: '可连接的 App' })).toBeNull()
    expect(screen.getByRole('button', { name: '管理连接' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '已有档案' })).toBeTruthy()
    expect(window.staithe.sources.autoConnect).not.toHaveBeenCalled()
  })
  it('断开最后一个位置后移除来源，回到所有会话，历史也不再进入失效筛选', async () => {
    connections = [connection]
    render(<App />); await ready()
    fireEvent.click(sidebar().getByRole('button', { name: /^Claude Code/ })); await ready()
    await manage()
    fireEvent.click(screen.getByRole('button', { name: '断开连接' }))
    await screen.findByText('尚未保存连接')
    fireEvent.click(screen.getByRole('button', { name: '关闭连接管理' })); await ready()
    expect(sidebar().queryByRole('button', { name: /^Claude Code/ })).toBeNull()
    expect(sidebar().getByRole('button', { name: '所有会话' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    fireEvent.click(screen.getByRole('button', { name: '前进' }))
    expect(sidebar().getByRole('button', { name: '所有会话' }).getAttribute('aria-pressed')).toBe('true')
    openConnections()
    expect(screen.getByRole('checkbox', { name: '选择 Claude Code' })).toBeTruthy()
  })
  it('断开同一 App 的一个位置仍保留来源和当前筛选，断开失败也不移除', async () => {
    connections = [connection, { ...connection, id: 'another' }]
    render(<App />); await ready()
    fireEvent.click(sidebar().getByRole('button', { name: /^Claude Code/ })); await ready()
    await manage()
    fireEvent.click(screen.getAllByRole('button', { name: '断开连接' })[0])
    await waitFor(() => expect(screen.getAllByRole('button', { name: '断开连接' })).toHaveLength(1))
    vi.mocked(window.staithe.sources.disconnect).mockRejectedValueOnce(new Error('撤销失败'))
    fireEvent.click(screen.getByRole('button', { name: '断开连接' }))
    await within(screen.getByRole('dialog', { name: '管理连接' })).findByText('撤销失败')
    fireEvent.click(screen.getByRole('button', { name: '关闭连接管理' })); await ready()
    expect(sidebar().getByRole('button', { name: /^Claude Code/ }).getAttribute('aria-pressed')).toBe('true')
    expect(connections).toHaveLength(1)
  })
})
