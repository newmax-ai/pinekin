// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FadeText } from '../src/renderer/src/components/FadeText'

let callback: () => void
const disconnect = vi.fn()
let available = 100, content = 160, availableHeight = 39, contentHeight = 78
beforeEach(() => {
  available = 100; content = 160; availableHeight = 39; contentHeight = 78
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => available)
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => content)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => availableHeight)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight)
  vi.stubGlobal('ResizeObserver', class {
    constructor(update: () => void) { callback = update }
    observe() {}
    disconnect = disconnect
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); disconnect.mockClear() })

describe('会话标题两行渐隐', () => {
  it('保留 h3、完整标题和文本，仅超过两行时标记截断，不添加省略号', () => {
    content = available
    const title = '合成任务标题 file:///synthetic/workspace/a-very-long-conversation-title'
    const view = render(<FadeText text={title} as="h3" lines={2} />)
    const heading = view.getByRole('heading', { level: 3, name: title })
    expect(heading.textContent).toBe(title)
    expect(heading.getAttribute('title')).toBe(title)
    expect(heading.getAttribute('data-lines')).toBe('2')
    expect(heading.getAttribute('data-overflow')).toBe('true')
    expect(heading.textContent).not.toContain('…')
  })
  it('会话栏调宽后取消渐隐、变窄后恢复，完整两行和单行不遮罩', () => {
    content = available
    const view = render(<FadeText text="合成多行会话标题" as="h3" lines={2} />)
    const heading = view.getByRole('heading', { level: 3 })
    expect(heading.getAttribute('data-overflow')).toBe('true')
    available = content = 360; contentHeight = availableHeight
    act(() => callback())
    expect(heading.getAttribute('data-overflow')).toBe('false')
    available = content = 240; contentHeight = 78
    act(() => window.dispatchEvent(new Event('resize')))
    expect(heading.getAttribute('data-overflow')).toBe('true')
    contentHeight = 20
    view.rerender(<FadeText text="短标题" as="h3" lines={2} />)
    expect(heading.getAttribute('data-overflow')).toBe('false')
  })
  it('隐藏多行文字不启用遮罩，无 ResizeObserver 时窗口 resize 仍重测', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    availableHeight = 0
    const view = render(<FadeText text="暂时隐藏的合成标题" as="h3" lines={2} />)
    const heading = view.getByRole('heading', { level: 3 })
    expect(heading.getAttribute('data-overflow')).toBe('false')
    availableHeight = 39
    act(() => window.dispatchEvent(new Event('resize')))
    expect(heading.getAttribute('data-overflow')).toBe('true')
    available = 0
    act(() => window.dispatchEvent(new Event('resize')))
    expect(heading.getAttribute('data-overflow')).toBe('false')
  })
  it('相同文本切换单行／两行时重新测量，卸载后的回调不再修改节点', () => {
    content = available
    const view = render(<FadeText text="合成标题" />)
    expect(view.container.firstElementChild?.getAttribute('data-overflow')).toBe('false')
    view.rerender(<FadeText text="合成标题" as="h3" lines={2} />)
    const heading = view.getByRole('heading', { level: 3 })
    expect(heading.getAttribute('data-overflow')).toBe('true')
    view.unmount()
    contentHeight = 20
    act(() => callback())
    expect(heading.getAttribute('data-overflow')).toBe('true')
  })
})

describe('NewMax 单行文字渐隐适配', () => {
  it('仅溢出时启用 mask，宽度变化后恢复，完整文本保留为 title', () => {
    const view = render(<FadeText text="DeepSeek Harness" />)
    const text = view.container.querySelector('.ds-fade-text')!
    expect(text.textContent).toBe('DeepSeek Harness')
    expect(text.getAttribute('title')).toBe('DeepSeek Harness')
    expect(text.getAttribute('data-overflow')).toBe('true')
    available = 200
    act(() => callback())
    expect(text.getAttribute('data-overflow')).toBe('false')
    view.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  })
  it('容器不变但名称变短也重新测量', () => {
    const view = render(<FadeText text="很长的客户端名称" />)
    content = 40
    view.rerender(<FadeText text="短名" />)
    expect(view.container.firstElementChild?.getAttribute('data-overflow')).toBe('false')
    expect(view.container.firstElementChild?.getAttribute('title')).toBe('短名')
  })
  it('隐藏时不错误启用渐隐，缺少 ResizeObserver 时仍可渲染', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    available = 0
    const view = render(<FadeText text="DeepSeek Harness" />)
    expect(view.container.firstElementChild?.getAttribute('data-overflow')).toBe('false')
  })
})
