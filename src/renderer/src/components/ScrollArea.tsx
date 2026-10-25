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
type ScrollAreaProps = HTMLAttributes<Viewport> & { as?: 'div' | 'pre'; ref?: Ref<Viewport>; bottomOverlayHeight?: number; bottomFadeSize?: number; revealSelector?: string }

// 不增加布局包装层：原生滚动、键盘、选择与业务事件仍由同一个视口承载。
export function ScrollArea({ as: Tag = 'div', ref, className = '', children, bottomOverlayHeight = 0, bottomFadeSize = FADE_SIZE, revealSelector, ...props }: ScrollAreaProps) {
  const viewport = useRef<Viewport | null>(null)
  const refresh = useRef<(() => void) | null>(null)
  const scrollDestination = useRef<number | null>(null)
  const revealed = useRef<{ target: Element; width: number; height: number; targetHeight: number } | null>(null)
  useImperativeHandle(ref, () => viewport.current!, [Tag])

  useLayoutEffect(() => {
    const element = viewport.current!
    let active = true
    let frame: number | undefined
    const observed = new Set<Element>()
    const revealSelection = (force = false) => {
      const target = revealSelector ? element.querySelector(revealSelector) : null
      const { clientWidth: width, clientHeight: height } = element
      if (!target || width <= 0 || height <= 0) { revealed.current = null; return }
      const rect = target.getBoundingClientRect()
      if (rect.height <= 0) { revealed.current = null; return }
      const previous = revealed.current
      if (!force && previous?.target === target && previous.width === width && previous.height === height && previous.targetHeight === rect.height) return
      revealed.current = { target, width, height, targetHeight: rect.height }
      const maxScroll = Math.max(0, element.scrollHeight - height)
      const current = element.scrollTop
      const top = rect.top - element.getBoundingClientRect().top - element.clientTop + current
      const bottom = top + rect.height
      const startInset = current > EDGE_THRESHOLD ? FADE_SIZE : 0
      const endInset = bottomOverlayHeight > 0 ? bottomOverlayHeight : maxScroll - current > EDGE_THRESHOLD ? bottomFadeSize : 0
      let next = current
      // 不调用 scrollIntoView，避免同时移动外层页面；超高项优先展示开头。
      if (top < current + startInset || rect.height > height - startInset - endInset) next = top - FADE_SIZE
      else if (bottom > current + height - endInset) next = bottom - height + (bottomOverlayHeight || bottomFadeSize)
      next = Math.max(0, Math.min(maxScroll, next))
      // 到达边界容差时直接贴边，让该端 mask 确实关闭。
      if (next <= EDGE_THRESHOLD) next = 0
      else if (!bottomOverlayHeight && maxScroll - next <= EDGE_THRESHOLD) next = maxScroll
      if (next !== current) {
        if (typeof element.scrollTo === 'function') {
          const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
          element.scrollTo({ top: next, behavior })
          scrollDestination.current = behavior === 'smooth' ? next : null
        } else element.scrollTop = next
      } else if (scrollDestination.current !== null) {
        // 新选中项已在安全区时，停止旧动画，避免它继续把新选中项带入 mask。
        if (scrollDestination.current !== current) element.scrollTo({ top: current, behavior: 'instant' })
        scrollDestination.current = null
      }
    }
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
          FADE_SIZE, bottomOverlayHeight > 0 ? bottomOverlayHeight : bottomFadeSize)
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
    const refreshSelection = () => { revealSelection(); schedule() }
    const revealInteracted = (event: Event) => {
      if (revealSelector && event.target instanceof Element && event.target.closest(revealSelector) === element.querySelector(revealSelector)) {
        revealSelection(true); schedule()
      }
    }
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(refreshSelection)
    const observeChildren = () => {
      const current = new Set<Element>([element, ...element.children])
      for (const child of observed) {
        if (!current.has(child)) { resize?.unobserve(child); observed.delete(child) }
      }
      for (const child of current) {
        if (!observed.has(child)) { resize?.observe(child); observed.add(child) }
      }
    }
    const mutation = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(() => { observeChildren(); refreshSelection() })
    observeChildren()
    // 不监听自身 style，避免写入 mask 触发观察器循环；文本原地更新也需要重测。
    mutation?.observe(element, { childList: true, subtree: true, characterData: true })
    element.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', refreshSelection)
    element.addEventListener('click', revealInteracted)
    element.addEventListener('focusin', revealInteracted)
    document.fonts?.ready.then(() => { if (active) refreshSelection() })
    refresh.current = refreshSelection
    revealSelection()
    update()
    return () => {
      active = false
      refresh.current = null
      if (frame !== undefined) cancelAnimationFrame(frame)
      resize?.disconnect()
      mutation?.disconnect()
      element.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', refreshSelection)
      element.removeEventListener('click', revealInteracted)
      element.removeEventListener('focusin', revealInteracted)
    }
  }, [Tag, bottomOverlayHeight, bottomFadeSize, revealSelector])
  useLayoutEffect(() => { refresh.current?.() }, [children])

  return <Tag {...props} ref={(element: Viewport | null) => { viewport.current = element }} className={`ds-scroll-area ${className}`}>{children}</Tag>
}
