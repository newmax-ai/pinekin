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
    importBundle: vi.fn().mockResolvedValue(null),
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
  it('导入成功刷新列表，取消不改变，错误显示提示', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: '导入 Staithe 包' }))
    await waitFor(() => expect(window.staithe.importBundle).toHaveBeenCalledOnce())
    const imported = { ...demoSessions[0], id: 'imported', title: '导入的档案', demo: false }
    vi.mocked(window.staithe.importBundle).mockResolvedValueOnce(imported)
    vi.mocked(window.staithe.list).mockResolvedValueOnce([imported, ...demoSessions])
    fireEvent.click(screen.getByRole('button', { name: '导入 Staithe 包' }))
    await screen.findByRole('heading', { level: 2, name: '导入的档案' })
    vi.mocked(window.staithe.importBundle).mockRejectedValueOnce(new Error('坏输入'))
    fireEvent.click(screen.getByRole('button', { name: '导入 Staithe 包' }))
    await screen.findByText('坏输入')
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
