// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FadeText } from '../src/renderer/src/components/FadeText'

let callback: () => void
const disconnect = vi.fn()
let available = 100, content = 160
beforeEach(() => {
  available = 100; content = 160
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => available)
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => content)
  vi.stubGlobal('ResizeObserver', class {
    constructor(update: () => void) { callback = update }
    observe() {}
    disconnect = disconnect
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); disconnect.mockClear() })

describe('NewMax 单行文字渐隐适配', () => {
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
