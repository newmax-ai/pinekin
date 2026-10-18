// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
it('已选会话刷新后变为不支持，清理卡片和旧正文，但保留明确的过滤原因提示', async () => {
  render(<SourceApp onArchives={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: '原会话' }))
  await screen.findByRole('region', { name: '会话消息' })
  const list = document.querySelector('.session-list') as HTMLElement; list.scrollTop = 100
  hidden = true
  fireEvent.click(screen.getByRole('button', { name: '刷新当前来源' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '原会话' })).toBeNull())
  expect(screen.queryByRole('region', { name: '会话消息' })).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('“原会话”已从列表过滤：协作边界尚未支持')
  expect(screen.getByRole('alert').textContent).toContain('原始文件未删除')
  expect(window.staithe.sources.read).toHaveBeenCalledOnce()
})
it('点击期间来源变为不支持时，清理条目但不能静默清空，展示原因且不提供无效重试', async () => {
  vi.mocked(window.staithe.sources.read).mockImplementation(async () => { hidden = true; throw new Error('协作边界尚未支持') })
  render(<SourceApp onArchives={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: '原会话' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '原会话' })).toBeNull())
  expect(screen.getByRole('alert').textContent).toContain('“原会话”已从列表过滤：协作边界尚未支持')
  expect(screen.getByRole('alert').textContent).toContain('原始文件未删除')
  expect(screen.queryByRole('button', { name: '重试读取' })).toBeNull()
})
it('首次读取前来源已删除时只显示读取错误，不虚构上次正文快照提示', async () => {
  vi.mocked(window.staithe.sources.read).mockRejectedValue(new Error('来源已移动或删除'))
  vi.mocked(window.staithe.sources.check).mockResolvedValue({ version: 2, connections: [connection], selected: null })
  render(<SourceApp onArchives={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: '原会话' }))
  await screen.findByText('来源已移动或删除')
  await waitFor(() => expect(window.staithe.sources.check).toHaveBeenCalled())
  expect(screen.queryByText('来源会话已删除，当前显示的是上次读取的内容')).toBeNull()
})
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
it('失败后的迟到检查不能清空随后重试成功的正文，也不能显示过期过滤提示', async () => {
  let resolveCheck!: (result: SourceCheckResult) => void
  const check = new Promise<SourceCheckResult>(resolve => { resolveCheck = resolve })
  vi.mocked(window.staithe.sources.check).mockReturnValueOnce(check)
  vi.mocked(window.staithe.sources.read).mockRejectedValueOnce(new Error('首次暂时失败'))
  render(<SourceApp onArchives={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: '原会话' }))
  await screen.findByText('首次暂时失败')
  fireEvent.click(screen.getByRole('button', { name: '重试读取' }))
  await screen.findByRole('region', { name: '会话消息' })
  await act(async () => { resolveCheck({ version: 1, connections: [connection], selected: { ...entry, availability: 'unsupported', reason: '过期能力状态' } }) })
  expect(screen.getByRole('region', { name: '会话消息' })).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: '原会话' })).toBeTruthy()
})
it('普通读取失败仍保留原条目和重试，不根据错误文字猜测不支持', async () => {
  vi.mocked(window.staithe.sources.read).mockRejectedValue(new Error('暂时没有读取权限'))
  render(<SourceApp onArchives={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: '原会话' }))
  await screen.findByText('暂时没有读取权限')
  expect(screen.getByRole('button', { name: '原会话' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '重试读取' })).toBeTruthy()
})
