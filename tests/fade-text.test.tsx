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

describe('详情标题悬停慢滚', () => {
  it('显式开启后仅溢出标题可聚焦，距离包含尾部遮罩宽度，速度按内容长度计算', () => {
    const title = '只读任务，禁止编辑或创建任何文件。仓库：/synthetic/workspace'
    const view = render(<FadeText as="h2" text={title} scrollOnHover />)
    const heading = view.getByRole('heading', { level: 2, name: title })
    expect(heading.getAttribute('data-scroll-on-hover')).toBe('true')
    expect(heading.getAttribute('tabindex')).toBe('0')
    expect(heading.style.getPropertyValue('--fade-scroll-distance')).toBe('76px')
    expect(heading.style.getPropertyValue('--fade-scroll-duration')).toBe('1.583s')
    expect(heading.querySelector('.ds-fade-text-content')?.textContent).toBe(title)
    expect(heading.textContent).toBe(title)
    expect(heading.getAttribute('title')).toBe(title)
    heading.style.setProperty('--fade-overflow-width', '32px'); act(() => callback())
    expect(heading.style.getPropertyValue('--fade-scroll-distance')).toBe('92px')
    expect(heading.style.getPropertyValue('--fade-scroll-duration')).toBe('1.917s')
  })
  it('使用内层自然文字宽度，外层已被移动的 scrollWidth 不影响滚动范围', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('ds-fade-text-content') ? 600 : 100
    })
    const view = render(<FadeText as="h2" text="合成超长标题" scrollOnHover />)
    const heading = view.getByRole('heading', { level: 2 })
    expect(heading.getAttribute('data-overflow')).toBe('true')
    expect(heading.style.getPropertyValue('--fade-scroll-distance')).toBe('516px')
    expect(heading.style.getPropertyValue('--fade-scroll-duration')).toBe('10.750s')
  })
  it('窗口变宽、隐藏或标题变短后移除滚动距离和键盘停靠，更新标题重建文字轨道', () => {
    const view = render(<FadeText as="h2" text="合成长标题" scrollOnHover />)
    const heading = view.getByRole('heading', { level: 2 })
    const track = heading.firstElementChild
    available = 200; act(() => callback())
    expect(heading.getAttribute('data-overflow')).toBe('false')
    expect(heading.getAttribute('tabindex')).toBeNull()
    expect(heading.style.getPropertyValue('--fade-scroll-distance')).toBe('')
    available = 0; act(() => callback())
    expect(heading.style.getPropertyValue('--fade-scroll-duration')).toBe('')
    available = 100; content = 101; act(() => callback())
    expect(heading.style.getPropertyValue('--fade-scroll-duration')).toBe('1.000s')
    content = 40; view.rerender(<FadeText as="h2" text="短标题" scrollOnHover />)
    expect(heading.firstElementChild).not.toBe(track)
    expect(heading.getAttribute('data-overflow')).toBe('false')
    expect(heading.style.getPropertyValue('--fade-scroll-distance')).toBe('')
    expect(heading.getAttribute('tabindex')).toBeNull()
  })
  it('导航名称默认不滚动，双行卡片即使传入开关也不启用横向移动', () => {
    const view = render(<FadeText text="很长的导航名称" />)
    expect(view.container.querySelector('[data-scroll-on-hover], .ds-fade-text-content')).toBeNull()
    view.rerender(<FadeText as="h2" text="合成详情标题" scrollOnHover />)
    const heading = view.getByRole('heading', { level: 2 })
    expect(heading.getAttribute('tabindex')).toBe('0')
    view.rerender(<FadeText as="h2" text="合成详情标题" />)
    expect(heading.getAttribute('data-scroll-on-hover')).toBeNull()
    expect(heading.style.getPropertyValue('--fade-scroll-distance')).toBe('')
    expect(heading.getAttribute('tabindex')).toBeNull()
    view.rerender(<FadeText as="h3" text="合成双行标题" lines={2} scrollOnHover />)
    expect(view.container.querySelector('[data-scroll-on-hover], .ds-fade-text-content')).toBeNull()
  })
  it('卸载后迟到的尺寸通知不能修改滚动目标', () => {
    const view = render(<FadeText as="h2" text="合成详情标题" scrollOnHover />)
    const heading = view.getByRole('heading', { level: 2 })
    view.unmount(); content = 600; act(() => callback())
    expect(heading.style.getPropertyValue('--fade-scroll-distance')).toBe('76px')
    expect(disconnect).toHaveBeenCalledOnce()
  })
})

describe('NewMax 单行文字渐隐适配', () => {
  it('详情 h2 保留完整标题与可访问名称，单行溢出才渐隐，变宽或标题变短后取消', () => {
    const title = 'Check my relevant connected apps and create a to-do checklist. Automatically update the list.'
    const view = render(<FadeText as="h2" text={title} />)
    const heading = view.getByRole('heading', { level: 2, name: title })
    expect(heading.textContent).toBe(title)
    expect(heading.getAttribute('title')).toBe(title)
    expect(heading.getAttribute('data-lines')).toBeNull()
    expect(heading.getAttribute('data-overflow')).toBe('true')
    available = content + 1; act(() => callback())
    expect(heading.getAttribute('data-overflow')).toBe('false')
    available = 100; act(() => callback())
    expect(heading.getAttribute('data-overflow')).toBe('true')
    content = 40; view.rerender(<FadeText as="h2" text="短标题" />)
    expect(view.getByRole('heading', { level: 2, name: '短标题' })).toBe(heading)
    expect(heading.getAttribute('data-overflow')).toBe('false')
  })
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
