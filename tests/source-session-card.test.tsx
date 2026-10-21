// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SourceEntry } from '../src/core/sources'
import { SourceSessionCard } from '../src/renderer/src/components/SourceSessionCard'

const { renderTitle } = vi.hoisted(() => ({ renderTitle: vi.fn() }))
vi.mock('../src/renderer/src/components/FadeText', () => ({ FadeText: ({ text }: { text: string }) => { renderTitle(text); return <h3>{text}</h3> } }))
const entry: SourceEntry = { id: 'a'.repeat(64), connectionId: 'connection', source: 'codex', title: '合成标题', project: '.', updatedAt: '2026-10-21T00:00:00Z', availability: 'unread' }
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('来源列表卡片渲染预算', () => {
  it('分页、加载状态等父层更新不重新渲染未变的旧卡片', () => {
    const onSelect = vi.fn(), now = Date.now()
    const view = render(<SourceSessionCard entry={entry} selected={false} now={now} onSelect={onSelect} />)
    view.rerender(<SourceSessionCard entry={entry} selected={false} now={now} onSelect={onSelect} />)
    expect(renderTitle).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '合成标题 .' }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ selected: entry })
  })
  it('选择、时间与条目变化仍更新，保留可访问名称和会话种类', () => {
    const onSelect = vi.fn(), now = Date.now()
    const view = render(<SourceSessionCard entry={entry} selected={false} now={now} onSelect={onSelect} />)
    view.rerender(<SourceSessionCard entry={entry} selected now={now} onSelect={onSelect} />)
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true')
    view.rerender(<SourceSessionCard entry={{ ...entry, title: '更新标题', kind: 'subagent' }} selected now={now + 60000} onSelect={onSelect} />)
    expect(screen.getByRole('button', { name: '更新标题 .' })).toBeTruthy()
    expect(renderTitle).toHaveBeenCalledTimes(3)
    expect(document.querySelector('.source-kind')).not.toBeNull()
  })
})
