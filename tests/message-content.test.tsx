// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Lexer } from 'marked'
import { MessageContent } from '../src/renderer/src/components/MessageContent'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('只读 Markdown 消息排版', () => {
  it('解析六级标题、段落、嵌套强调与删除线', () => {
    const { container } = render(<MessageContent content={'# 一级\n## 二级\n### 三级\n#### 四级\n##### 五级\n###### 六级\n\n普通 **粗体 *斜体*** 与 ~~删除~~。\n\n第二段'} />)
    for (let level = 1; level <= 6; level++) expect(screen.getByRole('heading', { level })).toBeTruthy()
    expect(container.querySelectorAll('p')).toHaveLength(2)
    expect(container.querySelector('strong em')?.textContent).toBe('斜体')
    expect(container.querySelector('del')?.textContent).toBe('删除')
  })

  it('解析有序列表的起始编号、嵌套列表和多段引用', () => {
    const { container } = render(<MessageContent content={'3. 第三项\n4. 第四项\n   - 嵌套 **项目**\n\n> 引用第一段\n>\n> 引用第二段'} />)
    expect(container.querySelector('ol')?.start).toBe(3)
    expect(container.querySelectorAll('ol > li')).toHaveLength(2)
    expect(container.querySelector('ol ul li strong')?.textContent).toBe('项目')
    expect(container.querySelectorAll('blockquote p')).toHaveLength(2)
  })

  it('GFM 表格保留表头、对齐和单元格内联样式，并使用横向 ScrollArea', () => {
    const { container } = render(<MessageContent content={'| 左列 | 中列 | 右列 |\n| :--- | :---: | ---: |\n| **粗体** | `a|b` | ~~旧值~~ |'.replace('`a|b`', '`a\\|b`')} />)
    expect(container.querySelectorAll('thead th')).toHaveLength(3)
    expect(container.querySelectorAll('tbody td')).toHaveLength(3)
    expect(container.querySelector('tbody strong')?.textContent).toBe('粗体')
    expect(container.querySelector('tbody code')?.textContent).toBe('a|b')
    expect(container.querySelector('tbody del')?.textContent).toBe('旧值')
    expect(container.querySelectorAll('th')[1].style.textAlign).toBe('center')
    expect(container.querySelectorAll('td')[2].style.textAlign).toBe('right')
    const viewport = container.querySelector('table')?.parentElement
    expect(viewport?.classList.contains('ds-scroll-area')).toBe(true)
    expect(viewport?.tabIndex).toBe(0)
  })

  it('任务列表仅显示只读状态，不生成可操作表单控件', () => {
    const { container } = render(<MessageContent content={'- [x] 已完成\n- [ ] 待处理'} />)
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(screen.getByLabelText('已完成')).toBeTruthy()
    expect(screen.getByLabelText('未完成')).toBeTruthy()
    expect(container.querySelector('input, button')).toBeNull()
  })

  it('行内代码、转义、字符实体和换行正确显示，不二次解析 HTML', () => {
    const { container } = render(<MessageContent content={'普通 `code <img src=x>`\n下一行  \n硬换行\n\n\\*非斜体\\* &amp; &#x4E2D; &lt;script&gt; &copy;\n\n---'} />)
    expect(container.querySelector('code')?.textContent).toBe('code <img src=x>')
    expect(container.querySelector('em, img, script')).toBeNull()
    expect(container.textContent).toContain('*非斜体* & 中 <script> ©')
    expect(container.querySelector('br')).not.toBeNull()
    expect(container.querySelector('hr')).not.toBeNull()
  })

  it('未闭合围栏按 Markdown 代码块显示，HTML 内容仍然仅为文本', () => {
    const { container } = render(<MessageContent content={'普通 `code`\n```ts\n未闭合代码\n<img src=x>'} />)
    expect(container.querySelector('p code')?.textContent).toBe('code')
    expect(container.querySelector('pre code')?.textContent).toBe('未闭合代码\n<img src=x>')
    expect(container.querySelector('img')).toBeNull()
  })

  it('多个代码块与未知语言均作为文本，不执行或自动链接', () => {
    const { container } = render(<MessageContent content={'开始\n```js\nalert(1)\n```\n中间\n~~~unknown\nhttps://example.invalid\n~~~\n结束'} />)
    expect(container.querySelectorAll('pre code')).toHaveLength(2)
    for (const code of container.querySelectorAll('pre')) {
      expect(code.classList.contains('ds-scroll-area')).toBe(true)
      expect(code.tabIndex).toBe(0)
    }
    expect(container.querySelectorAll('.code-label')).toHaveLength(2)
    expect(screen.getAllByText('只读代码')).toHaveLength(2)
    expect(screen.getByText('unknown')).toBeTruthy()
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelectorAll('p')).toHaveLength(3)
  })

  it('长围栏内部的短围栏不是结束符，空代码块仍保留', () => {
    const { container } = render(<MessageContent content={'````md\n```\nexample\n```\n````\n```\n```'} />)
    expect(container.querySelectorAll('pre code')).toHaveLength(2)
    expect(container.querySelector('pre code')?.textContent).toBe('```\nexample\n```')
    expect(screen.getByText('纯文本')).toBeTruthy()
  })

  it('缩进代码与嵌套围栏复用只读代码容器，不解释围栏元信息', () => {
    const { container } = render(<MessageContent content={'    echo safe\n\n> ```sh title="<img src=x>"\n> rm -rf /synthetic-only\n> ```'} />)
    expect(container.querySelectorAll('.code-block pre code')).toHaveLength(2)
    expect(container.querySelector('blockquote .code-label span')?.textContent).toBe('sh')
    expect(container.querySelector('img')).toBeNull()
  })

  it.each(['', '  \n\t'])('空消息显示明确占位 (%j)', content => {
    render(<MessageContent content={content} />)
    expect(screen.getByText('这条消息没有文本内容')).toBeTruthy()
  })
})

