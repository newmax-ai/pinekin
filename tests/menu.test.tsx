// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DsMenu } from '../src/renderer/src/components/DsMenu'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const menu = (open: boolean) => <DsMenu open={open} aria-label="合成菜单"><button role="menuitem">合成操作</button></DsMenu>
function animationEnd(element: HTMLElement, animationName = 'ds-dialog-exit') {
  fireEvent(element, Object.assign(new Event('animationend', { bubbles: true }), { animationName }))
}

describe('设计系统菜单的缩放淡入淡出', () => {
  it('默认关闭不挂载，打开时提供菜单语义与进场状态', () => {
    const view = render(menu(false))
    expect(screen.queryByRole('menu', { hidden: true })).toBeNull()
    view.rerender(menu(true))
    expect(screen.getByRole('menu').getAttribute('data-state')).toBe('open')
    expect(screen.getByRole('menu').classList.contains('ds-menu')).toBe(true)
    expect(screen.getByRole('menu').hasAttribute('inert')).toBe(false)
  })
  it('关闭立即禁用交互和可访问性，保留原节点直到自身退场完成', () => {
    const view = render(menu(true))
    const popup = screen.getByRole('menu')
    view.rerender(menu(false))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('menu', { hidden: true })).toBe(popup)
    expect(popup.getAttribute('data-state')).toBe('closing')
    expect(popup.hasAttribute('inert')).toBe(true)
    animationEnd(popup, 'ds-dialog-enter')
    animationEnd(popup.querySelector('button')!)
    expect(popup.isConnected).toBe(true)
    animationEnd(popup)
    expect(popup.isConnected).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('关闭动画事件丢失时兜底移除，卸载清理定时器', () => {
    const view = render(menu(true))
    view.rerender(menu(false))
    act(() => vi.advanceTimersByTime(179))
    expect(screen.getByRole('menu', { hidden: true })).toBeTruthy()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByRole('menu', { hidden: true })).toBeNull()
    view.rerender(menu(true)); view.rerender(menu(false)); view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('快速重新打开取消旧退场，不被旧动画事件或计时器移除', () => {
    const view = render(menu(true))
    const popup = screen.getByRole('menu')
    view.rerender(menu(false)); view.rerender(menu(true))
    animationEnd(popup)
    act(() => vi.advanceTimersByTime(200))
    expect(screen.getByRole('menu')).toBe(popup)
    expect(popup.getAttribute('data-state')).toBe('open')
    expect(popup.hasAttribute('inert')).toBe(false)
  })
  it('减少动态效果时关闭立即卸载，不等待动画事件', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    const view = render(menu(true))
    view.rerender(menu(false))
    expect(screen.queryByRole('menu', { hidden: true })).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('退场途中开启减少动态效果立即完成，并清理监听', () => {
    const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(media))
    const view = render(menu(true))
    view.rerender(menu(false))
    act(() => { media.matches = true; media.addEventListener.mock.calls[0][1]() })
    expect(screen.queryByRole('menu', { hidden: true })).toBeNull()
    expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })
})
