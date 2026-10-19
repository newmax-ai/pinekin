// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SourceProjectList } from '../src/renderer/src/components/SourceProjectList'
import type { SourceActionsAPI } from '../src/core/source-actions'
import { buildScrollMask } from '../src/renderer/src/components/ScrollArea'
import { readFileSync } from 'node:fs'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('项目视口复用设计系统 mask，滚动到边界与搜索后移除不需要的渐隐', async () => {
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const flush = () => act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)) })
  // jsdom 不接受多色标双端梯度，保留组件写入的原始 CSS 值进行比较。
  const masks = new WeakMap<CSSStyleDeclaration, string>()
  const declaration = Object.getPrototypeOf(document.createElement('div').style) as CSSStyleDeclaration
  vi.spyOn(declaration, 'maskImage', 'get').mockImplementation(function (this: CSSStyleDeclaration) { return masks.get(this) ?? '' })
  vi.spyOn(declaration, 'maskImage', 'set').mockImplementation(function (this: CSSStyleDeclaration, value: string) { masks.set(this, value) })
  for (const [name, value] of Object.entries({ clientWidth: 400, scrollWidth: 400, clientHeight: 240 })) {
    vi.spyOn(HTMLElement.prototype, name as 'clientWidth', 'get').mockReturnValue(value)
  }
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.children.length * 80 })
  const s = setup(Array.from({ length: 6 }, (_, i) => ({ id: String(i), name: `项目${i}`, path: `/root/${i}`, reason: undefined })))
  render(<SourceProjectList {...s.props} />)
  const first = await screen.findByRole('button', { name: '在 项目0 继续：/root/0' })
  const viewport = first.parentElement!
  expect(viewport.classList.contains('ds-scroll-area')).toBe(true)
  expect(viewport.classList.contains('source-project-list')).toBe(true)
  flush()
  expect(viewport.style.maskImage).toBe(buildScrollMask('to bottom', false, true))
  viewport.scrollTop = 100; fireEvent.scroll(viewport); flush()
  expect(viewport.style.maskImage).toBe(buildScrollMask('to bottom', true, true))
  viewport.scrollTop = 240; fireEvent.scroll(viewport); flush()
  expect(viewport.style.maskImage).toBe(buildScrollMask('to bottom', true, false))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '/root/4' } }); flush()
  expect(viewport.style.maskImage).toBe('none')
  expect(screen.getByRole('button', { name: '刷新项目列表' }).closest('.ds-scroll-area')).toBeNull()
  expect(screen.getByRole('searchbox').closest('.ds-scroll-area')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '在 项目4 继续：/root/4' }))
  expect(s.onChoose).toHaveBeenCalledExactlyOnceWith('4')
})

it('接续弹窗操作组右对齐，窄窗口允许换行，设置页脚沿用设计系统对齐', () => {
  const styles = readFileSync('src/renderer/src/components/SourceActions.css', 'utf8')
  const options = /\.source-target-options\s*\{([^}]*)\}/.exec(styles)![1]
  expect(options).toContain('justify-content: flex-end;')
  expect(options).toContain('flex-wrap: wrap;')
  const shared = readFileSync('src/renderer/src/styles.css', 'utf8')
  expect(/\.dialog-footer\s*\{([^}]*)\}/.exec(shared)![1]).toContain('justify-content: flex-end;')
})
function setup(projects = [{ id: 'a', name: '已有项目', path: '/a', reason: undefined as string | undefined }]) {
  const list = vi.fn().mockResolvedValue({ projects }), onChoose = vi.fn()
  const props = { entryId: 'a'.repeat(64), api: { listCodexProjects: list } as unknown as SourceActionsAPI, disabled: false, isActive: () => true, onChoose }
  return { list, onChoose, props }
}
it('不可精确归属的项目仍显示原因，不可点击；正常项目回传列表 ID', async () => {
  const s = setup([{ id: 'a', name: '多根项目', path: '/a', reason: '包含多个目录' }, { id: 'b', name: '正常项目', path: '/b', reason: undefined }])
  render(<SourceProjectList {...s.props} />)
  const disabled = await screen.findByRole('button', { name: '在 多根项目 继续：/a' })
  expect((disabled as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('包含多个目录')).toBeTruthy()
  fireEvent.click(disabled); expect(s.onChoose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '在 正常项目 继续：/b' }))
  expect(s.onChoose).toHaveBeenCalledExactlyOnceWith('b')
})
it('较多项目可按名称或路径搜索；刷新重置旧过滤，不留下无法清除的隐藏搜索', async () => {
  const s = setup(Array.from({ length: 6 }, (_, i) => ({ id: String(i), name: `项目${i}`, path: `/root/${i}`, reason: undefined })))
  render(<SourceProjectList {...s.props} />)
  const search = await screen.findByRole('searchbox', { name: '搜索已有项目' })
  fireEvent.change(search, { target: { value: '/root/4' } })
  expect(screen.getByRole('button', { name: '在 项目4 继续：/root/4' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '在 项目0 继续：/root/0' })).toBeNull()
  fireEvent.change(search, { target: { value: '没有这个项目' } })
  expect(screen.getByText('没有匹配的项目')).toBeTruthy()
  s.list.mockResolvedValueOnce({ projects: [{ id: 'new', name: '新增项目', path: '/new', reason: undefined }] })
  fireEvent.click(screen.getByRole('button', { name: '刷新项目列表' }))
  expect(await screen.findByRole('button', { name: '在 新增项目 继续：/new' })).toBeTruthy()
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(s.list).toHaveBeenCalledTimes(2)
})
it('旧主进程无列表 handler 显示明确提示，去掉 IPC 包装', async () => {
  const s = setup(); s.list.mockRejectedValueOnce(new Error("Error invoking remote method 'pinekin:source-actions-list-codex-projects': Error: No handler registered"))
  render(<SourceProjectList {...s.props} />)
  expect((await screen.findByRole('note')).textContent).toContain('项目列表接口已更新')
  expect(screen.queryByText(/Error invoking/)).toBeNull()
})
it('读取失败可以刷新恢复，卸载后的迟到失败不更新已关闭面板', async () => {
  const s = setup(); let fail!: (error: Error) => void
  s.list.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject }))
  const view = render(<SourceProjectList {...s.props} />)
  expect(screen.getByRole('status').textContent).toContain('正在读取')
  view.unmount()
  await act(async () => fail(new Error('迟到失败')))
  expect(screen.queryByText('迟到失败')).toBeNull()
})
