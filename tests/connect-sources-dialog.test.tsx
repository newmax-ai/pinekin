// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConnectSourcesDialog } from '../src/renderer/src/components/ConnectSourcesDialog'
import { sourceNames, type BrowsableSource, type SourceConnection, type SourceConnectResult } from '../src/core/sources'

const connection = (source: BrowsableSource): SourceConnection => ({ id: source, source, label: source, status: 'ready', total: 0, discovered: 0, issues: 0, ignoredLinks: 0 })
const success = (source: BrowsableSource): SourceConnectResult => ({ connections: [connection(source)], warnings: [] })
const connected = vi.fn(), changed = vi.fn(), busyChanged = vi.fn()
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  window.staithe = { ...window.staithe, sources: { connections: vi.fn(), autoConnect: vi.fn().mockImplementation(async source => success(source)), connect: vi.fn().mockResolvedValue(null), refresh: vi.fn(), check: vi.fn(), cancel: vi.fn(), disconnect: vi.fn(), page: vi.fn(), read: vi.fn() } }
})
function mount(initial: SourceConnection[] = []) {
  const disconnect = vi.fn<(items: SourceConnection[]) => Promise<boolean>>().mockResolvedValue(true)
  const onDismiss = vi.fn()
  function Harness() {
    const [connections, setConnections] = useState(initial)
    return <ConnectSourcesDialog connections={connections} onConnected={connected} onChanged={items => {
      changed(items)
      setConnections(previous => [...previous.filter(item => !items.some(next => next.id === item.id)), ...items])
    }} onBusyChange={busyChanged} onDismiss={onDismiss}
      onDisconnect={async items => {
        const ok = await disconnect(items)
        if (ok) setConnections(previous => previous.filter(item => !items.some(removed => removed.id === item.id)))
        return ok
      }} />
  }
  render(<Harness />)
  return { disconnect, onDismiss }
}
function toggle(source: BrowsableSource) { fireEvent.click(screen.getByRole('switch', { name: `连接 ${sourceNames[source]}` })) }
function card(source: BrowsableSource) { return screen.getByRole('region', { name: `${sourceNames[source]} 来源` }) }
async function idle(source: BrowsableSource) { await waitFor(() => expect((screen.getByRole('switch', { name: `连接 ${sourceNames[source]}` }) as HTMLButtonElement).disabled).toBe(false)) }

