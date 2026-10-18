// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DsSelect } from '../src/renderer/src/components/DsSelect'
import { DsDialog, DsButton, DesignIcon } from '../src/renderer/src/components/ui'

const options = [{ value: 'newmax', label: 'NewMax' }, { value: 'claude-code', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]
function Controlled() {
  const [value, setValue] = useState('newmax')
  return <DsSelect aria-label="来源 App" value={value} options={options} onChange={setValue} />
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  // JSDOM 不实现 Popover API，真实 top layer 与模态键盘行为在 Electron E2E 验证。
  HTMLElement.prototype.showPopover = function () { this.style.display = 'block' }
  HTMLElement.prototype.hidePopover = function () { this.style.display = 'none' }
})

describe('DsSelect 本地适配 NewMax 选择控件', () => {
  it('复用按钮触发器与菜单项契约，不渲染原生 select，选择后关闭并归还焦点', () => {
    const { container } = render(<Controlled />)
    const trigger = screen.getByRole('combobox', { name: '来源 App' })
    expect(trigger.classList.contains('ds-select-trigger')).toBe(true)
    expect(container.querySelector('select')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(screen.getByRole('listbox').getAttribute('popover')).toBe('manual')
    expect(screen.getByRole('option', { name: 'NewMax' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('option', { name: 'Codex' }))
    expect(trigger.textContent).toBe('Codex')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
  it('方向键导航不提前提交，Enter 提交，Home / End 跳转并处理循环', () => {
    render(<Controlled />)
    const trigger = screen.getByRole('combobox')
    trigger.focus(); fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'End' })
    expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)?.textContent).toBe('Codex')
    expect(trigger.textContent).toBe('NewMax')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)?.textContent).toBe('NewMax')
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    fireEvent.keyDown(trigger, { key: 'Home' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(trigger.textContent).toBe('Claude Code')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
  it('弹窗首次聚焦 combobox，Escape 先关闭菜单而不是弹窗，关闭按钮无默认 Tooltip', () => {
    const dismiss = vi.fn()
    render(<DsDialog titleId="test-title" busy={false} onDismiss={dismiss}>
      <h2 id="test-title">连接来源</h2>
      <DsButton iconOnly aria-label="关闭连接面板"><DesignIcon name="close" /></DsButton>
      <Controlled />
    </DsDialog>)
    const trigger = screen.getByRole('combobox')
    expect(document.activeElement).toBe(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    fireEvent(trigger, event)
    expect(event.defaultPrevented).toBe(true)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(dismiss).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
  })
  it('Tab 和点击外部关闭菜单，不提交或把焦点抢回；再次点击触发器可切换关闭', () => {
    const onChange = vi.fn()
    render(<><DsSelect aria-label="App" value="newmax" options={options} onChange={onChange} /><button>外部</button></>)
    const trigger = screen.getByRole('combobox')
    fireEvent.click(trigger); fireEvent.keyDown(trigger, { key: 'Tab' })
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.click(trigger)
    const outside = screen.getByRole('button', { name: '外部' })
    outside.focus(); fireEvent.pointerDown(outside)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(outside)
    fireEvent.click(trigger); fireEvent.click(trigger)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
  it('禁用或空选项不打开，处理中变为禁用会清理已打开菜单', () => {
    const { rerender } = render(<DsSelect aria-label="App" options={options} disabled />)
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.queryByRole('listbox')).toBeNull()
    rerender(<DsSelect aria-label="App" options={[]} />)
    expect((screen.getByRole('combobox') as HTMLButtonElement).disabled).toBe(true)
    rerender(<DsSelect aria-label="App" options={options} />)
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.getByRole('listbox')).toBeTruthy()
    rerender(<DsSelect aria-label="App" options={options} disabled />)
    expect(screen.queryByRole('listbox')).toBeNull()
  })
  it('无已选值展示占位，支持键入定位及 Space 提交', () => {
    const onChange = vi.fn()
    render(<DsSelect aria-label="App" placeholder="选择 App" options={options} onChange={onChange} />)
    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toBe('选择 App')
    fireEvent.keyDown(trigger, { key: 'c' })
    expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)?.textContent).toBe('Claude Code')
    fireEvent.keyDown(trigger, { key: 'o' })
    expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)?.textContent).toBe('Codex')
    fireEvent.keyDown(trigger, { key: ' ' })
    expect(onChange).toHaveBeenCalledWith('codex')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
  it('贴近视口边缘时约束宽高并向上展开，resize 后重新定位', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'combobox'
        ? { left: 980, right: 1160, top: 740, bottom: 772, width: 180, height: 32, x: 980, y: 740, toJSON() {} }
        : { left: 0, right: 180, top: 0, bottom: 108, width: 180, height: 108, x: 0, y: 0, toJSON() {} }
    })
    render(<Controlled />)
    fireEvent.click(screen.getByRole('combobox'))
    const menu = screen.getByRole('listbox')
    expect(parseFloat(menu.style.left)).toBeLessThanOrEqual(window.innerWidth - 180 - 8)
    expect(parseFloat(menu.style.top)).toBeLessThan(740)
    fireEvent(window, new Event('resize'))
    expect(menu.style.maxHeight).not.toBe('')
  })
})
