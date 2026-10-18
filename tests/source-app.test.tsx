// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
      check: vi.fn().mockResolvedValue({ version: 1, connections: [connection], selected: entry }),
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
  it('搜索结果描述复用单行渐隐组件，并保留完整来源和项目说明', async () => {
    const project = Array.from({ length: 12 }, (_, index) => `very-long-project-${index}`).join('/')
    vi.mocked(window.staithe.sources.page).mockResolvedValue({ ...page, items: [{ ...entry, project }] })
    render(<App />); await ready(); openSearch()
    const result = await within(screen.getByRole('dialog', { name: '搜索会话' })).findByRole('button', { name: `打开会话：${entry.title}` })
    const description = result.querySelector('small .ds-fade-text')
    expect(description).not.toBeNull()
    expect(description?.textContent).toBe(`Claude Code · ${project}`)
    expect(description?.getAttribute('title')).toBe(`Claude Code · ${project}`)
  })
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
    expect(document.querySelector('.reader-state')?.textContent).toBe('来源直读')
    expect(document.querySelector('.reader-state .read-only, .reader-state svg')).toBeNull()
    expect(screen.getByRole('button', { name: 'Pin 走这段对话' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    await waitFor(() => expect(window.staithe.sources.page).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1 })))
  })
  it('正文补出标题后立即同步当前列表，不重读正文或重置分页', async () => {
    vi.mocked(window.staithe.sources.page).mockResolvedValue(page)
    vi.mocked(window.staithe.sources.read).mockResolvedValue({ ...content, session: { ...content.session, title: '正文补出的标题' } })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /来源会话 my-project/ }))
    await screen.findByRole('heading', { level: 2, name: '正文补出的标题' })
    expect(document.querySelector('.session-card h3')?.textContent).toBe('正文补出的标题')
    expect(screen.getByText('1 / 135 条已加载')).toBeTruthy()
    expect(window.staithe.sources.read).toHaveBeenCalledOnce()
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
    fireEvent.click(await screen.findByRole('button', { name: '打开会话：来源会话' }))
    await screen.findByRole('region', { name: '会话消息' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('搜索词不进入浏览历史，返回、前进只恢复来源和实际打开的会话', async () => {
    vi.mocked(window.staithe.sources.page).mockResolvedValue(page)
    render(<App />); await ready()
    fireEvent.click(screen.getByRole('button', { name: /Claude Code.*135/ })); await ready()
    fireEvent.change(openSearch(), { target: { value: '项目' } })
    await waitFor(() => expect(window.staithe.sources.page).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'claude-code', query: '项目' })))
    fireEvent.change(screen.getByRole('textbox', { name: '搜索会话' }), { target: { value: '项目计划' } })
    await waitFor(() => expect(window.staithe.sources.page).toHaveBeenLastCalledWith(expect.objectContaining({ query: '项目计划' })))
    fireEvent.click(screen.getByRole('button', { name: '关闭搜索' }))
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => expect(window.staithe.sources.page).toHaveBeenLastCalledWith({ query: '', offset: 0, limit: 50 }))
    expect((screen.getByRole('button', { name: '返回' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '前进' })); await ready()
    await waitFor(() => expect(window.staithe.sources.page).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'claude-code', query: '' })))
    openSearch()
    fireEvent.click(await screen.findByRole('button', { name: '打开会话：来源会话' }))
    await screen.findByRole('region', { name: '会话消息' })
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: '会话消息' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '前进' }))
    await screen.findByRole('region', { name: '会话消息' })
  })
  it('输入、清空、无结果及关闭搜索只更新弹层，保留主列表、计数、滚动和当前正文', async () => {
    const second = { ...entry, id: 'b'.repeat(64), title: '另一段会话' }
    vi.mocked(window.staithe.sources.page).mockImplementation(async options => options?.query
      ? { ...page, items: options.query === '不存在' ? [] : [second], total: options.query === '不存在' ? 0 : 1, hasMore: false }
      : { ...page, items: [entry, second] })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /来源会话 my-project/ }))
    const messages = await screen.findByRole('region', { name: '会话消息' })
    const list = document.querySelector('.session-list') as HTMLElement
    list.scrollTop = 120; messages.scrollTop = 80
    const background = document.querySelector('.workspace')!.innerHTML
    const input = openSearch()
    fireEvent.change(input, { target: { value: '另一段' } })
    await waitFor(() => expect(document.querySelectorAll('.search-result')).toHaveLength(1))
    expect(document.querySelector('.search-result strong')?.textContent).toBe(second.title)
    expect(document.querySelector('.workspace')!.innerHTML).toBe(background)
    fireEvent.change(input, { target: { value: '不存在' } })
    await screen.findByRole('heading', { name: '没有匹配的会话' })
    expect(document.querySelector('.workspace')!.innerHTML).toBe(background)
    fireEvent.click(screen.getByRole('button', { name: '清空关键词' }))
    await waitFor(() => expect(document.querySelectorAll('.search-result')).toHaveLength(2))
    fireEvent.change(input, { target: { value: '另一段' } })
    await waitFor(() => expect(document.querySelectorAll('.search-result')).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: '清空搜索' }))
    await waitFor(() => expect(document.querySelectorAll('.search-result')).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: '关闭搜索' }))
    expect(document.querySelector('.workspace')!.innerHTML).toBe(background)
    expect(list.scrollTop).toBe(120); expect(messages.scrollTop).toBe(80)
    expect(window.staithe.sources.read).toHaveBeenCalledOnce()
    expect(document.querySelector('.messages')).toBe(messages)
    expect(document.querySelector('.session-list')).toBe(list)
  })
  it('搜索分页独立追加，搜索分页失败不污染主列表，点击跨页结果才切换正文', async () => {
    const result = { ...entry, id: 'b'.repeat(64), title: '查询结果' }
    const next = { ...entry, id: 'c'.repeat(64), title: '下一页查询结果' }
    let failMore = true
    vi.mocked(window.staithe.sources.page).mockImplementation(async options => {
      if (!options?.query) return page
      if (options.offset) {
        if (failMore) throw new Error('合成搜索分页失败')
        return { ...page, items: [next], total: 2, hasMore: false }
      }
      return { ...page, items: [result], total: 2 }
    })
    vi.mocked(window.staithe.sources.read).mockImplementation(async id => ({ ...content, session: { ...content.session, id, title: id === next.id ? next.title : entry.title } }))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /来源会话 my-project/ }))
    await screen.findByRole('region', { name: '会话消息' })
    const background = document.querySelector('.workspace')!.innerHTML
    fireEvent.change(openSearch(), { target: { value: '查询' } })
    await screen.findByRole('button', { name: '打开会话：查询结果' })
    fireEvent.click(screen.getByRole('button', { name: '加载更多结果' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '合成搜索分页失败')
    expect(document.querySelector('.workspace')!.innerHTML).toBe(background)
    failMore = false
    fireEvent.click(screen.getByRole('button', { name: '加载更多结果' }))
    await screen.findByRole('button', { name: '打开会话：下一页查询结果' })
    expect(window.staithe.sources.page).toHaveBeenLastCalledWith(expect.objectContaining({ query: '查询', offset: 1 }))
    expect(document.querySelectorAll('.search-result')).toHaveLength(2)
    expect(document.querySelector('.workspace')!.innerHTML).toBe(background)
    fireEvent.click(screen.getByRole('button', { name: '打开会话：下一页查询结果' }))
    await screen.findByRole('heading', { name: next.title, level: 2 })
    expect(document.querySelectorAll('.session-card')).toHaveLength(1)
    expect(document.querySelector('.session-card h3')?.textContent).toBe(entry.title)
    expect(document.querySelector('.list-heading [role="status"]')?.textContent).toBe('1 / 135 条已加载')
  })
  it('过期搜索响应和关闭后的分页响应不覆盖新结果或主列表，搜索失败可独立重试', async () => {
    let resolveOld!: (value: SourcePage) => void
    let resolveMore!: (value: SourcePage) => void
    let fail = true
    const result = { ...entry, id: 'b'.repeat(64), title: '最新结果' }
    vi.mocked(window.staithe.sources.page).mockImplementation(async options => {
      if (!options?.query) return page
      if (options.query === '旧词') return new Promise(resolve => { resolveOld = resolve })
      if (options.query === '失败' && fail) throw new Error('合成搜索失败')
      if (options.offset) return new Promise(resolve => { resolveMore = resolve })
      return { ...page, items: [result] }
    })
    render(<App />); await ready()
    const background = document.querySelector('.workspace')!.innerHTML
    const input = openSearch()
    fireEvent.change(input, { target: { value: '旧词' } })
    fireEvent.change(input, { target: { value: '新词' } })
    await screen.findByRole('button', { name: '打开会话：最新结果' })
    await act(async () => { resolveOld(page) })
    expect(document.querySelector('.search-result strong')?.textContent).toBe(result.title)
    fireEvent.change(input, { target: { value: '失败' } })
    await screen.findByText('合成搜索失败')
    expect(document.querySelector('.workspace')!.innerHTML).toBe(background)
    fail = false
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    await screen.findByRole('button', { name: '打开会话：最新结果' })
    fireEvent.click(screen.getByRole('button', { name: '加载更多结果' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭搜索' }))
    await act(async () => { resolveMore({ ...page, items: [result] }) })
    expect(document.querySelector('.workspace')!.innerHTML).toBe(background)
    expect((screen.getByRole('button', { name: '返回' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('搜索弹层中显式刷新来源后重新读取搜索结果，不停留在旧空状态', async () => {
    vi.mocked(window.staithe.sources.page).mockResolvedValue({ ...page, items: [], total: 0, hasMore: false, version: 1, snapshot: 'empty' })
    render(<App />); await ready(); openSearch()
    const dialog = screen.getByRole('dialog', { name: '搜索会话' })
    await within(dialog).findByRole('heading', { name: '还没有可浏览的会话' })
    vi.mocked(window.staithe.sources.page).mockResolvedValue({ ...page, version: 2, snapshot: 'populated' })
    vi.mocked(window.staithe.sources.check).mockResolvedValue({ version: 2, connections: [connection] })
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新' }))
    await within(dialog).findByRole('button', { name: '打开会话：来源会话' })
    expect(window.staithe.sources.check).toHaveBeenCalledWith({ mode: 'manual', connectionIds: [connection.id] })
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
  it('扫描动画原位替换侧栏右侧数字，其他来源数量不变，完成后恢复数字', async () => {
    const cindy: SourceConnection = { ...connection, id: 'cindy', source: 'cindy', total: 3, discovered: 3 }
    vi.mocked(window.staithe.sources.page).mockResolvedValueOnce({ ...page, items: [], total: 0, connections: [{ ...connection, status: 'scanning', total: null, discovered: 0 }, cindy] }).mockResolvedValue({ ...page, connections: [connection, cindy] })
    render(<App />)
    const source = await screen.findByRole('button', { name: /Claude Code.*加载中/ })
    const count = source.querySelector('.count')!
    expect(count.querySelector('.loading-mark')).not.toBeNull()
    expect(count.textContent).toBe('')
    expect(source.querySelector('.nav-item > span:first-child .loading-mark')).toBeNull()
    expect(screen.getByRole('button', { name: /Cindy.*3/ }).querySelector('.loading-mark')).toBeNull()
    expect(screen.queryByRole('button', { name: /Claude Code.*待刷新/ })).toBeNull()
    await screen.findByRole('button', { name: /Claude Code.*135/ })
    expect(source.querySelector('.count')).toBe(count)
    expect(count.querySelector('.loading-mark')).toBeNull()
    expect(count.textContent).toBe('135')
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
