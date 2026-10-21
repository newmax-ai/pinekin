// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { Sidebar } from '../src/renderer/src/components/Sidebar'

let media: MediaQueryList
let reduce: (matches: boolean) => void
beforeEach(() => {
  localStorage.clear()
  const events = new EventTarget()
  media = {
    matches: false, media: '(prefers-reduced-motion: reduce)', onchange: null,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events), addListener: vi.fn(), removeListener: vi.fn(),
  } as MediaQueryList
  vi.stubGlobal('matchMedia', vi.fn(() => media))
  reduce = matches => act(() => {
    Object.defineProperty(media, 'matches', { configurable: true, value: matches })
    media.dispatchEvent(new Event('change'))
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })

const sidebar = () => document.getElementById('archive-sidebar')!
const width = () => parseFloat(sidebar().style.width)
const pause = (ms: number) => act(() => new Promise<void>(resolve => setTimeout(resolve, ms)))

describe('真实 Motion 引擎的侧栏完成与中断', () => {
  it('收起存在中间帧，完成后宽度为零，重新展开恢复固定画布宽度', async () => {
    const view = render(<Sidebar open>内容</Sidebar>)
    expect(width()).toBe(240)
    view.rerender(<Sidebar open={false}>内容</Sidebar>)
    await waitFor(() => { expect(width()).toBeGreaterThan(0); expect(width()).toBeLessThan(240) })
    expect((sidebar().querySelector('.sidebar-content') as HTMLElement).style.width).toBe('240px')
    await waitFor(() => { expect(width()).toBe(0); expect(sidebar().style.visibility).toBe('hidden') })
    expect(sidebar().style.marginRight).toBe('8px')
    view.rerender(<Sidebar open>内容</Sidebar>)
    await waitFor(() => { expect(width()).toBe(240); expect(sidebar().style.visibility).toBe('visible') })
    expect(sidebar().style.marginRight).toBe('0px')
  })
  it.each([false, true])('动画中途切换减少动画后立即完成，旧动画不能覆写最终状态（目标展开 %s）', async open => {
    const view = render(<Sidebar open={!open}>内容</Sidebar>)
    view.rerender(<Sidebar open={open}>内容</Sidebar>)
    await waitFor(() => { expect(width()).toBeGreaterThan(0); expect(width()).toBeLessThan(240) })
    reduce(true)
    await waitFor(() => expect(width()).toBe(open ? 240 : 0))
    view.rerender(<Sidebar open={!open}>内容</Sidebar>)
    await pause(600)
    expect(width()).toBe(open ? 0 : 240)
    expect(sidebar().style.visibility).toBe(open ? 'hidden' : 'visible')
  })
  it('连续开合后由最后一次展开决定可见性，旧退场不能再次隐藏侧栏', async () => {
    const view = render(<Sidebar open>内容</Sidebar>)
    for (let index = 0; index < 3; index++) {
      view.rerender(<Sidebar open={false}>内容</Sidebar>)
      await pause(35)
      view.rerender(<Sidebar open>内容</Sidebar>)
      await pause(35)
    }
    await waitFor(() => { expect(width()).toBe(240); expect(sidebar().style.visibility).toBe('visible') })
    expect(sidebar().hasAttribute('inert')).toBe(false)
  })
})
