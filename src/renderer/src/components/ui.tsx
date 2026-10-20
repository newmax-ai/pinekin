import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithRef, type MouseEvent, type ReactNode } from 'react'
import { Archive, ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, CodeXml, Copy, Download, Ellipsis, Inbox, Info, Link, LockKeyhole, MessageSquareText, PanelLeft, PanelLeftClose, Plus, Search, Settings, ShieldCheck, X } from 'lucide-react'

import { Tooltip } from './Tooltip'

// 视觉契约源自 NewMax DS；这是独立实现，不引用宿主 store、窗口或运行时。
export function DsButton({ variant = 'tertiary', size = 'default', iconOnly = false, iconRelaxed = false, className = '', type = 'button', title, ...props }:
  ComponentPropsWithRef<'button'> & { variant?: 'primary' | 'tertiary' | 'ghost'; size?: 'mini' | 'small' | 'default'; iconOnly?: boolean; iconRelaxed?: boolean }) {
  const content = iconOnly ? props['aria-label'] || title : undefined
  const button = <button type={type} data-ds-pill-control="true" className={`ds-button ds-button-${variant}${iconOnly ? ' ds-button-icon' : ''}${iconRelaxed ? ' ds-button-icon-relaxed' : ''}${size !== 'default' ? ` ds-button-${size}` : ''} ${className}`} title={content ? undefined : title} {...props} />
  return content ? <Tooltip content={content} disabled={props.disabled}>{button}</Tooltip> : button
}

// 弹窗关闭入口统一在组件层维护规格，页面只提供名称、状态与关闭行为。
export function DsDialogClose({ 'aria-label': label = '关闭', className = '', ...props }: Omit<ComponentPropsWithRef<'button'>, 'children'>) {
  return <DsButton {...props} aria-label={label} variant="ghost" size="default" iconOnly iconRelaxed className={`ds-dialog-close ${className}`}><DesignIcon name="close" /></DsButton>
}

// 常规弹窗共用纯文字标题栏，不提供装饰图标插槽；关闭规格由 DsDialogClose 维护。
export function DsDialogHeader({ titleId, title, eyebrow, description, closeLabel, onDismiss, busy = false, className = '' }: {
  titleId: string; title: string; eyebrow?: string; description?: ReactNode; closeLabel?: string; onDismiss: () => void; busy?: boolean; className?: string
}) {
  const heading = <h2 id={titleId}>{title}</h2>
  return <div className={`dialog-header ${className}`}>
    {eyebrow || description ? <div className="dialog-heading">{eyebrow && <div className="eyebrow">{eyebrow}</div>}{heading}{description}</div> : heading}
    <DsDialogClose aria-label={closeLabel} disabled={busy} onClick={onDismiss} />
  </div>
}

const DialogPresenceContext = createContext<{ present: boolean; finishExit: () => void } | null>(null)

// 业务关闭立即生效，仅保留最后一次弹窗子树完成退场，不复制 DOM 或推迟业务回调。
export function DsDialogPresence({ children }: { children: ReactNode }) {
  const present = Boolean(children)
  const [retained, setRetained] = useState(children)
  const finishExit = useCallback(() => setRetained(null), [])
  useLayoutEffect(() => { if (present) setRetained(children) }, [present, children])
  useEffect(() => {
    if (present || !retained) return
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (motion?.matches) { finishExit(); return }
    // CSS 退场为 140ms；事件丢失或样式被覆盖时仍能释放原生 modal。
    const timer = window.setTimeout(finishExit, 180)
    const reduce = () => { if (motion?.matches) finishExit() }
    motion?.addEventListener('change', reduce)
    return () => { window.clearTimeout(timer); motion?.removeEventListener('change', reduce) }
  }, [present, retained, finishExit])
  const presence = useMemo(() => ({ present, finishExit }), [present, finishExit])
  return <DialogPresenceContext.Provider value={presence}>{present ? children : retained}</DialogPresenceContext.Provider>
}

