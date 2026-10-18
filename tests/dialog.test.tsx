// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { DsButton, DsDialog, DsDialogClose, DsDialogHeader } from '../src/renderer/src/components/ui'

beforeEach(() => {
  // 模拟 showModal 的原生初始聚焦：优先 autofocus，否则落到首个控件。
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
    const initial = this.hasAttribute('autofocus') ? this : this.querySelector<HTMLElement>('[autofocus]') ?? this.querySelector<HTMLElement>('button, input, select, textarea')
    initial?.focus()
  }
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('共享弹窗关闭按钮', () => {
  it('统一使用默认尺寸、ghost 与 relaxed 图标规格，不依赖页面单独配置', () => {
    render(<DsDialogClose aria-label="关闭面板" />)
    const close = screen.getByRole('button', { name: '关闭面板' })
    expect(close.classList.contains('ds-dialog-close')).toBe(true)
    expect(close.classList.contains('ds-button-small')).toBe(false)
    expect(close.classList.contains('ds-button-mini')).toBe(false)
    for (const name of ['ds-button-ghost', 'ds-button-icon', 'ds-button-icon-relaxed']) expect(close.classList.contains(name)).toBe(true)
    expect(close.querySelector('svg')?.getAttribute('width')).toBe('18')
    expect(close.getAttribute('type')).toBe('button')
    expect(close.getAttribute('title')).toBeNull()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
  it('保留点击、禁用、ref 和附加样式，缺省可访问名称为关闭', () => {
    const onClick = vi.fn(), ref = { current: null as HTMLButtonElement | null }
    const { rerender } = render(<DsDialogClose ref={ref} className="extra-close" onClick={onClick} />)
    const close = screen.getByRole('button', { name: '关闭' })
    expect(ref.current).toBe(close)
    expect(close.classList.contains('extra-close')).toBe(true)
    fireEvent.click(close)
    expect(onClick).toHaveBeenCalledOnce()
    rerender(<DsDialogClose disabled onClick={onClick} />)
    fireEvent.click(close)
    expect(onClick).toHaveBeenCalledOnce()
  })
})

describe('共享弹窗标题', () => {
  it.each([undefined, '上下文交接'])('统一渲染无装饰图标的标题，保留说明 %s 和默认尺寸关闭按钮', eyebrow => {
    const onDismiss = vi.fn()
    const { container } = render(<DsDialogHeader titleId="shared-title" title="选择接续目标" eyebrow={eyebrow} closeLabel="关闭接续面板" onDismiss={onDismiss} />)
    const heading = screen.getByRole('heading', { level: 2, name: '选择接续目标' })
    const header = container.querySelector('.dialog-header')!
    expect(heading.id).toBe('shared-title')
    expect(header.firstElementChild?.contains(heading) || header.firstElementChild === heading).toBe(true)
    expect(header.querySelector('.dialog-icon')).toBeNull()
    expect(header.querySelectorAll('svg')).toHaveLength(1)
    expect(header.querySelector('.eyebrow')?.textContent).toBe(eyebrow)
    const close = screen.getByRole('button', { name: '关闭接续面板' })
    expect(close.classList.contains('ds-dialog-close')).toBe(true)
    expect(close.classList.contains('ds-button-small')).toBe(false)
    expect(close.contains(header.querySelector('svg'))).toBe(true)
    fireEvent.click(close)
    expect(onDismiss).toHaveBeenCalledOnce()
  })
  it('保留附加布局类和忙碌禁用状态，不改变标题关联或初始焦点', () => {
    const onDismiss = vi.fn()
    render(<DsDialog titleId="shared-title" busy onDismiss={onDismiss}>
      <DsDialogHeader titleId="shared-title" title="连接来源 App" className="connection-header" busy onDismiss={onDismiss} />
      <input aria-label="来源输入" />
    </DsDialog>)
    const dialog = screen.getByRole('dialog', { name: '连接来源 App' })
    expect(dialog.querySelector('.dialog-header')?.classList.contains('connection-header')).toBe(true)
    const close = screen.getByRole('button', { name: '关闭' }) as HTMLButtonElement
    expect(close.disabled).toBe(true)
    fireEvent.click(close)
    expect(onDismiss).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '来源输入' }))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

describe('弹窗初始焦点', () => {
  it.each(['select', 'input', 'textarea'] as const)('打开时优先聚焦 %s，关闭按钮从未获得默认焦点或弹出提示', kind => {
    const closeFocus = vi.fn()
    render(<DsDialog titleId="title" busy={false} onDismiss={() => {}}>
      <h2 id="title">连接来源</h2><DsButton iconOnly aria-label="关闭面板" onFocus={closeFocus}>×</DsButton>
      {kind === 'select' ? <select aria-label="主要输入"><option>NewMax</option></select> : kind === 'input' ? <input aria-label="主要输入" /> : <textarea aria-label="主要输入" />}
    </DsDialog>)
    expect(document.activeElement).toBe(screen.getByLabelText('主要输入'))
    expect(closeFocus).not.toHaveBeenCalled()
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(screen.getByLabelText('主要输入').hasAttribute('autofocus')).toBe(false)
  })
  it('无可用输入时聚焦弹窗容器，跳过禁用和隐藏输入，而不是关闭按钮', () => {
    const closeFocus = vi.fn()
    render(<DsDialog titleId="title" busy={false} onDismiss={() => {}}>
      <h2 id="title">读取说明</h2><DsButton iconOnly aria-label="关闭面板" onFocus={closeFocus}>×</DsButton>
      <input type="hidden" /><input disabled /><select hidden><option>隐藏</option></select>
    </DsDialog>)
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: '读取说明' }))
    expect(closeFocus).not.toHaveBeenCalled()
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(document.activeElement?.hasAttribute('autofocus')).toBe(false)
  })
  it('不抢走用户操作中的焦点；手动聚焦关闭按钮仍有提示，关闭后恢复触发按钮', async () => {
    function Example() {
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      return <><button onClick={() => setOpen(true)}>打开</button>{open && <DsDialog titleId="title" busy={busy} onDismiss={() => setOpen(false)}>
        <h2 id="title">连接来源</h2><DsButton iconOnly aria-label="关闭面板" onClick={() => setOpen(false)}>×</DsButton>
        <select aria-label="来源"><option>NewMax</option></select><button onClick={() => setBusy(value => !value)}>切换状态</button>
      </DsDialog>}</>
    }
    render(<Example />)
    const trigger = screen.getByRole('button', { name: '打开' }); trigger.focus(); fireEvent.click(trigger)
    const close = screen.getByRole('button', { name: '关闭面板' })
    act(() => close.focus())
    expect(screen.getByRole('tooltip').textContent).toBe('关闭面板')
    fireEvent.click(screen.getByRole('button', { name: '切换状态' }))
    expect(document.activeElement).toBe(close)
    fireEvent.click(close)
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})
