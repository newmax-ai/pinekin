import { useState, type ComponentPropsWithRef } from 'react'
import { DesignIcon } from './ui'
import './DsCheckbox.css'

type CheckboxSize = 'mini' | 'small' | 'default' | 'large'
type Props = Omit<ComponentPropsWithRef<'button'>, 'onChange' | 'children' | 'type' | 'role' | 'aria-checked'> & {
  checked?: boolean
  defaultChecked?: boolean
  indeterminate?: boolean
  onChange?: (checked: boolean) => void
  size?: CheckboxSize
}
const sizes = {
  mini: { box: 14, icon: 9, border: 1.5 },
  small: { box: 16, icon: 10, border: 1.5 },
  default: { box: 20, icon: 12, border: 2 },
  large: { box: 24, icon: 14, border: 2 },
} as const

// 对齐 NewMax DsCheckbox 的圆形、尺寸与状态契约；外层标签由调用方提供，避免嵌套 label。
export function DsCheckbox({ checked, defaultChecked = false, indeterminate = false, onChange, size = 'default', disabled = false,
  className = '', style, onClick, ...props }: Props) {
  const [internal, setInternal] = useState(defaultChecked)
  const isOn = checked ?? internal, isMixed = indeterminate && !isOn
  const { box, icon, border } = sizes[size]
  return <button {...props} type="button" role="checkbox" aria-checked={isMixed ? 'mixed' : isOn} disabled={disabled}
    data-ds-round-control="true" className={`ds-checkbox ${className}`} style={{ width: box, height: box, borderWidth: border, ...style }}
    onClick={event => {
      if (disabled) return
      onClick?.(event)
      if (event.defaultPrevented) return
      event.preventDefault()
      const next = isMixed || !isOn
      if (checked === undefined) setInternal(next)
      onChange?.(next)
    }}>
    {(isOn || isMixed) && <DesignIcon name={isMixed ? 'minus' : 'check-bold'} size={icon} />}
  </button>
}
