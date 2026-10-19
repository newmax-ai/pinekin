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

describe('ScrollArea 选中项避开渐隐区域', () => {
  const selector = '[aria-pressed="true"]'
  function geometry(viewport: HTMLElement, target: HTMLElement, top: number, targetHeight = 64) {
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 20, width, height))
    vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 20 + top - viewport.scrollTop, width, targetHeight))
  }
  function setup(top: number, scrollTop = 100, overlay = 0, targetHeight = 64, scrollTo?: HTMLElement['scrollTo']) {
    height = 300; contentHeight = 1000
    const view = render(<ScrollArea bottomOverlayHeight={overlay}><button aria-pressed="true">会话</button></ScrollArea>)
    const viewport = view.container.firstElementChild as HTMLElement
    const target = viewport.firstElementChild as HTMLElement
    viewport.scrollTop = scrollTop
    geometry(viewport, target, top, targetHeight)
    if (scrollTo) viewport.scrollTo = scrollTo
    view.rerender(<ScrollArea revealSelector={selector} bottomOverlayHeight={overlay}><button aria-pressed="true">会话</button></ScrollArea>)
    return { view, viewport, target }
  }
  it.each([
    ['上沿渐隐内', 110, 100, 62],
    ['下沿渐隐内', 320, 100, 132],
    ['视口上方', 40, 300, 0],
    ['视口下方', 600, 100, 412],
    ['不透明安全区内', 180, 100, 100],
    ['首项且已在顶部', 4, 0, 0],
    ['末项且已在底部', 924, 700, 700],
    ['上沿 4px 容差内', 50, 100, 0],
    ['下沿 4px 容差内', 885, 500, 700],
  ])('%s：整张卡片以最小位移显示', (_name, top, scrollTop, expected) => {
    const { viewport } = setup(top, scrollTop)
    expect(viewport.scrollTop).toBe(expected)
    expect(viewport.scrollLeft).toBe(0)
    expect(viewport.hasAttribute('revealSelector')).toBe(false)
  })
  it('定位使用原生平滑滚动，不直接跳到终点或改变横向位置', () => {
    const scrollTo = vi.fn()
    const matchMedia = vi.fn().mockReturnValue({ matches: false })
    vi.stubGlobal('matchMedia', matchMedia)
    const { viewport } = setup(320, 100, 0, 64, scrollTo)
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 132, behavior: 'smooth' })
    expect(viewport.scrollTop).toBe(100)
  })
  it('每次定位读取减少动态效果设置，启用后立即定位', () => {
    const scrollTo = vi.fn()
    const preference = { matches: false }
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(preference))
    const { target } = setup(320, 100, 0, 64, scrollTo)
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 132, behavior: 'smooth' })
    preference.matches = true
    fireEvent.click(target)
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 132, behavior: 'instant' })
  })
  it('没有媒体查询 API 时仍平滑定位，安全区内不发起滚动', () => {
    vi.stubGlobal('matchMedia', undefined)
    const scrollTo = vi.fn()
    setup(180, 100, 0, 64, scrollTo)
    expect(scrollTo).not.toHaveBeenCalled()
    cleanup()
    setup(320, 100, 0, 64, scrollTo)
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 132, behavior: 'smooth' })
  })
  it.each([['在安全区', 280, 180, 'instant'], ['在屏幕上方', 40, 0, 'smooth']] as const)('动画途中切换到%s的新选中项时覆盖旧目标', (_name, top, expected, behavior) => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }))
    const scrollTo = vi.fn()
    const { view, viewport } = setup(600, 100, 0, 64, scrollTo)
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 412, behavior: 'smooth' })
    // 模拟浏览器只走完一部分动画，而不是同步把 scrollTop 改到终点。
    viewport.scrollTop = 180
    view.rerender(<ScrollArea revealSelector={selector}><button aria-pressed="false">会话</button><button aria-pressed="false">下一条</button></ScrollArea>)
    const next = viewport.lastElementChild as HTMLElement
    geometry(viewport, next, top)
    view.rerender(<ScrollArea revealSelector={selector}><button aria-pressed="false">会话</button><button aria-pressed="true">下一条</button></ScrollArea>)
    expect(scrollTo).toHaveBeenCalledTimes(2)
    expect(scrollTo).toHaveBeenLastCalledWith({ top: expected, behavior })
  })
  it('动画期间的滚动事件和普通重渲染不会重复启动定位', () => {
    const scrollTo = vi.fn()
    const { view, viewport } = setup(600, 100, 0, 64, scrollTo)
    viewport.scrollTop = 180
    fireEvent.scroll(viewport); flushFrames()
    view.rerender(<ScrollArea revealSelector={selector}><button aria-pressed="true">新标题</button></ScrollArea>)
    act(() => mutationObservers[0].callback()); flushFrames()
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 412, behavior: 'smooth' })
  })
  it('底部更新提示使用 96px 安全区，不沿用默认 48px', () => {
    const { viewport } = setup(290, 100, 96)
    expect(viewport.scrollTop).toBe(150)
  })
  it('更新提示出现不抢走手动滚动位置，再次选中才使用加高后的安全区', () => {
    const { view, viewport, target } = setup(320)
    viewport.scrollTop = 500
    view.rerender(<ScrollArea revealSelector={selector} bottomOverlayHeight={96}><button aria-pressed="true">会话</button></ScrollArea>)
    expect(viewport.scrollTop).toBe(500)
    viewport.scrollTop = 100
    fireEvent.click(target)
    expect(viewport.scrollTop).toBe(180)
  })
  it('底部预留悬浮提示空间后，末项也能完整移到 96px 遮罩上方', () => {
    const { viewport, target } = setup(924, 100, 96)
    contentHeight = 1096
    fireEvent.click(target)
    expect(viewport.scrollTop).toBe(784)
    expect(target.getBoundingClientRect().bottom).toBe(20 + height - 96)
  })
  it('选中末项时滚动不越过实际范围，超高卡片优先显示顶部', () => {
    expect(setup(924, 100).viewport.scrollTop).toBe(700)
    cleanup()
    expect(setup(400, 100, 0, 280).viewport.scrollTop).toBe(352)
  })
  it('已选中项再次点击或键盘聚焦时也避开 mask，不滚动外层容器', () => {
    const { viewport, target } = setup(320)
    const parent = viewport.parentElement!
    parent.scrollTop = 70
    viewport.scrollTop = 100
    fireEvent.click(target)
    expect(viewport.scrollTop).toBe(132)
    viewport.scrollTop = 100
    fireEvent.focusIn(target)
    expect(viewport.scrollTop).toBe(132)
    expect(parent.scrollTop).toBe(70)
  })
  it('手动滚动与无关重渲染不把列表拉回选中项', () => {
    const { view, viewport } = setup(320)
    viewport.scrollTop = 500
    fireEvent.scroll(viewport); flushFrames()
    view.rerender(<ScrollArea revealSelector={selector}><button aria-pressed="true">更新后的标题</button></ScrollArea>)
    act(() => mutationObservers[0].callback()); flushFrames()
    expect(viewport.scrollTop).toBe(500)
  })
  it('搜索、历史导航或异步列表出现新选中节点后重新定位', () => {
    const { view, viewport, target } = setup(180)
    view.rerender(<ScrollArea revealSelector={selector}><button aria-pressed="false">会话</button><button aria-pressed="false">下一条</button></ScrollArea>)
    const next = viewport.lastElementChild as HTMLElement
    geometry(viewport, next, 600)
    view.rerender(<ScrollArea revealSelector={selector}><button aria-pressed="false">会话</button><button aria-pressed="true">下一条</button></ScrollArea>)
    expect(viewport.scrollTop).toBe(412)
    expect(target.getAttribute('aria-pressed')).toBe('false')
    geometry(viewport, target, 110)
    view.rerender(<ScrollArea revealSelector={selector}><button aria-pressed="true">会话</button><button aria-pressed="false">下一条</button></ScrollArea>)
    expect(viewport.scrollTop).toBe(62)
  })
  it('窗口缩小或卡片尺寸变化后重测，隐藏视口恢复时再定位', () => {
    const { viewport } = setup(320)
    height = 200
    act(() => resizeObservers.at(-1)!.callback()); flushFrames()
    expect(viewport.scrollTop).toBe(232)
    height = 0; viewport.scrollTop = 100
    act(() => resizeObservers.at(-1)!.callback()); flushFrames()
    expect(viewport.scrollTop).toBe(100)
    height = 300
    act(() => resizeObservers.at(-1)!.callback()); flushFrames()
    expect(viewport.scrollTop).toBe(132)
  })
  it('未启用或没有选中项时不调整滚动，卸载后移除交互监听', () => {
    const { view, viewport, target } = setup(320)
    const remove = vi.spyOn(viewport, 'removeEventListener')
    view.rerender(<ScrollArea><button aria-pressed="true">会话</button></ScrollArea>)
    viewport.scrollTop = 100
    fireEvent.click(target); fireEvent.focusIn(target)
    expect(viewport.scrollTop).toBe(100)
    view.rerender(<ScrollArea revealSelector={selector}><button aria-pressed="false">会话</button></ScrollArea>)
    expect(viewport.scrollTop).toBe(100)
    view.unmount()
    expect(remove).toHaveBeenCalledWith('click', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('focusin', expect.any(Function))
  })
})

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
