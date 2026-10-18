// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SourceConnection } from '../src/core/sources'
import { EmptyState, emptyStatePresets, resolveArchiveEmptyState, resolveSourceEmptyState } from '../src/renderer/src/components/EmptyState'

afterEach(cleanup)
const connection: SourceConnection = { id: 'fixture', source: 'claude-code', label: '合成位置', status: 'ready', discovered: 0, total: 0, issues: 0, ignoredLinks: 0 }
const base = { loaded: true, error: '', count: 0, query: '', connections: [connection] }

describe('空状态判定优先级', () => {
  it('有可展示数据时不覆盖内容，即使其他位置失败或仍在统计', () => {
    expect(resolveSourceEmptyState({ ...base, count: 1, error: '分页失败' })).toBeUndefined()
    expect(resolveSourceEmptyState({ ...base, count: 1, connections: [{ ...connection, status: 'scanning' }] })).toBeUndefined()
  })
  it('初次加载与列表请求失败都不能被当成空库或未连接', () => {
    expect(resolveSourceEmptyState({ ...base, loaded: false, connections: [] })).toBe('loading')
    expect(resolveSourceEmptyState({ ...base, loaded: false, error: '请求失败', connections: [] })).toBe('list-error')
    expect(resolveSourceEmptyState({ ...base, error: '请求失败' })).toBe('list-error')
  })
  it('未连接优先于搜索无结果，不在渲染时自动扫描或连接', () => {
    expect(resolveSourceEmptyState({ ...base, query: '任何词', connections: [] })).toBe('disconnected')
  })
  it.each([
    ['scanning', 'scanning'], ['error', 'connection-error'], ['partial', 'partial'],
    ['cancelled', 'paused'], ['idle', 'needs-refresh'], ['ready', 'empty'],
  ] as const)('%s 无数据时显示 %s，而不是笼统的搜索失败', (status, expected) => {
    expect(resolveSourceEmptyState({ ...base, connections: [{ ...connection, status }] })).toBe(expected)
    expect(resolveSourceEmptyState({ ...base, query: '词', connections: [{ ...connection, status }] })).toBe(status === 'ready' ? 'no-results' : expected)
  })
  it('多个位置混合时按统计、错误、部分、暂停、未刷新排序', () => {
    const states = ['scanning', 'error', 'partial', 'cancelled', 'idle', 'ready'] as const
    const expected = ['scanning', 'connection-error', 'partial', 'paused', 'needs-refresh', 'empty']
    states.forEach((_status, index) => {
      expect(resolveSourceEmptyState({ ...base, connections: states.slice(index).reverse().map(status => ({ ...connection, status })) })).toBe(expected[index])
    })
  })
  it('只包含空白字符的关键词不构成有效搜索', () => {
    expect(resolveSourceEmptyState({ ...base, query: '  \n ' })).toBe('empty')
  })
  it('档案加载、错误、空库、来源为空及搜索为空分别处理', () => {
    const archive = { loaded: true, error: '', total: 0, count: 0, query: '', filtered: false }
    expect(resolveArchiveEmptyState(archive)).toBe('archives-empty')
    expect(resolveArchiveEmptyState({ ...archive, loaded: false })).toBe('archive-loading')
    expect(resolveArchiveEmptyState({ ...archive, error: '读取失败' })).toBe('archive-error')
    expect(resolveArchiveEmptyState({ ...archive, total: 2, filtered: true })).toBe('source-empty')
    expect(resolveArchiveEmptyState({ ...archive, total: 2, query: '没有' })).toBe('no-results')
    expect(resolveArchiveEmptyState({ ...archive, total: 0, query: '没有' })).toBe('archives-empty')
    expect(resolveArchiveEmptyState({ ...archive, count: 1, total: 1 })).toBeUndefined()
  })
})

