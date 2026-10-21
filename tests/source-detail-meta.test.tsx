// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SourceDetailMeta } from '../src/renderer/src/components/SourceDetailMeta'
import type { SourceContent, SourceEntry } from '../src/core/sources'

const entry: SourceEntry = { id: 'a'.repeat(64), connectionId: '11111111-1111-4111-8111-111111111111', source: 'newmax', title: '合成会话', project: '.', updatedAt: '2026-10-21T00:00:00Z', availability: 'readable' }
function snapshot(total = 8, visible = 8): SourceContent {
  return { session: { id: entry.id, title: entry.title, source: entry.source, updatedAt: entry.updatedAt, tags: [], demo: false,
    messages: Array.from({ length: visible }, (_, index) => ({ role: 'user' as const, content: `合成消息 ${index}` })) }, warnings: [],
    window: { offset: 0, textOffset: 0, totalMessages: total, hasMore: total > visible, snapshot: 'c'.repeat(64) } }
}
afterEach(cleanup)

function summary(container: HTMLElement) { return container.querySelector<HTMLElement>('.source-detail-summary')! }
function width(container: HTMLElement) { return container.querySelector<HTMLElement>('.source-detail-meta')!.style.getPropertyValue('--source-meta-number-width') }

describe('紧凑且稳定的来源元信息', () => {
  it('初次读取保留完整字段结构，只显示数字占位，不把短占位替换成长描述', () => {
    const view = render(<SourceDetailMeta entry={entry} reading />)
    expect(summary(view.container).getAttribute('title')).toBe('— 条来源消息 · 当前片段 — 条文本')
    expect(view.container.querySelector('.detail-message-count')?.getAttribute('aria-label')).toBe('消息数正在读取')
    expect(summary(view.container).getAttribute('aria-busy')).toBe('true')
    expect(width(view.container)).toBe('')
    const numbers = [...view.container.querySelectorAll('.source-detail-number')]
    view.rerender(<SourceDetailMeta entry={entry} content={snapshot()} />)
    expect(summary(view.container).getAttribute('title')).toBe('8 条来源消息 · 当前片段 8 条文本')
    expect([...view.container.querySelectorAll('.source-detail-number')]).toEqual(numbers)
    expect(width(view.container)).toBe('')
  })
  it('已读到另一个会话时保留排版结构而非旧数字，日期紧跟描述并立即更新', () => {
    const view = render(<SourceDetailMeta entry={entry} content={snapshot(83, 9)} />)
    const row = view.container.querySelector('.source-detail-meta')!
    const date = row.querySelector('time')!
    const count = row.querySelector('.detail-message-count')!
    view.rerender(<SourceDetailMeta entry={{ ...entry, id: 'b'.repeat(64), updatedAt: '2026-10-20T00:00:00Z' }} reading />)
    expect(view.container.querySelector('.source-detail-meta')).toBe(row)
    expect(row.querySelector('.detail-message-count')).toBe(count)
    expect(count.textContent).toBe('— 条来源消息 · 当前片段 — 条文本')
    expect(summary(view.container).getAttribute('title')).not.toMatch(/83|9/)
    expect(row.lastElementChild).toBe(date)
    expect(date.textContent).toBe('2026-10-20')
    expect(width(view.container)).toBe('')
  })
  it('数字按当前内容自然排列，从长数字切回短数字或加载占位时不保留历史位宽', () => {
    const view = render(<SourceDetailMeta entry={entry} content={snapshot(12345, 100)} />)
    expect(width(view.container)).toBe('')
    view.rerender(<SourceDetailMeta entry={entry} reading />)
    expect(width(view.container)).toBe('')
    view.rerender(<SourceDetailMeta entry={entry} content={snapshot()} />)
    expect(width(view.container)).toBe('')
    expect(summary(view.container).getAttribute('title')).toBe('8 条来源消息 · 当前片段 8 条文本')
    for (const number of view.container.querySelectorAll<HTMLElement>('.source-detail-number')) {
      expect(number.style.width).toBe('')
      expect(number.style.minWidth).toBe('')
    }
  })
  it('工具活动加载时保留字段结构，但不显示上一会话工具数或类型', () => {
    const content = { ...snapshot(), presentation: { kind: 'browser-task' as const, textMessages: 8, toolCalls: 12, toolResults: 12, attachments: 0, omittedRecords: 0, activities: [], activitiesTruncated: false } }
    const view = render(<SourceDetailMeta entry={entry} content={content} />)
    expect(screen.getByText('浏览器任务')).toBeTruthy()
    expect(summary(view.container).getAttribute('title')).toContain('24 项工具活动')
    view.rerender(<SourceDetailMeta entry={{ ...entry, id: 'b'.repeat(64), kind: 'conversation' }} reading />)
    expect(summary(view.container).getAttribute('title')).toContain('— 项工具活动')
    expect(summary(view.container).textContent).not.toContain('24')
    expect(screen.queryByText('浏览器任务')).toBeNull()
    view.rerender(<SourceDetailMeta entry={entry} content={snapshot()} />)
    expect(summary(view.container).textContent).not.toContain('项工具活动')
  })
  it('兼容非分段正文，加载沿用其字段结构；失败也只显示占位，不伪造零条', () => {
    const { window: _window, ...content } = snapshot()
    const view = render(<SourceDetailMeta entry={entry} content={content} />)
    expect(summary(view.container).getAttribute('title')).toBe('8 条消息')
    view.rerender(<SourceDetailMeta entry={entry} reading />)
    expect(summary(view.container).getAttribute('title')).toBe('— 条消息')
    view.rerender(<SourceDetailMeta entry={entry} />)
    expect(view.container.querySelector('.detail-message-count')?.getAttribute('aria-label')).toBe('消息数暂不可用')
    expect(summary(view.container).textContent).not.toContain('0 条')
    expect(summary(view.container).getAttribute('aria-busy')).not.toBe('true')
  })
  it('零消息如实显示为零，分段总数和当前片段文本数仍明确区分', () => {
    const view = render(<SourceDetailMeta entry={entry} content={snapshot(0, 0)} />)
    expect(summary(view.container).getAttribute('title')).toBe('0 条来源消息 · 当前片段 0 条文本')
    view.rerender(<SourceDetailMeta entry={{ ...entry, kind: 'subagent' }} content={snapshot(1000, 12)} />)
    expect(screen.getByText('子会话')).toBeTruthy()
    expect(summary(view.container).getAttribute('title')).toBe('子会话 · 1000 条来源消息 · 当前片段 12 条文本')
  })
})
