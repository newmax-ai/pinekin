import { useEffect, useId, useLayoutEffect, useRef, useState, type AriaAttributes, type KeyboardEvent } from 'react'
import { DesignIcon } from './ui'
import './DsSelect.css'

export interface DsSelectOption { value: string; label: string }
interface DsSelectProps extends Pick<AriaAttributes, 'aria-label' | 'aria-labelledby' | 'aria-describedby'> {
  id?: string
  value?: string
  options: DsSelectOption[]
  onChange?: (value: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
}

/** 本地适配 NewMax DsSelect / DsMenu 的基础单选契约；不引入宿主 store、i18n 或 portal。 */
export function DsSelect({ id, value, options, onChange, placeholder = '请选择', disabled = false, className = '', ...aria }: DsSelectProps) {
  const menuId = useId()
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const typed = useRef({ text: '', time: 0 })
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const selected = options.findIndex(option => option.value === value)
  const unavailable = disabled || !options.length
  const expanded = open && !unavailable
  const activeIndex = Math.min(active, options.length - 1)

  useEffect(() => { if (unavailable) setOpen(false) }, [unavailable])
  useLayoutEffect(() => {
    if (!expanded) return
    const popup = menu.current!, button = trigger.current!
    // 原生 popover 进入 top layer，但 DOM 仍归属 dialog，避免被滚动容器裁切或跳出模态焦点范围。
    function position() {
      const rect = button.getBoundingClientRect(), gutter = 8, gap = 4
      const width = Math.min(Math.max(rect.width, 120), window.innerWidth - gutter * 2)
      popup.style.width = `${width}px`
      const below = Math.max(0, window.innerHeight - rect.bottom - gap - gutter)
      const above = Math.max(0, rect.top - gap - gutter)
      const upward = below < Math.min(Math.max(popup.scrollHeight, popup.getBoundingClientRect().height), 240) && above > below
      popup.style.maxHeight = `${Math.min(400, upward ? above : below)}px`
      const height = popup.getBoundingClientRect().height
      popup.style.left = `${Math.max(gutter, Math.min(rect.left, window.innerWidth - width - gutter))}px`
      popup.style.top = `${upward ? Math.max(gutter, rect.top - height - gap) : Math.max(gutter, rect.bottom + gap)}px`
    }
    popup.showPopover?.()
    position()
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('scroll', position, true)
    window.addEventListener('resize', position)
    return () => {
      popup.hidePopover?.()
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('scroll', position, true)
      window.removeEventListener('resize', position)
    }
  }, [expanded])
  useEffect(() => {
    if (expanded) document.getElementById(`${menuId}-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [expanded, activeIndex, menuId])

  function show(index = Math.max(selected, 0)) {
    if (unavailable) return
    setActive(index); setOpen(true); trigger.current?.focus()
  }
  function choose(index: number) {
    onChange?.(options[index].value)
    setOpen(false); trigger.current?.focus()
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (unavailable || event.nativeEvent.isComposing) return
    const key = event.key
    if (expanded && key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); setOpen(false); return
    }
    if (key === 'Tab') { setOpen(false); return }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault()
      if (!expanded) show()
      else setActive((activeIndex + (key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
    } else if (key === 'Home' || key === 'End') {
      event.preventDefault(); show(key === 'Home' ? 0 : options.length - 1)
    } else if (key === 'Enter' || key === ' ') {
      event.preventDefault()
      if (expanded) choose(activeIndex)
      else show()
    } else if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now(), prefix = (now - typed.current.time < 700 ? typed.current.text : '') + key.toLocaleLowerCase()
      typed.current = { text: prefix, time: now }
      const index = options.findIndex(option => option.label.toLocaleLowerCase().startsWith(prefix))
      if (index >= 0) { event.preventDefault(); show(index) }
    }
  }

  return <div ref={container} className={`ds-select ${className}`}>
    <button ref={trigger} id={id} type="button" role="combobox" className="ds-select-trigger" disabled={unavailable}
      {...aria} aria-haspopup="listbox" aria-expanded={expanded} aria-controls={expanded ? menuId : undefined}
      aria-activedescendant={expanded ? `${menuId}-${activeIndex}` : undefined}
      onClick={() => { if (expanded) setOpen(false); else show() }} onKeyDown={keyDown}>
      <span className="ds-select-value">{options[selected]?.label ?? placeholder}</span><DesignIcon name="chevron-down" size={16} />
    </button>
    {expanded && <div ref={menu} id={menuId} role="listbox" popover="manual" className="ds-select-menu"
      aria-label={aria['aria-label']} aria-labelledby={aria['aria-labelledby']}>
      {options.map((option, index) => <button key={option.value} id={`${menuId}-${index}`} type="button" role="option" tabIndex={-1}
        className="ds-select-option" aria-selected={value === option.value} data-active={activeIndex === index}
        onPointerDown={event => event.preventDefault()} onPointerMove={() => setActive(index)} onClick={() => choose(index)}>
        <span className="ds-select-check">{value === option.value && <DesignIcon name="check" size={18} />}</span><span>{option.label}</span>
      </button>)}
    </div>}
  </div>
}