describe('统一空占位组件', () => {
  it.each(Object.keys(emptyStatePresets) as (keyof typeof emptyStatePresets)[])('%s 有明确标题，仅必要场景补充简短说明，插画为本地装饰资源', kind => {
    const { container } = render(<EmptyState kind={kind} />)
    const state = container.querySelector('[data-empty-state]')!
    expect(state.getAttribute('data-empty-state')).toBe(kind)
    expect(screen.getByRole('heading').textContent?.length).toBeGreaterThan(0)
    const description = container.querySelector('.empty-description')
    if (['partial', 'connection-error', 'empty', 'unsupported'].includes(kind)) {
      expect(description?.textContent?.length).toBeGreaterThan(0)
      expect(description!.textContent!.length).toBeLessThanOrEqual(22)
    } else expect(description).toBeNull()
    expect(container.querySelector('.empty-footnote')).toBeNull()
    const image = container.querySelector('img')
    if (image) {
      expect(image.getAttribute('src')).toMatch(/empty-states\/[^/]+\.svg/)
      expect(image.getAttribute('alt')).toBe('')
      expect(image.getAttribute('aria-hidden')).toBe('true')
      expect(image.getAttribute('draggable')).toBe('false')
    }
  })
  it.each(['hero', 'compact', 'quiet'] as const)('%s 全部场景沿用统一语义颜色，不额外分配局部色阶', layout => {
    for (const kind of Object.keys(emptyStatePresets) as (keyof typeof emptyStatePresets)[]) {
      const { container, unmount } = render(<EmptyState kind={kind} layout={layout} />)
      expect(container.querySelector('[data-empty-state]')?.hasAttribute('data-empty-tone')).toBe(false)
      unmount()
    }
  })
  it('加载与统计只播报进度，不显示判空插画和操作', () => {
    const { container } = render(<EmptyState kind="scanning" />)
    expect(screen.getByRole('status').textContent).toContain('正在发现会话')
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[aria-hidden="true"].empty-progress')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
  it.each(Object.keys(emptyStatePresets) as (keyof typeof emptyStatePresets)[])('hero %s 保留标题和一句简短描述，不显示通用脚注', kind => {
    const { container } = render(<EmptyState kind={kind} layout="hero" />)
    expect(screen.getByRole('heading', { level: 2 })).toBeTruthy()
    expect(container.querySelectorAll('.empty-description')).toHaveLength(1)
    const description = container.querySelector('.empty-description')!.textContent!
    expect(description.length).toBeGreaterThan(0)
    expect(description.length).toBeLessThanOrEqual(28)
    expect(description).not.toBe(screen.getByRole('heading').textContent)
    expect(container.querySelector('.empty-footnote')).toBeNull()
  })
  it.each([
    ['disconnected', '尚未连接会话来源', '支持 Claude Code、Codex 等来源。', '连接来源 App'],
    ['needs-refresh', '等待刷新', '连接位置已保留，会话列表尚未更新。', '刷新'],
    ['paused', '会话统计已暂停', '当前统计结果可能不完整。', '刷新'],
    ['empty', '还没有可浏览的会话', '新对话需在来源 App 中创建。', '刷新'],
    ['no-results', '没有找到匹配的会话', '结果仅限当前筛选的来源。', '清空关键词'],
    ['archives-empty', '还没有会话档案', '导入前可预览内容与兼容性。', '选择会话文件'],
    ['source-empty', '此来源还没有会话档案', '其他来源的档案不受此筛选影响。', '清空筛选'],
    ['selection', '尚未选择会话', '正文与来源信息将在这里显示。', ''],
  ] as const)('%s 标题说明状态，描述补充信息，行动交给按钮', (kind, title, description, label) => {
    const { container } = render(<EmptyState kind={kind} layout="hero" action={label ? { label, onClick: vi.fn() } : undefined} />)
    expect(screen.getByRole('heading').textContent).toBe(title)
    expect(container.querySelector('.empty-description')?.textContent).toBe(description)
    expect(description).not.toContain(title)
    if (label) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
      expect(description).not.toContain(label)
    } else expect(screen.queryByRole('button')).toBeNull()
  })
  it('hero 真实错误原因优先，不再叠加默认说明', () => {
    const { container } = render(<EmptyState kind="read-error" layout="hero" description="文件已移动" />)
    expect(container.querySelectorAll('p')).toHaveLength(1)
    expect(screen.getByText('文件已移动')).toBeTruthy()
  })
  it('quiet 仅短提示；hero 使用 h2，compact 使用 h3', () => {
    const { container, rerender } = render(<EmptyState kind="empty" layout="quiet" />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.getByText('暂无会话', { selector: 'p' })).toBeTruthy()
    rerender(<EmptyState kind="selection" layout="hero" />)
    expect(screen.getByRole('heading', { level: 2 })).toBeTruthy()
    expect(container.querySelector('img')).toBeTruthy()
    expect(screen.getByRole('heading').textContent).toBe('尚未选择会话')
    expect(container.querySelector('.empty-description')?.textContent).toBe('正文与来源信息将在这里显示。')
    expect(container.querySelector('.empty-footnote')).toBeNull()
  })
  it.each([
    ['loading', '正在读取会话…'], ['archive-loading', '正在读取档案…'], ['scanning', '正在发现会话…'],
    ['disconnected', '连接来源后查看会话'], ['needs-refresh', '刷新后查看会话'], ['paused', '统计已暂停，可刷新重试'],
    ['partial', '部分位置未读完，可刷新重试'], ['connection-error', '来源读取失败，请检查连接'], ['list-error', '列表读取失败，请重试'],
    ['empty', '暂无会话'], ['no-results', '未找到匹配的会话'], ['selection', '选择会话查看内容'],
    ['read-error', '会话读取失败，请重试'], ['unsupported', '暂不支持读取此格式'], ['messages', '暂无消息'],
    ['archives-empty', '暂无会话档案'], ['source-empty', '此来源暂无档案'], ['archive-error', '档案读取失败，请重试'], ['connections-empty', '暂无连接'],
  ] as const)('quiet %s 加载用动画，其余只显示短描述，不显示标题或插画', (kind, text) => {
    const { container } = render(<EmptyState kind={kind} layout="quiet" title="不应显示的标题" />)
    expect(screen.queryByRole('heading')).toBeNull()
    const pending = ['loading', 'archive-loading', 'scanning'].includes(kind)
    expect(container.querySelectorAll('p')).toHaveLength(pending ? 0 : 1)
    if (pending) {
      expect(screen.getByRole('img', { name: text }).classList.contains('loading-mark')).toBe(true)
      expect(container.textContent).toBe('')
    } else expect(container.querySelector('p')?.textContent).toBe(text)
    expect(text.length).toBeLessThanOrEqual(16)
    expect(container.querySelector('img, .empty-progress, .empty-footnote')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('quiet 仅保留具体错误原因与必要行动，不再叠加默认说明', () => {
    const run = vi.fn()
    const reason = '<img src=x onerror="alert(1)">'
    const { container } = render(<EmptyState kind="list-error" layout="quiet" description={reason} action={{ label: '重新加载', onClick: run }} />)
    expect(screen.queryByRole('heading')).toBeNull()
    expect(container.querySelectorAll('p')).toHaveLength(1)
    expect(screen.getByText(reason)).toBeTruthy()
    expect(container.querySelector('img, [onerror]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(run).toHaveBeenCalledOnce()
  })
  it('待刷新只保留简短标题和行动，不插入空说明段落', () => {
    const { container } = render(<EmptyState kind="needs-refresh" action={{ label: '刷新', onClick: vi.fn() }} />)
    expect(screen.getByRole('heading').textContent).toBe('等待刷新')
    expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy()
    expect(container.querySelector('.empty-description')).toBeNull()
  })
  it('显式空说明可以隐藏默认说明，必要原因仍可由调用方传入', () => {
    const { container, rerender } = render(<EmptyState kind="empty" description="" />)
    expect(container.querySelector('.empty-description')).toBeNull()
    rerender(<EmptyState kind="read-error" description="文件已移动" />)
    expect(screen.getByText('文件已移动')).toBeTruthy()
  })
  it.each(['hero', 'compact', 'quiet'] as const)('%s 空占位行动统一使用 tertiary 按钮，保持可操作', layout => {
    const run = vi.fn()
    render(<EmptyState kind="disconnected" layout={layout} action={{ label: '连接来源', onClick: run }} />)
    const button = screen.getByRole('button', { name: '连接来源' })
    expect(button.classList.contains('ds-button-tertiary')).toBe(true)
    expect(button.classList.contains('ds-button-primary')).toBe(false)
    expect(button.classList.contains('ds-button-ghost')).toBe(false)
    fireEvent.click(button)
    expect(run).toHaveBeenCalledOnce()
  })
  it('主要行动可禁用，不隐式调用任何外部能力', () => {
    const run = vi.fn()
    const { rerender } = render(<EmptyState kind="disconnected" action={{ label: '连接来源', onClick: run, disabled: true }} />)
    fireEvent.click(screen.getByRole('button', { name: '连接来源' })); expect(run).not.toHaveBeenCalled()
    rerender(<EmptyState kind="disconnected" action={{ label: '连接来源', onClick: run }} />)
    fireEvent.click(screen.getByRole('button', { name: '连接来源' })); expect(run).toHaveBeenCalledOnce()
  })
  it('失败原因以纯文本呈现，未支持没有虚假的重试按钮', () => {
    const reason = '<img src=x onerror="alert(1)">'
    const { container } = render(<EmptyState kind="unsupported" description={reason} />)
    expect(screen.getByRole('alert').textContent).toContain(reason)
    expect(container.querySelector('[onerror]')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
