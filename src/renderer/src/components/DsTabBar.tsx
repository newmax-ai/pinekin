import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import './DsTabBar.css'

interface DsTabItem<T extends string> { value: T; label: string; disabled?: boolean }
interface Props<T extends string> {
  id: string
  items: DsTabItem<T>[]
  value: T
  onChange: (value: T) => void
  panelId: string
  'aria-label': string
}

// 只适配 NewMax DsTabBar 的文字分段与滑动底板，不依赖宿主工具链或运行时。
export function DsTabBar<T extends string>({ id, items, value, onChange, panelId, 'aria-label': label }: Props<T>) {
  const container = useRef<HTMLDivElement>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const [indicator, setIndicator] = useState({ left: 0, width: 0, height: 0, animated: false })
  const selected = items.findIndex(item => item.value === value)
  useLayoutEffect(() => {
    const button = buttons.current[selected]
    if (!button) return
    const measure = (animate: boolean) => setIndicator(previous => ({
      left: button.offsetLeft, width: button.offsetWidth, height: button.offsetHeight,
      animated: animate && previous.width > 0,
    }))
    measure(true)
    if (typeof ResizeObserver === 'undefined') return
    let firstFire = true
    const initiallyMeasured = button.offsetWidth > 0
    const observer = new ResizeObserver(() => {
      // 已测量时保留切换动效；原生弹窗初次 showModal 前宽度为零，首次回调必须补测。
      if (firstFire) { firstFire = false; if (initiallyMeasured) return }
      measure(false)
    })
    observer.observe(container.current!)
    buttons.current.forEach(item => { if (item) observer.observe(item) })
    return () => observer.disconnect()
  }, [selected, items])

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const enabled = items.flatMap((item, position) => item.disabled ? [] : [position])
    const current = enabled.indexOf(index)
    let next: number
    if (event.key === 'ArrowRight') next = enabled[(current + 1) % enabled.length]
    else if (event.key === 'ArrowLeft') next = enabled[(current - 1 + enabled.length) % enabled.length]
    else if (event.key === 'Home') next = enabled[0]
    else if (event.key === 'End') next = enabled[enabled.length - 1]
    else return
    event.preventDefault()
    buttons.current[next]?.focus()
    onChange(items[next].value)
  }

  return <div ref={container} className="ds-tab-bar" role="tablist" aria-label={label} data-ds-pill-control="true">
    <span className="ds-tab-bar-indicator" aria-hidden="true" data-ds-pill-control="true" data-animated={indicator.animated}
      style={{ left: indicator.left, width: indicator.width, height: indicator.height }} />
    {items.map((item, index) => <button key={item.value} ref={element => { buttons.current[index] = element }}
      type="button" role="tab" id={`${id}-${item.value}`} aria-controls={panelId} aria-selected={item.value === value}
      tabIndex={item.value === value && !item.disabled ? 0 : -1} disabled={item.disabled} data-ds-pill-control="true"
      onClick={() => onChange(item.value)} onKeyDown={event => navigate(event, index)}>{item.label}</button>)}
  </div>
}
