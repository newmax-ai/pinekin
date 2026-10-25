import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

// 本地适配 NewMax Tooltip / tooltipVisualSpec；不引入宿主工具函数或运行时。
const delayMs = 150
const warmWindowMs = 300
const offset = 4
const viewportPadding = 8
let activeDismiss: (() => void) | null = null
let pendingDismiss: (() => void) | null = null
let lastDismissTime = 0

type TriggerProps = ButtonHTMLAttributes<HTMLButtonElement>
const restoringFocus = new WeakSet<HTMLElement>()

// 仅抑制本次同步焦点恢复产生的提示，不影响后续悬停或键盘聚焦。
export function restoreFocusWithoutTooltip(element: HTMLElement) {
  restoringFocus.add(element)
  try { element.focus({ preventScroll: true }) }
  finally { restoringFocus.delete(element) }
}

export function Tooltip({ content, disabled = false, side = 'bottom', children }: { content: string; disabled?: boolean; side?: 'top' | 'bottom'; children: ReactElement<TriggerProps> }) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement | null>(null)
  const tooltip = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number; side: 'top' | 'bottom' } | null>(null)
  const pointerInteraction = useRef(false)
  const expanded = children.props['aria-expanded'] === true || children.props['aria-expanded'] === 'true'
  const popup = children.props['aria-haspopup']
  const suppressed = disabled || expanded && popup !== undefined && popup !== false && popup !== 'false'
  const visible = open && !suppressed
  const dismiss = useCallback(() => {
    clearTimeout(timer.current)
    if (pendingDismiss === dismiss) pendingDismiss = null
    if (activeDismiss === dismiss) { activeDismiss = null; lastDismissTime = Date.now() }
    setOpen(false)
    setPosition(null)
  }, [])

  useEffect(() => () => {
    clearTimeout(timer.current)
    if (pendingDismiss === dismiss) pendingDismiss = null
    if (activeDismiss === dismiss) activeDismiss = null
  }, [dismiss])
  useLayoutEffect(() => { if (suppressed) dismiss() }, [suppressed, dismiss])

  function show(element: HTMLButtonElement, immediate = false) {
    if (suppressed) return
    trigger.current = element
    const warm = activeDismiss !== null || Date.now() - lastDismissTime < warmWindowMs
    pendingDismiss?.()
    const activate = () => {
      pendingDismiss = null
      if (activeDismiss !== dismiss) activeDismiss?.()
      activeDismiss = dismiss
      setOpen(true)
    }
    if (immediate || warm) activate()
    else { timer.current = setTimeout(activate, delayMs); pendingDismiss = dismiss }
  }

  useLayoutEffect(() => {
    const element = tooltip.current
    if (!visible || !element || !trigger.current) return
    // 顶层 Popover 避免工作台 overflow 裁切，也能显示在原生 modal 之上。
    element.showPopover?.()
    const rect = trigger.current.getBoundingClientRect()
    const width = element.offsetWidth
    const height = element.offsetHeight
    const available = {
      bottom: window.innerHeight - rect.bottom - offset - viewportPadding,
      top: rect.top - offset - viewportPadding,
    }
    const oppositeSide = side === 'top' ? 'bottom' : 'top'
    const resolvedSide = height > available[side] && available[oppositeSide] > available[side] ? oppositeSide : side
    const clamp = (value: number, maximum: number) => Math.max(viewportPadding, Math.min(value, maximum))
    setPosition({
      left: clamp(rect.left + (rect.width - width) / 2, window.innerWidth - width - viewportPadding),
      top: clamp(resolvedSide === 'top' ? rect.top - offset - height : rect.bottom + offset, window.innerHeight - height - viewportPadding),
      side: resolvedSide,
    })
    return () => { element.hidePopover?.() }
  }, [visible, content, side])

  useEffect(() => {
    if (!visible) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss() }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [visible, dismiss])

  const props = children.props
  return <>
    {cloneElement(children, {
      'aria-describedby': [props['aria-describedby'], visible ? id : undefined].filter(Boolean).join(' ') || undefined,
      onMouseEnter: event => { props.onMouseEnter?.(event); if (event.buttons === 0) show(event.currentTarget) },
      onMouseLeave: event => { props.onMouseLeave?.(event); pointerInteraction.current = false; dismiss() },
      onFocus: event => { props.onFocus?.(event); if (pointerInteraction.current || restoringFocus.has(event.currentTarget)) dismiss(); else show(event.currentTarget, true) },
      onBlur: event => { props.onBlur?.(event); pointerInteraction.current = false; dismiss() },
      onPointerDown: event => { pointerInteraction.current = true; props.onPointerDown?.(event); dismiss() },
      onClick: event => { props.onClick?.(event); dismiss() },
    })}
    {visible && createPortal(<div ref={tooltip} id={id} role="tooltip" popover={typeof HTMLElement.prototype.showPopover === 'function' ? 'manual' : undefined} className="ds-tooltip" data-side={position?.side}
      style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' }}>{content}</div>, document.body)}
  </>
}
