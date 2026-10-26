// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ConversationEnd } from '../src/renderer/src/components/ConversationEnd'

afterEach(cleanup)

describe('品牌对话收尾', () => {
  it('仅保留装饰场景，不显示结束提示文字或产生交互入口', () => {
    const { container } = render(<ConversationEnd />)
    const ending = container.querySelector('.conversation-ending')!
    const illustration = container.querySelector('img')!
    expect(ending.textContent).toBe('')
    expect(ending.children).toHaveLength(1)
    expect(ending.firstElementChild).toBe(illustration)
    expect(screen.queryByText('当前记录到此')).toBeNull()
    expect(screen.queryByText('档案记录到此')).toBeNull()
    expect(illustration.getAttribute('src')).toContain('pinekin-forest-panorama.png')
    expect(illustration.getAttribute('alt')).toBe('')
    expect(illustration.getAttribute('aria-hidden')).toBe('true')
    expect(illustration.getAttribute('draggable')).toBe('false')
    expect(illustration.getAttribute('width')).toBe('1600')
    expect(illustration.getAttribute('height')).toBe('640')
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelectorAll('article')).toHaveLength(0)
  })
})
