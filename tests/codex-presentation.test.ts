import { describe, expect, it } from 'vitest'
import { sourceMessageParts, sourcePromptTitle } from '../src/core/source-presentation'
import { codexFilesContext, codexFilesPrompt, codexActualRequest, codexImageContext, codexImagePlaceholder } from './fixtures/codex'

const parts = (content: string) => sourceMessageParts(content, 'codex', 'user')

describe('Codex 附件包装展示边界', () => {
  it.each(['# My request:', '## My request:', '## My request for Codex:'])('完整附件包装以真实请求作为正文与标题：%s', marker => {
    const content = codexFilesPrompt.replace('# My request:', marker) + '\n' + codexImageContext
    expect(parts(content)).toEqual({ primary: codexActualRequest, context: codexFilesContext + '\n' + codexImageContext })
    expect(sourcePromptTitle(content, 'codex')).toBe(codexActualRequest)
  })
  it('支持 CRLF、多附件和多张图片占位，不吞掉真正的多行请求', () => {
    const files = codexFilesContext + '\n\n## notes.txt (/synthetic/notes.txt)\nImage attachment: false'
    const request = '第一行请求\n\n## 用户正文标题\n保留正文中的 <image> 引用'
    const images = codexImageContext + '\n<image 2>\n' + codexImagePlaceholder + '\n</image 2>'
    const content = `${files}\n\n# My request:\n${request}\n${images}`.replace(/\n/g, '\r\n')
    expect(parts(content).primary).toBe(request.replace(/\n/g, '\r\n'))
    expect(parts(content).context).toContain('notes.txt')
    expect(parts(content).context).toContain('</image 2>')
    expect(sourcePromptTitle(content, 'codex')).toBe('第一行请求')
  })
  it('尾部独立占位可以折叠，但请求中的普通标签、代码和未知结构保持原样', () => {
    const request = '解释这些示例\n```xml\n<image>\n内容\n</image>\n```\n<unknown>正文</unknown>'
    const content = codexFilesContext + '\n\n# My request:\n' + request + '\n' + codexImagePlaceholder
    expect(parts(content)).toEqual({ primary: request, context: codexFilesContext + '\n' + codexImagePlaceholder })
  })
  it('没有真正请求的附件包装不能拿包装标题冒充首问', () => {
    const content = codexFilesContext + '\n\n# My request:\n' + codexImageContext
    expect(parts(content).primary).toBe('')
    expect(sourcePromptTitle(content, 'codex')).toBe('')
  })
  it.each([
    '请解释 Files mentioned by the user: 和 My request:',
    '```text\n' + codexFilesPrompt + '\n```',
    '> ' + codexFilesPrompt.replace(/\n/g, '\n> '),
    codexFilesContext,
    '# Files mentioned by the user:\n普通文字不是附件列表\n# My request:\n不要误切分',
    '# Files mentioned by the user:\n```text\n## example\n# My request:\n```',
  ])('不处理普通引用、代码、未知或缺失分隔符的包装：%s', content => {
    expect(parts(content)).toEqual({ primary: content, context: '' })
  })
  it('助手或其他来源不套用 Codex 用户包装规则', () => {
    expect(sourceMessageParts(codexFilesPrompt, 'codex', 'assistant')).toEqual({ primary: codexFilesPrompt, context: '' })
    expect(sourceMessageParts(codexFilesPrompt, 'claude-code', 'user')).toEqual({ primary: codexFilesPrompt, context: '' })
  })
  it('不把未闭合或不匹配的图片标签吞到附件上下文', () => {
    const tail = '<image 1>\n' + codexImagePlaceholder + '\n</image 2>'
    const content = codexFilesPrompt + '\n' + tail
    expect(parts(content)).toEqual({ primary: codexActualRequest + '\n' + tail, context: codexFilesContext })
  })
  it.each([
    '```text\n' + codexImagePlaceholder,
    '~~~~text\n' + codexImagePlaceholder,
    '    缩进代码\n    ' + codexImagePlaceholder,
  ])('不移动未闭合代码块或缩进代码中的占位文字：%s', request => {
    const content = codexFilesContext + '\n\n# My request:\n' + request
    expect(parts(content)).toEqual({ primary: request, context: codexFilesContext })
  })
  it('完整波浪线围栏中的占位文字仍保留，围栏外的实际附件可以折叠', () => {
    const request = '~~~~text\n' + codexImagePlaceholder + '\n~~~~'
    const content = codexFilesContext + '\n\n# My request:\n' + request + '\n' + codexImagePlaceholder
    expect(parts(content)).toEqual({ primary: request, context: codexFilesContext + '\n' + codexImagePlaceholder })
  })
  it('有附件包装但没有占位符的普通图片标签仍是用户原文', () => {
    const tail = '<image>\n</image>'
    expect(parts(codexFilesPrompt + '\n' + tail).primary).toBe(codexActualRequest + '\n' + tail)
  })
})
