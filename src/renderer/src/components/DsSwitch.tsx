import type { ComponentPropsWithRef } from 'react'
import './DsSwitch.css'

type Props = Omit<ComponentPropsWithRef<'button'>, 'onChange' | 'onClick' | 'children' | 'type' | 'role' | 'aria-checked'> & {
  checked: boolean
  onChange: (checked: boolean) => void
  size?: 'default' | 'small'
}

// 受控开关：授权操作完成后由调用方更新，不把点击意图当作已连接。
export function DsSwitch({ checked, onChange, size = 'default', disabled = false, className = '', ...props }: Props) {
  return <button {...props} type="button" role="switch" aria-checked={checked} disabled={disabled}
    data-ds-pill-control="true" className={`ds-switch${size === 'small' ? ' ds-switch-small' : ''} ${className}`} onClick={() => { if (!disabled) onChange(!checked) }}>
    <span className="ds-switch-thumb" data-ds-round-control="true" aria-hidden="true" />
  </button>
}
