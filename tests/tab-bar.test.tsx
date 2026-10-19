// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { DsTabBar } from '../src/renderer/src/components/DsTabBar'

const items = [{ value: 'domestic', label: '国内' }, { value: 'disabled', label: '不可用', disabled: true }, { value: 'international', label: '国际' }]
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function mount() {
  const changed = vi.fn()
  function Harness() {
    const [value, setValue] = useState('domestic')
    return <DsTabBar id="regions" items={items} value={value} panelId="region-panel" aria-label="来源地区" onChange={next => { changed(next); setValue(next) }} />
  }
  const view = render(<Harness />)
  return { ...view, changed }
}

describe('本地 NewMax DsTabBar 适配', () => {
  it('保留胶囊结构、受控选中语义和单一 Tab 键入口', () => {
    const { changed } = mount()
    const domestic = screen.getByRole('tab', { name: '国内' }), international = screen.getByRole('tab', { name: '国际' })
    expect(screen.getByRole('tablist', { name: '来源地区' }).getAttribute('data-ds-pill-control')).toBe('true')
    expect(domestic.getAttribute('aria-selected')).toBe('true')
    expect(domestic.getAttribute('aria-controls')).toBe('region-panel')
    expect(domestic.id).toBe('regions-domestic')
    expect(domestic.tabIndex).toBe(0)
    expect(international.tabIndex).toBe(-1)
    fireEvent.click(screen.getByRole('tab', { name: '不可用' }))
    expect(changed).not.toHaveBeenCalled()
    fireEvent.click(international)
    expect(changed).toHaveBeenCalledExactlyOnceWith('international')
    expect(international.getAttribute('aria-selected')).toBe('true')
    expect(international.tabIndex).toBe(0)
    expect(domestic.tabIndex).toBe(-1)
  })
  it('左右键循环切换并略过禁用项，Home/End 移到首尾，不截获其他按键', () => {
    const { changed } = mount()
    const domestic = screen.getByRole('tab', { name: '国内' }), international = screen.getByRole('tab', { name: '国际' })
    domestic.focus()
    fireEvent.keyDown(domestic, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(international)
    fireEvent.keyDown(international, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(domestic)
    fireEvent.keyDown(domestic, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(international)
    fireEvent.keyDown(international, { key: 'Home' })
    expect(document.activeElement).toBe(domestic)
    fireEvent.keyDown(domestic, { key: 'End' })
    expect(document.activeElement).toBe(international)
    fireEvent.keyDown(international, { key: 'Tab' })
    expect(changed).toHaveBeenCalledTimes(5)
  })
  it('选中底板随标签滑动，尺寸改变立即对齐并清理 observer', () => {
    let resize!: ResizeObserverCallback
    const disconnect = vi.fn(), observe = vi.fn()
    vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { resize = callback } observe = observe; disconnect = disconnect })
    let width = 48
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) { return this.textContent === '国际' ? 99 : 3 })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => width)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(26)
    const { unmount } = mount()
    const indicator = document.querySelector<HTMLElement>('.ds-tab-bar-indicator')!
    expect(indicator.style.left).toBe('3px')
    expect(indicator.style.width).toBe('48px')
    expect(indicator.getAttribute('data-animated')).toBe('false')
    fireEvent.click(screen.getByRole('tab', { name: '国际' }))
    expect(indicator.style.left).toBe('99px')
    expect(indicator.getAttribute('data-animated')).toBe('true')
    act(() => resize([], {} as ResizeObserver))
    expect(indicator.getAttribute('data-animated')).toBe('true')
    width = 60
    act(() => resize([], {} as ResizeObserver))
    expect(indicator.style.width).toBe('60px')
    expect(indicator.getAttribute('data-animated')).toBe('false')
    expect(observe).toHaveBeenCalled()
    unmount()
    expect(disconnect).toHaveBeenCalled()
  })
  it('弹窗首次隐藏时尺寸为零，显示后的首次观察立即恢复选中底板', () => {
    let resize!: ResizeObserverCallback
    vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { resize = callback } observe() {} disconnect() {} })
    let width = 0
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => width)
    mount()
    const indicator = document.querySelector<HTMLElement>('.ds-tab-bar-indicator')!
    expect(indicator.style.width).toBe('0px')
    width = 48
    act(() => resize([], {} as ResizeObserver))
    expect(indicator.style.width).toBe('48px')
    expect(indicator.getAttribute('data-animated')).toBe('false')
  })
  it('默认高度 32px、内边距 3px，遵循主题和减少动画设置', () => {
    const css = readFileSync('src/renderer/src/components/DsTabBar.css', 'utf8')
    expect(css).toMatch(/\.ds-tab-bar\s*\{[^}]*height: 32px;[^}]*padding: 3px;/)
    expect(css).toContain('var(--ds-on-surface)')
    expect(css).toContain('var(--ds-surface-100)')
    expect(css).toContain('var(--ds-elevation-100)')
    expect(css).toContain('var(--ds-radius-pill)')
    expect(css).toContain('prefers-reduced-motion: reduce')
  })
})
