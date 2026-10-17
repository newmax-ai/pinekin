// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MessageContent } from '../src/renderer/src/components/MessageContent'

afterEach(cleanup)
describe('只读消息排版', () => {
  it('普通文本、未闭合围栏和行内反引号保持原文', () => {
    const content = '普通 `code`\n```ts\n未闭合代码\n<img src=x>'
    const { container } = render(<MessageContent content={content} />)
    expect(container.querySelector('p')?.textContent).toBe(content)
    expect(container.querySelector('pre, img')).toBeNull()
  })
  it('多个代码块与未知语言均作为文本，不执行或自动链接', () => {
    const { container } = render(<MessageContent content={'开始\n```js\nalert(1)\n```\n中间\n~~~unknown\nhttps://example.invalid\n~~~\n结束'} />)
    expect(container.querySelectorAll('pre code')).toHaveLength(2)
    for (const code of container.querySelectorAll('pre')) {
      expect(code.classList.contains('ds-scroll-area')).toBe(true)
      expect(code.tabIndex).toBe(0)
    }
    expect(screen.getByText('unknown')).toBeTruthy()
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelectorAll('p')).toHaveLength(3)
  })
  it('长围栏内部的短围栏不是结束符，空代码块仍保留', () => {
    const { container } = render(<MessageContent content={'````md\n```\nexample\n```\n````\n```\n```'} />)
    expect(container.querySelectorAll('pre code')).toHaveLength(2)
    expect(container.querySelector('pre code')?.textContent).toBe('```\nexample\n```')
  })
  it('空消息显示明确占位', () => {
    render(<MessageContent content="" />)
    expect(screen.getByText('这条消息没有文本内容')).toBeTruthy()
  })
})
