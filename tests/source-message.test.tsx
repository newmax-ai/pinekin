// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SourceMessage, SourceActivity } from '../src/renderer/src/components/SourceMessage'
import { sourceMessageParts, sourcePromptTitle } from '../src/core/source-presentation'

afterEach(cleanup)
const task = 'Task: 检查合成播放按钮\n\nCurrent URL: http://127.0.0.1:9999/test\nViewport: 400x800\n\nPage snapshot:\n<script>页面快照不执行</script>\n合成页面正文'

describe('来源详情按内容结构展示', () => {
  it('浏览器任务只将真实任务作为标题和首屏正文，完整页面上下文可展开', () => {
    expect(sourcePromptTitle(task, 'claude-code')).toBe('检查合成播放按钮')
    render(<SourceMessage message={{ role: 'user', content: task }} source="claude-code" />)
    expect(screen.getByText('检查合成播放按钮')).toBeTruthy()
    const summary = screen.getByText('页面上下文')
    expect(summary.closest('details')?.open).toBe(false)
    expect(screen.queryByText(/合成页面正文/)).toBeNull()
    const details = summary.closest('details')!; details.open = true; fireEvent(details, new Event('toggle'))
    expect(screen.getByText(/合成页面正文/)).toBeTruthy()
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('a, img, iframe')).toBeNull()
  })
  it.each(['Task: 普通任务没有页面包装', '请解释 Current URL: 和 Page snapshot: 字段', '```text\n' + task + '\n```'])('不误折叠普通文字和引用：%s', content => {
    expect(sourceMessageParts(content, 'claude-code', 'user')).toEqual({ primary: content, context: '' })
  })
  it('助手原文不因包含浏览器包装而被改写', () => {
    expect(sourceMessageParts(task, 'claude-code', 'assistant')).toEqual({ primary: task, context: '' })
  })
  it('Claude 前置系统/IDE上下文保留在折叠区，不掩盖真实输入', () => {
    const content = '<system-reminder>合成约束</system-reminder>\n<ide_opened_file>文件</ide_opened_file>\n真实输入'
    expect(sourceMessageParts(content, 'claude-code', 'user')).toEqual({ primary: '真实输入', context: '<system-reminder>合成约束</system-reminder>\n<ide_opened_file>文件</ide_opened_file>' })
  })
  it('长正文默认限量渲染，可展开全文，不丢失末尾内容', () => {
    const content = '合成很长的用户消息\n' + 'x'.repeat(10_000) + '\n末尾唯一标记'
    render(<SourceMessage message={{ role: 'user', content }} source="claude-code" />)
    expect(screen.queryByText('末尾唯一标记')).toBeNull()
    const details = screen.getByText('展开完整消息').closest('details')!; details.open = true; fireEvent(details, new Event('toggle'))
    expect(screen.getByText(/末尾唯一标记/)).toBeTruthy()
  })
  it('工具活动有明确调用/结果身份，输出默认折叠且不进入问答', () => {
    render(<SourceActivity presentation={{ kind: 'browser-task', textMessages: 1, toolCalls: 1, toolResults: 1, attachments: 0, omittedRecords: 0, activitiesTruncated: false,
      activities: [{ kind: 'call', name: 'synthetic_tool', content: '{"selector":"#play"}' }, { kind: 'result', name: 'synthetic_tool', content: '合成工具结果' }] }} />)
    expect(screen.getByText(/1 次调用.*1 条结果/)).toBeTruthy()
    expect(screen.queryByText('合成工具结果')).toBeNull()
    const details = screen.getByText(/工具活动/).closest('details')!; details.open = true; fireEvent(details, new Event('toggle'))
    expect(screen.getByText('调用 · synthetic_tool')).toBeTruthy()
    const result = screen.getByText('结果 · synthetic_tool').closest('details')!; result.open = true; fireEvent(result, new Event('toggle'))
    expect(screen.getByText('合成工具结果')).toBeTruthy()
  })
  it('标题取真实首行并限制长度，不把整篇页面快照或第二行挤进列表', () => {
    expect(sourcePromptTitle('首行标题\n第二行很长的正文', 'claude-code')).toBe('首行标题')
    expect(Array.from(sourcePromptTitle('😀'.repeat(300), 'claude-code')).length).toBeLessThanOrEqual(81)
  })
})
