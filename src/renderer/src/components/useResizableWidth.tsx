import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'

export function useResizableWidth({ storageKey, min, max, defaultWidth, disabled = false }: {
  storageKey: string; min: number; max: number; defaultWidth: number; disabled?: boolean
}) {
  const clamp = (value: number) => Math.round(Math.max(min, Math.min(max, value)))
  const [preferred, setPreferred] = useState<number | undefined>(() => {
    try {
      const value = localStorage.getItem(storageKey)
      if (value?.trim() && Number.isFinite(Number(value))) return Number(value)
    } catch { /* 禁用存储不影响调宽。 */ }
    return undefined
  })
  const [dragging, setDragging] = useState(false)
  const cleanupRef = useRef<(() => void) | null>(null)
  const cancelRef = useRef<(() => void) | null>(null)
  const width = clamp(preferred ?? defaultWidth)
  const cancel = useCallback(() => cancelRef.current?.(), [])
  useEffect(() => () => cleanupRef.current?.(), [])
  useEffect(() => { cancel() }, [max, disabled, cancel])

  function saveWidth(value: number) {
    const next = clamp(value)
    setPreferred(next)
    try { localStorage.setItem(storageKey, String(next)) } catch { /* 保留当前窗口的设置。 */ }
  }
  function reset() {
    cancel()
    setPreferred(undefined)
    try { localStorage.removeItem(storageKey) } catch { /* 保留当前窗口的默认宽度。 */ }
  }
  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (disabled || event.button !== 0 || event.isPrimary === false) return
    event.preventDefault()
    cancel()
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
      window.removeEventListener('pointercancel', cancelPointer)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', blur)
      handle.removeEventListener('lostpointercapture', cancelPointer)
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
      currentWidth = clamp(startWidth + next.clientX - startX)
      setPreferred(currentWidth)
    }
    const up = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(true) }
    const cancelPointer = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(false) }
    const blur = () => finish(true)
    const key = (next: globalThis.KeyboardEvent) => { if (next.key === 'Escape') { next.preventDefault(); finish(false) } }
    cleanupRef.current = cleanup
    cancelRef.current = () => finish(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancelPointer)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', blur)
    handle.addEventListener('lostpointercapture', cancelPointer)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    setDragging(true)
    try { handle.setPointerCapture?.(pointerId) } catch { /* 捕获不可用时仍由窗口事件收尾。 */ }
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = { ArrowLeft: width - 10, ArrowRight: width + 10, Home: min, End: max }[event.key]
    if (!disabled && next !== undefined) { event.preventDefault(); cancel(); saveWidth(next) }
  }
  return { width, dragging, cancel, handleProps: {
    'aria-orientation': 'vertical' as const, 'aria-valuemin': min, 'aria-valuemax': max,
    'aria-valuenow': width, 'aria-valuetext': `${width} 像素`, tabIndex: 0,
    onPointerDown: startDrag, onDoubleClick: reset, onKeyDown: keyDown,
  } }
}
