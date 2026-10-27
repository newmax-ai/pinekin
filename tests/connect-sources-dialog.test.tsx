// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConnectSourcesDialog } from '../src/renderer/src/components/ConnectSourcesDialog'
import { browsableSources, sourceNames, type BrowsableSource, type SourceConnection, type SourceConnectResult } from '../src/core/sources'

const connection = (source: BrowsableSource): SourceConnection => ({ id: source, source, label: source, status: 'ready', total: 0, discovered: 0, issues: 0, ignoredLinks: 0 })
const success = (source: BrowsableSource): SourceConnectResult => ({ connections: [connection(source)], warnings: [] })
const connected = vi.fn(), changed = vi.fn(), busyChanged = vi.fn()
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  window.staithe = { ...window.staithe, platform: 'darwin', sources: { connections: vi.fn(), autoConnect: vi.fn().mockImplementation(async source => success(source)), connect: vi.fn().mockResolvedValue(null), refresh: vi.fn(), check: vi.fn(), cancel: vi.fn(), disconnect: vi.fn(), page: vi.fn(), read: vi.fn() } }
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

describe('平台来源能力', () => {
  it.each(['darwin', 'win32'])('%s 的 NewMax 和 Cindy 与日志来源一样可以自动连接', async platform => {
    window.staithe = { ...window.staithe, platform }
    mount()
    expect(document.activeElement).toBe(within(card('newmax')).getByRole('switch'))
    expect(window.staithe.sources.autoConnect).not.toHaveBeenCalled()
    for (const source of ['newmax', 'cindy'] as const) {
      const control = within(card(source)).getByRole('switch') as HTMLButtonElement
      expect(control.disabled).toBe(false)
      expect(card(source).textContent).not.toMatch(/暂不支持|完全已验证/)
      toggle(source); await idle(source)
      expect(window.staithe.sources.autoConnect).toHaveBeenLastCalledWith(source)
      expect(control.getAttribute('aria-checked')).toBe('true')
      expect(within(card(source)).getByText('0 条会话')).toBeTruthy()
    }
    expect(window.staithe.sources.connect).not.toHaveBeenCalled()
  })
  it.each(['darwin', 'win32'])('%s 自动查找无结果后 NewMax 和 Cindy 可使用自定义位置', async platform => {
    window.staithe = { ...window.staithe, platform }
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValue({ connections: [], warnings: [], notices: ['未找到本机会话'] })
    mount()
    for (const source of ['newmax', 'cindy'] as const) {
      toggle(source); await idle(source)
      vi.mocked(window.staithe.sources.connect).mockResolvedValueOnce(connection(source))
      const manual = within(card(source)).getByRole('button', { name: '使用自定义位置…' }) as HTMLButtonElement
      expect(manual.disabled).toBe(false)
      fireEvent.click(manual); await idle(source)
      expect(window.staithe.sources.connect).toHaveBeenLastCalledWith(source)
      expect(within(card(source)).getByRole('switch').getAttribute('aria-checked')).toBe('true')
      expect(within(card(source)).queryByRole('alert')).toBeNull()
    }
  })
  it.each(['原生 SQLite 只读组件缺失', 'WAL 副文件不可安全读取'])('Windows 保留主线程错误：%s，不冒充连接成功且仍可手动重试', async reason => {
    window.staithe = { ...window.staithe, platform: 'win32' }
    vi.mocked(window.staithe.sources.autoConnect).mockRejectedValue(new Error(reason))
    vi.mocked(window.staithe.sources.connect).mockRejectedValue(new Error(reason))
    const { onDismiss } = mount()
    for (const source of ['newmax', 'cindy'] as const) {
      toggle(source); await idle(source)
      const region = card(source)
      expect(within(region).getByRole('alert').textContent).toContain(reason)
      expect(within(region).getByRole('switch').getAttribute('aria-checked')).toBe('false')
      fireEvent.click(within(region).getByRole('button', { name: '使用自定义位置…' })); await idle(source)
      expect(window.staithe.sources.connect).toHaveBeenLastCalledWith(source)
      expect(within(region).getByRole('alert').textContent).toContain(reason)
      expect(within(region).getByRole('switch').getAttribute('aria-checked')).toBe('false')
      expect(region.textContent).not.toMatch(/完全已验证|0 条会话/)
    }
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(connected).not.toHaveBeenCalled()
    expect(onDismiss).toHaveBeenCalledOnce()
  })
  it('Linux 提前禁用数据库来源，不扫描或弹出位置选择', async () => {
    window.staithe = { ...window.staithe, platform: 'linux' }
    mount()
    expect(document.activeElement).toBe(within(card('claude-code')).getByRole('switch'))
    for (const source of ['newmax', 'cindy'] as const) {
      expect(within(card(source)).getByText(/暂不支持安全数据库直读/)).toBeTruthy()
      expect((within(card(source)).getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
      expect(within(card(source)).queryByRole('button', { name: '使用自定义位置…' })).toBeNull()
      toggle(source)
    }
    expect(window.staithe.sources.autoConnect).not.toHaveBeenCalled()
    expect(window.staithe.sources.connect).not.toHaveBeenCalled()
    toggle('codex'); await idle('codex')
    expect(window.staithe.sources.autoConnect).toHaveBeenCalledExactlyOnceWith('codex')
  })
  it.each(['darwin', 'win32', 'linux'])('%s 已有数据库连接均能断开，只有不支持的平台阻止重新开启', async platform => {
    window.staithe = { ...window.staithe, platform }
    const { disconnect } = mount([connection('newmax'), connection('cindy')])
    for (const source of ['newmax', 'cindy'] as const) {
      const control = within(card(source)).getByRole('switch') as HTMLButtonElement
      expect(control.disabled).toBe(false)
      toggle(source)
      await waitFor(() => expect(disconnect).toHaveBeenLastCalledWith([connection(source)]))
      await waitFor(() => expect(control.getAttribute('aria-checked')).toBe('false'))
      expect(control.disabled).toBe(platform === 'linux')
      toggle(source)
      if (platform === 'linux') expect(window.staithe.sources.autoConnect).not.toHaveBeenCalled()
      else {
        await idle(source)
        expect(window.staithe.sources.autoConnect).toHaveBeenLastCalledWith(source)
        expect(control.getAttribute('aria-checked')).toBe('true')
      }
    }
  })
})

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
    expect(screen.getAllByRole('switch').map(control => control.getAttribute('aria-label'))).toEqual(browsableSources.map(source => `连接 ${sourceNames[source]}`))
    expect(screen.getByRole('list', { name: '来源 App' }).querySelector('[hidden] .connection-source-card')).toBeNull()
    expect(document.querySelector('.connection-feedback')).toBeNull()
    expect(window.staithe.sources.autoConnect).not.toHaveBeenCalled()
    expect(window.staithe.sources.connect).not.toHaveBeenCalled()
    expect(window.staithe.sources.disconnect).not.toHaveBeenCalled()
  })
  it.each(['success', 'notice', 'error'] as const)('%s 前后操作状态只替换当前卡片的数量行，不增加列表顶部占位', async outcome => {
    let settle!: (result: SourceConnectResult) => void, fail!: (reason: Error) => void
    vi.mocked(window.staithe.sources.autoConnect).mockReturnValueOnce(new Promise((resolve, reject) => { settle = resolve; fail = reject }))
    mount()
    const dialog = screen.getByRole('dialog'), footer = dialog.querySelector('.dialog-footer'), grid = dialog.querySelector('.connection-app-list')
    const summary = card('qwen-code').querySelector('.connection-summary > p'), otherText = card('codex').textContent
    expect(dialog.querySelector('.connection-feedback')).toBeNull()
    toggle('qwen-code')
    const progress = within(card('qwen-code')).getByRole('status')
    expect(progress.parentElement).toBe(summary?.parentElement)
    expect(progress.textContent).toBe('正在连接…')
    expect(summary?.getAttribute('aria-hidden')).toBe('true')
    expect(card('codex').textContent).toBe(otherText)
    if (outcome === 'error') fail(new Error('合成读取错误'))
    else settle(outcome === 'notice' ? { connections: [], warnings: [], notices: ['未找到本机会话'] } : success('qwen-code'))
    await idle('qwen-code')
    expect(card('qwen-code').querySelector('.connection-summary > p')).toBe(summary)
    expect(summary?.textContent).toBe(outcome === 'success' ? '0 条会话' : outcome === 'notice' ? '未找到本机会话' : '自动查找本机会话')
    expect(summary?.getAttribute('role')).toBe(outcome === 'notice' ? 'status' : null)
    expect(dialog.querySelector('.connection-feedback')).toBeNull()
    expect(dialog.querySelector('.dialog-footer')).toBe(footer)
    expect(dialog.querySelector('.connection-app-list')).toBe(grid)
    expect(within(card('qwen-code')).queryByRole('alert') !== null).toBe(outcome === 'error')
  })
  it('断开期间只在当前卡片的数量行显示状态', async () => {
    const { disconnect } = mount([connection('codex')])
    let finish!: (ok: boolean) => void
    disconnect.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    toggle('codex')
    const summary = card('codex').querySelector('.connection-summary > p')
    const progress = within(card('codex')).getByRole('status')
    expect(progress.parentElement).toBe(summary?.parentElement)
    expect(progress.textContent).toBe('正在断开…')
    expect(summary?.getAttribute('aria-hidden')).toBe('true')
    expect(within(card('newmax')).queryByRole('status')).toBeNull()
    finish(true); await idle('codex')
    expect(summary?.textContent).toBe('自动查找本机会话')
  })
  it('手动选择位置的等待状态位于当前卡片，取消后恢复统计', async () => {
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValueOnce({ connections: [], warnings: [], notices: ['未找到本机会话'] })
    mount(); toggle('qwen-code'); await idle('qwen-code')
    let finish!: (connection: SourceConnection | null) => void
    vi.mocked(window.staithe.sources.connect).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    fireEvent.click(within(card('qwen-code')).getByRole('button', { name: '使用自定义位置…' }))
    const summary = card('qwen-code').querySelector('.connection-summary > p')
    expect(summary?.textContent).toBe('未找到本机会话')
    expect(summary?.getAttribute('aria-hidden')).toBe('true')
    expect(within(card('qwen-code')).getByRole('status').textContent).toBe('等待选择位置…')
    expect(document.querySelector('.connection-feedback')).toBeNull()
    finish(null); await idle('qwen-code')
    expect(summary?.textContent).toBe('未找到本机会话')
  })
  it.each(['connect', 'manual'] as const)('已有多行提示时再次 %s 保留原内容的自然占位，不先收起再展开', async mode => {
    const notice = '未找到 Qwen Code 的本机会话，可能尚未安装或尚未创建会话，也可使用自定义位置。'
    const missing: SourceConnectResult = { connections: [], warnings: [], notices: [notice] }
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValueOnce(missing)
    mount(); toggle('qwen-code'); await idle('qwen-code')
    const region = card('qwen-code'), summary = region.querySelector('.connection-summary')!, placeholder = summary.querySelector('p')!
    const manual = within(region).getByRole('button', { name: '使用自定义位置…' })
    let finish!: () => void
    if (mode === 'connect') {
      vi.mocked(window.staithe.sources.autoConnect).mockReturnValueOnce(new Promise(resolve => { finish = () => resolve(missing) }))
      toggle('qwen-code')
    } else {
      vi.mocked(window.staithe.sources.connect).mockReturnValueOnce(new Promise(resolve => { finish = () => resolve(null) }))
      fireEvent.click(manual)
    }
    expect(summary.getAttribute('data-notice')).toBe('true')
    expect(summary.getAttribute('data-pending')).toBe('true')
    expect(placeholder.textContent).toBe(notice)
    expect(placeholder.getAttribute('aria-hidden')).toBe('true')
    const progress = within(region).getByRole('status')
    expect(progress.classList.contains('connection-summary-progress')).toBe(true)
    expect(progress.textContent).toBe(mode === 'connect' ? '正在连接…' : '等待选择位置…')
    expect(within(region).getByRole('button', { name: '使用自定义位置…' })).toBe(manual)
    finish(); await idle('qwen-code')
    expect(summary.getAttribute('data-pending')).toBe('false')
    expect(summary.querySelector('p')).toBe(placeholder)
    expect(placeholder.getAttribute('aria-hidden')).toBeNull()
    expect(placeholder.textContent).toBe(notice)
    expect(region.querySelector('.connection-summary-progress')).toBeNull()
  })
  it('父层断开错误归到当前 App 卡片，不随其他 App 的连接状态迁移', async () => {
    function Harness() {
      const [error, setError] = useState('')
      return <ConnectSourcesDialog connections={[connection('codex')]} error={error} onConnected={connected} onChanged={changed}
        onBusyChange={busyChanged} onDismiss={() => {}} onDisconnect={async () => { setError('合成断开权限不足'); return false }} />
    }
    render(<Harness />)
    toggle('codex'); await idle('codex')
    expect(within(card('codex')).getByRole('alert').textContent).toContain('合成断开权限不足')
    expect(document.querySelector('.connection-feedback')).toBeNull()
    toggle('newmax'); await idle('newmax')
    expect(within(card('newmax')).queryByRole('alert')).toBeNull()
    expect(within(card('codex')).getByRole('alert').textContent).toContain('合成断开权限不足')
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
    expect(screen.getAllByRole('switch')).toHaveLength(browsableSources.length)
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
      expect(screen.getByRole('list', { name: '来源 App' }).children).toHaveLength(browsableSources.length)
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
    const feedback = original.querySelector('.connection-summary > p')
    expect(info).not.toBeNull()
    expect(original.querySelector('details, summary')).toBeNull()
    expect(screen.queryByText('连接详情')).toBeNull()
    expect(screen.getAllByRole('switch').every(control => control.classList.contains('ds-switch-small'))).toBe(true)
    toggle('newmax')
    expect(screen.getByRole('status').parentElement).toBe(feedback?.parentElement)
    expect(feedback?.getAttribute('aria-hidden')).toBe('true')
    expect(original.querySelector('.connection-inline-info')).toBe(info)
    const reason = '合成失败原因：' + '权限检查未完成；'.repeat(30)
    resolve({ connections: [], warnings: [reason] }); await idle('newmax')
    expect(original.querySelector('.connection-inline-info')).toBe(info)
    expect(original.querySelector('.connection-summary > p')).toBe(feedback)
    expect(document.querySelector('.connection-feedback')).toBeNull()
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
  it('所有已适配卡片同时显示，没有多选提交或常驻管理按钮，打开不扫描', () => {
    mount()
    expect(screen.getByRole('list', { name: '来源 App' }).children).toHaveLength(browsableSources.length)
    expect(screen.getAllByRole('switch')).toHaveLength(browsableSources.length)
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
    expect(within(card('newmax')).getByRole('status').textContent).toBe('正在连接…')
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
  it.each(['darwin', 'win32'])('%s 位置已保存但读取失败时开关仍开启，明确显示失败且保留手动入口', async platform => {
    window.staithe = { ...window.staithe, platform }
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
  it.each(browsableSources)('%s 未安装或没有会话时显示中性提示，而非错误警报', async source => {
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValue({ connections: [], warnings: [], notices: ['未找到本机会话，可能尚未安装或尚未创建会话。'] })
    mount(); toggle(source); await idle(source)
    const region = card(source)
    expect(within(region).queryByRole('alert')).toBeNull()
    expect(region.querySelector('.connection-error')).toBeNull()
    expect(within(region).getByRole('status').textContent).toContain('未找到本机会话')
    expect(within(region).getByRole('status').classList.contains('connection-notice')).toBe(true)
    expect(within(region).getByRole('button', { name: '使用自定义位置…' })).toBeTruthy()
    expect(within(region).getByRole('switch').getAttribute('aria-checked')).toBe('false')
  })
  it('未找到提示直接替换原描述，不与自动查找文案叠加，仍保留手动位置入口', async () => {
    const notice = '未找到 Qwen Code 的本机会话，可能尚未安装或尚未创建会话，也可使用自定义位置。'
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValueOnce({ connections: [], warnings: [], notices: [notice] })
    mount(); toggle('qwen-code'); await idle('qwen-code')
    const region = card('qwen-code'), summary = region.querySelector('.connection-summary')!
    expect(within(region).queryByText('自动查找本机会话')).toBeNull()
    expect(within(region).getByRole('status').textContent).toBe(notice)
    expect(within(region).getByRole('status').parentElement).toBe(summary)
    expect(summary.getAttribute('data-notice')).toBe('true')
    expect(region.querySelector('.connection-inline-info .connection-notice')).toBeNull()
    expect(region.querySelectorAll('.connection-notice')).toHaveLength(1)
    expect(within(region).getByRole('button', { name: '使用自定义位置…' })).toBeTruthy()
  })
  it('旧桥没有 notices 且返回空结果时仍显示中性提示', async () => {
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValue({ connections: [], warnings: [] })
    mount(); toggle('qwen-code'); await idle('qwen-code')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(card('qwen-code')).getByRole('status').textContent).toContain('未找到本机会话')
  })
  it('未找到的提示不作为其他 App 连接成功后的错误汇总', async () => {
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValueOnce({ connections: [], warnings: [], notices: ['未找到 WorkBuddy 的本机会话'] })
    mount(); toggle('workbuddy'); await idle('workbuddy')
    toggle('codex'); await idle('codex')
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(connected).toHaveBeenCalledWith(['codex'], [])
  })
  it('从真实错误重试到未找到时，清除旧警报；之后连接成功清除提示', async () => {
    vi.mocked(window.staithe.sources.autoConnect).mockRejectedValueOnce(new Error('没有读取权限'))
    mount(); toggle('qwen-code'); await idle('qwen-code')
    expect(screen.getByRole('alert').textContent).toContain('没有读取权限')
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValueOnce({ connections: [], warnings: [], notices: ['未找到本机会话'] })
    toggle('qwen-code'); await idle('qwen-code')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(card('qwen-code')).getByRole('status').textContent).toContain('未找到本机会话')
    toggle('qwen-code'); await idle('qwen-code')
    expect(within(card('qwen-code')).queryByRole('status')).toBeNull()
    expect(within(card('qwen-code')).getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })
  it('未找到后手动选位置，取消保留提示，失败仍报错，成功原卡更新', async () => {
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValue({ connections: [], warnings: [], notices: ['未找到 NewMax'] })
    const { onDismiss } = mount(); toggle('newmax'); await idle('newmax')
    const manual = within(card('newmax')).getByRole('button', { name: '使用自定义位置…' })
    fireEvent.click(manual); await idle('newmax')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(card('newmax')).getByRole('status').textContent).toContain('未找到 NewMax')
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