describe('不可信 Markdown 安全边界', () => {
  it('实体只解码一次，代码、转义和自动链接中的实体保持原样', () => {
    const { container } = render(<MessageContent content={'&#38;lt;script&#38;gt; &amp;lt;script&amp;gt; &copy 未结束实体\n\n`&amp;` 和 \\&amp;\n\n<https://example.invalid/?a=&amp;b=1>\n\n![**粗体** 与 &#38;lt;img&#38;gt;](https://example.invalid/image)'} />)
    expect(container.querySelector('p')?.textContent).toBe('&lt;script&gt; &lt;script&gt; &copy 未结束实体')
    expect(container.querySelectorAll('p')[1].textContent).toBe('&amp; 和 &amp;')
    expect(container.textContent).toContain('https://example.invalid/?a=&amp;b=1')
    expect(container.querySelector('.markdown-image-alt')?.textContent).toBe('粗体 与 &lt;img&gt;')
    expect(container.querySelector('.markdown-image-alt strong')).toBeNull()
    expect(container.querySelector('script, img, a')).toBeNull()
  })

  it('解析异常安全降级为原文，不丢失历史内容也不执行 HTML', () => {
    vi.spyOn(Lexer, 'lex').mockImplementationOnce(() => { throw new Error('合成解析异常') })
    const content = '# 保留原文\n<img src=x onerror=alert(1)>'
    const { container } = render(<MessageContent content={content} />)
    expect(container.querySelector('p')?.textContent).toBe(content)
    expect(container.querySelector('img, h1')).toBeNull()
  })

  it('相同内容重渲染复用解析结果，内容变化后更新输出', () => {
    const lexer = vi.spyOn(Lexer, 'lex')
    const { rerender } = render(<MessageContent content="# 第一版" />)
    rerender(<MessageContent content="# 第一版" />)
    expect(lexer).toHaveBeenCalledTimes(1)
    rerender(<MessageContent content="# 第二版" />)
    expect(lexer).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('heading', { name: '第二版' })).toBeTruthy()
  })

  it('raw HTML 原样显示为文本，不创建脚本、事件属性、样式或嵌入资源', () => {
    const payload = '<script>window.__markdownXss = true</script>\n\n<img src="https://example.invalid/pixel" onerror="alert(1)">\n\n<iframe srcdoc="<script>alert(1)</script>"></iframe>\n\n<svg onload="alert(1)"><a href="javascript:alert(1)">x</a></svg>\n\n<style>@import "https://example.invalid/style";</style>\n\n<link rel="stylesheet" href="https://example.invalid/style">\n\n<object data="file:///synthetic"></object>\n\n<video poster="https://example.invalid/pixel"></video>\n\n<form action="https://example.invalid"><input autofocus></form>'
    const { container } = render(<MessageContent content={payload} />)
    expect(container.querySelector('script, img, iframe, svg, style, link, object, video, form, input')).toBeNull()
    expect(container.querySelector('[onerror], [onload], [src], [href], [srcdoc], [data], [poster]')).toBeNull()
    expect(container.textContent).toContain('<script>window.__markdownXss = true</script>')
    expect(container.textContent).toContain('<img src="https://example.invalid/pixel" onerror="alert(1)">')
    expect('__markdownXss' in window).toBe(false)
  })

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'jav&#x61;script:alert(1)',
    'javascript&#58;alert(1)',
    'java%73cript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'file:///synthetic/private.txt',
    'newmax-staithe://import/synthetic',
    '//example.invalid/external',
    'https://example.invalid/safe',
    'mailto:synthetic@example.invalid',
    '#local-fragment',
    '/relative/path',
  ])('链接 %s 只显示标签，不生成导航地址或点击操作', href => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { container } = render(<MessageContent content={`[**显示标签**](<${href}>)`} />)
    expect(container.querySelector('strong')?.textContent).toBe('显示标签')
    expect(container.querySelector('a, [href], [src], [role="link"], [tabindex]')).toBeNull()
    fireEvent.click(screen.getByText('显示标签'))
    expect(open).not.toHaveBeenCalled()
  })

  it('自动链接与引用链接仍是不可导航文本', () => {
    const { container } = render(<MessageContent content={'https://example.invalid/path\n\n<synthetic@example.invalid>\n\n[引用标签][ref]\n\n[ref]: javascript:alert(1)'} />)
    expect(container.textContent).toContain('https://example.invalid/path')
    expect(container.textContent).toContain('synthetic@example.invalid')
    expect(container.textContent).toContain('引用标签')
    expect(container.querySelector('a, [href]')).toBeNull()
  })

  it('图片只显示替代文本，空替代文本有占位，不创建资源节点或发起请求', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const request = vi.spyOn(XMLHttpRequest.prototype, 'open')
    const { container } = render(<MessageContent content={'![远程 &amp; 图](https://example.invalid/tracker.png)\n\n![本地图](file:///synthetic/image.png)\n\n![数据图](data:image/svg+xml;base64,PHN2Zz4=)\n\n![](https://example.invalid/empty.png)\n\n[![链接中的图](https://example.invalid/inner.png)](javascript:alert(1))\n\n![引用图][image]\n\n[image]: https://example.invalid/ref.png'} />)
    for (const text of ['远程 & 图', '本地图', '数据图', '图片', '链接中的图', '引用图']) expect(screen.getByText(text)).toBeTruthy()
    expect(container.querySelector('img, picture, source, a, [src], [srcset], [href]')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('HTML 和实体藏在表格、引用、链接标签、代码和图片替代文本中仍不能变为 DOM', () => {
    const { container } = render(<MessageContent content={'| 内容 |\n| --- |\n| <img src=x onerror=alert(1)> |\n\n> <script>alert(1)</script>\n\n[<img src=x>](javascript:alert(1))\n\n![&lt;img src=x onerror=alert(1)&gt;](https://example.invalid/x)\n\n```html\n<script>alert(1)</script>\n```\n\n`&lt;script&gt;`'} />)
    expect(container.querySelector('img, script, a, [onerror], [src], [href]')).toBeNull()
    expect(container.querySelector('td')?.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.querySelector('pre code')?.textContent).toBe('<script>alert(1)</script>')
    expect(container.querySelector('p code')?.textContent).toBe('&lt;script&gt;')
    expect(screen.getByText('<img src=x onerror=alert(1)>', { selector: '.markdown-image-alt' })).toBeTruthy()
  })
})
