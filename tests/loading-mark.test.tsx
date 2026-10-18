// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { LoadingMark } from '../src/renderer/src/components/LoadingMark'

afterEach(cleanup)
describe('微型流动点加载动画', () => {
  it('提供可访问的状态名称，不显示加载中文字，三枚流动点仅作为装饰', () => {
    const { container } = render(<LoadingMark label="正在加载会话" />)
    const mark = screen.getByRole('img', { name: '正在加载会话' })
    expect(mark.textContent).toBe('')
    expect(container.querySelectorAll('.loading-mark > i')).toHaveLength(3)
    expect(Array.from(mark.children).every(child => child.getAttribute('aria-hidden') === 'true')).toBe(true)
  })
})
