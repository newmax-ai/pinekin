// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SourceEntry, SourcePage } from '../src/core/sources'
import { SourceApp } from '../src/renderer/src/SourceApp'
import { SourceSessionCard } from '../src/renderer/src/components/SourceSessionCard'
import { fixtureSessions } from './fixtures/sessions'
import { mockSourcesAPI } from './fixtures/source-api'

// 仅合成数据：工作目录与标题都是虚构值。
const connection = { id: '11111111-1111-4111-8111-111111111111', source: 'claude-code' as const, label: 'synthetic', status: 'ready' as const, discovered: 3, total: 3, issues: 0, ignoredLinks: 0 }
const base = { connectionId: connection.id, source: connection.source, project: 'synthetic', updatedAt: '2026-10-21T00:00:00Z', availability: 'readable' as const }
const main: SourceEntry = { ...base, id: 'a'.repeat(64), title: '主会话甲', sourceSessionId: 'main-a', kind: 'conversation', workspace: '/synthetic/work/alpha', subagentCount: 2 }
const plain: SourceEntry = { ...base, id: 'b'.repeat(64), title: '主会话乙', sourceSessionId: 'main-b', kind: 'conversation', workspace: '/synthetic/work/beta' }
const children: SourceEntry[] = ['丙', '丁'].map((name, index) => ({ ...base, id: String(index + 1).repeat(64), title: `子代理${name}`, kind: 'subagent', parentSessionId: 'main-a', workspace: '/synthetic/work/alpha' }))
const workspaces = [{ path: '/synthetic/work/alpha', count: 1 }, { path: '/synthetic/work/beta', count: 1 }]
const pageOf = (items: SourceEntry[], extra: Partial<SourcePage> = {}): SourcePage => ({ items, total: items.length, offset: 0, hasMore: false, connections: [connection], workspaces, ...extra })

afterEach(() => { cleanup(); vi.restoreAllMocks() })
beforeEach(() => {
  // JSDOM 不实现 Popover API，真实 top layer 行为在 Electron E2E 验证。
  HTMLElement.prototype.showPopover = function () { this.style.display = 'block' }
  HTMLElement.prototype.hidePopover = function () { this.style.display = 'none' }
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
})
function setup(facets = workspaces) {
  const page = vi.fn().mockImplementation(async (query: Record<string, unknown>) => {
    if (facets.length < 2) return pageOf([plain], { workspaces: facets })
    if (query.parentSessionId) return pageOf(children, { workspaces: undefined })
    if (query.workspace === '/synthetic/work/beta') return pageOf([plain])
    return pageOf([main, plain])
  })
  window.staithe = { platform: 'darwin', list: vi.fn(), previewImport: vi.fn(), confirmImport: vi.fn(), cancelImport: vi.fn(), exportSession: vi.fn(), copy: vi.fn(), onOpenSession: vi.fn().mockReturnValue(() => {}),
    sources: { ...mockSourcesAPI(), page, read: vi.fn().mockImplementation(async () => ({ session: fixtureSessions[0], warnings: [] })) } }
  render(<SourceApp />)
  return page
}

