// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SourceUpdatePill } from '../src/renderer/src/components/SourceUpdatePill'

const actions = { onRead: vi.fn(), onJump: vi.fn() }
const finish = (element: HTMLElement, name = 'source-update-exit') => fireEvent(element, Object.assign(new Event('animationend', { bubbles: true }), { animationName: name }))
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('同一个正文更新胶囊', () => {
  it('无状态时不显示，不创建退场计时器', () => {
    const view = render(<SourceUpdatePill {...actions} />)
    expect(view.container.firstChild).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('更新、读取、跳转复用原按钮和浮层，测量文字宽度用于平滑过渡，读取时禁止操作', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('source-update-label') ? this.textContent === '读取中…' ? 52 : 78 : 0
    })
    const view = render(<SourceUpdatePill {...actions} state="updated" />)
    const button = screen.getByRole('button', { name: '查看更新' })
    const overlay = button.closest('.source-content-update')!
    const labels = button.querySelector<HTMLElement>('.source-update-labels')!
    expect(button.textContent).toBe('此对话有更新')
    expect(labels.style.width).toBe('78px')
    fireEvent.click(button)
    expect(actions.onRead).toHaveBeenCalledOnce()
    view.rerender(<SourceUpdatePill {...actions} state="reading" />)
    expect(screen.getByRole('button', { name: '查看更新' })).toBe(button)
    expect(button.textContent).toBe('读取中…')
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(labels.style.width).toBe('52px')
    fireEvent.click(button)
    expect(actions.onRead).toHaveBeenCalledOnce()
    view.rerender(<SourceUpdatePill {...actions} state="jump" />)
    expect(screen.getByRole('button', { name: '跳到新增消息' })).toBe(button)
    expect(button.closest('.source-content-update')).toBe(overlay)
    expect(button.textContent).toBe('跳到新增消息')
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(labels.style.width).toBe('78px')
    expect(button.querySelector('svg')).toBeNull()
    fireEvent.click(button)
    expect(actions.onJump).toHaveBeenCalledOnce()
    expect(actions.onRead).toHaveBeenCalledOnce()
  })
  it('读取失败可以回到更新态，尚未跳转又收到更新时仍复用同一个按钮', () => {
    const view = render(<SourceUpdatePill {...actions} state="reading" />)
    const button = screen.getByRole('button')
    for (const state of ['updated', 'jump', 'updated'] as const) {
      view.rerender(<SourceUpdatePill {...actions} state={state} />)
      expect(screen.getByRole('button')).toBe(button)
    }
    expect(button.textContent).toBe('此对话有更新')
    expect(button.hasAttribute('disabled')).toBe(false)
  })
  it('跳到新增消息没有自动收起计时器，保持可点击直到用户处理', () => {
    const view = render(<SourceUpdatePill {...actions} state="jump" />)
    const button = screen.getByRole('button', { name: '跳到新增消息' })
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByRole('button', { name: '跳到新增消息' })).toBe(button)
    expect(actions.onRead).not.toHaveBeenCalled()
    expect(actions.onJump).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    view.unmount()
  })
  it('关闭立即退出交互与辅助技术树，保留原节点退场，只有自身退出动画结束才移除', () => {
    const view = render(<SourceUpdatePill {...actions} state="jump" />)
    const overlay = screen.getByRole('status')
    const button = screen.getByRole('button')
    view.rerender(<SourceUpdatePill {...actions} />)
    expect(view.container.firstChild).toBe(overlay)
    expect(overlay.getAttribute('data-state')).toBe('closing')
    expect(overlay.hasAttribute('inert')).toBe(true)
    expect(screen.queryByRole('button')).toBeNull()
    fireEvent.click(button)
    expect(actions.onJump).not.toHaveBeenCalled()
    finish(button)
    finish(overlay, 'source-update-enter')
    expect(view.container.firstChild).toBe(overlay)
    finish(overlay)
    expect(view.container.firstChild).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['updated', 'jump'] as const)('退场期间重新进入 %s，取消旧卸载任务并继续复用按钮', state => {
    const view = render(<SourceUpdatePill {...actions} state="jump" />)
    const button = screen.getByRole('button')
    view.rerender(<SourceUpdatePill {...actions} />)
    view.rerender(<SourceUpdatePill {...actions} state={state} />)
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByRole('button')).toBe(button)
    expect(button.closest('.source-content-update')?.getAttribute('data-state')).toBe('open')
    finish(button.closest('.source-content-update')!)
    expect(screen.getByRole('button')).toBe(button)
  })
  it('遗漏退场事件仍能兜底移除，卸载时清理计时器', () => {
    const view = render(<SourceUpdatePill {...actions} state="updated" />)
    view.rerender(<SourceUpdatePill {...actions} />)
    act(() => vi.advanceTimersByTime(180))
    expect(view.container.firstChild).toBeNull()
    view.rerender(<SourceUpdatePill {...actions} state="jump" />)
    view.rerender(<SourceUpdatePill {...actions} />)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([false, true])('减少动态效果在关闭前或退场中启用时立即移除：%s', reduced => {
    const media = Object.assign(new EventTarget(), { matches: reduced })
    vi.stubGlobal('matchMedia', vi.fn(() => media))
    const view = render(<SourceUpdatePill {...actions} state="jump" />)
    view.rerender(<SourceUpdatePill {...actions} />)
    if (!reduced) {
      expect(view.container.firstChild).not.toBeNull()
      media.matches = true
      act(() => media.dispatchEvent(new Event('change')))
    }
    expect(view.container.firstChild).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('字体尺寸变化重新测量标签，状态切换与卸载时断开旧观察器', () => {
    let resized!: ResizeObserverCallback
    let width = 70
    const observe = vi.fn(), disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resized = callback }
      observe = observe
      disconnect = disconnect
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => width)
    const view = render(<SourceUpdatePill {...actions} state="updated" />)
    const labels = view.container.querySelector<HTMLElement>('.source-update-labels')!
    expect(labels.style.width).toBe('70px')
    width = 80
    act(() => resized([], {} as ResizeObserver))
    expect(labels.style.width).toBe('80px')
    view.rerender(<SourceUpdatePill {...actions} state="reading" />)
    expect(disconnect).toHaveBeenCalledOnce()
    expect(observe).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(disconnect).toHaveBeenCalledTimes(2)
  })
})
