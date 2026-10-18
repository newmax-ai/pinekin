// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from '../src/renderer/src/App'
import type { SourceConnection, SourceContent, SourceEntry, SourcePage } from '../src/core/sources'
import { fixtureSessions } from './fixtures/sessions'
import { sourceNames, type BrowsableSource } from '../src/core/sources'

const connection: SourceConnection = { id: '11111111-1111-4111-8111-111111111111', source: 'claude-code', label: 'projects', status: 'ready', discovered: 135, total: 135, issues: 0, ignoredLinks: 0 }
const entry: SourceEntry = { id: 'a'.repeat(64), connectionId: connection.id, source: 'claude-code', title: '来源会话', project: 'my-project', updatedAt: '2026-10-18T00:00:00Z', availability: 'unread' }
const content: SourceContent = { session: { ...fixtureSessions[0], id: entry.id, title: entry.title, source: entry.source }, warnings: ['仅文本，不支持原生恢复'] }
const page: SourcePage = { items: [entry], total: 135, offset: 0, hasMore: true, connections: [connection] }
afterEach(cleanup)
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  // JSDOM 只有 popover 的隐藏样式，没有 show/hide 实现；真实 top layer 由 Electron E2E 验证。
  HTMLElement.prototype.showPopover = function () { this.style.display = 'block' }
  HTMLElement.prototype.hidePopover = function () { this.style.display = 'none' }
  window.staithe = {
    platform: 'darwin', list: vi.fn().mockResolvedValue([]), previewImport: vi.fn(), confirmImport: vi.fn(), cancelImport: vi.fn(),
    exportSession: vi.fn(), copy: vi.fn(), onOpenSession: vi.fn().mockReturnValue(() => {}),
    sources: { connections: vi.fn().mockResolvedValue([]), autoConnect: vi.fn().mockResolvedValue({ connections: [], warnings: ['未找到此 App 的本机会话，请先在该 App 中创建会话后重试。'] }), connect: vi.fn().mockResolvedValue(null), refresh: vi.fn(), cancel: vi.fn(), disconnect: vi.fn(),
      page: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, hasMore: false, connections: [] }), read: vi.fn().mockResolvedValue(content) },
  }
})
async function ready() { await waitFor(() => expect((screen.getByRole('button', { name: '搜索' }) as HTMLButtonElement).disabled).toBe(false)) }
function openSearch() {
  const trigger = screen.getByRole('button', { name: '搜索' }); trigger.focus(); fireEvent.click(trigger)
  return screen.getByRole('textbox', { name: '搜索会话' })
}
function openConnections() { fireEvent.click(screen.getByRole('button', { name: '连接 App' })) }
function chooseSource(source: BrowsableSource) {
  fireEvent.click(screen.getByRole('checkbox', { name: `选择 ${sourceNames[source]}` }))
  fireEvent.click(screen.getByRole('button', { name: '连接所选 App' }))
}

