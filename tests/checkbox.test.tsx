// @vitest-environment jsdom
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DsCheckbox } from '../src/renderer/src/components/DsCheckbox'

afterEach(cleanup)
describe('NewMax DsCheckbox 本地适配', () => {
  it('使用原生 button 的 checkbox 语义与正圆标记，不渲染系统 checkbox input', () => {
    render(<DsCheckbox aria-label="选择来源" />)
    const checkbox = screen.getByRole('checkbox', { name: '选择来源' })
    expect(checkbox.tagName).toBe('BUTTON')
    expect(checkbox.getAttribute('type')).toBe('button')
    expect(checkbox.getAttribute('aria-checked')).toBe('false')
    expect(checkbox.hasAttribute('data-ds-round-control')).toBe(true)
    expect(document.querySelector('input[type="checkbox"]')).toBeNull()
  })
  it.each([['mini', 14, 9, 1.5], ['small', 16, 10, 1.5], ['default', 20, 12, 2], ['large', 24, 14, 2]] as const)('%s 尺寸沿用 NewMax 的选框、图标和边框尺度', (size, box, icon, border) => {
    render(<DsCheckbox aria-label="选择来源" size={size} checked />)
    const checkbox = screen.getByRole('checkbox') as HTMLButtonElement
    expect(checkbox.style.width).toBe(`${box}px`)
    expect(checkbox.style.height).toBe(`${box}px`)
    expect(checkbox.style.borderWidth).toBe(`${border}px`)
    expect(checkbox.querySelector('svg')?.getAttribute('width')).toBe(String(icon))
    expect(checkbox.querySelector('path')?.getAttribute('d')).toBe('M5 11L10.5 16.5L21 6')
    expect(checkbox.querySelector('path')?.getAttribute('stroke-width')).toBe('3')
  })
  it('受控值由父层更新，每次点击只通知一次布尔值', () => {
    const onChange = vi.fn()
    const { rerender } = render(<DsCheckbox aria-label="选择来源" checked={false} onChange={onChange} />)
    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true)
    expect(checkbox.getAttribute('aria-checked')).toBe('false')
    rerender(<DsCheckbox aria-label="选择来源" checked onChange={onChange} />)
    fireEvent.click(checkbox)
    expect(onChange).toHaveBeenLastCalledWith(false)
    expect(onChange).toHaveBeenCalledTimes(2)
  })
  it('非受控模式、半选和已选优先级与 NewMax 一致', () => {
    const onChange = vi.fn()
    const { rerender } = render(<DsCheckbox aria-label="选择来源" indeterminate onChange={onChange} />)
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox.getAttribute('aria-checked')).toBe('mixed')
    fireEvent.click(checkbox)
    expect(checkbox.getAttribute('aria-checked')).toBe('true')
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true)
    rerender(<DsCheckbox aria-label="选择来源" indeterminate={false} onChange={onChange} />)
    fireEvent.click(checkbox)
    expect(checkbox.getAttribute('aria-checked')).toBe('false')
  })
  it('整行 label 点击只切换一次，禁用态不触发回调，ref 指向可聚焦按钮', () => {
    const onChange = vi.fn(), ref = createRef<HTMLButtonElement>()
    const { rerender } = render(<label>App 名称<DsCheckbox ref={ref} aria-label="选择来源" onChange={onChange} /></label>)
    fireEvent.click(screen.getByText('App 名称'))
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true)
    expect(ref.current).toBe(screen.getByRole('checkbox'))
    rerender(<label>App 名称<DsCheckbox ref={ref} aria-label="选择来源" disabled onChange={onChange} /></label>)
    fireEvent.click(screen.getByText('App 名称')); fireEvent.click(screen.getByRole('checkbox'))
    expect(onChange).toHaveBeenCalledOnce()
    expect(ref.current?.disabled).toBe(true)
  })
  it('支持默认勾选及外层取消点击，保留可访问描述和样式扩展', () => {
    const onChange = vi.fn()
    render(<DsCheckbox aria-label="选择来源" aria-describedby="help" defaultChecked className="extra" style={{ margin: 4 }} onClick={event => event.preventDefault()} onChange={onChange} />)
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox.getAttribute('aria-checked')).toBe('true')
    expect(checkbox.getAttribute('aria-describedby')).toBe('help')
    expect(checkbox.classList.contains('extra')).toBe(true)
    fireEvent.click(checkbox)
    expect(onChange).not.toHaveBeenCalled()
  })
  it('样式使用 DS token、圆形、悬浮外圈和按压缩放，减少动画立即禁用过渡', () => {
    const styles = readFileSync(resolve('src/renderer/src/components/DsCheckbox.css'), 'utf8')
    expect(styles).toContain('border-radius: var(--ds-radius-pill)')
    expect(styles).toContain('var(--ds-text-tertiary)')
    expect(styles).toContain('var(--ds-action-primary-text)')
    expect(styles).toContain('var(--ds-action-primary) 6%')
    expect(styles).not.toContain('--ds-brand-primary')
    expect(styles).toContain('scale(0.85)')
    expect(styles).toContain('var(--ds-motion-spring)')
    expect(styles).toContain('prefers-reduced-motion: reduce')
    expect(styles).toContain('transition: none')
    expect(styles).not.toContain('accent-color')
  })
})
