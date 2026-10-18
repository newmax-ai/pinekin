import { useEffect, useRef, type ComponentPropsWithRef, type MouseEvent, type ReactNode } from 'react'
import { Archive, ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, CodeXml, Copy, Inbox, Info, Link, LockKeyhole, MessageSquareText, PanelLeft, PanelLeftClose, Plus, Search, ShieldCheck, X } from 'lucide-react'

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
export function DsDialogHeader({ titleId, title, eyebrow, closeLabel, onDismiss, busy = false, className = '' }: {
  titleId: string; title: string; eyebrow?: string; closeLabel?: string; onDismiss: () => void; busy?: boolean; className?: string
}) {
  const heading = <h2 id={titleId}>{title}</h2>
  return <div className={`dialog-header ${className}`}>
    {eyebrow ? <div><div className="eyebrow">{eyebrow}</div>{heading}</div> : heading}
    <DsDialogClose aria-label={closeLabel} disabled={busy} onClick={onDismiss} />
  </div>
}

export function DsDialog({ titleId, onDismiss, busy, children, returnFocus, dismissOnBackdrop = false }: { titleId: string; onDismiss: () => void; busy: boolean; children: ReactNode; returnFocus?: HTMLElement | null; dismissOnBackdrop?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const backdropPress = useRef(false)
  function isBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return false
    const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect()
    return event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom
  }
  useEffect(() => {
    const trigger = returnFocus ?? document.activeElement
    const modal = dialog.current!
    const initial = Array.from(modal.querySelectorAll<HTMLElement>('input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), [role="combobox"]:not(:disabled)')).find(candidate => {
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
    onCancel={event => { event.preventDefault(); if (!busy) onDismiss() }}
    onPointerDown={event => { backdropPress.current = dismissOnBackdrop && event.button === 0 && isBackdrop(event) }}
    onClick={event => {
      // 必须在遮罩按下并释放，避免内部留白或选中文字后拖出时误关。
      const dismiss = backdropPress.current && isBackdrop(event)
      backdropPress.current = false
      if (dismissOnBackdrop && !busy && dismiss) onDismiss()
    }}>{children}</dialog>
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
  chevron: ChevronRight,
  'chevron-down': ChevronDown,
  check: Check,
  close: X,
}
export function DesignIcon({ name, size = 18 }: { name: keyof typeof icons; size?: number }) {
  const Icon = icons[name]
  return <Icon className="design-icon" size={size} strokeWidth={1.75} aria-hidden="true" focusable="false" />
}
