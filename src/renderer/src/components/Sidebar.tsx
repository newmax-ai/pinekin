import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { motion, useAnimationControls } from 'framer-motion'
import { useResizableWidth } from './useResizableWidth'

// 移植 NewMax DsLayoutPanelMotion / Sidebar 的参数，不引用宿主运行时。
const layoutTransition = { type: 'spring', duration: 0.5, bounce: 0 } as const

export function Sidebar({ open, children }: { open: boolean; children: ReactNode }) {
  const [viewport, setViewport] = useState(window.innerWidth)
  const narrow = viewport <= 1150
  // 为会话列表、至少 400px 的阅读区和 8px 工作区外边距保留空间。
  const max = Math.max(240, Math.min(360, viewport - (narrow ? 280 : 310) - 408))
  const { width, dragging, cancel, handleProps } = useResizableWidth({
    storageKey: 'pinekin.sidebar-width', min: 240, max, defaultWidth: 240, disabled: !open,
  })
  useEffect(() => {
    const resize = () => { cancel(); setViewport(window.innerWidth) }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [cancel])

  const [media] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)'))
  const [reduceMotion, setReduceMotion] = useState(media?.matches ?? false)
  useLayoutEffect(() => {
    if (!media) return
    const update = () => setReduceMotion(media.matches)
    media.addEventListener('change', update)
    update()
    return () => media.removeEventListener('change', update)
  }, [media])

  const layoutControls = useAnimationControls()
  const contentControls = useAnimationControls()
  const layoutReady = useRef(false)
  const contentReady = useRef(false)
  const initialLayout = useRef<CSSProperties>({ width: open ? width : 0, marginRight: open ? 0 : 8, visibility: open ? 'visible' : 'hidden' })
  const initialOpacity = useRef(open ? 1 : 0)
  useLayoutEffect(() => {
    const target = { width: open ? width : 0, marginRight: open ? 0 : 8 }
    const visibility = open ? 'visible' : 'hidden'
    // 直接 stop + set，系统中途开启减少动画时也立即到位，不依赖结束事件。
    if (!layoutReady.current || reduceMotion || dragging) {
      layoutControls.stop()
      layoutControls.set({ ...target, visibility })
    } else {
      layoutControls.set({ visibility: 'visible' })
      void layoutControls.start({ ...target, transition: layoutTransition, transitionEnd: { visibility } })
    }
    layoutReady.current = true
    return () => layoutControls.stop()
  }, [open, width, dragging, reduceMotion, layoutControls])
  useLayoutEffect(() => {
    const target = { opacity: open ? 1 : 0 }
    if (!contentReady.current || reduceMotion) {
      contentControls.stop()
      contentControls.set(target)
    } else {
      void contentControls.start({ ...target, transition: { delay: open ? 0.01 : 0, duration: open ? 0.16 : 0.18, ease: 'easeOut' } })
    }
    contentReady.current = true
    return () => contentControls.stop()
  }, [open, reduceMotion, contentControls])

  return <motion.aside id="archive-sidebar" className="sidebar" aria-label="档案导航" aria-hidden={!open || undefined} inert={!open}
    initial={false} animate={layoutControls} style={initialLayout.current} data-resizing={dragging}>
    <div className="sidebar-content-clip">
      <motion.div className="sidebar-content" initial={false} animate={contentControls} style={{ width, opacity: initialOpacity.current }}>
        {children}
      </motion.div>
    </div>
    <div className="sidebar-resize-handle" role="separator" aria-label="调整侧栏宽度" aria-controls="archive-sidebar" hidden={!open}
      title="拖动调整侧栏宽度，双击恢复默认" {...handleProps} />
  </motion.aside>
}