describe('来源卡片：工作目录与子会话标注', () => {
  it('显示工作目录末级名称（完整路径作悬停提示）与折叠的子会话数，不改变可访问名称', () => {
    render(<SourceSessionCard entry={main} selected={false} now={Date.now()} onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: '主会话甲 synthetic' })).toBeTruthy()
    expect(screen.getByText('alpha').getAttribute('title')).toBe('/synthetic/work/alpha')
    expect(screen.getByText('2 个子会话')).toBeTruthy()
  })
  it('种类标签、工作目录与子会话数合并在同一行容器，不额外占高度', () => {
    render(<SourceSessionCard entry={{ ...main, kind: 'subagent' }} selected={false} now={Date.now()} onSelect={vi.fn()} />)
    const row = document.querySelector('.source-card-context')!
    expect(row.querySelector('.source-kind')?.textContent).toBe('子会话')
    expect(row.querySelector('.source-workspace')).not.toBeNull()
    expect(document.querySelectorAll('.source-card-context')).toHaveLength(1)
    expect(document.querySelector('.session-card > .source-kind')).toBeNull()
  })
  it('多个文字标签之间用装饰性小圆点间隔，单个标签不出现分隔符', () => {
    const view = render(<SourceSessionCard entry={{ ...main, kind: 'subagent' }} selected={false} now={Date.now()} onSelect={vi.fn()} />)
    const row = document.querySelector('.source-card-context')!
    expect([...row.children].map(node => node.textContent)).toEqual(['子会话', '·', 'alpha', '·', '2 个子会话'])
    expect([...row.querySelectorAll('.source-card-dot')].every(dot => dot.getAttribute('aria-hidden') === 'true')).toBe(true)
    view.rerender(<SourceSessionCard entry={{ ...main, subagentCount: undefined }} selected={false} now={Date.now()} onSelect={vi.fn()} />)
    expect(document.querySelector('.source-card-context')!.textContent).toBe('alpha')
    expect(document.querySelector('.source-card-dot')).toBeNull()
  })
  it('标题单行显示，不使用双行截断', () => {
    render(<SourceSessionCard entry={{ ...main, title: '只读任务，禁止编辑或创建任何文件。'.repeat(4) }} selected={false} now={Date.now()} onSelect={vi.fn()} />)
    const title = document.querySelector('.source-session-card h3')!
    expect(title.classList.contains('ds-fade-text')).toBe(true)
    expect(title.hasAttribute('data-lines')).toBe(false)
  })
  it('标题被截断时用 Tooltip 组件显示完整标题，未截断时不显示，也不再使用原生 title', () => {
    const entry = { ...main, title: '只读任务，禁止编辑或创建任何文件。'.repeat(4) }
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
    const natural = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(100)
    const view = render(<SourceSessionCard entry={entry} selected={false} now={Date.now()} onSelect={vi.fn()} />)
    const card = screen.getByRole('button', { name: /只读任务/ })
    expect(card.querySelector('h3')!.hasAttribute('title')).toBe(false)
    fireEvent.focus(card)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.blur(card)
    natural.mockReturnValue(400)
    view.rerender(<SourceSessionCard entry={{ ...entry }} selected={false} now={Date.now()} onSelect={vi.fn()} />)
    view.rerender(<SourceSessionCard entry={{ ...entry, title: entry.title + '。' }} selected={false} now={Date.now()} onSelect={vi.fn()} />)
    fireEvent.focus(screen.getByRole('button', { name: /只读任务/ }))
    expect(screen.getByRole('tooltip').textContent).toBe(entry.title + '。')
    fireEvent.blur(screen.getByRole('button', { name: /只读任务/ }))
    expect(screen.queryByRole('tooltip')).toBeNull()
    width.mockRestore(); natural.mockRestore()
  })
  it('鼠标悬停被截断的标题卡片时延迟后显示 Tooltip，离开后消失', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(400)
    render(<SourceSessionCard entry={{ ...main, title: '悬停合成标题' }} selected={false} now={Date.now()} onSelect={vi.fn()} />)
    const card = screen.getByRole('button', { name: /悬停合成标题/ })
    fireEvent.mouseEnter(card)
    expect((await screen.findByRole('tooltip')).textContent).toBe('悬停合成标题')
    fireEvent.mouseLeave(card)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
  it('Tooltip 显示在卡片右侧并与卡片顶部对齐，不盖住下方卡片；右侧放不下时翻到左侧', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(400)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120)
    const rect = (left: number, right: number) => ({ left, right, top: 200, bottom: 290, width: right - left, height: 90, x: left, y: 200, toJSON: () => ({}) }) as DOMRect
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(100, 360))
    const view = render(<SourceSessionCard entry={{ ...main, title: '右侧提示标题' }} selected={false} now={Date.now()} onSelect={vi.fn()} />)
    fireEvent.focus(screen.getByRole('button', { name: /右侧提示标题/ }))
    let tip = screen.getByRole('tooltip')
    expect(tip.getAttribute('data-side')).toBe('right')
    expect(tip.style.left).toBe('364px')
    expect(tip.style.top).toBe('200px')
    fireEvent.blur(screen.getByRole('button', { name: /右侧提示标题/ }))
    bounds.mockReturnValue(rect(700, 1000))
    view.rerender(<SourceSessionCard entry={{ ...main, title: '右侧提示标题 ' }} selected={false} now={Date.now()} onSelect={vi.fn()} />)
    fireEvent.focus(screen.getByRole('button', { name: /右侧提示标题/ }))
    tip = screen.getByRole('tooltip')
    expect(tip.getAttribute('data-side')).toBe('left')
    expect(tip.style.left).toBe('396px')
  })
  it('只有种类标签时仍渲染该行', () => {
    render(<SourceSessionCard entry={{ ...plain, workspace: undefined, kind: 'subagent' }} selected={false} now={Date.now()} onSelect={vi.fn()} />)
    expect(document.querySelector('.source-card-context > .source-kind')).not.toBeNull()
  })
  it('Windows 路径取末级目录；无工作目录或子会话时不渲染标注', () => {
    const view = render(<SourceSessionCard entry={{ ...main, workspace: 'C:\\synthetic\\work\\gamma', subagentCount: undefined }} selected={false} now={Date.now()} onSelect={vi.fn()} />)
    expect(screen.getByText('gamma')).toBeTruthy()
    expect(screen.queryByText(/个子会话/)).toBeNull()
    view.rerender(<SourceSessionCard entry={{ ...main, workspace: undefined, subagentCount: undefined }} selected={false} now={Date.now()} onSelect={vi.fn()} />)
    expect(document.querySelector('.source-workspace')).toBeNull()
  })
})

