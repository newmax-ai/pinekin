// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { formatSessionTime, SessionTime, useCurrentTime } from '../src/renderer/src/components/SessionTime'

const now = new Date(2026, 9, 18, 12, 30, 45).getTime()
const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const iso = (time: number) => new Date(time).toISOString()

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('会话友好时间', () => {
  it.each([
    [0, '刚刚'], [59_999, '刚刚'], [minute, '1分钟前'],
    [59 * minute + 59_999, '59分钟前'], [hour, '1小时前'],
    [23 * hour + 59 * minute, '23小时前'], [day, '1天前'],
    [7 * day - 1, '6天前'],
  ])('经过 %i 毫秒显示 %s', (elapsed, label) => {
    expect(formatSessionTime(iso(now - elapsed), now).label).toBe(label)
  })

  it('一周以前保留本地日期和时分，不再只有日期', () => {
    expect(formatSessionTime(iso(now - 7 * day), now)).toEqual({
      label: '10月11日 12:30', full: '2026年10月11日 12:30:45',
    })
  })

  it('跨年补充年份，不将往年的会话混作今年', () => {
    expect(formatSessionTime(new Date(2025, 11, 31, 23, 5, 9).toISOString(), now)).toEqual({
      label: '2025年12月31日 23:05', full: '2025年12月31日 23:05:09',
    })
  })

  it('午夜使用 00 点而不是 24 点', () => {
    expect(formatSessionTime(new Date(2026, 9, 1, 0, 5).toISOString(), now)).toEqual({
      label: '10月01日 00:05', full: '2026年10月01日 00:05:00',
    })
  })

  it('按实际时间差计算，正确处理带时区的来源时间', () => {
    expect(formatSessionTime('2026-10-18T12:30:45+08:00', Date.parse('2026-10-18T05:30:45Z')).label).toBe('1小时前')
  })

  it('允许不足一分钟的时钟误差，更远的未来时间显示完整日期而非负数', () => {
    expect(formatSessionTime(iso(now + 59_999), now).label).toBe('刚刚')
    expect(formatSessionTime(iso(now + minute), now).label).toBe('2026年10月18日 12:31:45')
  })

  it.each(['', 'not-a-date'])('无效时间 %j 明确显示未知时间', dateTime => {
    expect(formatSessionTime(dateTime, now)).toEqual({ label: '时间未知', full: '时间未知' })
    const { container } = render(<SessionTime dateTime={dateTime} now={now} />)
    expect(container.querySelector('time')?.hasAttribute('datetime')).toBe(false)
  })

  it('保留原始机器时间，悬停和辅助技术可获取完整本地时间', () => {
    const dateTime = iso(now - hour)
    render(<SessionTime dateTime={dateTime} now={now} />)
    const time = screen.getByText('1小时前')
    expect(time.tagName).toBe('TIME')
    expect(time.getAttribute('datetime')).toBe(dateTime)
    expect(time.title).toBe('2026年10月18日 11:30:45')
    expect(time.getAttribute('aria-label')).toBe(time.title)
  })
})

describe('会话时间自动更新', () => {
  it('每分钟更新时间并在卸载时清理计时器', () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const dateTime = iso(now - 59 * minute)
    function Card() { return <SessionTime dateTime={dateTime} now={useCurrentTime()} /> }
    const view = render(<Card />)
    expect(screen.getByText('59分钟前')).toBeTruthy()
    act(() => vi.advanceTimersByTime(minute))
    expect(screen.getByText('1小时前')).toBeTruthy()
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('窗口恢复焦点或页面重新可见时立即校准，并清理事件监听', () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const removeWindow = vi.spyOn(window, 'removeEventListener')
    const removeDocument = vi.spyOn(document, 'removeEventListener')
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    const hook = renderHook(() => useCurrentTime())
    vi.setSystemTime(now + hour)
    act(() => window.dispatchEvent(new Event('focus')))
    expect(hook.result.current).toBe(now + hour)
    visibility.mockReturnValue('hidden')
    vi.setSystemTime(now + 2 * hour)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(hook.result.current).toBe(now + hour)
    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(hook.result.current).toBe(now + 2 * hour)
    hook.unmount()
    expect(removeWindow).toHaveBeenCalledWith('focus', expect.any(Function))
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })
})
