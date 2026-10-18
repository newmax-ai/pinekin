// @vitest-environment jsdom
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
  window.staithe = { ...window.staithe, sources: { connections: vi.fn(), autoConnect: vi.fn().mockImplementation(async source => success(source)), connect: vi.fn().mockResolvedValue(null), refresh: vi.fn(), cancel: vi.fn(), disconnect: vi.fn(), page: vi.fn(), read: vi.fn() } }
})
function mount(connections: SourceConnection[] = []) {
  render(<ConnectSourcesDialog connections={connections} onConnected={connected} onChanged={changed} onBusyChange={busyChanged} onDismiss={vi.fn()} onManage={vi.fn()} onArchives={vi.fn()} />)
}
function select(...sources: BrowsableSource[]) { sources.forEach(source => fireEvent.click(screen.getByRole('checkbox', { name: `选择 ${sourceNames[source]}` }))) }
function submit() { fireEvent.click(screen.getByRole('button', { name: /连接所选 App|重试所选 App/ })) }

describe('来源多选批量连接', () => {
  it('连接列表统一使用圆形 DsCheckbox，点击整行一次只增加一个选择', () => {
    mount()
    const checkbox = screen.getByRole('checkbox', { name: '选择 NewMax' })
    expect(checkbox.tagName).toBe('BUTTON')
    expect(checkbox.classList.contains('ds-checkbox')).toBe(true)
    expect(document.querySelector('input[type="checkbox"]')).toBeNull()
    fireEvent.click(screen.getByText('NewMax', { exact: true }))
    expect(checkbox.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('button', { name: '连接所选 App' })).toBeTruthy()
    fireEvent.click(checkbox)
    expect(checkbox.getAttribute('aria-checked')).toBe('false')
    expect((screen.getByRole('button', { name: '连接所选 App' }) as HTMLButtonElement).disabled).toBe(true)
    expect(window.staithe.sources.autoConnect).not.toHaveBeenCalled()
  })
  it('选择数量变化不改按钮文案或节点，空选仍禁用且勾选不扫描', () => {
    mount()
    const button = screen.getByRole('button', { name: '连接所选 App' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getAllByRole('checkbox')).toHaveLength(5)
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: '选择 NewMax' }))
    for (const source of ['newmax', 'claude-code', 'codex', 'cindy', 'deepseek'] as const) {
      select(source)
      expect(screen.getByRole('button', { name: '连接所选 App' })).toBe(button)
      expect(button.textContent).toBe('连接所选 App')
      expect(button.disabled).toBe(false)
    }
    expect(window.staithe.sources.autoConnect).not.toHaveBeenCalled()
    select('newmax', 'claude-code', 'codex', 'cindy', 'deepseek')
    expect(button.textContent).toBe('连接所选 App')
    expect(button.disabled).toBe(true)
  })
  it('一次提交多个 App，按列表顺序串行连接，全部成功后一次通知跳转', async () => {
    mount(); select('cindy', 'newmax', 'codex'); submit()
    await waitFor(() => expect(connected).toHaveBeenCalledOnce())
    expect(vi.mocked(window.staithe.sources.autoConnect).mock.calls).toEqual([['newmax'], ['codex'], ['cindy']])
    expect(connected).toHaveBeenCalledWith(['newmax', 'codex', 'cindy'], [])
    expect(changed).toHaveBeenCalledTimes(3)
    expect(busyChanged).toHaveBeenLastCalledWith(false)
  })
  it('连接期间禁用全部操作，等待当前 App 后再处理下一项，不重复提交', async () => {
    let resolve!: (result: SourceConnectResult) => void
    vi.mocked(window.staithe.sources.autoConnect).mockReturnValueOnce(new Promise(done => { resolve = done }))
    mount(); select('newmax', 'cindy'); submit()
    expect(screen.getByRole('status').textContent).toContain('正在连接 NewMax')
    expect((screen.getByRole('button', { name: '正在连接…' }) as HTMLButtonElement).disabled).toBe(true)
    screen.getAllByRole('checkbox').forEach(checkbox => { expect((checkbox as HTMLInputElement).disabled).toBe(true); fireEvent.click(checkbox) })
    fireEvent.click(screen.getByRole('button', { name: '正在连接…' }))
    expect(window.staithe.sources.autoConnect).toHaveBeenCalledExactlyOnceWith('newmax')
    resolve(success('newmax'))
    await waitFor(() => expect(connected).toHaveBeenCalledOnce())
    expect(window.staithe.sources.autoConnect).toHaveBeenCalledTimes(2)
  })
  it('单项失败不阻塞后续 App，保留各项结果，只重试失败选择而不重复添加成功项', async () => {
    vi.mocked(window.staithe.sources.autoConnect).mockRejectedValueOnce(new Error('没有读取权限'))
    mount(); select('newmax', 'codex'); submit()
    await screen.findByRole('alert')
    await waitFor(() => expect(window.staithe.sources.autoConnect).toHaveBeenCalledTimes(2))
    expect(connected).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('NewMax')
    expect(screen.getByRole('alert').textContent).toContain('没有读取权限')
    expect(screen.getByRole('button', { name: '查看已连接会话' })).toBeTruthy()
    expect((screen.getByRole('checkbox', { name: '选择 Codex' }) as HTMLInputElement).disabled).toBe(true)
    submit()
    await waitFor(() => expect(connected).toHaveBeenCalledWith(['newmax', 'codex'], []))
    expect(vi.mocked(window.staithe.sources.autoConnect).mock.calls).toEqual([['newmax'], ['codex'], ['newmax']])
  })
  it('已保存位置但读取失败不冒充成功，不自动跳转或丢失具体原因', async () => {
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValue({ connections: [{ ...connection('cindy'), status: 'error', total: null, error: '数据库结构未支持' }], warnings: [] })
    mount(); select('cindy'); submit()
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('数据库结构未支持'))
    expect(connected).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '查看已连接会话' })).toBeNull()
    expect(screen.getByRole('button', { name: '重试所选 App' })).toBeTruthy()
  })
  it('部分位置成功保留警告，用户选择查看时只跳转有可读位置的来源', async () => {
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValue({ connections: [connection('codex')], warnings: ['归档目录不可读'] })
    mount(); select('codex'); submit()
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('归档目录不可读'))
    fireEvent.click(screen.getByRole('button', { name: '查看已连接会话' }))
    expect(connected).toHaveBeenCalledWith(['codex'], [expect.stringContaining('归档目录不可读')])
  })
  it('未找到可指定自定义位置，取消不清除原提示，成功后更新结果', async () => {
    vi.mocked(window.staithe.sources.autoConnect).mockResolvedValue({ connections: [], warnings: ['未找到 NewMax 的本机会话'] })
    mount(); select('newmax'); submit()
    await screen.findByRole('alert')
    const card = screen.getByRole('region', { name: 'NewMax 连接结果' })
    expect(card.querySelector('details')?.open).toBe(false)
    fireEvent.click(within(card).getByText('查看详情与其他方式'))
    const manual = within(card).getByRole('button', { name: '使用自定义位置…' })
    fireEvent.click(manual)
    await waitFor(() => expect(busyChanged).toHaveBeenLastCalledWith(false))
    expect(card.textContent).toContain('未找到 NewMax')
    expect(connected).not.toHaveBeenCalled()
    vi.mocked(window.staithe.sources.connect).mockResolvedValue(connection('newmax'))
    fireEvent.click(manual)
    await waitFor(() => expect(connected).toHaveBeenCalledWith(['newmax'], []))
    expect(window.staithe.sources.connect).toHaveBeenCalledWith('newmax')
  })
  it('手动连接异常保留批次内其他成功项', async () => {
    vi.mocked(window.staithe.sources.autoConnect).mockImplementation(async source => source === 'newmax' ? { connections: [], warnings: ['未找到'] } : success(source))
    vi.mocked(window.staithe.sources.connect).mockRejectedValue(new Error('位置不可读'))
    mount(); select('newmax', 'codex'); submit()
    await screen.findByRole('button', { name: '查看已连接会话' })
    fireEvent.click(screen.getByText('查看详情与其他方式'))
    fireEvent.click(screen.getByRole('button', { name: '使用自定义位置…' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('位置不可读'))
    fireEvent.click(screen.getByRole('button', { name: '查看已连接会话' }))
    expect(connected).toHaveBeenCalledWith(['codex'], [expect.stringContaining('位置不可读')])
  })
})