describe('来源列表：按工作目录筛选', () => {
  it('分面超过一个目录时出现筛选器；选择后用 workspace 重新查询，并保留筛选器以便切回', async () => {
    const page = setup()
    await screen.findByRole('button', { name: '主会话甲 synthetic' })
    const select = screen.getByRole('combobox', { name: '按工作目录筛选' })
    fireEvent.click(select)
    fireEvent.click(screen.getByRole('option', { name: 'beta' }))
    await waitFor(() => expect(page).toHaveBeenLastCalledWith(expect.objectContaining({ workspace: '/synthetic/work/beta' })))
    await screen.findByRole('button', { name: '主会话乙 synthetic' })
    expect(screen.queryByRole('button', { name: '主会话甲 synthetic' })).toBeNull()
    fireEvent.click(screen.getByRole('combobox', { name: '按工作目录筛选' }))
    fireEvent.click(screen.getByRole('option', { name: '全部目录' }))
    await screen.findByRole('button', { name: '主会话甲 synthetic' })
    expect(page.mock.calls.at(-1)![0]).not.toHaveProperty('workspace')
  })
  it('筛选器使用 small 规格与中性色，并通栏铺满列表宽度', async () => {
    setup()
    await screen.findByRole('button', { name: '主会话甲 synthetic' })
    const root = screen.getByRole('combobox', { name: '按工作目录筛选' }).closest('.ds-select')!
    expect(root.getAttribute('data-size')).toBe('small')
    expect(root.getAttribute('data-tone')).toBe('neutral')
    expect(readFileSync('src/renderer/src/styles.css', 'utf8')).toMatch(/\.source-workspace-filter \.ds-select\s*\{[^}]*width:\s*100%/)
  })
  it('只有一个或没有工作目录时不显示筛选器', async () => {
    setup([workspaces[0]])
    await screen.findByRole('button', { name: '主会话乙 synthetic' })
    expect(screen.queryByRole('combobox', { name: '按工作目录筛选' })).toBeNull()
  })
})

