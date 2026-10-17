import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'

const STORAGE_KEY = 'pinekin.sidebar-width'
const MIN_WIDTH = 180
const MAX_WIDTH = 360
const clamp = (value: number, max: number) => Math.round(Math.max(MIN_WIDTH, Math.min(max, value)))
function readWidth(): number | undefined {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value?.trim() && Number.isFinite(Number(value))) return clamp(Number(value), MAX_WIDTH)
  } catch { /* 禁用存储不影响调宽。 */ }
  return undefined
}

export function Sidebar({ open, children }: { open: boolean; children: ReactNode }) {
  const [preferred, setPreferred] = useState(readWidth)
  const [viewport, setViewport] = useState(window.innerWidth)
  const [dragging, setDragging] = useState(false)
  const cleanupRef = useRef<(() => void) | null>(null)
  const cancelRef = useRef<(() => void) | null>(null)
  const narrow = viewport <= 1150
  // 为会话列表、至少 400px 的阅读区和 8px 工作区外边距保留空间。
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewport - (narrow ? 280 : 310) - 408))
  const width = clamp(preferred ?? (narrow ? 180 : 200), max)
  useEffect(() => {
    const resize = () => { cancelRef.current?.(); setViewport(window.innerWidth) }
    window.addEventListener('resize', resize)
    return () => { cleanupRef.current?.(); window.removeEventListener('resize', resize) }
  }, [])
  useEffect(() => { if (!open) cancelRef.current?.() }, [open])

  function saveWidth(value: number) {
    const next = clamp(value, max)
    setPreferred(next)
    try { localStorage.setItem(STORAGE_KEY, String(next)) } catch { /* 保留当前窗口的设置。 */ }
  }
  function reset() {
    cancelRef.current?.()
    setPreferred(undefined)
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* 保留当前窗口的默认宽度。 */ }
  }
  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || event.isPrimary === false) return
    event.preventDefault()
    cancelRef.current?.()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = width
    let currentWidth = width
    let finished = false
    const previousCursor = document.body.style.cursor
    const previousSelection = document.body.style.userSelect
    const cleanup = () => {
      finished = true
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', blur)
      handle.removeEventListener('lostpointercapture', cancel)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelection
      cleanupRef.current = null
      cancelRef.current = null
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId)
    }
    const finish = (commit: boolean) => {
      if (finished) return
      cleanup()
      setDragging(false)
      if (commit) saveWidth(currentWidth)
      else setPreferred(preferred)
    }
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return
      if (next.buttons === 0) { finish(true); return }
      currentWidth = clamp(startWidth + next.clientX - startX, max)
      setPreferred(currentWidth)
    }
    const up = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(true) }
    const cancel = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(false) }
    const blur = () => finish(true)
    const key = (next: KeyboardEvent) => { if (next.key === 'Escape') { next.preventDefault(); finish(false) } }
    cleanupRef.current = cleanup
    cancelRef.current = () => finish(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', blur)
    handle.addEventListener('lostpointercapture', cancel)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    setDragging(true)
    try { handle.setPointerCapture?.(pointerId) } catch { /* 捕获不可用时仍由窗口事件收尾。 */ }
  }

  return <aside id="archive-sidebar" className="sidebar" aria-label="档案导航" hidden={!open} style={{ width }} data-resizing={dragging}>
    {children}
    <div className="sidebar-resize-handle" role="separator" aria-label="调整侧栏宽度" aria-controls="archive-sidebar"
      aria-orientation="vertical" aria-valuemin={MIN_WIDTH} aria-valuemax={max} aria-valuenow={width} aria-valuetext={`${width} 像素`}
      tabIndex={0} title="拖动调整侧栏宽度，双击恢复默认" onPointerDown={startDrag} onDoubleClick={reset}
      onKeyDown={event => {
        const next = { ArrowLeft: width - 10, ArrowRight: width + 10, Home: MIN_WIDTH, End: max }[event.key]
        if (next !== undefined) { event.preventDefault(); saveWidth(next) }
      }} />
  </aside>
}