describe('来源逻辑沿用原有设计', () => {
  it.each(['darwin', 'win32', 'linux'])('%s 恢复原导航、Logo 搜索、插画及紧凑列表，不新增独立设计', async platform => {
    window.staithe = { ...window.staithe, platform }
    vi.mocked(window.staithe.sources.page).mockResolvedValue(page)
    render(<App />); await ready()
    const navigation = screen.getByRole('navigation', { name: '浏览导航' })
    expect(within(navigation).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['返回', '前进', '收起侧栏'])
    expect(navigation.closest(platform === 'linux' ? '.topbar' : '.window-toolbar')).not.toBeNull()
    expect(document.querySelectorAll('.window-controls-space')).toHaveLength(platform === 'darwin' ? 1 : 0)
    const brand = document.querySelector('.brand') as HTMLElement
    expect(brand.querySelector('.brand-logo')?.textContent).toBe('pinekin.')
    expect(within(brand).getByRole('button', { name: '搜索' })).toBeTruthy()
    expect(brand.nextElementSibling?.classList.contains('sidebar-section')).toBe(true)
    expect(document.querySelector('.sidebar-section')?.firstElementChild?.textContent).toBe('连接 App')
    expect(document.querySelector('.sidebar-section')?.children[1].textContent).toBe('会话来源')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.querySelector('.storage-note .storage-illustration')?.getAttribute('src')).toContain('pinekin-local-storage.svg')
    expect(document.querySelector('.storage-note .local-info')?.textContent).toBe('仅在本机读取')
    expect(document.querySelector('.session-card')?.children).toHaveLength(2)
    expect(document.querySelector('.session-card h3')?.textContent).toBe(entry.title)
    expect(document.querySelector('.list-heading')?.nextElementSibling?.classList.contains('session-list')).toBe(true)
    expect(document.querySelector('[class*="relay-"]')).toBeNull()
    expect(screen.queryByText('中转站')).toBeNull()
    expect(screen.queryByText('会话中转 · 来源直读')).toBeNull()
    expect(screen.queryByText('不搬家，只中转')).toBeNull()
    expect(screen.queryByRole('button', { name: '已有档案' })).toBeNull()
    expect(screen.queryByRole('button', { name: '管理连接' })).toBeNull()
  })
  it('来源卡片显示相对时间，悬停保留完整本地时刻，不新增来源读取', async () => {
    const now = new Date(2026, 9, 18, 12, 30, 45).getTime()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const updatedAt = new Date(now - 60 * 60_000).toISOString()
    try {
      vi.mocked(window.staithe.sources.page).mockResolvedValue({ ...page, items: [{ ...entry, updatedAt }] })
      render(<App />); await ready()
      const time = document.querySelector('.session-card time')!
      expect(time.textContent).toBe('1小时前')
      expect(time.getAttribute('datetime')).toBe(updatedAt)
      expect(time.getAttribute('title')).toBe('2026年10月18日 11:30:45')
      expect(time.getAttribute('aria-label')).toBe('2026年10月18日 11:30:45')
      expect(document.querySelector('.session-card')?.children).toHaveLength(2)
      expect(window.staithe.sources.page).toHaveBeenCalledOnce()
      expect(window.staithe.sources.read).not.toHaveBeenCalled()
    } finally { clock.mockRestore() }
  })
  it('默认不读档案、不自动扫描，兼容与连接管理收在原菜单弹窗内', async () => {
    render(<App />); await ready()
    expect(screen.getByRole('heading', { name: '尚未连接会话来源' })).toBeTruthy()
    expect(window.staithe.list).not.toHaveBeenCalled()
    expect(window.staithe.sources.refresh).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /NewMax.*未连接/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '导入会话文件' })).toBeNull()
    openConnections()
    fireEvent.click(screen.getByRole('button', { name: '已有档案' }))
    await screen.findByText('暂无会话档案', { selector: 'p' })
    expect(window.staithe.list).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '返回来源会话' }))
    await ready()
    expect(screen.getByRole('heading', { name: '尚未连接会话来源' })).toBeTruthy()
  })
  it('连接面板展示多选列表和只读范围，不预先扫描，默认聚焦首项而不是关闭按钮', async () => {
    render(<App />); await ready(); openConnections()
    const dialog = screen.getByRole('dialog', { name: '连接来源 App' })
    expect(dialog.querySelector('.dialog-header .dialog-icon')).toBeNull()
    expect(dialog.querySelector('.dialog-header')?.firstElementChild?.tagName).toBe('H2')
    expect(within(dialog).getByRole('list', { name: '可连接的 App' })).toBeTruthy()
    expect(dialog.textContent).not.toContain('首次自动定位暂未支持')
    expect(dialog.textContent).toContain('只读访问 · 不保存正文 · 不修改来源')
    expect(dialog.querySelectorAll('.connection-card')).toHaveLength(0)
    expect(dialog.querySelector('select')).toBeNull()
    expect(within(dialog).queryByRole('combobox')).toBeNull()
    expect(dialog.querySelector('.notice')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: '选择 NewMax' }))
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect((screen.getByRole('button', { name: '连接所选 App' }) as HTMLButtonElement).disabled).toBe(true)
    expect(window.staithe.sources.autoConnect).not.toHaveBeenCalled()
    expect(window.staithe.sources.connect).not.toHaveBeenCalled()
  })
  it('连接弹窗关闭按钮使用默认尺寸，保持关闭行为', async () => {
    render(<App />); await ready(); openConnections()
    const close = screen.getByRole('button', { name: '关闭连接面板' })
    expect(close.classList.contains('ds-button-small')).toBe(false)
    expect(close.classList.contains('ds-button-mini')).toBe(false)
    expect(close.classList.contains('ds-button-ghost')).toBe(true)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.click(close)
    expect(screen.queryByRole('dialog', { name: '连接来源 App' })).toBeNull()
  })
  it.each(['newmax', 'claude-code', 'codex', 'deepseek', 'cindy'] as const)('%s 勾选后提交自动定位，不要求用户理解文件位置', async source => {
    render(<App />); await ready(); openConnections(); chooseSource(source)
    const body = screen.getByRole('dialog').querySelector('.dialog-content')!
    const visibleCopy = Array.from(body.querySelectorAll('label, h3, p')).filter(element => !element.closest('details')).map(element => element.textContent).join('')
    expect(visibleCopy).not.toMatch(/WAL|conversations|副文件|元数据|标题索引|projects|sessions|选择.*文件/)
    await waitFor(() => expect(window.staithe.sources.autoConnect).toHaveBeenCalledExactlyOnceWith(source))
    expect(window.staithe.sources.connect).not.toHaveBeenCalled()
    expect(window.staithe.sources.read).not.toHaveBeenCalled()
    expect(window.staithe.list).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('连接未完成'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(document.querySelector('.sidebar-section')?.textContent).not.toContain(sourceNames[source])
  })
  it('自动连接成功关闭弹窗，多个位置一并加载而不弹出位置选择', async () => {
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValue({ connections: [connection, { ...connection, id: 'another' }], warnings: [] })
    render(<App />); await ready(); openConnections(); chooseSource('claude-code')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(window.staithe.sources.connect).not.toHaveBeenCalled()
    expect(window.staithe.sources.page).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'claude-code' }))
  })
  it('部分位置失败逐项显示，确认查看后警告仍保留到主界面', async () => {
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValue({ connections: [connection], warnings: ['另一个位置没有读取权限'] })
    render(<App />); await ready(); openConnections(); chooseSource('claude-code')
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('部分位置已连接'))
    fireEvent.click(screen.getByRole('button', { name: '查看已连接会话' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('没有读取权限'))
    expect(window.staithe.sources.page).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'claude-code' }))
  })
  it('从已连接来源打开时仍列出其他可连接 App，不预选或重复连接当前来源', async () => {
    vi.mocked(window.staithe.sources.page).mockResolvedValue(page)
    render(<App />); await ready()
    fireEvent.click(screen.getByRole('button', { name: /Claude Code.*135/ })); await ready(); openConnections()
    expect(screen.queryByRole('checkbox', { name: '选择 Claude Code' })).toBeNull()
    expect(screen.getByRole('checkbox', { name: '选择 Codex' })).toBeTruthy()
    expect(window.staithe.sources.autoConnect).not.toHaveBeenCalled()
  })
  it('完整总数与分页不受视觉恢复影响，点击才读取，不调用归档', async () => {
    vi.mocked(window.staithe.sources.page).mockResolvedValue(page)
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /来源会话 my-project/ }))
    await screen.findByRole('region', { name: '会话消息' })
    expect(window.staithe.sources.read).toHaveBeenCalledWith(entry.id)
    expect(window.staithe.previewImport).not.toHaveBeenCalled()
    expect(window.staithe.list).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Claude Code.*135/ })).toBeTruthy()
    expect(screen.getByText('1 / 135 条已加载')).toBeTruthy()
    expect(document.querySelector('.reader-state .read-only')?.textContent).toBe('只读')
    expect(screen.getByRole('button', { name: 'Pin 走这段对话' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    await waitFor(() => expect(window.staithe.sources.page).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1 })))
  })
  it('恢复 Logo 搜索弹窗、快捷键和焦点返回，搜索仍由主进程覆盖全部元数据', async () => {
    vi.mocked(window.staithe.sources.page).mockResolvedValue(page)
    render(<App />); await ready()
    fireEvent.change(openSearch(), { target: { value: '另一项目' } })
    await waitFor(() => expect(window.staithe.sources.page).toHaveBeenLastCalledWith(expect.objectContaining({ query: '另一项目', offset: 0 })))
    expect(document.querySelector('.search-header .search')).not.toBeNull()
    expect(document.querySelector('.session-pane input')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '关闭搜索' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '搜索' })))
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '搜索会话' }))
    fireEvent.click(screen.getByRole('button', { name: '打开会话：来源会话' }))
    await screen.findByRole('region', { name: '会话消息' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('原返回、前进按钮恢复来源和查询，不是装饰按钮', async () => {
    vi.mocked(window.staithe.sources.page).mockResolvedValue(page)
    render(<App />); await ready()
    fireEvent.click(screen.getByRole('button', { name: /Claude Code.*135/ })); await ready()
    fireEvent.change(openSearch(), { target: { value: '项目' } })
    await waitFor(() => expect(window.staithe.sources.page).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'claude-code', query: '项目' })))
    fireEvent.change(screen.getByRole('textbox', { name: '搜索会话' }), { target: { value: '项目计划' } }); await ready()
    fireEvent.click(screen.getByRole('button', { name: '关闭搜索' }))
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => expect(window.staithe.sources.page).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'claude-code', query: '' })))
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => expect(window.staithe.sources.page).toHaveBeenLastCalledWith({ query: '', offset: 0, limit: 50 }))
    fireEvent.click(screen.getByRole('button', { name: '前进' })); await ready()
    fireEvent.click(screen.getByRole('button', { name: '前进' }))
    await waitFor(() => expect(window.staithe.sources.page).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'claude-code', query: '项目计划' })))
  })
  it('未支持正文仍可选择并解释，不为了恢复设计隐藏问题', async () => {
    vi.mocked(window.staithe.sources.page).mockResolvedValue({ ...page, hasMore: false, items: [{ ...entry, availability: 'unsupported', reason: '分叉结构尚未支持' }] })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /来源会话 my-project/ }))
    await screen.findByText('分叉结构尚未支持')
    expect(window.staithe.sources.read).not.toHaveBeenCalled()
  })
  it('原接续按钮只打开能力检查，未支持目标依然禁用', async () => {
    vi.mocked(window.staithe.sources.page).mockResolvedValue(page)
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /来源会话 my-project/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Pin 走这段对话' }))
    expect(screen.getByRole('dialog', { name: '选择接续目标' }).textContent).toContain('尚未完成目标客户端的创建、打开与接续验证')
    expect((screen.getByRole('button', { name: '自动接续暂未支持' }) as HTMLButtonElement).disabled).toBe(true)
    expect(window.staithe.copy).not.toHaveBeenCalled()
  })
  it('切换会话和浏览历史时，过期正文不会覆盖新选择', async () => {
    const second = { ...entry, id: 'b'.repeat(64), title: '第二段' }
    vi.mocked(window.staithe.sources.page).mockResolvedValue({ ...page, items: [entry, second] })
    let resolveFirst!: (value: SourceContent) => void
    vi.mocked(window.staithe.sources.read).mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ ...content, session: { ...content.session, id: second.id, title: second.title } })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /来源会话 my-project/ }))
    fireEvent.click(screen.getByRole('button', { name: /第二段 my-project/ }))
    await screen.findByRole('heading', { level: 2, name: '第二段' })
    resolveFirst(content)
    await waitFor(() => expect(within(screen.getByRole('region', { name: '来源会话详情' })).queryByRole('heading', { level: 2, name: '来源会话' })).toBeNull())
  })
  it('已授权来源扫描时显示加载中，轮询完成自动显示数量，不要求手动刷新', async () => {
    vi.mocked(window.staithe.sources.page).mockResolvedValueOnce({ ...page, items: [], total: 0, connections: [{ ...connection, status: 'scanning', total: null, discovered: 0 }] }).mockResolvedValue(page)
    render(<App />)
    await screen.findByRole('button', { name: /Claude Code.*加载中/ })
    expect(screen.queryByRole('button', { name: /Claude Code.*待刷新/ })).toBeNull()
    await screen.findByRole('button', { name: /Claude Code.*135/ })
    expect(screen.getByText('1 / 135 条已加载')).toBeTruthy()
    expect(window.staithe.sources.refresh).not.toHaveBeenCalled()
    expect(window.staithe.sources.autoConnect).not.toHaveBeenCalled()
  })
  it('统计未完成继续放在原列表标题的数量位置，失败不伪装为零', async () => {
    vi.mocked(window.staithe.sources.page).mockResolvedValue({ ...page, connections: [{ ...connection, status: 'partial', total: null, discovered: 10, issues: 1 }] })
    render(<App />)
    await screen.findByRole('button', { name: /Claude Code.*部分/ })
    expect(screen.getByText(/发现 10 条，统计未完成/).closest('.list-heading')).not.toBeNull()
  })
})
