// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DsSwitch } from '../src/renderer/src/components/DsSwitch'

afterEach(cleanup)
describe('DsSwitch', () => {
  it('small 尺寸由组件提供，不泄漏原生 size 属性或影响默认尺寸', () => {
    const { rerender } = render(<DsSwitch aria-label="连接测试" size="small" checked={false} onChange={vi.fn()} />)
    const control = screen.getByRole('switch')
    expect(control.classList.contains('ds-switch-small')).toBe(true)
    expect(control.hasAttribute('size')).toBe(false)
    rerender(<DsSwitch aria-label="连接测试" checked onChange={vi.fn()} />)
    expect(control.classList.contains('ds-switch-small')).toBe(false)
    expect(control.getAttribute('aria-checked')).toBe('true')
  })
  it('受控开关使用原生按钮与 switch 语义，不自行乐观更新', () => {
    const change = vi.fn()
    const { rerender } = render(<DsSwitch aria-label="连接测试" checked={false} onChange={change} />)
    const control = screen.getByRole('switch', { name: '连接测试' })
    expect(control.tagName).toBe('BUTTON')
    fireEvent.click(control)
    expect(change).toHaveBeenCalledExactlyOnceWith(true)
    expect(control.getAttribute('aria-checked')).toBe('false')
    rerender(<DsSwitch aria-label="连接测试" checked onChange={change} />)
    fireEvent.click(control)
    expect(change).toHaveBeenLastCalledWith(false)
    expect(control.getAttribute('aria-checked')).toBe('true')
  })
  it('禁用时不触发，开关与滑块使用胶囊和圆形豁免', () => {
    const change = vi.fn()
    render(<DsSwitch aria-label="连接测试" checked disabled onChange={change} />)
    const control = screen.getByRole('switch')
    fireEvent.click(control)
    expect(change).not.toHaveBeenCalled()
    expect(control.getAttribute('data-ds-pill-control')).toBe('true')
    expect(control.querySelector('[data-ds-round-control="true"]')).toBeTruthy()
  })
})