describe('App 连接开关', () => {
  it('描述紧跟标题，所有来源同时可见，不保留地区筛选或空工具栏', () => {
    mount()
    const heading = screen.getByRole('heading', { name: '连接来源 App' })
    const description = screen.getByText('连接 App，集中浏览本机会话；断开不会删除原会话。')
    expect(heading.nextElementSibling).toBe(description)
    expect(description.closest('.dialog-header')).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('tabpanel')).toBeNull()
    expect(document.querySelector('.connection-toolbar')).toBeNull()
    expect(screen.getAllByRole('switch').map(control => control.getAttribute('aria-label'))).toEqual(['连接 NewMax', '连接 Claude Code', '连接 Codex', '连接 Cindy', '连接 DeepSeek Harness'])
    expect(screen.getByRole('list', { name: '来源 App' }).querySelector('[hidden] .connection-source-card')).toBeNull()
    expect((document.querySelector('.connection-feedback') as HTMLElement).hidden).toBe(true)
    expect(window.staithe.sources.autoConnect).not.toHaveBeenCalled()
    expect(window.staithe.sources.connect).not.toHaveBeenCalled()
    expect(window.staithe.sources.disconnect).not.toHaveBeenCalled()
  })
  it('空信息区不占高度，连接后直接展示位置，断开后恢复紧凑内容', async () => {
    mount()
    const info = card('newmax').querySelector('.connection-inline-info') as HTMLElement
    expect(info.hidden).toBe(true)
    expect(info.classList.contains('scroll-area')).toBe(false)
    toggle('newmax'); await idle('newmax')
    expect(info.hidden).toBe(false)
    expect(within(info).getByText('0 条')).toBeTruthy()
    toggle('newmax'); await idle('newmax')
    expect(info.hidden).toBe(true)
    expect(screen.getAllByRole('switch')).toHaveLength(5)
  })
  it('同一网格保留不同来源的连接、错误和本次完成结果', async () => {
    vi.mocked(window.staithe.sources.autoConnect).mockRejectedValueOnce(new Error('读取失败'))
    mount(); toggle('newmax'); await idle('newmax')
    toggle('codex'); await idle('codex')
    expect(within(card('newmax')).getByRole('alert').textContent).toContain('读取失败')
    toggle('newmax'); await idle('newmax')
    expect(screen.getByRole('switch', { name: '连接 Codex' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('连接 App，集中浏览本机会话；断开不会删除原会话。').closest('.dialog-header')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(connected).toHaveBeenCalledWith(['newmax', 'codex'], [])
  })
  it('底部只保留完成按钮，不混入旧档案入口，完成仍可关闭弹窗', () => {
    const { onDismiss } = mount()
    const footer = document.querySelector('.dialog-footer') as HTMLElement
    expect(within(footer).getAllByRole('button').map(button => button.textContent)).toEqual(['完成'])
    expect(screen.queryByRole('button', { name: '已有档案' })).toBeNull()
    expect(footer.classList.contains('connection-footer')).toBe(false)
    fireEvent.click(within(footer).getByRole('button', { name: '完成' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
  it('连接只由开关表达，开启关闭前后不再显示重复状态标签', async () => {
    mount([connection('codex')])
    const verify = () => {
      expect(document.querySelector('.connection-state')).toBeNull()
      expect(screen.queryByText(/^(已连接|未连接|连接未完成)$/)).toBeNull()
      expect(screen.getByRole('list', { name: '来源 App' }).children).toHaveLength(5)
    }
    verify()
    expect(screen.getByRole('switch', { name: '连接 Codex' }).getAttribute('aria-checked')).toBe('true')
    toggle('newmax'); await idle('newmax'); verify()
    expect(within(card('newmax')).getByText('0 条会话')).toBeTruthy()
    toggle('codex'); await idle('codex'); verify()
    expect(screen.getByRole('switch', { name: '连接 Codex' }).getAttribute('aria-checked')).toBe('false')
  })
  it('已授权但总数未知时仅提示统计未完成，不重复已连接文案', () => {
    mount([{ ...connection('codex'), total: null, discovered: 2 }])
    expect(within(card('codex')).getByText('统计未完成 · 已发现 2 条')).toBeTruthy()
    expect(card('codex').textContent).not.toContain('已连接')
    expect(screen.getByRole('switch', { name: '连接 Codex' }).getAttribute('aria-checked')).toBe('true')
  })
  it('状态切换复用信息节点，直接显示长错误全文，没有折叠入口', async () => {
    let resolve!: (result: SourceConnectResult) => void
    vi.mocked(window.staithe.sources.autoConnect).mockReturnValueOnce(new Promise(done => { resolve = done }))
    mount()
    const original = card('newmax')
    const info = original.querySelector('.connection-inline-info')
    const feedback = document.querySelector('.connection-feedback')
    expect(info).not.toBeNull()
    expect(original.querySelector('details, summary')).toBeNull()
    expect(screen.queryByText('连接详情')).toBeNull()
    expect(screen.getAllByRole('switch').every(control => control.classList.contains('ds-switch-small'))).toBe(true)
    toggle('newmax')
    expect(screen.getByRole('status')).toBe(feedback)
    expect(original.querySelector('.connection-inline-info')).toBe(info)
    const reason = '合成失败原因：' + '权限检查未完成；'.repeat(30)
    resolve({ connections: [], warnings: [reason] }); await idle('newmax')
    expect(original.querySelector('.connection-inline-info')).toBe(info)
    expect(document.querySelector('.connection-feedback')).toBe(feedback)
    const alert = within(original).getByRole('alert')
    expect(alert.closest('.connection-inline-info')).toBe(info)
    expect(alert.textContent).toContain(reason)
    expect(within(original).getByRole('button', { name: '使用自定义位置…' })).toBeTruthy()
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValue(success('newmax'))
    toggle('newmax'); await idle('newmax')
    expect(original.querySelector('.connection-inline-info')).toBe(info)
    toggle('newmax'); await idle('newmax')
    expect(original.querySelector('.connection-inline-info')).toBe(info)
  })
  it('五张卡片同时显示，没有多选提交或常驻管理按钮，打开不扫描', () => {
    mount()
    expect(screen.getByRole('list', { name: '来源 App' }).children).toHaveLength(5)
    expect(screen.getAllByRole('switch')).toHaveLength(5)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: /连接所选|重试所选|断开连接/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /刷新连接|暂停统计/ })).toBeNull()
    expect(document.querySelector('details, summary')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('switch', { name: '连接 NewMax' }))
    expect(screen.getByRole('switch', { name: '连接 Codex' }).getAttribute('aria-checked')).toBe('false')
    expect(window.staithe.sources.autoConnect).not.toHaveBeenCalled()
  })
  it('打开立即连接，不自动关闭或移动卡片，关闭撤销整个 App', async () => {
    const { disconnect } = mount()
    const original = card('codex'), grid = screen.getByRole('list', { name: '来源 App' }), nodes = [...grid.children]
    toggle('codex'); await idle('codex')
    expect(window.staithe.sources.autoConnect).toHaveBeenCalledExactlyOnceWith('codex')
    expect(screen.getByRole('switch', { name: '连接 Codex' }).getAttribute('aria-checked')).toBe('true')
    expect(connected).not.toHaveBeenCalled()
    expect(card('codex')).toBe(original)
    expect([...grid.children]).toEqual(nodes)
    toggle('codex'); await idle('codex')
    expect(disconnect).toHaveBeenCalledExactlyOnceWith([connection('codex')])
    expect(screen.getByRole('switch', { name: '连接 Codex' }).getAttribute('aria-checked')).toBe('false')
    expect(card('codex')).toBe(original)
    expect([...grid.children]).toEqual(nodes)
  })
  it('普通和归档会话统计直接整合在卡片内，不重复说明或提供逐位置按钮', async () => {
    const locations = [{ ...connection('codex'), id: 'current', label: 'sessions', total: 2180, discovered: 2180 },
      { ...connection('codex'), id: 'archive', label: 'archived_sessions', total: 1554, discovered: 1554 }]
    const { disconnect } = mount(locations)
    const app = card('codex')
    expect(within(app).getByText('3734 条会话')).toBeTruthy()
    expect(app.querySelector('details, summary')).toBeNull()
    expect(within(app).getByText('普通会话').getAttribute('title')).toBe('sessions')
    expect(within(app).getByText('归档会话').getAttribute('title')).toBe('archived_sessions')
    expect(within(app).getByText('2180 条')).toBeTruthy()
    expect(within(app).getByText('1554 条')).toBeTruthy()
    expect(app.textContent).not.toContain('分别保存在')
    expect(within(app).queryByRole('button', { name: /刷新连接|暂停统计|断开连接/ })).toBeNull()
    toggle('codex'); await idle('codex')
    expect(disconnect).toHaveBeenCalledExactlyOnceWith(locations)
    expect(screen.getByRole('switch', { name: '连接 Codex' }).getAttribute('aria-checked')).toBe('false')
  })
  it('不完整位置保留真实状态与异常数，长路径仍可查看完整名称', () => {
    const label = '/synthetic/' + 'long-workspace-'.repeat(20)
    mount([{ ...connection('codex'), label, status: 'partial', total: null, discovered: 3, issues: 2, ignoredLinks: 1 }])
    expect(within(card('codex')).getByText(label).getAttribute('title')).toBe(label)
    expect(within(card('codex')).getByText('部分可读 · 已发现 3 条')).toBeTruthy()
    expect(within(card('codex')).getByText('不可访问目录 2 · 跳过符号链接 1')).toBeTruthy()
  })
  it.each(['scanning', 'partial', 'cancelled', 'error', 'idle'] as const)('%s 不冒充完整总数，开关表示授权而非读取成功', status => {
    mount([{ ...connection('codex'), status, discovered: 3, total: null }, { ...connection('codex'), id: 'archive', total: 5, discovered: 5 }])
    expect(within(card('codex')).getByText('已发现 8 条 · 统计未完成')).toBeTruthy()
    expect(screen.getByRole('switch', { name: '连接 Codex' }).getAttribute('aria-checked')).toBe('true')
  })
  it('连接期间锁定开关和关闭操作，防止重复请求，成功前不虚报已连接', async () => {
    let resolve!: (result: SourceConnectResult) => void
    vi.mocked(window.staithe.sources.autoConnect).mockReturnValueOnce(new Promise(done => { resolve = done }))
    mount(); toggle('newmax')
    expect(screen.getByRole('status').textContent).toContain('正在连接 NewMax')
    expect(screen.getByRole('switch', { name: '连接 NewMax' }).getAttribute('aria-checked')).toBe('false')
    for (const control of screen.getAllByRole('switch')) {
      expect((control as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(control)
    }
    expect((screen.getByRole('button', { name: '完成' }) as HTMLButtonElement).disabled).toBe(true)
    expect(window.staithe.sources.autoConnect).toHaveBeenCalledOnce()
    resolve(success('newmax')); await idle('newmax')
    expect(busyChanged).toHaveBeenLastCalledWith(false)
  })
  it('连接失败保持关闭，可直接再开重试，不影响其他 App', async () => {
    vi.mocked(window.staithe.sources.autoConnect).mockRejectedValueOnce(new Error('没有读取权限'))
    mount(); toggle('newmax'); await idle('newmax')
    expect(screen.getByRole('alert').textContent).toContain('没有读取权限')
    expect(screen.getByRole('switch', { name: '连接 NewMax' }).getAttribute('aria-checked')).toBe('false')
    toggle('codex'); await idle('codex')
    toggle('newmax'); await idle('newmax')
    expect(vi.mocked(window.staithe.sources.autoConnect).mock.calls).toEqual([['newmax'], ['codex'], ['newmax']])
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(connected).toHaveBeenCalledWith(['newmax', 'codex'], [])
  })
  it('位置已保存但读取失败时开关仍开启，明确显示失败且保留手动入口', async () => {
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValue({ connections: [{ ...connection('cindy'), status: 'error', total: null, error: '数据库结构未支持' }], warnings: [] })
    mount(); toggle('cindy'); await idle('cindy')
    expect(screen.getByRole('switch', { name: '连接 Cindy' }).getAttribute('aria-checked')).toBe('true')
    expect(within(card('cindy')).getByText('读取失败 · 已发现 0 条')).toBeTruthy()
    expect(card('cindy').querySelector('.connection-state')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('数据库结构未支持')
    expect(connected).not.toHaveBeenCalled()
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValue(success('codex'))
    toggle('codex'); await idle('codex')
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(connected).toHaveBeenCalledWith(['codex'], [expect.stringContaining('数据库结构未支持')])
  })
  it('断开失败不假装关闭，异常与忙碌状态均能恢复', async () => {
    const { disconnect } = mount([connection('codex')])
    disconnect.mockResolvedValueOnce(false)
    toggle('codex'); await idle('codex')
    expect(screen.getByRole('switch', { name: '连接 Codex' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('alert').textContent).toContain('断开未完成')
    disconnect.mockRejectedValueOnce(new Error('撤销失败'))
    toggle('codex'); await idle('codex')
    expect(screen.getByRole('alert').textContent).toContain('撤销失败')
    toggle('codex'); await idle('codex')
    expect(screen.getByRole('switch', { name: '连接 Codex' }).getAttribute('aria-checked')).toBe('false')
  })
  it('部分成功保留警告，点击完成才进入会话', async () => {
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValue({ connections: [connection('codex')], warnings: ['归档目录不可读'] })
    mount(); toggle('codex'); await idle('codex')
    expect(screen.getByRole('alert').textContent).toContain('归档目录不可读')
    expect(connected).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(connected).toHaveBeenCalledWith(['codex'], [expect.stringContaining('归档目录不可读')])
  })
  it('未找到后手动选位置，取消保留原因，失败可重试，成功原卡更新', async () => {
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValue({ connections: [], warnings: ['未找到 NewMax'] })
    const { onDismiss } = mount(); toggle('newmax'); await idle('newmax')
    const manual = within(card('newmax')).getByRole('button', { name: '使用自定义位置…' })
    fireEvent.click(manual); await idle('newmax')
    expect(screen.getByRole('alert').textContent).toContain('未找到 NewMax')
    vi.mocked(window.staithe.sources.connect).mockRejectedValueOnce(new Error('位置不可读'))
    fireEvent.click(manual); await idle('newmax')
    expect(screen.getByRole('alert').textContent).toContain('位置不可读')
    vi.mocked(window.staithe.sources.connect).mockResolvedValue(connection('newmax'))
    fireEvent.click(manual); await idle('newmax')
    expect(screen.getByRole('switch', { name: '连接 NewMax' }).getAttribute('aria-checked')).toBe('true')
    expect(onDismiss).not.toHaveBeenCalled()
    expect(connected).not.toHaveBeenCalled()
  })
  it('未更改连接时完成仅关闭，不改变当前来源筛选', () => {
    const { onDismiss } = mount([connection('codex')])
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(connected).not.toHaveBeenCalled()
  })
})
