// @vitest-environment jsdom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScrollToBottom } from '../src/renderer/src/components/ScrollToBottom'

const observers: { callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
beforeEach(() => {
  observers.length = 0
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn(); disconnect = vi.fn()
    constructor(public callback: () => void) { observers.push(this) }
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function setup({ height = 300, contentHeight = 1000, top = 0 } = {}) {
  const viewport = createRef<HTMLDivElement>()
  const element = document.createElement('div')
  element.append(document.createElement('div'))
  viewport.current = element
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: height },
    scrollHeight: { configurable: true, value: contentHeight },
  })
  element.scrollTop = top
  element.scrollTo = vi.fn()
  const view = render(<ScrollToBottom viewport={viewport} contentKey="first" />)
  return { ...view, viewport, element }
}

describe('对话详情滚动到底部', () => {
  it('悬停时在按钮上方显示提示，点击后收起提示并滚动', () => {
    vi.useFakeTimers()
    try {
      const { element } = setup()
      const button = screen.getByRole('button', { name: '滚动到底部' })
      vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ left: 300, right: 336, top: 500, bottom: 536, width: 36, height: 36 } as DOMRect)
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(32)
      fireEvent.mouseEnter(button)
      act(() => vi.advanceTimersByTime(150))
      const tooltip = screen.getByRole('tooltip')
      expect(tooltip.textContent).toBe('滚动到底部')
      expect(tooltip.getAttribute('data-side')).toBe('top')
      expect(tooltip.style.top).toBe('464px')
      expect(button.getAttribute('aria-describedby')).toBe(tooltip.id)
      fireEvent.click(button)
      expect(screen.queryByRole('tooltip')).toBeNull()
      expect(element.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 700, behavior: 'smooth' })
    } finally { vi.useRealTimers() }
  })

  it('有未读到底的内容时显示向下按钮，只平滑滚动消息视口', () => {
    const { element } = setup()
    const button = screen.getByRole('button', { name: '滚动到底部' })
    expect(button.querySelector('svg')).not.toBeNull()
    expect(button.classList.contains('scroll-to-bottom')).toBe(true)
    fireEvent.click(button)
    expect(element.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 700, behavior: 'smooth' })
    expect(element.scrollTop).toBe(0)
  })

  it.each([
    { height: 300, contentHeight: 100_000, start: 99_400, end: 99_700 },
    { height: 1200, contentHeight: 100_000, start: 98_200, end: 98_800 },
    { height: 300, contentHeight: 1201, start: 601, end: 901 },
  ])('长对话先定位到末段，再仅平滑滚动最后一屏且不超过 600 px：$height/$contentHeight', ({ height, contentHeight, start, end }) => {
    const { element } = setup({ height, contentHeight })
    fireEvent.click(screen.getByRole('button', { name: '滚动到底部' }))
    expect(element.scrollTo).toHaveBeenCalledTimes(2)
    expect(element.scrollTo).toHaveBeenNthCalledWith(1, { top: start, behavior: 'instant' })
    expect(element.scrollTo).toHaveBeenNthCalledWith(2, { top: end, behavior: 'smooth' })
  })

  it.each([
    { height: 300, contentHeight: 1200, top: 0 },
    { height: 1200, contentHeight: 2400, top: 0 },
    { height: 300, contentHeight: 100_000, top: 99_200 },
  ])('按剩余距离判断，三屏或 1200 px 以内不跳跃：$height/$contentHeight/$top', ({ height, contentHeight, top }) => {
    const { element } = setup({ height, contentHeight, top })
    fireEvent.click(screen.getByRole('button', { name: '滚动到底部' }))
    expect(element.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: contentHeight - height, behavior: 'smooth' })
  })

  it('长对话在减少动态效果模式下直接到底，不播放末段动画', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    const { element } = setup({ contentHeight: 100_000 })
    fireEvent.click(screen.getByRole('button', { name: '滚动到底部' }))
    expect(element.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 99_700, behavior: 'instant' })
  })

  it('长对话缺少 scrollTo 时仍能直接到底并隐藏按钮', () => {
    const { element } = setup({ contentHeight: 100_000 })
    Object.defineProperty(element, 'scrollTo', { value: undefined })
    fireEvent.click(screen.getByRole('button', { name: '滚动到底部' }))
    expect(element.scrollTop).toBe(99_700)
    expect(screen.queryByRole('button', { name: '滚动到底部' })).toBeNull()
  })

  it.each([0, 3, 4])('距离底部 %s px 时隐藏，向上滚动后重新显示', distance => {
    const { element } = setup({ top: 700 - distance })
    expect(screen.queryByRole('button', { name: '滚动到底部' })).toBeNull()
    element.scrollTop = 500
    fireEvent.scroll(element)
    expect(screen.getByRole('button', { name: '滚动到底部' })).toBeTruthy()
    element.scrollTop = 700
    fireEvent.scroll(element)
    expect(screen.queryByRole('button', { name: '滚动到底部' })).toBeNull()
  })

  it.each([0, 200, 300])('内容高度 %s px 未超过视口时不显示', contentHeight => {
    setup({ contentHeight })
    expect(screen.queryByRole('button', { name: '滚动到底部' })).toBeNull()
  })

  it('隐藏或未挂载的视口不显示按钮', () => {
    const view = setup({ height: 0 })
    expect(screen.queryByRole('button', { name: '滚动到底部' })).toBeNull()
    view.viewport.current = null
    view.rerender(<ScrollToBottom viewport={view.viewport} contentKey="missing" />)
    expect(screen.queryByRole('button', { name: '滚动到底部' })).toBeNull()
  })

  it('尊重减少动态效果设置，点击时读取最新内容高度', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    const { element } = setup()
    Object.defineProperty(element, 'scrollHeight', { value: 1400 })
    fireEvent.click(screen.getByRole('button', { name: '滚动到底部' }))
    expect(element.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1100, behavior: 'instant' })
  })

  it('窗口和正文尺寸变化时更新，不改变原阅读位置', () => {
    const { element } = setup({ contentHeight: 200, top: 40 })
    expect(observers[0].observe).toHaveBeenCalledWith(element)
    expect(observers[0].observe).toHaveBeenCalledWith(element.firstElementChild)
    Object.defineProperty(element, 'scrollHeight', { value: 1000 })
    act(() => observers[0].callback())
    expect(screen.getByRole('button', { name: '滚动到底部' })).toBeTruthy()
    Object.defineProperty(element, 'clientHeight', { value: 1200 })
    fireEvent(window, new Event('resize'))
    expect(screen.queryByRole('button', { name: '滚动到底部' })).toBeNull()
    expect(element.scrollTop).toBe(40)
    expect(element.scrollTo).not.toHaveBeenCalled()
  })

  it('切换正文后重新绑定观察器，卸载时释放监听', () => {
    const { element, viewport, rerender, unmount } = setup()
    const remove = vi.spyOn(element, 'removeEventListener')
    Object.defineProperty(element, 'scrollHeight', { value: 200 })
    rerender(<ScrollToBottom viewport={viewport} contentKey="second" />)
    expect(screen.queryByRole('button', { name: '滚动到底部' })).toBeNull()
    expect(observers[0].disconnect).toHaveBeenCalledOnce()
    unmount()
    expect(observers[1].disconnect).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function))
  })

  it('缺少 ResizeObserver 或 scrollTo 时仍可使用原生滚动', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const { element } = setup()
    Object.defineProperty(element, 'scrollTo', { value: undefined })
    fireEvent.click(screen.getByRole('button', { name: '滚动到底部' }))
    expect(element.scrollTop).toBe(700)
    expect(screen.queryByRole('button', { name: '滚动到底部' })).toBeNull()
  })
})
