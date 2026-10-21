// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SourceApp } from '../src/renderer/src/SourceApp'
import { mockSourcesAPI } from './fixtures/source-api'
import type { SourceContent, SourceEntry } from '../src/core/sources'
import type { StaitheAPI } from '../src/core/types'

const connection = { id: '11111111-1111-4111-8111-111111111111', source: 'codex' as const, label: 'synthetic', status: 'ready' as const, discovered: 1, total: 1, issues: 0, ignoredLinks: 0 }
const entry: SourceEntry = { id: 'a'.repeat(64), connectionId: connection.id, source: connection.source, title: '合成会话', project: '.', updatedAt: '2026-10-21T00:00:00Z', availability: 'readable', revision: 'v1' }
const content: SourceContent = { revision: 'v1', warnings: [], session: { id: entry.id, title: entry.title, source: entry.source, updatedAt: entry.updatedAt, tags: [], demo: false, messages: [{ role: 'user', content: '合成正文' }] } }

beforeEach(() => {
  window.staithe = { platform: 'darwin', copy: vi.fn(), onOpenSession: vi.fn(), sources: {
    ...mockSourcesAPI(), page: vi.fn().mockResolvedValue({ items: [entry], total: 1, offset: 0, hasMore: false, connections: [connection], version: 1 }),
    read: vi.fn().mockResolvedValue(content), check: vi.fn().mockResolvedValue({ version: 1, connections: [connection], selected: { ...entry, revision: 'v2' } }),
  }, sourceActions: {
    inspect: vi.fn().mockResolvedValue({ original: { available: false, app: 'Codex' }, targets: [] }), openOriginal: vi.fn(), exportText: vi.fn(), continueInCodex: vi.fn(),
    prepareHandoffFile: vi.fn().mockResolvedValue({ token: '11111111-1111-4111-8111-111111111111' }),
    deliverHandoffFile: vi.fn().mockResolvedValue({ status: 'file-copied' }), discardHandoffFile: vi.fn().mockResolvedValue(undefined),
  } } as unknown as StaitheAPI
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
async function open() {
  render(<SourceApp />)
  fireEvent.click(await screen.findByRole('button', { name: '合成会话 .' }))
  return screen.findByRole('region', { name: '会话消息' })
}

describe('消息区共用居中 Toast', () => {
  it('关闭更新不读取或滚动，同版本检查后不复现，新版本仍提示', async () => {
    const messages = await open()
    messages.scrollTop = 120
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    fireEvent.focus(window)
    const update = await screen.findByRole('button', { name: '查看更新' })
    expect(update.parentElement?.classList.contains('ds-toast-surface')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '关闭更新提示' }))
    expect(screen.queryByRole('button', { name: '查看更新' })).toBeNull()
    expect(screen.queryByRole('button', { name: '关闭更新提示' })).toBeNull()
    expect(messages.scrollTop).toBe(120)
    expect(window.staithe.sources.read).toHaveBeenCalledOnce()

    clock.mockReturnValue(Date.now() + 16_000)
    fireEvent.focus(window)
    await waitFor(() => expect(window.staithe.sources.check).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('button', { name: '查看更新' })).toBeNull()
    vi.mocked(window.staithe.sources.check).mockResolvedValueOnce({ version: 1, connections: [connection], selected: { ...entry, revision: 'v3' } })
    clock.mockReturnValue(Date.now() + 16_000)
    fireEvent.focus(window)
    await screen.findByRole('button', { name: '查看更新' })
    expect(messages.scrollTop).toBe(120)
    expect(window.staithe.sources.read).toHaveBeenCalledOnce()
  })
  it('关闭跳转提示只收起入口，不再读取或移动正文', async () => {
    const messages = await open()
    messages.scrollTop = 120
    const scroll = vi.fn()
    messages.querySelectorAll('article').forEach(article => { article.scrollIntoView = scroll })
    vi.mocked(window.staithe.sources.read).mockResolvedValueOnce({ ...content, revision: 'v2', session: { ...content.session, messages: [...content.session.messages, { role: 'assistant', content: '合成新增正文' }] } })
    fireEvent.click(screen.getByRole('button', { name: '刷新当前来源' }))
    await screen.findByRole('button', { name: '跳到新增消息' })
    fireEvent.click(screen.getByRole('button', { name: '关闭更新提示' }))
    expect(screen.queryByRole('button', { name: '跳到新增消息' })).toBeNull()
    expect(window.staithe.sources.read).toHaveBeenCalledTimes(2)
    expect(messages.scrollTop).toBe(120)
    expect(scroll).not.toHaveBeenCalled()
  })
})
