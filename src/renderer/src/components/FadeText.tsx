import { useLayoutEffect, useRef } from 'react'

// 复用末端 mask；慢滚仅显式用于单行详情标题，不影响导航和双行列表。
export function FadeText({ text, as: Element = 'span', lines = 1, scrollOnHover = false }: {
  text: string; as?: 'span' | 'h2' | 'h3'; lines?: 1 | 2; scrollOnHover?: boolean
}) {
  const ref = useRef<HTMLElement | null>(null)
  const track = useRef<HTMLSpanElement>(null)
  const hoverScroll = scrollOnHover && lines === 1
  useLayoutEffect(() => {
    const element = ref.current!
    let active = true
    const measure = () => {
      if (!active) return
      // 内层自然宽度不受 translateX 影响，避免移动中重新测量得到错误距离。
      const width = track.current?.scrollWidth ?? element.scrollWidth
      const visible = element.clientWidth > 0 && (lines === 1 || element.clientHeight > 0)
      const overflow = width > element.clientWidth || (lines === 2 && element.scrollHeight > element.clientHeight)
      element.dataset.overflow = String(visible && overflow)
      if (hoverScroll && visible && overflow) {
        const fade = Math.min(element.clientWidth / 2, parseFloat(getComputedStyle(element).getPropertyValue('--fade-overflow-width')) || 16)
        // 多移出一个遮罩宽度，让最后几个字最终停在清晰区域；按 48px/s 匀速前进。
        const distance = width - element.clientWidth + fade
        element.style.setProperty('--fade-scroll-distance', `${distance}px`)
        element.style.setProperty('--fade-scroll-duration', `${Math.max(1, distance / 48).toFixed(3)}s`)
        element.tabIndex = 0
      } else {
        element.style.removeProperty('--fade-scroll-distance')
        element.style.removeProperty('--fade-scroll-duration')
        element.removeAttribute('tabindex')
      }
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener('resize', measure)
    void document.fonts?.ready.then(measure)
    return () => { active = false; observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [text, Element, lines, hoverScroll])
  return <Element ref={element => { ref.current = element }} className="ds-fade-text" data-lines={lines === 2 ? '2' : undefined}
    data-scroll-on-hover={hoverScroll ? 'true' : undefined} title={text}>
    {hoverScroll ? <span key={text} ref={track} className="ds-fade-text-content">{text}</span> : text}
  </Element>
}
