import { useEffect, useRef } from 'react'

/**
 * 只在连接弹窗使用：按未受滚动裁切的内层内容计算高度，CSS 在真实像素高度间过渡。
 * 不观察弹窗或滚动视口自身的动画高度，避免尺寸反馈循环；不预留固定大外框。
 */
export function useContentSizedDialog() {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const viewport = viewportRef.current, content = contentRef.current
    const dialog = viewport?.closest('dialog')
    const header = dialog?.querySelector<HTMLElement>('.dialog-header'), footer = dialog?.querySelector<HTMLElement>('.dialog-footer')
    if (!viewport || !content || !dialog || !header || !footer) return
    let active = true, frame: number | undefined, lastHeight = -1
    const originalHeight = dialog.style.height
    const measure = () => {
      frame = undefined
      if (!active || !dialog.open || dialog.dataset.state === 'closing') return
      // offsetHeight 不受共享入场 scale 动画影响，也不取受限 viewport 的 clientHeight。
      const intrinsic = header.offsetHeight + content.offsetHeight + footer.offsetHeight
      if (!intrinsic) return
      const style = getComputedStyle(viewport)
      const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
      const height = Math.min(Math.ceil(intrinsic + padding), Math.max(0, window.innerHeight - 64))
      if (height === lastHeight) return
      lastHeight = height
      dialog.style.height = `${height}px`
    }
    const schedule = () => {
      if (active && frame === undefined) frame = requestAnimationFrame(measure)
    }
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    for (const element of [header, content, footer]) resize?.observe(element)
    // 老环境回退只监听内容与文字，不监听本组件写入的 style。
    const mutation = !resize && typeof MutationObserver !== 'undefined' ? new MutationObserver(schedule) : undefined
    mutation?.observe(dialog, { childList: true, subtree: true, characterData: true })
    window.addEventListener('resize', schedule)
    document.fonts?.ready.then(schedule)
    measure()
    return () => {
      active = false
      if (frame !== undefined) cancelAnimationFrame(frame)
      resize?.disconnect(); mutation?.disconnect()
      window.removeEventListener('resize', schedule)
      dialog.style.height = originalHeight
    }
  }, [])
  return { viewportRef, contentRef }
}
