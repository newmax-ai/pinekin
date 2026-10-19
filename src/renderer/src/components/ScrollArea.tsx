import { useImperativeHandle, useLayoutEffect, useRef, type HTMLAttributes, type Ref } from 'react'

const EDGE_THRESHOLD = 4
// 对齐 NewMax 侧栏实际调用的 fadeHeight，而非上游组件的 24px 默认值。
const FADE_SIZE = 48
const SAMPLE_COUNT = 16
const samples = Array.from({ length: SAMPLE_COUNT + 1 }, (_, index) => {
  const ratio = index / SAMPLE_COUNT
  return { ratio, alpha: ratio ** 3 * (ratio * (ratio * 6 - 15) + 10) }
})
const pixels = (value: number) => `${Math.round(value * 100) / 100}px`
function color(alpha: number) {
  if (alpha <= 0) return 'transparent'
  if (alpha >= 1) return 'black'
  return `rgba(0, 0, 0, ${Math.round(alpha * 1000) / 1000})`
}

// 本地适配 NewMax smoothMaskGradient 的 16 段 smootherstep，不依赖宿主运行时。
export function buildScrollMask(direction: 'to bottom' | 'to right', start: boolean, end: boolean, fadeSize = FADE_SIZE, endFadeSize = fadeSize) {
  if (!start && !end) return undefined
  const stops = start ? samples.map(({ ratio, alpha }) => `${color(alpha)} ${pixels(fadeSize * ratio)}`) : ['black 0px']
  if (end) {
    for (const { ratio, alpha } of samples) {
      const remaining = endFadeSize * (1 - ratio)
      stops.push(`${color(1 - alpha)} ${remaining <= 0.005 ? '100%' : `calc(100% - ${pixels(remaining)})`}`)
    }
  } else stops.push('black 100%')
  return `linear-gradient(${direction}, ${stops.join(', ')})`
}

type Viewport = HTMLDivElement | HTMLPreElement
type ScrollAreaProps = HTMLAttributes<Viewport> & { as?: 'div' | 'pre'; ref?: Ref<Viewport>; bottomOverlayHeight?: number }

// 不增加布局包装层：原生滚动、键盘、选择与业务事件仍由同一个视口承载。
export function ScrollArea({ as: Tag = 'div', ref, className = '', children, bottomOverlayHeight = 0, ...props }: ScrollAreaProps) {
  const viewport = useRef<Viewport | null>(null)
  const refresh = useRef<(() => void) | null>(null)
  useImperativeHandle(ref, () => viewport.current!, [Tag])

  useLayoutEffect(() => {
    const element = viewport.current!
    let active = true
    let frame: number | undefined
    const observed = new Set<Element>()
    const update = () => {
      frame = undefined
      if (!active) return
      const { clientWidth, clientHeight, scrollWidth, scrollHeight } = element
      const visible = clientWidth > 0 && clientHeight > 0
      const verticalOverflow = scrollHeight - clientHeight > EDGE_THRESHOLD
      // 底部有悬浮操作时，即使已滚到底或不足一屏，也淡出其下方内容；上沿与横轴不变。
      const vertical = visible && (verticalOverflow || bottomOverlayHeight > 0)
        ? buildScrollMask('to bottom', verticalOverflow && element.scrollTop > EDGE_THRESHOLD,
          bottomOverlayHeight > 0 || scrollHeight - clientHeight - element.scrollTop > EDGE_THRESHOLD,
          FADE_SIZE, bottomOverlayHeight > 0 ? bottomOverlayHeight : FADE_SIZE)
        : undefined
      const horizontal = visible && scrollWidth - clientWidth > EDGE_THRESHOLD
        ? buildScrollMask('to right', element.scrollLeft > EDGE_THRESHOLD, scrollWidth - clientWidth - element.scrollLeft > EDGE_THRESHOLD)
        : undefined
      const masks = [vertical, horizontal].filter(Boolean)
      const image = masks.join(', ') || 'none'
      element.style.maskImage = image
      element.style.webkitMaskImage = image
      element.style.maskComposite = masks.length === 2 ? 'intersect' : 'add'
      element.style.webkitMaskComposite = masks.length === 2 ? 'source-in' : 'source-over'
    }
    const schedule = () => {
      if (active && frame === undefined) frame = requestAnimationFrame(update)
    }
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    const observeChildren = () => {
      const current = new Set<Element>([element, ...element.children])
      for (const child of observed) {
        if (!current.has(child)) { resize?.unobserve(child); observed.delete(child) }
      }
      for (const child of current) {
        if (!observed.has(child)) { resize?.observe(child); observed.add(child) }
      }
    }
    const mutation = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(() => { observeChildren(); schedule() })
    observeChildren()
    // 不监听自身 style，避免写入 mask 触发观察器循环；文本原地更新也需要重测。
    mutation?.observe(element, { childList: true, subtree: true, characterData: true })
    element.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    document.fonts?.ready.then(schedule)
    refresh.current = schedule
    update()
    return () => {
      active = false
      refresh.current = null
      if (frame !== undefined) cancelAnimationFrame(frame)
      resize?.disconnect()
      mutation?.disconnect()
      element.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [Tag, bottomOverlayHeight])
  useLayoutEffect(() => { refresh.current?.() }, [children])

  return <Tag {...props} ref={(element: Viewport | null) => { viewport.current = element }} className={`ds-scroll-area ${className}`}>{children}</Tag>
}
