// @vitest-environment jsdom
import { useContentSizedDialog } from '../src/renderer/src/components/useContentSizedDialog'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let headerHeight = 80, bodyHeight = 220, footerHeight = 70, viewportHeight = 900
let frames: Map<number, FrameRequestCallback>, nextFrame = 0
const observers: { callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
const mutations: { callback: () => void; disconnect: ReturnType<typeof vi.fn> }[] = []
function flush() { act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)) }) }
function Harness({ closing = false }: { closing?: boolean }) {
  const { viewportRef, contentRef } = useContentSizedDialog()
  return <dialog open data-state={closing ? 'closing' : 'open'}>
    <div className="dialog-header">标题</div>
    <div ref={viewportRef} style={{ paddingTop: 4, paddingBottom: 20 }}><div ref={contentRef}>自然内容</div></div>
    <div className="dialog-footer">完成</div>
  </dialog>
}
beforeEach(() => {
  headerHeight = 80; bodyHeight = 220; footerHeight = 70; viewportHeight = 900
  observers.length = 0; mutations.length = 0; frames = new Map(); nextFrame = 0
  vi.stubGlobal('innerHeight', viewportHeight)
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => viewportHeight })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('dialog-header') ? headerHeight : this.classList.contains('dialog-footer') ? footerHeight : bodyHeight
  })
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)))
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn(); disconnect = vi.fn()
    constructor(public callback: () => void) { observers.push(this) }
  })
  vi.stubGlobal('MutationObserver', class {
    observe = vi.fn(); disconnect = vi.fn()
    constructor(public callback: () => void) { mutations.push(this) }
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('随内容伸缩的弹窗尺寸', () => {
  it('初始高度只取真实标题、正文、内边距与页脚，不默认占满 760px', () => {
    const view = render(<Harness />), dialog = view.container.querySelector('dialog')!
    expect(dialog.style.height).toBe('394px')
    expect(observers).toHaveLength(1)
    expect(observers[0].observe).toHaveBeenCalledTimes(3)
    expect(observers[0].observe.mock.calls.flat()).not.toContain(dialog)
    expect(observers[0].observe.mock.calls.flat()).not.toContain(dialog.children[1])
  })
  it('正文变长和变短都会更新数值高度，支持 CSS 在两个真实尺寸间过渡', () => {
    const view = render(<Harness />), dialog = view.container.querySelector('dialog')!
    bodyHeight = 380; observers[0].callback(); flush()
    expect(dialog.style.height).toBe('554px')
    bodyHeight = 100; observers[0].callback(); flush()
    expect(dialog.style.height).toBe('274px')
  })
  it('只在超过视口时收紧，不把窗口较大当作扩高理由', () => {
    const view = render(<Harness />), dialog = view.container.querySelector('dialog')!
    bodyHeight = 2000; observers[0].callback(); flush()
    expect(dialog.style.height).toBe('836px')
    bodyHeight = 100; observers[0].callback(); flush()
    expect(dialog.style.height).toBe('274px')
    viewportHeight = 1400; fireEvent(window, new Event('resize')); flush()
    expect(dialog.style.height).toBe('274px')
  })
  it('窗口缩小后重新限高，恢复后仍以自然内容高度为准', () => {
    const view = render(<Harness />), dialog = view.container.querySelector('dialog')!
    viewportHeight = 300; fireEvent(window, new Event('resize')); flush()
    expect(dialog.style.height).toBe('236px')
    viewportHeight = 900; fireEvent(window, new Event('resize')); flush()
    expect(dialog.style.height).toBe('394px')
  })
  it('多次尺寸通知每帧只测量一次，不观察自身动画高度导致反馈循环', () => {
    render(<Harness />)
    const count = vi.mocked(requestAnimationFrame).mock.calls.length
    observers[0].callback(); observers[0].callback(); observers[0].callback()
    expect(vi.mocked(requestAnimationFrame).mock.calls.length - count).toBe(1)
    expect(frames.size).toBe(1)
    flush()
    expect(frames.size).toBe(0)
  })
  it('未形成可测量内容时不把弹窗压到零，后来可恢复自然测量', () => {
    headerHeight = bodyHeight = footerHeight = 0
    const view = render(<Harness />), dialog = view.container.querySelector('dialog')!
    expect(dialog.style.height).toBe('')
    headerHeight = 80; bodyHeight = 220; footerHeight = 70
    observers[0].callback(); flush()
    expect(dialog.style.height).toBe('394px')
  })
  it('没有 ResizeObserver 时用有界的内容变动通知回退，不依赖轮询定时器', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const view = render(<Harness />), dialog = view.container.querySelector('dialog')!
    expect(dialog.style.height).toBe('394px')
    expect(mutations).toHaveLength(1)
    bodyHeight = 330; mutations[0].callback(); flush()
    expect(dialog.style.height).toBe('504px')
  })
  it('退场期间停止修改尺寸，避免覆盖共享关闭动效', () => {
    const view = render(<Harness />), dialog = view.container.querySelector('dialog')!
    view.rerender(<Harness closing />)
    bodyHeight = 400; observers[0].callback(); flush()
    expect(dialog.style.height).toBe('394px')
  })
  it('卸载清理观察器、待执行帧与窗口监听，不在旧节点上继续改高度', () => {
    const view = render(<Harness />)
    observers[0].callback()
    expect(frames.size).toBe(1)
    view.unmount()
    expect(observers[0].disconnect).toHaveBeenCalledOnce()
    expect(frames.size).toBe(0)
    fireEvent(window, new Event('resize'))
    observers[0].callback()
    expect(frames.size).toBe(0)
  })
})
