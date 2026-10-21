// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { Sidebar } from '../src/renderer/src/components/Sidebar'
import { DesignIcon } from '../src/renderer/src/components/ui'

const motionState = vi.hoisted(() => ({ controls: [] as Array<{ start: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> }))
vi.mock('framer-motion', async () => {
  const { createElement, useRef } = await import('react')
  function component(tag: 'aside' | 'div') {
    return function Motion({ animate: _animate, initial: _initial, ...props }: ComponentProps<'div'> & { animate?: unknown; initial?: unknown }) {
      return createElement(tag, props)
    }
  }
  return {
    motion: { aside: component('aside'), div: component('div') },
    useAnimationControls: () => {
      const ref = useRef<(typeof motionState.controls)[number] | null>(null)
      if (!ref.current) {
        ref.current = { start: vi.fn().mockResolvedValue(undefined), set: vi.fn(), stop: vi.fn() }
        motionState.controls.push(ref.current)
      }
      return ref.current
    },
  }
})

let media: MediaQueryList
let change: (matches: boolean) => void
beforeEach(() => {
  localStorage.clear()
  motionState.controls.length = 0
  const events = new EventTarget()
  media = {
    matches: false, media: '(prefers-reduced-motion: reduce)', onchange: null,
    addEventListener: vi.fn(events.addEventListener.bind(events)),
    removeEventListener: vi.fn(events.removeEventListener.bind(events)),
    dispatchEvent: events.dispatchEvent.bind(events), addListener: vi.fn(), removeListener: vi.fn(),
  } as MediaQueryList
  vi.stubGlobal('matchMedia', vi.fn(() => media))
  change = matches => act(() => {
    Object.defineProperty(media, 'matches', { configurable: true, value: matches })
    media.dispatchEvent(new Event('change'))
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })

const sidebar = () => document.getElementById('archive-sidebar')!

describe('NewMax 侧栏开合动效', () => {
  it('初始布局直接到位，收起使用 500ms 无回弹 spring，不用 hidden 中断退场', () => {
    const view = render(<Sidebar open><button>来源</button></Sidebar>)
    expect(motionState.controls).toHaveLength(2)
    const [layout, content] = motionState.controls
    expect(layout.start).not.toHaveBeenCalled()
    expect(layout.set).toHaveBeenLastCalledWith({ width: 240, marginRight: 0, visibility: 'visible' })
    view.rerender(<Sidebar open={false}><button>来源</button></Sidebar>)
    expect(sidebar().hidden).toBe(false)
    expect(sidebar().getAttribute('aria-hidden')).toBe('true')
    expect(sidebar().hasAttribute('inert')).toBe(true)
    expect(screen.queryByRole('button', { name: '来源' })).toBeNull()
    expect(layout.start).toHaveBeenLastCalledWith({
      width: 0, marginRight: 8, transition: { type: 'spring', duration: 0.5, bounce: 0 },
      transitionEnd: { visibility: 'hidden' },
    })
    expect(content.start).toHaveBeenLastCalledWith({ opacity: 0, transition: { delay: 0, duration: 0.18, ease: 'easeOut' } })
  })
  it('展开沿用固定宽度内容画布和 10ms 延迟、160ms 淡入，不挤压或缩放文字', () => {
    localStorage.setItem('pinekin.sidebar-width', '320')
    const view = render(<Sidebar open={false}>内容</Sidebar>)
    const canvas = sidebar().querySelector<HTMLElement>('.sidebar-content')!
    expect(canvas.style.width).toBe('320px')
    view.rerender(<Sidebar open>内容</Sidebar>)
    expect(motionState.controls[0].start).toHaveBeenLastCalledWith({
      width: 320, marginRight: 0, transition: { type: 'spring', duration: 0.5, bounce: 0 },
      transitionEnd: { visibility: 'visible' },
    })
    expect(motionState.controls[1].start).toHaveBeenLastCalledWith({ opacity: 1, transition: { delay: 0.01, duration: 0.16, ease: 'easeOut' } })
    expect(sidebar().getAttribute('aria-hidden')).toBeNull()
    expect(sidebar().hasAttribute('inert')).toBe(false)
    const styles = readFileSync('src/renderer/src/styles.css', 'utf8')
    expect(styles).toMatch(/\.sidebar-content-clip\s*\{[^}]*overflow: clip;/)
    const rule = /\.sidebar-content\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(rule).toContain('flex-direction: column;')
    expect(rule).toContain('container-type: inline-size;')
    expect(rule).not.toMatch(/transform:|transition:/)
    expect(styles).not.toContain('.sidebar[hidden] + .workspace-card')
  })
  it('快速反向切换取消上一段动效，保留子树、滚动位置、输入与保存宽度', () => {
    const view = render(<Sidebar open><input aria-label="测试输入" defaultValue="保留" /><div data-testid="scroll">内容</div></Sidebar>)
    const input = screen.getByRole('textbox')
    const scroll = screen.getByTestId('scroll')
    scroll.scrollTop = 120
    const stops = motionState.controls[0].stop.mock.calls.length
    view.rerender(<Sidebar open={false}><input aria-label="测试输入" defaultValue="保留" /><div data-testid="scroll">内容</div></Sidebar>)
    view.rerender(<Sidebar open><input aria-label="测试输入" defaultValue="保留" /><div data-testid="scroll">内容</div></Sidebar>)
    expect(motionState.controls[0].stop.mock.calls.length).toBeGreaterThan(stops)
    expect(screen.getByRole('textbox')).toBe(input)
    expect((input as HTMLInputElement).value).toBe('保留')
    expect(screen.getByTestId('scroll').scrollTop).toBe(120)
    expect(localStorage.getItem('pinekin.sidebar-width')).toBeNull()
    expect(motionState.controls[0].set).toHaveBeenLastCalledWith({ visibility: 'visible' })
  })
  it('拖拽逐帧跟手，不启动 spring；收起时清理拖拽和全局光标', () => {
    const view = render(<Sidebar open>内容</Sidebar>)
    const handle = screen.getByRole('separator', { name: '调整侧栏宽度' })
    const pointer = (target: HTMLElement | Window, type: string, clientX: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, buttons: 1, clientX })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      fireEvent(target, event)
    }
    pointer(handle, 'pointerdown', 240)
    expect(document.body.style.cursor).toBe('col-resize')
    pointer(window, 'pointermove', 300)
    expect(motionState.controls[0].set).toHaveBeenLastCalledWith({ width: 300, marginRight: 0, visibility: 'visible' })
    expect(motionState.controls[0].start).not.toHaveBeenCalled()
    view.rerender(<Sidebar open={false}>内容</Sidebar>)
    expect(document.body.style.cursor).not.toBe('col-resize')
    expect(screen.queryByRole('separator')).toBeNull()
  })
  it.each([true, false])('系统减少动画从初始 %s 开始时，开关切换立即到位', initial => {
    change(initial)
    const view = render(<Sidebar open>内容</Sidebar>)
    if (!initial) {
      view.rerender(<Sidebar open={false}>内容</Sidebar>)
      expect(motionState.controls[0].start).toHaveBeenCalledOnce()
      change(true)
    } else view.rerender(<Sidebar open={false}>内容</Sidebar>)
    expect(motionState.controls[0].set).toHaveBeenLastCalledWith({ width: 0, marginRight: 8, visibility: 'hidden' })
    expect(motionState.controls[1].set).toHaveBeenLastCalledWith({ opacity: 0 })
    view.rerender(<Sidebar open>内容</Sidebar>)
    expect(motionState.controls[0].set).toHaveBeenLastCalledWith({ width: 240, marginRight: 0, visibility: 'visible' })
    expect(motionState.controls[1].set).toHaveBeenLastCalledWith({ opacity: 1 })
  })
  it('没有 matchMedia 仍可开合，卸载取消动画并移除媒体监听', () => {
    vi.stubGlobal('matchMedia', undefined)
    const first = render(<Sidebar open>内容</Sidebar>)
    first.rerender(<Sidebar open={false}>内容</Sidebar>)
    expect(motionState.controls[0].start).toHaveBeenCalledOnce()
    first.unmount()
    expect(motionState.controls[0].stop).toHaveBeenCalled()
    vi.stubGlobal('matchMedia', vi.fn(() => media))
    const second = render(<Sidebar open>内容</Sidebar>)
    expect(media.addEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    second.unmount()
    expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
  })
})

describe('NewMax 专用侧栏图标', () => {
  it.each([
    ['panel-open', 'M7.75 8C8.16421 8 8.5 8.33579'],
    ['panel-closed', '19H9V5H6.5'],
  ] as const)('%s 复用原始填充 SVG 路径，尺寸、颜色继承和可访问性不变', (name, path) => {
    const { container } = render(<DesignIcon name={name} size={20} />)
    const icon = container.querySelector('svg')!
    expect(icon.classList.contains('lucide')).toBe(false)
    expect(icon.getAttribute('width')).toBe('20')
    expect(icon.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.getAttribute('focusable')).toBe('false')
    expect(icon.querySelector('path')!.getAttribute('fill')).toBe('currentColor')
    expect(icon.querySelector('path')!.getAttribute('d')).toContain(path)
  })
})
