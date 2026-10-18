// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DsRefreshButton } from '../src/renderer/src/components/DsRefreshButton'

afterEach(cleanup)

describe('钱包式刷新按钮', () => {
  it('复用 ghost / small / iconOnly、提示和可访问名称', () => {
    render(<DsRefreshButton onClick={vi.fn()} aria-label="刷新当前来源" />)
    const button = screen.getByRole('button', { name: '刷新当前来源' })
    expect(button.classList.contains('ds-button-ghost')).toBe(true)
    expect(button.classList.contains('ds-button-small')).toBe(true)
    expect(button.classList.contains('ds-button-icon')).toBe(true)
    expect(button.textContent).toBe('')
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    fireEvent.focus(button)
    expect(screen.getByRole('tooltip').textContent).toBe('刷新当前来源')
  })
  it('每次点击触发一整圈动画，hover 和请求状态变化不重建转圈节点', () => {
    const onClick = vi.fn()
    const { rerender } = render(<DsRefreshButton onClick={onClick} />)
    const button = screen.getByRole('button', { name: '刷新' })
    const idle = button.querySelector('.ds-refresh-turn')!
    expect(idle.getAttribute('data-active')).toBe('false')
    fireEvent.mouseEnter(button)
    expect(button.querySelector('.ds-refresh-turn')).toBe(idle)
    fireEvent.click(button)
    const firstTurn = button.querySelector('.ds-refresh-turn')!
    expect(firstTurn).not.toBe(idle)
    expect(firstTurn.getAttribute('data-active')).toBe('true')
    rerender(<DsRefreshButton onClick={onClick} loading />)
    expect(button.querySelector('.ds-refresh-turn')).toBe(firstTurn)
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
    rerender(<DsRefreshButton onClick={onClick} />)
    expect(button.querySelector('.ds-refresh-turn')).toBe(firstTurn)
    fireEvent.click(button)
    expect(button.querySelector('.ds-refresh-turn')).not.toBe(firstTurn)
    expect(onClick).toHaveBeenCalledTimes(2)
  })
  it('禁用和加载各自阻止重复调用，成功或失败恢复由真实请求状态决定', () => {
    const onClick = vi.fn()
    const { rerender } = render(<DsRefreshButton onClick={onClick} disabled />)
    const button = screen.getByRole('button', { name: '刷新' })
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
    expect(button.getAttribute('data-unavailable')).toBe('true')
    rerender(<DsRefreshButton onClick={onClick} loading />)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.getAttribute('data-unavailable')).toBe('false')
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
    rerender(<DsRefreshButton onClick={onClick} />)
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.getAttribute('aria-busy')).toBe('false')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })
  it('沿用钱包 35° 蓄力、350ms swift 和 700ms bounce，加载旋转与点击回弹分层', () => {
    const tokens = readFileSync(resolve('src/renderer/src/tokens.css'), 'utf8')
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(tokens).toContain('--ds-duration-slow: 350ms;')
    expect(tokens).toContain('--ds-duration-bounce: 700ms;')
    expect(tokens).toContain('--ds-ease-bounce: cubic-bezier(0.68, -0.55, 0.265, 1.55);')
    expect(tokens).toContain('--ds-motion-bounce: var(--ds-duration-bounce) var(--ds-ease-bounce);')
    expect(styles).toMatch(/\.ds-refresh-button \.design-icon\s*\{[^}]*transition: transform var\(--ds-duration-slow\) var\(--ds-ease-swift\);/)
    expect(styles).toMatch(/\.ds-refresh-button:hover:not\(\[data-unavailable='true'\]\) \.design-icon\s*\{[^}]*rotate\(-35deg\)/)
    expect(styles).toMatch(/\.ds-refresh-turn\[data-active='true'\]\s*\{[^}]*animation: ds-refresh-turn var\(--ds-motion-bounce\);/)
    expect(styles).toMatch(/\.ds-refresh-button\[aria-busy='true'\] \.ds-refresh-progress\s*\{[^}]*animation: source-refresh-spin 1s linear var\(--ds-duration-bounce\) infinite;/)
    expect(styles).not.toMatch(/\.source-refresh-button\[aria-busy='true'\] \.design-icon/)
    expect(styles).toMatch(/\.list-heading-copy\s*\{[^}]*gap: 2px;/)
    expect(styles).toContain('animation: none !important; transition: none !important;')
  })
})