export function DsDialog({ titleId, onDismiss, busy, children, returnFocus, dismissOnBackdrop = true, animateHeight = false }: { titleId: string; onDismiss: () => void; busy: boolean; children: ReactNode; returnFocus?: HTMLElement | null; dismissOnBackdrop?: boolean; animateHeight?: boolean }) {
  const presence = useContext(DialogPresenceContext)
  const present = presence?.present ?? true
  const dialog = useRef<HTMLDialogElement>(null)
  const sizeContent = useRef<HTMLDivElement>(null)
  const heightOwned = useRef(false)
  const backdropPress = useRef(false)
  useLayoutEffect(() => {
    const modal = dialog.current!
    if (!animateHeight) {
      if (heightOwned.current) modal.style.removeProperty('height')
      heightOwned.current = false
      return
    }
    heightOwned.current = true
    if (!present || typeof ResizeObserver === 'undefined') return
    const content = sizeContent.current!
    let active = true
    const update = () => {
      if (!active) return
      // 内容不随外框的动画高度收缩，避免观察器反馈循环；offsetHeight 不包含进场 scale。
      const height = content.offsetHeight
      if (height > 0) modal.style.height = `${height}px`
    }
    const observer = new ResizeObserver(update)
    observer.observe(content)
    update()
    return () => { active = false; observer.disconnect() }
  }, [animateHeight, present])
  useEffect(() => {
    if (present) return
    const modal = dialog.current!
    const finish = (event: AnimationEvent) => {
      if (event.target === modal && !event.pseudoElement && event.animationName === 'ds-dialog-exit') presence?.finishExit()
    }
    modal.addEventListener('animationend', finish)
    return () => modal.removeEventListener('animationend', finish)
  }, [present, presence])
  function isBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return false
    const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect()
    return event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom
  }
  useEffect(() => {
    const trigger = returnFocus ?? document.activeElement
    const modal = dialog.current!
    const initial = Array.from(modal.querySelectorAll<HTMLElement>('[data-dialog-initial-focus]:not(:disabled), input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), [role="combobox"]:not(:disabled)')).find(candidate => {
      if (candidate.closest('[hidden], [inert], [aria-hidden="true"], details:not([open])')) return false
      for (let element: HTMLElement | null = candidate; element && element !== modal; element = element.parentElement) {
        const style = getComputedStyle(element)
        if (style.display === 'none' || style.visibility === 'hidden') return false
      }
      return true
    }) ?? modal
    // 在 showModal 前指定初始焦点，避免先聚焦页头关闭按钮再转移而闪出 Tooltip。
    const autofocus = initial.getAttribute('autofocus')
    initial.setAttribute('autofocus', '')
    try { modal.showModal(); initial.focus({ preventScroll: true }) }
    finally {
      if (autofocus === null) initial.removeAttribute('autofocus')
      else initial.setAttribute('autofocus', autofocus)
    }
    return () => { queueMicrotask(() => { if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus() }) }
  }, [returnFocus])
  return <dialog ref={dialog} tabIndex={-1} className="ds-dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy}
    data-state={present ? 'open' : 'closing'} data-animate-height={animateHeight || undefined} inert={!present} aria-hidden={!present || undefined}
    onCancel={event => { event.preventDefault(); if (present && !busy) onDismiss() }}
    onPointerDown={event => { backdropPress.current = dismissOnBackdrop && event.button === 0 && isBackdrop(event) }}
    onClick={event => {
      // 必须在遮罩按下并释放，避免内部留白或选中文字后拖出时误关。
      const dismiss = backdropPress.current && isBackdrop(event)
      backdropPress.current = false
      if (present && dismissOnBackdrop && !busy && dismiss) onDismiss()
    }}>{animateHeight ? <div className="ds-dialog-size-content" ref={sizeContent}>{children}</div> : children}</dialog>
}

// 静态具名导入便于按需打包；品牌来源图标由 SourceIcon 单独管理。
const icons = {
  dock: Inbox,
  archive: Archive,
  plus: Plus,
  search: Search,
  shield: ShieldCheck,
  lock: LockKeyhole,
  info: Info,
  message: MessageSquareText,
  code: CodeXml,
  link: Link,
  arrow: ArrowRight,
  back: ArrowLeft,
  'panel-open': PanelLeftClose,
  'panel-closed': PanelLeft,
  copy: Copy,
  download: Download,
  settings: Settings,
  chevron: ChevronRight,
  'chevron-down': ChevronDown,
  more: Ellipsis,
  check: Check,
  close: X,
}
export function DesignIcon({ name, size = 18 }: { name: keyof typeof icons | 'check-bold' | 'minus' | 'refresh'; size?: number }) {
  // 刷新按钮沿用 NewMax DS 的单箭头图标，不引入宿主运行时依赖。
  if (name === 'refresh') return <svg className="design-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
    <path d="M19.7504 3.00018C20.1644 3.00042 20.5004 3.33611 20.5004 3.75018V8.75018C20.5003 9.16417 20.1644 9.49995 19.7504 9.50018H14.7504C14.3363 9.50018 14.0005 9.16431 14.0004 8.75018C14.0004 8.33597 14.3362 8.00018 14.7504 8.00018H18.0453C17.2933 6.86345 16.2332 5.95587 14.9799 5.39081C13.4602 4.7058 11.7502 4.56553 10.1391 4.99335C8.52806 5.42131 7.11372 6.39165 6.13422 7.74042C5.15476 9.08924 4.66956 10.7342 4.76117 12.3986C4.85285 14.0629 5.51563 15.645 6.63715 16.8781C7.75874 18.111 9.27126 18.9206 10.9194 19.1691C12.5676 19.4175 14.2517 19.09 15.687 18.2424C17.1222 17.3946 18.222 16.0783 18.8002 14.5148C18.9439 14.1263 19.3756 13.9278 19.7641 14.0715C20.1522 14.2153 20.3511 14.647 20.2075 15.0353C19.5097 16.9221 18.1827 18.5112 16.4506 19.5344C14.7185 20.5574 12.6859 20.9521 10.6967 20.6525C8.70741 20.3527 6.88154 19.376 5.52777 17.8879C4.17411 16.3997 3.37484 14.4903 3.2641 12.4816C3.15349 10.4727 3.73812 8.48655 4.92035 6.85858C6.10258 5.23068 7.80985 4.05961 9.75433 3.54315C11.6987 3.02683 13.7621 3.19689 15.5961 4.02362C16.9507 4.6343 18.119 5.57599 19.0004 6.75116V3.75018C19.0004 3.33597 19.3362 3.00018 19.7504 3.00018Z" fill="currentColor" />
  </svg>
  // 选择控件沿用 NewMax DesignIcon 的两个标记；其他 UI 图标继续使用 Lucide。
  if (name === 'check-bold' || name === 'minus') return <svg className="design-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
    {name === 'check-bold' ? <path d="M5 11L10.5 16.5L21 6" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      : <path d="M19 11.25C19.4142 11.25 19.75 11.5858 19.75 12C19.75 12.4142 19.4142 12.75 19 12.75H5C4.58579 12.75 4.25 12.4142 4.25 12C4.25 11.5858 4.58579 11.25 5 11.25H19Z" fill="currentColor" />}
  </svg>
  const Icon = icons[name]
  return <Icon className="design-icon" size={size} strokeWidth={1.75} aria-hidden="true" focusable="false" />
}