describe.each([
  ['newmax', 'NewMax'], ['codex', 'Codex'], ['cindy', 'Cindy'], ['deepseek', 'DeepSeek Harness'], ['qwen-code', 'Qwen Code'], ['workbuddy', 'WorkBuddy'],
] as const)('%s 来源：复用工作区筛选', (source, label) => {
  it('可选择工作区并切回全部目录；换来源时清除工作区条件', async () => {
    const selectedConnection = { ...connection, source }
    const entries = [main, plain].map(entry => ({ ...entry, source, project: '' }))
    const page = vi.fn().mockImplementation(async (query: Record<string, unknown>) => pageOf(
      query.source === source ? entries.filter(entry => !query.workspace || entry.workspace === query.workspace) : [main, plain],
      { connections: [connection, selectedConnection] },
    ))
    window.staithe = { platform: 'darwin', list: vi.fn(), previewImport: vi.fn(), confirmImport: vi.fn(), cancelImport: vi.fn(), exportSession: vi.fn(), copy: vi.fn(), onOpenSession: vi.fn().mockReturnValue(() => {}),
      sources: { ...mockSourcesAPI(), page } }
    render(<SourceApp />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${label}`) }))
    await waitFor(() => expect(page).toHaveBeenLastCalledWith(expect.objectContaining({ source })))
    fireEvent.click(screen.getByRole('combobox', { name: '按工作目录筛选' }))
    fireEvent.click(screen.getByRole('option', { name: 'beta' }))
    await waitFor(() => expect(page).toHaveBeenLastCalledWith(expect.objectContaining({ source, workspace: '/synthetic/work/beta' })))
    await waitFor(() => expect(screen.queryByRole('button', { name: '主会话甲' })).toBeNull())
    expect(screen.getByRole('button', { name: '主会话乙' })).toBeTruthy()
    fireEvent.click(screen.getByRole('combobox', { name: '按工作目录筛选' }))
    fireEvent.click(screen.getByRole('option', { name: '全部目录' }))
    await screen.findByRole('button', { name: '主会话甲' })
    expect(page.mock.calls.at(-1)![0]).not.toHaveProperty('workspace')
    fireEvent.click(screen.getByRole('combobox', { name: '按工作目录筛选' }))
    fireEvent.click(screen.getByRole('option', { name: 'beta' }))
    await waitFor(() => expect(page.mock.calls.at(-1)![0].workspace).toBe('/synthetic/work/beta'))
    fireEvent.click(screen.getByRole('button', { name: /^Claude Code/ }))
    await waitFor(() => expect(page).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'claude-code' })))
    expect(page.mock.calls.at(-1)![0]).not.toHaveProperty('workspace')
  })
})

describe('来源详情：子会话', () => {
  it('主会话详情列出折叠的子会话，点击后打开子会话正文', async () => {
    const page = setup()
    fireEvent.click(await screen.findByRole('button', { name: '主会话甲 synthetic' }))
    const group = await screen.findByRole('group', { name: '子会话' })
    expect(page).toHaveBeenCalledWith(expect.objectContaining({ connectionId: connection.id, parentSessionId: 'main-a' }))
    const buttons = await within(group).findAllByRole('button')
    expect(buttons.map(button => button.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('子代理丙'), expect.stringContaining('子代理丁')]))
    await act(async () => { fireEvent.click(buttons[0]) })
    await waitFor(() => expect(window.staithe.sources.read).toHaveBeenLastCalledWith(children[0].id))
    // 子会话自身没有再下一级，不显示子会话面板。
    expect(screen.queryByRole('group', { name: '子会话' })).toBeNull()
  })
  it('没有子会话的主会话不请求也不显示面板', async () => {
    const page = setup()
    fireEvent.click(await screen.findByRole('button', { name: '主会话乙 synthetic' }))
    await waitFor(() => expect(window.staithe.sources.read).toHaveBeenCalled())
    expect(screen.queryByRole('group', { name: '子会话' })).toBeNull()
    expect(page.mock.calls.some(([query]) => 'parentSessionId' in query)).toBe(false)
  })
})
