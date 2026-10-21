// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { App } from '../src/renderer/src/App'
import { SourceActions } from '../src/renderer/src/components/SourceActions'
import { SourceReadNotice } from '../src/renderer/src/components/SourceReadNotes'
import type { SourceContent, SourceEntry } from '../src/core/sources'
import type { StaitheAPI } from '../src/core/types'

const entry: SourceEntry = { id: 'a'.repeat(64), connectionId: '11111111-1111-4111-8111-111111111111', source: 'codex', title: '合成会话', project: 'synthetic', updatedAt: '2026-10-21T00:00:00Z', availability: 'readable' }
const content: SourceContent = { session: { id: entry.id, source: entry.source, title: entry.title, updatedAt: entry.updatedAt, tags: [], demo: false, messages: [{ role: 'user', content: '合成正文' }] }, warnings: ['仅文本，不支持原生恢复', '只读访问，不保存正文副本。'] }
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  window.staithe = { platform: 'darwin', copy: vi.fn(), onOpenSession: vi.fn().mockReturnValue(() => {}), sources: {
    page: vi.fn().mockResolvedValue({ items: [entry], total: 1, offset: 0, hasMore: false, connections: [] }),
    read: vi.fn().mockResolvedValue(content), check: vi.fn().mockResolvedValue({ version: 1, connections: [], selected: entry }),
  } } as unknown as StaitheAPI
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function openSession(value = content) {
  vi.mocked(window.staithe.sources.read).mockResolvedValue(value)
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: '合成会话 synthetic' }))
  await screen.findByRole('region', { name: '会话消息' })
}
function openNotes() {
  fireEvent.click(screen.getByRole('button', { name: '更多会话操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '读取说明' }))
  return screen.getByRole('dialog', { name: '读取说明' })
}

describe('详情页读取说明按需查看', () => {
  it('读取说明复用共享高度过渡，展开与收起更新目标高度但保持原节点和焦点', () => {
    let height = 240
    let updateHeight: (() => void) | undefined
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('ds-dialog-size-content') ? height : 0
    })
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: () => void) {}
      observe(target: Element) { if (target.classList.contains('ds-dialog-size-content')) updateHeight = this.callback }
      disconnect() {}
    })
    render(<SourceReadNotice warnings={['存在非 completed 的消息完成状态。']} />)
    fireEvent.click(screen.getByRole('button', { name: '回答可能不完整，查看读取说明' }))
    const dialog = screen.getByRole('dialog', { name: '读取说明' })
    expect(dialog.getAttribute('data-animate-height')).toBe('true')
    expect(updateHeight).toBeTypeOf('function')
    expect(dialog.style.height).toBe('240px')
    const toggle = within(dialog).getByRole('button', { name: '展开原始读取说明' })
    toggle.focus()
    fireEvent.click(toggle)
    height = 560; act(() => updateHeight!())
    expect(dialog.style.height).toBe('560px')
    fireEvent.click(within(dialog).getByRole('button', { name: '收起原始读取说明' }))
    height = 240; act(() => updateHeight!())
    expect(dialog.style.height).toBe('240px')
    expect(screen.getByRole('dialog', { name: '读取说明' })).toBe(dialog)
    expect(within(dialog).getByRole('button', { name: '展开原始读取说明' })).toBe(toggle)
    expect(document.activeElement).toBe(toggle)
  })
  it('正常阅读不显示报告、说明计数或固定警告；更多菜单保留完整说明', async () => {
    await openSession()
    expect(document.querySelector('.archive-report')).toBeNull()
    expect(screen.queryByText(/读取报告|项说明/)).toBeNull()
    expect(screen.queryByText(content.warnings[0])).toBeNull()
    expect(screen.queryByRole('status', { name: '内容完整性提示' })).toBeNull()
    const dialog = openNotes()
    expect(dialog.getAttribute('data-animate-height')).toBe('true')
    expect(within(dialog).getByRole('region', { name: '读取说明内容' }).getAttribute('lang')).toBe('zh-CN')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(within(dialog).queryByRole('region', { name: '原始读取说明' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: '展开原始读取说明' }))
    const rawNotes = within(dialog).getByRole('region', { name: '原始读取说明' })
    for (const warning of content.warnings) expect(within(rawNotes).getByText(warning)).toBeTruthy()
    expect(window.staithe.sources.read).toHaveBeenCalledOnce()
    expect(window.staithe.copy).not.toHaveBeenCalled()
  })
  it('无文字消息时仍能查看说明，但复制、导出和保存不可用', async () => {
    await openSession({ ...content, session: { ...content.session, messages: [] } })
    fireEvent.click(screen.getByRole('button', { name: '更多会话操作' }))
    for (const name of ['复制会话文本', '导出 Markdown', '保存接续文件']) {
      expect((screen.getByRole('menuitem', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
    fireEvent.click(screen.getByRole('menuitem', { name: '读取说明' }))
    expect(screen.getByRole('dialog', { name: '读取说明' })).toBeTruthy()
  })
  it('读取失败仍直接显示错误，不藏进说明', async () => {
    vi.mocked(window.staithe.sources.read).mockRejectedValue(new Error('合成读取失败'))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '合成会话 synthetic' }))
    expect(await screen.findByText('合成读取失败')).toBeTruthy()
    expect((screen.getByRole('button', { name: '更多会话操作' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it.each(['关闭按钮', 'Escape'])('%s 关闭后焦点返回更多按钮', async method => {
    render(<SourceActions entryId={entry.id} content={content} />)
    await act(async () => {})
    const trigger = screen.getByRole('button', { name: '更多会话操作' })
    const dialog = openNotes()
    if (method === '关闭按钮') fireEvent.click(within(dialog).getByRole('button', { name: '关闭读取说明' }))
    else fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }))
    expect(screen.queryByRole('dialog', { name: '读取说明' })).toBeNull()
    fireEvent(dialog, Object.assign(new Event('animationend', { bubbles: true }), { animationName: 'ds-dialog-exit' }))
    await act(async () => {})
    expect(document.activeElement).toBe(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
  it.each(['切换会话', '重新读取', '内容清空'])('%s 时关闭旧说明，不把上一会话报告带到新会话', async change => {
    const view = render(<SourceActions entryId={entry.id} content={content} />)
    await act(async () => {})
    openNotes()
    view.rerender(<SourceActions entryId={change === '切换会话' ? 'b'.repeat(64) : entry.id}
      content={change === '内容清空' ? undefined : content} disabled={change === '重新读取'} />)
    expect(screen.queryByRole('dialog', { name: '读取说明' })).toBeNull()
  })
  it('说明作为纯文本显示，空说明不伪造完整读取成功', async () => {
    const warning = '<img src="file:///synthetic/private.png" onerror="alert(1)">'
    const view = render(<SourceActions entryId={entry.id} content={{ ...content, warnings: [warning] }} />)
    await act(async () => {})
    const dialog = openNotes()
    fireEvent.click(within(dialog).getByRole('button', { name: '展开原始读取说明' }))
    expect(within(dialog).getByText(warning)).toBeTruthy()
    expect(dialog.querySelector('img')).toBeNull()
    view.rerender(<SourceActions entryId={entry.id} content={{ ...content, warnings: [] }} />)
    expect(within(dialog).queryByRole('list')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: /原始读取说明/ })).toBeNull()
    expect(dialog.textContent).toContain('不等于完整原生会话恢复')
    expect(dialog.textContent).not.toContain('完整读取成功')
  })
  it.each([
    ['日志包含回退，仍按追加日志展示，不保证是当前有效分支。', '此会话含回退记录，当前文本可能包含已撤销的历史。'],
    ['日志包含回退：保留已写入消息，不计算当前有效分支；交接也会包含已撤销的历史，请先检查。', '此会话含回退记录，当前文本可能包含已撤销的历史。'],
    ['包含已回退消息；本版按导出顺序显示，不重建有效分支或执行顺序。', '此会话含回退记录，当前文本可能包含已撤销的历史。'],
    ['压缩摘要与 replacement_history 不作为新消息，不表示压缩后的完整上下文。', '此会话含上下文压缩记录，当前文本不代表完整有效上下文。'],
    ['日志包含上下文压缩：摘要和 replacement_history 不作为新消息重复导入；本档案不是压缩后的有效上下文。', '此会话含上下文压缩记录，当前文本不代表完整有效上下文。'],
    ['存在加密内容，仅显示明文和占位符，不尝试解密。', '部分内容已加密，仅展示已有明文和占位符。'],
    ['存在加密消息内容：仅显示已有明文与占位符，没有尝试解密。', '部分内容已加密，仅展示已有明文和占位符。'],
    ['消息阶段或完成状态只作原记录说明，不把部分回答当作任务完成。', '部分回答可能不完整，来源记录不足以判断是否已完整结束。'],
    ['存在非 completed 的消息完成状态；不能把显示的文本视为完整答复。', '部分回答可能不完整，来源记录不足以判断是否已完整结束。'],
    ['子会话只显示当前文件内容；继承上下文可能缺失，不读取父会话。', '仅展示此子会话自身记录，继承上下文可能缺失。'],
    ['当前父链之外的 2 个节点未加入正文或工具活动。', '仅展示当前消息链，其他分支记录未包含。'],
    ['单链未包含全部分支或尾部状态：2 个链外节点仅保留在原件；本档案不是完整对话或全部有效历史。', '仅展示当前消息链，其他分支记录未包含。'],
    ['未映射内容块：2 个。图片、音频和未知结构仅显示占位符，不联网或读取本地引用。', '部分非文本或未知格式内容未展示，完整内容请在来源中查看。'],
    ['存在未映射的用户内容对象，仅保存在快照中。', '部分非文本或未知格式内容未展示，完整内容请在来源中查看。'],
  ])('影响完整性的情况收为元信息标记，点击查看完整说明：%s', async (warning, notice) => {
    await openSession({ ...content, warnings: [...content.warnings, warning, warning] })
    const status = screen.getByRole('status', { name: '内容完整性提示' })
    expect(status.closest('.source-detail-header')).not.toBeNull()
    expect(status.classList.contains('source-update-notice')).toBe(false)
    expect(screen.queryByText(notice)).toBeNull()
    expect(status.textContent).not.toContain(content.warnings[0])
    expect(screen.queryByText(warning)).toBeNull()
    const trigger = within(status).getByRole('button')
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: '读取说明' })
    expect(within(dialog).getAllByText(notice)).toHaveLength(1)
    expect(dialog.querySelector('ul, ol, li')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: '展开原始读取说明' }))
    expect(within(dialog).getAllByText(warning)).toHaveLength(2)
  })
  it('完成状态提示使用简短标记，多类问题合并为单一入口而非报告计数', () => {
    const warnings = ['存在非 completed 的消息完成状态；不能把显示的文本视为完整答复。']
    const view = render(<SourceReadNotice warnings={warnings} />)
    expect(screen.getByRole('button', { name: '回答可能不完整，查看读取说明' })).toBeTruthy()
    view.rerender(<SourceReadNotice warnings={[...warnings, '日志包含回退，仍按追加日志展示。']} />)
    const status = screen.getByRole('status', { name: '内容完整性提示' })
    expect(within(status).getAllByRole('button')).toHaveLength(1)
    expect(within(status).getByText('有内容需留意')).toBeTruthy()
    expect(status.textContent).not.toMatch(/\d|项说明/)
    fireEvent.click(within(status).getByRole('button'))
    const dialog = screen.getByRole('dialog', { name: '读取说明' })
    expect(within(dialog).getByText('部分回答可能不完整，来源记录不足以判断是否已完整结束。')).toBeTruthy()
    expect(within(dialog).getByText('此会话含回退记录，当前文本可能包含已撤销的历史。')).toBeTruthy()
  })
  it.each(['关闭按钮', 'Escape'])('从状态标记打开说明，%s 关闭后焦点返回标记', async method => {
    render(<SourceReadNotice warnings={['存在非 completed 的消息完成状态。']} />)
    const trigger = screen.getByRole('button', { name: '回答可能不完整，查看读取说明' })
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: '读取说明' })
    if (method === '关闭按钮') fireEvent.click(within(dialog).getByRole('button', { name: '关闭读取说明' }))
    else fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }))
    expect(screen.queryByRole('dialog', { name: '读取说明' })).toBeNull()
    fireEvent(dialog, Object.assign(new Event('animationend', { bubbles: true }), { animationName: 'ds-dialog-exit' }))
    await act(async () => {})
    expect(document.activeElement).toBe(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
  it.each(['重新读取', '说明更新', '问题消失'])('%s 时不保留旧状态弹窗', change => {
    const warnings = ['存在非 completed 的消息完成状态。']
    const view = render(<SourceReadNotice warnings={warnings} />)
    fireEvent.click(screen.getByRole('button', { name: '回答可能不完整，查看读取说明' }))
    view.rerender(<SourceReadNotice warnings={change === '重新读取' ? warnings : change === '问题消失' ? [] : ['存在加密内容。']} disabled={change === '重新读取'} />)
    expect(screen.queryByRole('dialog', { name: '读取说明' })).toBeNull()
    if (change === '重新读取') expect((screen.getByRole('button', { name: '回答可能不完整，查看读取说明' }) as HTMLButtonElement).disabled).toBe(true)
    if (change === '问题消失') expect(screen.queryByRole('status', { name: '内容完整性提示' })).toBeNull()
  })
  it('读取说明按段落分层，原始解析说明默认折叠且支持反复展开收起', async () => {
    const warning = '正文直接读取来源，仅在当前窗口内存中展示；没有导入、备份或复制原件。'
    await openSession({ ...content, warnings: [warning, '存在非 completed 的消息完成状态。', '日志包含回退。'] })
    fireEvent.click(screen.getByRole('button', { name: '有内容需留意，查看读取说明' }))
    const dialog = screen.getByRole('dialog', { name: '读取说明' })
    const summary = within(dialog).getByRole('region', { name: '内容完整性说明' })
    expect(within(summary).getByRole('heading', { name: '需要留意', level: 3 })).toBeTruthy()
    expect(summary.querySelectorAll('p')).toHaveLength(2)
    expect(dialog.querySelector('ul, ol, li')).toBeNull()
    const toggle = within(dialog).getByRole('button', { name: '展开原始读取说明' })
    expect(toggle.classList.contains('ds-button')).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(within(dialog).queryByRole('region', { name: '原始读取说明' })).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const rawNotes = within(dialog).getByRole('region', { name: '原始读取说明' })
    expect(toggle.getAttribute('aria-controls')).toBe(rawNotes.id)
    expect(within(rawNotes).getByText(warning)).toBeTruthy()
    expect(rawNotes.querySelectorAll('p')).toHaveLength(3)
    fireEvent.click(within(dialog).getByRole('button', { name: '收起原始读取说明' }))
    expect(within(dialog).queryByRole('region', { name: '原始读取说明' })).toBeNull()
    expect(within(summary).getByText('部分回答可能不完整，来源记录不足以判断是否已完整结束。')).toBeTruthy()
    fireEvent.click(toggle)
    expect(within(dialog).getByRole('region', { name: '原始读取说明' }).textContent).toContain(warning)
  })
  it('常规上下文省略、工具预览上限和压缩文件说明不冒充内容缺失', async () => {
    await openSession({ ...content, warnings: [...content.warnings,
      '来源阅读视图省略系统／开发者与纯注入上下文：12 条。原记录仍在来源文件，档案导入规则未改变。',
      '来源阅读额外展示工具活动预览，最多 100 条、每条 1,024 字符；不执行历史工具。',
      '输入为 Zstandard 压缩日志；使用有界展开后的同一来源阅读投影，不保存展开副本或执行内容。',
    ] })
    expect(screen.queryByRole('status', { name: '内容完整性提示' })).toBeNull()
  })
})
