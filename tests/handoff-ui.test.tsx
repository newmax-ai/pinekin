// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SourceActions } from '../src/renderer/src/components/SourceActions'
import type { PreparedHandoff } from '../src/core/handoff'
import type { StaitheAPI } from '../src/core/types'

const id = 'a'.repeat(64), token = '11111111-1111-4111-8111-111111111111'
const prepared: PreparedHandoff = { token }
function api() { return window.staithe.sourceActions! }
function copy() { fireEvent.click(screen.getByRole('button', { name: '复制接续文件' })) }
beforeEach(() => {
  window.staithe = { copy: vi.fn(), sourceActions: {
    inspect: vi.fn().mockResolvedValue({ original: { available: false, app: 'Codex' }, targets: [] }),
    openOriginal: vi.fn(), exportText: vi.fn(), continueInTarget: vi.fn(), inspectTarget: vi.fn(),
    prepareHandoffFile: vi.fn().mockResolvedValue(prepared),
    deliverHandoffFile: vi.fn().mockResolvedValue({ status: 'file-copied' }), discardHandoffFile: vi.fn().mockResolvedValue(undefined),
  } } as unknown as StaitheAPI
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('默认直接复制通用文件，不再选择目标 App', () => {
  it('一次点击准备并复制文件，没有弹窗、预览、目标选择或原生创建', async () => {
    render(<SourceActions entryId={id} />)
    expect(api().prepareHandoffFile).not.toHaveBeenCalled()
    copy()
    await waitFor(() => expect(api().deliverHandoffFile).toHaveBeenCalledExactlyOnceWith(token, 'copy-file'))
    expect(api().prepareHandoffFile).toHaveBeenCalledExactlyOnceWith(id)
    expect(api().discardHandoffFile).toHaveBeenCalledWith(token)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('在其他 App 继续')).toBeNull()
    expect(screen.queryByText(/复制并打开/)).toBeNull()
    expect(api().continueInTarget).not.toHaveBeenCalled(); expect(api().inspectTarget).not.toHaveBeenCalled()
    expect(api().openOriginal).not.toHaveBeenCalled(); expect(window.staithe.copy).not.toHaveBeenCalled()
    expect((await screen.findByRole('status')).textContent).toContain('文件已复制，可在支持文件粘贴的 App 中添加。')
    expect(screen.getByRole('status').textContent).not.toMatch(/已恢复|已创建|接续成功/)
  })
  it('准备期间按钮文案不变，重复点击不会重复读取或交付', async () => {
    let finish!: (value: PreparedHandoff) => void
    vi.mocked(api().prepareHandoffFile!).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    render(<SourceActions entryId={id} />)
    copy(); copy()
    const button = screen.getByRole('button', { name: '复制接续文件' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(api().prepareHandoffFile).toHaveBeenCalledTimes(1)
    await act(async () => finish(prepared))
    await waitFor(() => expect(button.disabled).toBe(false))
    expect(api().deliverHandoffFile).toHaveBeenCalledTimes(1)
  })
  it.each(['change', 'disable', 'unmount'] as const)('%s 后迟到的准备结果只释放，不复制文件', async mode => {
    let finish!: (value: PreparedHandoff) => void
    vi.mocked(api().prepareHandoffFile!).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const view = render(<SourceActions entryId={id} />)
    copy()
    if (mode === 'change') view.rerender(<SourceActions entryId={'b'.repeat(64)} />)
    if (mode === 'disable') view.rerender(<SourceActions entryId={id} disabled />)
    if (mode === 'unmount') view.unmount()
    await act(async () => finish(prepared))
    expect(api().discardHandoffFile).toHaveBeenCalledWith(token)
    expect(api().deliverHandoffFile).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('离开再回到同一会话也不能交付过时请求', async () => {
    let finish!: (value: PreparedHandoff) => void
    vi.mocked(api().prepareHandoffFile!).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const view = render(<SourceActions entryId={id} />)
    copy()
    view.rerender(<SourceActions entryId={'b'.repeat(64)} />)
    view.rerender(<SourceActions entryId={id} />)
    await act(async () => finish(prepared))
    expect(api().deliverHandoffFile).not.toHaveBeenCalled()
    expect(api().discardHandoffFile).toHaveBeenCalledWith(token)
  })
  it('失败提示后可再次点击重试，副作用失败仍释放令牌', async () => {
    vi.mocked(api().prepareHandoffFile!).mockRejectedValueOnce(new Error('来源变化，请重试'))
    vi.mocked(api().deliverHandoffFile!).mockRejectedValueOnce(new Error('文件剪贴板失败'))
    render(<SourceActions entryId={id} />)
    copy()
    expect((await screen.findByRole('alert')).textContent).toContain('来源变化')
    copy()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('文件剪贴板失败'))
    expect(api().discardHandoffFile).toHaveBeenCalledWith(token)
    copy()
    await screen.findByRole('status')
    expect(api().prepareHandoffFile).toHaveBeenCalledTimes(3)
    expect(window.staithe.copy).not.toHaveBeenCalled()
  })
  it.each(['exported', 'cancelled'] as const)('更多菜单保存完整接续文件，结果为 %s 时如实反馈', async status => {
    vi.mocked(api().deliverHandoffFile!).mockResolvedValueOnce({ status })
    render(<SourceActions entryId={id} content={{ warnings: [], session: { id, title: '合成', source: 'codex', updatedAt: '2026-10-20T00:00:00Z', demo: false, tags: [], messages: [{ role: 'user', content: '当前片段' }] } }} />)
    fireEvent.click(screen.getByRole('button', { name: '更多会话操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '保存接续文件' }))
    await waitFor(() => expect(api().discardHandoffFile).toHaveBeenCalledWith(token))
    expect(api().prepareHandoffFile).toHaveBeenCalledExactlyOnceWith(id)
    expect(api().deliverHandoffFile).toHaveBeenCalledExactlyOnceWith(token, 'export')
    expect(api().exportText).not.toHaveBeenCalled()
    expect(window.staithe.copy).not.toHaveBeenCalled()
    if (status === 'exported') expect(screen.getByRole('status').textContent).toContain('接续文件已保存')
    else expect(screen.queryByRole('status')).toBeNull()
  })
  it('投递中切换会话立即释放旧令牌，迟到结果不显示成功', async () => {
    let finish!: (result: { status: 'file-copied' }) => void
    vi.mocked(api().deliverHandoffFile!).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const view = render(<SourceActions entryId={id} />)
    copy()
    await waitFor(() => expect(api().deliverHandoffFile).toHaveBeenCalled())
    view.rerender(<SourceActions entryId={'b'.repeat(64)} />)
    expect(api().discardHandoffFile).toHaveBeenCalledWith(token)
    await act(async () => finish({ status: 'file-copied' }))
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('旧 preload 明确提示更新，不降级复制文字或原生迁移', async () => {
    delete api().prepareHandoffFile
    render(<SourceActions entryId={id} />)
    copy()
    expect((await screen.findByRole('alert')).textContent).toContain('文件交接接口尚未加载')
    expect(api().continueInTarget).not.toHaveBeenCalled()
    expect(window.staithe.copy).not.toHaveBeenCalled()
  })
  it('主进程缺少新通道时给可读提示', async () => {
    vi.mocked(api().prepareHandoffFile!).mockRejectedValueOnce(new Error("Error invoking remote method 'pinekin:handoff-file-prepare': Error: No handler registered"))
    render(<SourceActions entryId={id} />); copy()
    expect((await screen.findByRole('alert')).textContent).toContain('文件交接接口尚未加载')
  })
})
