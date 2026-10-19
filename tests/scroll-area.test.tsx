// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { buildScrollMask, ScrollArea } from '../src/renderer/src/components/ScrollArea'

let width = 100, height = 100, contentWidth = 100, contentHeight = 300
const resizeObservers: { callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
const mutationObservers: { callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
let frames: Map<number, FrameRequestCallback>
let frameId = 0
function flushFrames() {
  act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)) })
}
function mask(element: HTMLElement) { return element.style.maskImage || 'none' }

beforeEach(() => {
  width = height = contentWidth = 100; contentHeight = 300
  frames = new Map(); resizeObservers.length = 0; mutationObservers.length = 0
  // jsdom 会拒绝含 34 个色标的双端平滑梯度；单测检查原始值，Electron E2E 检查真实 CSS。
  const masks = new WeakMap<CSSStyleDeclaration, string>()
  const declaration = Object.getPrototypeOf(document.createElement('div').style) as CSSStyleDeclaration
  vi.spyOn(declaration, 'maskImage', 'get').mockImplementation(function (this: CSSStyleDeclaration) { return masks.get(this) ?? '' })
  vi.spyOn(declaration, 'maskImage', 'set').mockImplementation(function (this: CSSStyleDeclaration, value: string) { masks.set(this, value) })
  for (const [name, value] of Object.entries({ clientWidth: () => width, clientHeight: () => height, scrollWidth: () => contentWidth, scrollHeight: () => contentHeight })) {
    vi.spyOn(HTMLElement.prototype, name as 'clientWidth', 'get').mockImplementation(value)
  }
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)))
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn()
    constructor(public callback: () => void) { resizeObservers.push(this) }
  })
  vi.stubGlobal('MutationObserver', class {
    observe = vi.fn(); disconnect = vi.fn()
    constructor(public callback: () => void) { mutationObservers.push(this) }
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('NewMax ScrollArea mask 本地适配', () => {
  it('48px 渐隐对齐 NewMax 侧栏，保留每端 17 个采样点与 smootherstep 曲线', () => {
    expect(buildScrollMask('to bottom', false, false)).toBeUndefined()
    const start = buildScrollMask('to bottom', true, false)!
    expect(start).toContain('transparent 0px, rgba(0, 0, 0, 0.002) 3px')
    expect(start).toContain('rgba(0, 0, 0, 0.5) 24px')
    expect(start).toContain('black 48px, black 100%')
    const both = buildScrollMask('to right', true, true)!
    expect(both).toContain('black 48px, black calc(100% - 48px)')
    expect(both).toContain('transparent 100%')
    expect(both.match(/rgba\(/g)).toHaveLength(30)
  })
  it('实际滚动视口的横纵轴均使用加宽后的 48px mask', () => {
    contentWidth = 300
    const view = render(<ScrollArea>内容</ScrollArea>)
    const element = view.container.firstElementChild as HTMLElement
    flushFrames()
    expect(mask(element).match(/calc\(100% - 48px\)/g)).toHaveLength(2)
    element.scrollTop = element.scrollLeft = 100
    fireEvent.scroll(element); flushFrames()
    expect(mask(element).match(/black 48px/g)).toHaveLength(2)
  })
  it('底部悬浮操作只加高下沿 mask，出现和消失均保留视口与滚动位置', () => {
    height = 300; contentHeight = 900; contentWidth = 300
    const view = render(<ScrollArea>内容</ScrollArea>)
    const element = view.container.firstElementChild as HTMLElement
    element.scrollTop = 100
    fireEvent.scroll(element); flushFrames()
    const normal = mask(element)
    view.rerender(<ScrollArea bottomOverlayHeight={96}>内容</ScrollArea>); flushFrames()
    expect(view.container.firstElementChild).toBe(element)
    expect(element.scrollTop).toBe(100)
    expect(mask(element)).toBe([
      buildScrollMask('to bottom', true, true, 48, 96),
      buildScrollMask('to right', false, true),
    ].join(', '))
    expect(element.hasAttribute('bottomOverlayHeight')).toBe(false)
    view.rerender(<ScrollArea>内容</ScrollArea>); flushFrames()
    expect(mask(element)).toBe(normal)
    expect(element.scrollTop).toBe(100)
  })
  it('悬浮操作显示时到达列表底部或内容不足一屏仍保留下沿遮罩，隐藏视口不设置遮罩', () => {
    height = 300; contentHeight = 900
    const view = render(<ScrollArea bottomOverlayHeight={96}>内容</ScrollArea>)
    const element = view.container.firstElementChild as HTMLElement
    element.scrollTop = 600
    fireEvent.scroll(element); flushFrames()
    expect(mask(element)).toBe(buildScrollMask('to bottom', true, true, 48, 96))
    contentHeight = 200; element.scrollTop = 0
    fireEvent.scroll(element); flushFrames()
    expect(mask(element)).toBe(buildScrollMask('to bottom', false, true, 48, 96))
    width = height = 0
    fireEvent.scroll(element); flushFrames()
    expect(mask(element)).toBe('none')
  })
  it('4px 边界容差内保持该侧完全可见，双轴使用交集而非覆盖', () => {
    contentWidth = 300
    const view = render(<ScrollArea>内容</ScrollArea>)
    const element = view.container.firstElementChild as HTMLElement
    element.scrollTop = element.scrollLeft = 4
    fireEvent.scroll(element); flushFrames()
    const start = mask(element)
    element.scrollTop = element.scrollLeft = 4.5
    fireEvent.scroll(element); flushFrames()
    expect(mask(element)).not.toBe(start)
    expect(element.style.maskComposite).toBe('intersect')
    expect(element.style.webkitMaskComposite).toBe('source-in')
    element.scrollTop = element.scrollLeft = 196
    fireEvent.scroll(element); flushFrames()
    expect(mask(element)).not.toContain('transparent 100%')
  })
  it('不增加包装节点，保留语义、ref、样式与事件', () => {
    const ref = createRef<HTMLPreElement>()
    const onScroll = vi.fn()
    const view = render(<ScrollArea as="pre" ref={ref} className="preview" aria-label="代码" tabIndex={0} style={{ maxHeight: 200 }} onScroll={onScroll}><code>只读文本</code></ScrollArea>)
    const element = view.container.firstElementChild as HTMLPreElement
    expect(element.tagName).toBe('PRE')
    expect(element.classList.contains('ds-scroll-area')).toBe(true)
    expect(element.classList.contains('preview')).toBe(true)
    expect(element.getAttribute('aria-label')).toBe('代码')
    expect(element.tabIndex).toBe(0)
    expect(element.style.maxHeight).toBe('200px')
    expect(ref.current).toBe(element)
    expect(element.firstElementChild?.tagName).toBe('CODE')
    fireEvent.scroll(element)
    expect(onScroll).toHaveBeenCalledOnce()
  })
  it('无溢出、隐藏或亚像素误差时不遮罩', () => {
    contentHeight = 100
    const view = render(<ScrollArea>短内容</ScrollArea>)
    const element = view.container.firstElementChild as HTMLElement
    flushFrames()
    expect(mask(element)).toBe('none')
    contentHeight = 100.5
    act(() => resizeObservers[0].callback()); flushFrames()
    expect(mask(element)).toBe('none')
    width = height = 0; contentHeight = 300
    act(() => resizeObservers[0].callback()); flushFrames()
    expect(mask(element)).toBe('none')
  })
  it('纵向滚动只渐隐仍有内容的一侧，到达末尾立即恢复末端', () => {
    const view = render(<ScrollArea>长内容</ScrollArea>)
    const element = view.container.firstElementChild as HTMLElement
    flushFrames()
    const start = mask(element)
    expect(start).toContain('linear-gradient(to bottom')
    expect(start).not.toBe('none')
    element.scrollTop = 100
    fireEvent.scroll(element); flushFrames()
    const middle = mask(element)
    expect(middle).not.toBe(start)
    expect(middle).toContain('transparent')
    element.scrollTop = 200
    fireEvent.scroll(element); flushFrames()
    expect(mask(element)).not.toBe(middle)
    expect(mask(element)).not.toBe(start)
    element.scrollTop = 199.5
    fireEvent.scroll(element); flushFrames()
    const end = mask(element)
    element.scrollTop = 200
    fireEvent.scroll(element); flushFrames()
    expect(mask(element)).toBe(end)
  })
  it('横向代码也根据左右边界渐隐，双轴溢出保留两层 mask', () => {
    contentHeight = 100; contentWidth = 300
    const view = render(<ScrollArea as="pre"><code>长代码</code></ScrollArea>)
    const element = view.container.firstElementChild as HTMLElement
    flushFrames()
    const start = mask(element)
    expect(start).toContain('linear-gradient(to right')
    expect(start).not.toContain('to bottom')
    element.scrollLeft = 100
    fireEvent.scroll(element); flushFrames()
    expect(mask(element)).not.toBe(start)
    const middle = mask(element)
    element.scrollLeft = 200
    fireEvent.scroll(element); flushFrames()
    expect(mask(element)).not.toBe(middle)
    contentHeight = 300
    act(() => resizeObservers[0].callback()); flushFrames()
    expect(mask(element)).toContain('to bottom')
    expect(mask(element)).toContain('to right')
  })
  it('内容和子节点尺寸改变后重测，滚动事件按帧合并且卸载清理', () => {
    const view = render(<ScrollArea><div>内容</div></ScrollArea>)
    const element = view.container.firstElementChild as HTMLElement
    flushFrames()
    expect(resizeObservers[0].observe).toHaveBeenCalledWith(element)
    expect(resizeObservers[0].observe).toHaveBeenCalledWith(element.firstElementChild)
    contentHeight = 80
    act(() => mutationObservers[0].callback()); flushFrames()
    expect(mask(element)).toBe('none')
    contentHeight = 300
    fireEvent(window, new Event('resize')); flushFrames()
    expect(mask(element)).not.toBe('none')
    view.rerender(<ScrollArea><div>更新后短内容</div><div>新增节点</div></ScrollArea>)
    act(() => mutationObservers[0].callback()); flushFrames()
    expect(resizeObservers[0].observe).toHaveBeenCalledWith(element.lastElementChild)
    fireEvent.scroll(element); fireEvent.scroll(element); fireEvent.scroll(element)
    expect(frames.size).toBe(1)
    view.unmount()
    expect(frames.size).toBe(0)
    expect(resizeObservers[0].disconnect).toHaveBeenCalled()
    expect(mutationObservers[0].disconnect).toHaveBeenCalledOnce()
  })
  it('缺少观察器时仍可通过滚动和窗口 resize 更新', () => {
    vi.stubGlobal('ResizeObserver', undefined); vi.stubGlobal('MutationObserver', undefined)
    const view = render(<ScrollArea>内容</ScrollArea>)
    const element = view.container.firstElementChild as HTMLElement
    flushFrames()
    expect(mask(element)).not.toBe('none')
    contentHeight = 80
    fireEvent.scroll(element); flushFrames()
    expect(mask(element)).toBe('none')
    contentHeight = 300
    fireEvent(window, new Event('resize')); flushFrames()
    expect(mask(element)).not.toBe('none')
  })
})
