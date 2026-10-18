// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SourceApp } from '../src/renderer/src/SourceApp'
import { mockSourcesAPI } from './fixtures/source-api'
import { fixtureSessions } from './fixtures/sessions'
import type { SourceCheckResult, SourceContent, SourceEntry } from '../src/core/sources'
const connection = { id: '11111111-1111-4111-8111-111111111111', source: 'cindy' as const, label: 'synthetic', status: 'ready' as const, discovered: 1, total: 1, issues: 0, ignoredLinks: 0 }
const entry: SourceEntry = { id: 'a'.repeat(64), connectionId: connection.id, source: 'cindy', title: '原会话', project: '', updatedAt: '2026-10-18T00:00:00Z', availability: 'unread', revision: 'v1' }
let hidden: boolean
beforeEach(() => {
  hidden = false
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLElement.prototype.showPopover = function () {}; HTMLElement.prototype.hidePopover = function () {}
  window.staithe = { platform: 'darwin', list: vi.fn(), previewImport: vi.fn(), confirmImport: vi.fn(), cancelImport: vi.fn(), exportSession: vi.fn(), copy: vi.fn(), onOpenSession: vi.fn(),
    sources: { ...mockSourcesAPI(), page: vi.fn().mockImplementation(async () => ({ items: hidden ? [] : [entry], total: hidden ? 0 : 1, offset: 0, hasMore: false,
      connections: [{ ...connection, total: hidden ? 0 : 1, discovered: hidden ? 0 : 1 }], version: hidden ? 2 : 1, snapshot: hidden ? 'hidden' : 'visible' })),
    read: vi.fn().mockResolvedValue({ session: { ...fixtureSessions[0], id: entry.id, title: entry.title, source: 'cindy' }, warnings: [], revision: 'v1' }),
    check: vi.fn().mockImplementation(async () => ({ version: hidden ? 2 : 1, connections: [{ ...connection, total: hidden ? 0 : 1, discovered: hidden ? 0 : 1 }],
      selected: hidden ? { ...entry, availability: 'unsupported', reason: '协作边界尚未支持' } : entry })) } }
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it.each(['成功', '失败'])('读取失败立即退出加载，后台检查%s及重试期间不叠加占位或干扰新请求', async outcome => {
  function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (reason: Error) => void
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
  }
  const firstRead = deferred<SourceContent>()
  const retryRead = deferred<SourceContent>()
  const check = deferred<SourceCheckResult>()
  vi.mocked(window.staithe.sources.read).mockReturnValueOnce(firstRead.promise).mockReturnValueOnce(retryRead.promise)
  vi.mocked(window.staithe.sources.check).mockReturnValueOnce(check.promise)
  render(<SourceApp onArchives={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: '原会话' }))
  expect(screen.getByRole('heading', { name: '正在读取来源正文…' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '重试读取' })).toBeNull()

  await act(async () => { firstRead.reject(new Error('合成读取失败')) })
  expect(window.staithe.sources.check).toHaveBeenCalledOnce()
  expect(screen.getByRole('heading', { name: '暂时无法读取这段会话' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: '正在读取来源正文…' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: '重试读取' }))
  expect(window.staithe.sources.read).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('heading', { name: '正在读取来源正文…' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: '暂时无法读取这段会话' })).toBeNull()
  expect(screen.queryByRole('button', { name: '重试读取' })).toBeNull()
  await act(async () => {
    if (outcome === '成功') check.resolve({ version: 1, connections: [connection], selected: entry })
    else check.reject(new Error('合成检查失败'))
  })
  expect(screen.getByRole('heading', { name: '正在读取来源正文…' })).toBeTruthy()
  await act(async () => { retryRead.resolve({ session: { ...fixtureSessions[0], id: entry.id, title: entry.title, source: 'cindy' }, warnings: [], revision: 'v1' }) })
  expect(screen.getByRole('region', { name: '会话消息' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: '正在读取来源正文…' })).toBeNull()
  expect(screen.queryByRole('heading', { name: '暂时无法读取这段会话' })).toBeNull()
})
