// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from '../src/renderer/src/App'
import { demoSessions } from '../src/core/demo'

afterEach(cleanup)
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  window.staithe = {
    list: vi.fn().mockResolvedValue(demoSessions),
    previewImport: vi.fn().mockResolvedValue(null),
    confirmImport: vi.fn(),
    cancelImport: vi.fn().mockResolvedValue(undefined),
    exportSession: vi.fn().mockResolvedValue(true),
    copy: vi.fn().mockResolvedValue(undefined),
    onOpenSession: vi.fn().mockReturnValue(() => {}),
  }
})
async function open() {
  render(<App />)
  await screen.findByRole('heading', { level: 2, name: demoSessions[0].title })
}
describe('档案界面', () => {
  it('搜索、来源过滤与空态都可使用', async () => {
    await open()
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: '不存在的内容' } })
    expect(screen.getByText('没有找到匹配的会话')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /^Codex\s*1$/ }))
    expect(screen.queryByRole('button', { name: new RegExp(demoSessions[0].title) })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /所有会话/ }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(demoSessions[1].title) }))
    expect(screen.getByRole('heading', { level: 2, name: demoSessions[1].title })).toBeTruthy()
  })
  it('交接面板支持目标选择、复制与两种导出；导出可取消', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: '带走这段对话' }))
    fireEvent.change(screen.getByLabelText('接续目标'), { target: { value: 'NewMax' } })
    fireEvent.click(screen.getByRole('button', { name: '复制交接文本' }))
    await waitFor(() => expect(window.staithe.copy).toHaveBeenCalledWith(expect.stringContaining('目标：NewMax')))
    fireEvent.click(screen.getByRole('button', { name: '导出 Markdown' }))
    await screen.findByText('已导出到你选择的位置')
    expect(window.staithe.exportSession).toHaveBeenCalledWith(demoSessions[0].id, 'markdown', 'NewMax')
    vi.mocked(window.staithe.exportSession).mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: '导出 Staithe 包' }))
    await screen.findByText('已取消导出')
    fireEvent.click(screen.getByRole('button', { name: '关闭交接面板' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('预览后确认才保存，报告缺失和重复，错误保留预览', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: '导入会话文件' }))
    await waitFor(() => expect(window.staithe.previewImport).toHaveBeenCalledOnce())
    const imported = { ...demoSessions[0], id: 'imported', title: '导入的档案', demo: false }
    const preview = { token: 'test-token', title: imported.title, sourceName: 'Cindy', evidence: 'fixture-tested' as const,
      messageCount: 2, byteLength: 100, sha256: 'a'.repeat(64), warnings: ['附件未映射'], duplicate: false }
    vi.mocked(window.staithe.previewImport).mockResolvedValue(preview)
    vi.mocked(window.staithe.confirmImport).mockRejectedValueOnce(new Error('保存失败'))
    fireEvent.click(screen.getByRole('button', { name: '导入会话文件' }))
    await screen.findByRole('dialog', { name: '确认导入档案' })
    expect(screen.getByText('附件未映射')).toBeTruthy()
    expect(window.staithe.confirmImport).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认保存到本地' }))
    await screen.findByText('保存失败')
    vi.mocked(window.staithe.confirmImport).mockResolvedValueOnce({ session: imported, duplicate: false })
    vi.mocked(window.staithe.list).mockResolvedValueOnce([imported, ...demoSessions])
    fireEvent.click(screen.getByRole('button', { name: '确认保存到本地' }))
    await screen.findByRole('heading', { level: 2, name: '导入的档案' })
    expect(window.staithe.confirmImport).toHaveBeenCalledWith(preview.token)
    vi.mocked(window.staithe.previewImport).mockResolvedValueOnce({ ...preview, duplicate: true })
    vi.mocked(window.staithe.confirmImport).mockResolvedValueOnce({ session: imported, duplicate: true })
    fireEvent.click(screen.getByRole('button', { name: '导入会话文件' }))
    await screen.findByText('这个文件已导入，将打开已有档案，不新增副本。')
    fireEvent.click(screen.getByRole('button', { name: '打开已有档案' }))
    await screen.findByText('已打开相同文件的已有档案，未创建副本')
    vi.mocked(window.staithe.previewImport).mockRejectedValueOnce(new Error('坏输入'))
    fireEvent.click(screen.getByRole('button', { name: '导入会话文件' }))
    await screen.findByText('坏输入')
  })
  it('取消预览和 Escape 都释放待导入内容，不写入档案', async () => {
    await open()
    vi.mocked(window.staithe.previewImport).mockResolvedValue({ token: 'token', title: '待导入', sourceName: 'Cindy',
      evidence: 'fixture-tested', messageCount: 1, byteLength: 20, sha256: 'a'.repeat(64), warnings: [], duplicate: false })
    fireEvent.click(screen.getByRole('button', { name: '导入会话文件' }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: '取消导入' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(window.staithe.cancelImport).toHaveBeenCalledWith('token')
    fireEvent.click(screen.getByRole('button', { name: '导入会话文件' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(window.staithe.confirmImport).not.toHaveBeenCalled()
  })
  it('复制本地深链并处理导出错误', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: '复制本地链接' }))
    await waitFor(() => expect(window.staithe.copy).toHaveBeenCalledWith(`newmax-staithe://session/${demoSessions[0].id}`))
    fireEvent.click(screen.getByRole('button', { name: '带走这段对话' }))
    vi.mocked(window.staithe.exportSession).mockRejectedValueOnce(new Error('无法写入'))
    fireEvent.click(screen.getByRole('button', { name: '导出 Markdown' }))
    await screen.findByText('无法写入')
  })
  it('深链切换到已存在的会话，未知 ID 给出明确提示', async () => {
    await open()
    const callback = vi.mocked(window.staithe.onOpenSession).mock.calls[0][0]
    callback(demoSessions[1].id)
    await screen.findByRole('heading', { level: 2, name: demoSessions[1].title })
    callback('unknown')
    await screen.findByText('本机没有这段会话，请先导入对应的 Staithe 包。')
  })
  it('加载失败不伪造成功状态', async () => {
    vi.mocked(window.staithe.list).mockRejectedValueOnce(new Error('档案无法读取'))
    render(<App />)
    await screen.findByText('档案无法读取')
  })
})
