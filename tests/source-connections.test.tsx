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
function toggle(name = 'Claude Code') { fireEvent.click(screen.getByRole('switch', { name: `连接 ${name}` })) }

describe('来源 App 级连接开关', () => {
  it('未授权时仅侧栏所有会话，五个开关默认关闭且打开弹窗不扫描', async () => {
    render(<App />); await ready(); openConnections()
    expect(sidebar().getAllByRole('button').map(item => item.textContent)).toEqual(['连接 App', '所有会话'])
    expect(screen.getAllByRole('switch')).toHaveLength(5)
    for (const item of screen.getAllByRole('switch')) expect(item.getAttribute('aria-checked')).toBe('false')
    expect(window.staithe.sources.autoConnect).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '连接所选 App' })).toBeNull()
  })
  it.each(browsableSources)('打开 %s 后卡片原位更新，点击完成才进入对应来源', async source => {
    render(<App />); await ready(); openConnections()
    const card = screen.getByRole('region', { name: `${sourceNames[source]} 来源` })
    toggle(sourceNames[source]); await ready()
    expect(window.staithe.sources.autoConnect).toHaveBeenCalledExactlyOnceWith(source)
    expect(screen.getByRole('region', { name: `${sourceNames[source]} 来源` })).toBe(card)
    expect(screen.getByRole('switch', { name: `连接 ${sourceNames[source]}` }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '完成' })); await ready()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(sidebar().getByRole('button', { name: new RegExp(`^${sourceNames[source]}.*0$`) }).getAttribute('aria-pressed')).toBe('true')
  })
  it('依次打开多个 App 不关闭弹窗，完成后进入所有会话', async () => {
    render(<App />); await ready(); openConnections()
    toggle('NewMax'); await ready(); toggle('Cindy'); await ready()
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '完成' })); await ready()
    expect(sidebar().getByRole('button', { name: /^所有会话/ }).getAttribute('aria-pressed')).toBe('true')
    expect(sidebar().getAllByRole('button').map(item => item.textContent)).toEqual(['连接 App', '所有会话0', 'NewMax0', 'Cindy0'])
  })
  it('暂停状态直接整合显示，不提供逐位置按钮，主列表刷新仍可更新统计', async () => {
    connections = [{ ...connection, status: 'cancelled', total: null }]
    vi.mocked(window.staithe.sources.check).mockImplementation(async () => { connections = [{ ...connection, discovered: 3, total: 3 }]; return { version: 0, connections } })
    render(<App />); await ready(); openConnections()
    await screen.findByText('已暂停 · 已发现 0 条')
    expect(screen.getByRole('switch', { name: '连接 Claude Code' }).getAttribute('aria-checked')).toBe('true')
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: /刷新连接|暂停统计|断开连接/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    fireEvent.click(screen.getByRole('button', { name: '刷新当前来源' }))
    await waitFor(() => expect(window.staithe.sources.check).toHaveBeenCalledWith({ mode: 'manual', connectionIds: [connection.id] }))
    await ready(); openConnections()
    await screen.findByText('3 条会话')
    expect(window.staithe.sources.cancel).not.toHaveBeenCalled()
  })
  it('主列表刷新失败保留授权与卡片状态', async () => {
    connections = [connection]
    vi.mocked(window.staithe.sources.check).mockRejectedValueOnce(new Error('合成刷新失败'))
    render(<App />); await ready()
    fireEvent.click(screen.getByRole('button', { name: '刷新当前来源' }))
    await screen.findByText('合成刷新失败')
    await ready(); openConnections()
    expect(screen.getByRole('switch', { name: '连接 Claude Code' }).getAttribute('aria-checked')).toBe('true')
    expect(connections).toEqual([connection])
  })
  it('关闭 App 串行撤销所有位置，不丢回已撤销位置、不影响其他 App，清理失效筛选和历史', async () => {
    connections = [connection, { ...connection, id: 'another' }, { ...connection, id: 'other', source: 'codex' }]
    render(<App />); await ready()
    fireEvent.click(sidebar().getByRole('button', { name: /^Claude Code/ })); await ready(); openConnections()
    toggle(); await ready()
    expect(vi.mocked(window.staithe.sources.disconnect).mock.calls).toEqual([[connection.id], ['another']])
    expect(screen.getByRole('switch', { name: '连接 Claude Code' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: '连接 Codex' }).getAttribute('aria-checked')).toBe('true')
    expect(connections.map(item => item.id)).toEqual(['other'])
    fireEvent.click(screen.getByRole('button', { name: '完成' })); await ready()
    expect(sidebar().queryByRole('button', { name: /^Claude Code/ })).toBeNull()
    expect(sidebar().getByRole('button', { name: /^所有会话/ }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '返回' })); fireEvent.click(screen.getByRole('button', { name: '前进' }))
    expect(sidebar().getByRole('button', { name: /^所有会话/ }).getAttribute('aria-pressed')).toBe('true')
  })
  it('多位置断开中途失败保留真实剩余位置和开启状态，重试只撤销剩余项', async () => {
    connections = [connection, { ...connection, id: 'another' }]
    vi.mocked(window.staithe.sources.disconnect).mockImplementation(async id => {
      if (id === 'another') throw new Error('撤销失败')
      connections = connections.filter(item => item.id !== id)
    })
    render(<App />); await ready()
    fireEvent.click(sidebar().getByRole('button', { name: /^Claude Code/ })); await ready(); openConnections()
    toggle(); await ready()
    expect(screen.getByText('撤销失败')).toBeTruthy()
    expect(screen.getByRole('switch', { name: '连接 Claude Code' }).getAttribute('aria-checked')).toBe('true')
    expect(sidebar().getByRole('button', { name: /^Claude Code/ }).getAttribute('aria-pressed')).toBe('true')
    expect(connections.map(item => item.id)).toEqual(['another'])
    vi.mocked(window.staithe.sources.disconnect).mockImplementation(async id => { connections = connections.filter(item => item.id !== id) })
    toggle(); await ready()
    expect(vi.mocked(window.staithe.sources.disconnect).mock.calls).toEqual([[connection.id], ['another'], ['another']])
    expect(screen.getByRole('switch', { name: '连接 Claude Code' }).getAttribute('aria-checked')).toBe('false')
    expect(sidebar().queryByRole('button', { name: /^Claude Code/ })).toBeNull()
  })
  it('断开期间阻止重复开关、完成和其他 App 操作', async () => {
    connections = [connection]
    let finish!: () => void
    vi.mocked(window.staithe.sources.disconnect).mockImplementation(() => new Promise<void>(resolve => { finish = () => { connections = []; resolve() } }))
    render(<App />); await ready(); openConnections(); toggle()
    for (const control of screen.getAllByRole('switch')) { expect((control as HTMLButtonElement).disabled).toBe(true); fireEvent.click(control) }
    expect((screen.getByRole('button', { name: '完成' }) as HTMLButtonElement).disabled).toBe(true)
    expect(window.staithe.sources.disconnect).toHaveBeenCalledOnce()
    finish(); await ready()
    expect(screen.getByRole('switch', { name: '连接 Claude Code' }).getAttribute('aria-checked')).toBe('false')
  })
})
