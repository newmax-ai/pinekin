// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArchiveApp } from '../src/renderer/src/App'
import { SourceApp } from '../src/renderer/src/SourceApp'
import { fixtureSessions } from './fixtures/sessions'
import { mockSourcesAPI } from './fixtures/source-api'

const sessions = fixtureSessions.slice(0, 3)
const connection = { id: '11111111-1111-4111-8111-111111111111', source: 'claude-code' as const, label: 'synthetic', status: 'ready' as const, discovered: 3, total: 3, issues: 0, ignoredLinks: 0 }
const entries = sessions.map(session => ({ id: session.id, connectionId: connection.id, source: connection.source, title: session.title, project: '.', updatedAt: session.updatedAt, availability: 'unread' as const }))

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  window.staithe = {
    platform: 'darwin', list: vi.fn().mockResolvedValue(sessions), previewImport: vi.fn(), confirmImport: vi.fn(), cancelImport: vi.fn(),
    exportSession: vi.fn(), copy: vi.fn(), onOpenSession: vi.fn().mockReturnValue(() => {}),
    sources: {
      ...mockSourcesAPI(),
      page: vi.fn().mockResolvedValue({ items: entries, total: 3, offset: 0, hasMore: false, connections: [connection] }),
      read: vi.fn().mockImplementation(async id => ({ session: sessions.find(session => session.id === id)!, warnings: [] })),
    },
  }
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function open(kind: 'source' | 'archive') {
  render(kind === 'source' ? <SourceApp /> : <ArchiveApp />)
  await screen.findByText(sessions[0].title, { selector: '.session-card h3' })
  const list = document.querySelector('.session-list') as HTMLElement
  const cards = [...list.querySelectorAll<HTMLButtonElement>('.session-card')]
  const tops = [110, 320, 600]
  for (const [name, value] of Object.entries({ clientWidth: 280, clientHeight: 300, scrollHeight: 1000 })) {
    vi.spyOn(list, name as 'clientWidth', 'get').mockReturnValue(value)
  }
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 20, 280, 300))
  cards.forEach((card, index) => vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 20 + tops[index] - list.scrollTop, 280, 64)))
  // 完成初次布局测量，再模拟用户手动滚动，避免把 jsdom 从零尺寸恢复误当成搜索引起的移动。
  fireEvent(window, new Event('resize'))
  list.scrollTop = 100
  return { list, cards }
}

describe.each(['source', 'archive'] as const)('%s 会话列表选中滚动接入', kind => {
  it('点击下沿卡片后完整避开 mask，再次点击同一项也能校正', async () => {
    const { list, cards } = await open(kind)
    fireEvent.click(cards[1])
    expect(cards[1].getAttribute('aria-pressed')).toBe('true')
    expect(list.scrollTop).toBe(132)
    list.scrollTop = 100
    fireEvent.click(cards[1].querySelector('h3')!)
    expect(list.scrollTop).toBe(132)
  })
  it('返回和前进按实际选中卡片调整，不滚动外层容器', async () => {
    const { list, cards } = await open(kind)
    const parent = list.parentElement!
    parent.scrollTop = 70
    fireEvent.click(cards[0])
    fireEvent.click(cards[1])
    await screen.findByRole('region', { name: '会话消息' })
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(cards[0].getAttribute('aria-pressed')).toBe('true')
    expect(list.scrollTop).toBe(62)
    fireEvent.click(screen.getByRole('button', { name: '前进' }))
    expect(cards[1].getAttribute('aria-pressed')).toBe('true')
    expect(list.scrollTop).toBe(132)
    expect(parent.scrollTop).toBe(70)
  })
  it('搜索选择屏外会话后定位主列表，未选择时保留原滚动位置', async () => {
    const { list, cards } = await open(kind)
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    const dialog = screen.getByRole('dialog', { name: '搜索会话' })
    const result = await within(dialog).findByRole('button', { name: `${kind === 'source' ? '打开会话' : '打开档案'}：${sessions[2].title}` })
    expect(list.scrollTop).toBe(100)
    fireEvent.click(result)
    expect(cards[2].getAttribute('aria-pressed')).toBe('true')
    expect(list.scrollTop).toBe(412)
    // 等待选择触发的合成正文读取结束，确保异步更新不影响滚动。
    await act(async () => {})
    expect(list.scrollTop).toBe(412)
  })
})
