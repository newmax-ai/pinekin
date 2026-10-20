// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { DsButton, DsDialog, DsDialogClose, DsDialogHeader, DsDialogPresence } from '../src/renderer/src/components/ui'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

describe('共享弹窗遮罩关闭', () => {
  function mount({ busy = false, dismissOnBackdrop }: { busy?: boolean; dismissOnBackdrop?: boolean } = {}) {
    const onDismiss = vi.fn()
    render(<DsDialog titleId="title" busy={busy} onDismiss={onDismiss} dismissOnBackdrop={dismissOnBackdrop}>
      <h2 id="title">测试弹窗</h2><button>内部操作</button>
    </DsDialog>)
    const dialog = screen.getByRole('dialog', { name: '测试弹窗' })
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 400, 300))
    return { dialog, onDismiss }
  }
  function press(target: HTMLElement, clientX: number, clientY: number, button = 0) {
    fireEvent(target, new MouseEvent('pointerdown', { bubbles: true, clientX, clientY, button }))
  }
  it.each([[50, 200], [550, 200], [200, 50], [200, 450]])('默认点击外侧遮罩 %s, %s 时关闭一次', (clientX, clientY) => {
    const { dialog, onDismiss } = mount()
    press(dialog, clientX, clientY)
    fireEvent.click(dialog, { clientX, clientY })
    expect(onDismiss).toHaveBeenCalledOnce()
    fireEvent.click(dialog, { clientX, clientY })
    expect(onDismiss).toHaveBeenCalledOnce()
  })
  it('点击内容、内部留白或边框不关闭', () => {
    const { dialog, onDismiss } = mount()
    const button = screen.getByRole('button', { name: '内部操作' })
    press(button, 200, 200); fireEvent.click(button, { clientX: 200, clientY: 200 })
    for (const [clientX, clientY] of [[110, 110], [100, 200], [500, 200], [200, 100], [200, 400]]) {
      press(dialog, clientX, clientY); fireEvent.click(dialog, { clientX, clientY })
    }
    expect(onDismiss).not.toHaveBeenCalled()
  })
  it('从内部拖到遮罩，或从遮罩拖回内部不关闭', () => {
    const { dialog, onDismiss } = mount()
    press(screen.getByRole('button', { name: '内部操作' }), 200, 200)
    fireEvent.click(dialog, { clientX: 50, clientY: 200 })
    press(dialog, 110, 110); fireEvent.click(dialog, { clientX: 50, clientY: 200 })
    press(dialog, 50, 200); fireEvent.click(dialog, { clientX: 110, clientY: 110 })
    fireEvent.click(dialog, { clientX: 50, clientY: 200 })
    expect(onDismiss).not.toHaveBeenCalled()
  })
  it.each([{ busy: true }, { dismissOnBackdrop: false }])('忙碌或显式关闭遮罩退出时不关闭：%j', options => {
    const { dialog, onDismiss } = mount(options)
    press(dialog, 50, 200); fireEvent.click(dialog, { clientX: 50, clientY: 200 })
    expect(onDismiss).not.toHaveBeenCalled()
  })
  it('非主按键点击遮罩不关闭', () => {
    const { dialog, onDismiss } = mount()
    press(dialog, 50, 200, 2); fireEvent.click(dialog, { clientX: 50, clientY: 200, button: 2 })
    expect(onDismiss).not.toHaveBeenCalled()
  })
  it.each([false, true])('Escape 保留忙碌保护：busy=%s', busy => {
    const { dialog, onDismiss } = mount({ busy })
    const event = new Event('cancel', { cancelable: true })
    fireEvent(dialog, event)
    expect(event.defaultPrevented).toBe(true)
    expect(onDismiss).toHaveBeenCalledTimes(busy ? 0 : 1)
  })
})

describe('共享弹窗进退场', () => {
  function mount(initiallyOpen = true, busy = false) {
    const onDismiss = vi.fn()
    function Example() {
      const [open, setOpen] = useState(initiallyOpen)
      return <><button onClick={() => setOpen(true)}>打开动画弹窗</button><button onClick={() => setOpen(false)}>外部关闭</button>
        <DsDialogPresence>{open && <DsDialog titleId="motion-title" busy={busy} onDismiss={() => { onDismiss(); setOpen(false) }}>
          <h2 id="motion-title">动画弹窗</h2><DsDialogClose onClick={() => { onDismiss(); setOpen(false) }} />
          <input aria-label="编辑内容" defaultValue="保留内容" />
          <button onClick={() => setOpen(false)}>返回</button>
        </DsDialog>}</DsDialogPresence></>
    }
    return { ...render(<Example />), onDismiss }
  }
  function finish(dialog: HTMLElement, animationName = 'ds-dialog-exit', target = dialog) {
    fireEvent(target, Object.assign(new Event('animationend', { bubbles: true }), { animationName }))
  }
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('首次关闭不挂载弹窗，打开时进入共享进场状态', () => {
    const { container } = mount(false)
    expect(container.querySelector('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开动画弹窗' }))
    expect(screen.getByRole('dialog').getAttribute('data-state')).toBe('open')
    expect(screen.getByRole('dialog').hasAttribute('inert')).toBe(false)
  })
  it.each(['关闭', '返回', '外部关闭', 'Escape', '遮罩'])('%s 立即更新业务状态，保留原节点和内容直到退场完成', method => {
    const { container, onDismiss } = mount()
    const dialog = screen.getByRole('dialog')
    const input = screen.getByRole('textbox', { name: '编辑内容' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '退场时不闪回' } })
    if (method === 'Escape') fireEvent(dialog, new Event('cancel', { cancelable: true }))
    else if (method === '遮罩') {
      vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 400, 300))
      fireEvent(dialog, new MouseEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 200, button: 0 }))
      fireEvent.click(dialog, { clientX: 50, clientY: 200 })
    } else fireEvent.click(screen.getByRole('button', { name: method }))
    expect(onDismiss).toHaveBeenCalledTimes(['关闭', 'Escape', '遮罩'].includes(method) ? 1 : 0)
    expect(container.querySelector('dialog')).toBe(dialog)
    expect(dialog.getAttribute('data-state')).toBe('closing')
    expect(dialog.hasAttribute('inert')).toBe(true)
    expect(dialog.getAttribute('aria-hidden')).toBe('true')
    expect(dialog.querySelector('input')).toBe(input)
    expect(input.value).toBe('退场时不闪回')
    finish(dialog)
    expect(container.querySelector('dialog')).toBeNull()
  })
  it('子元素、进场动画及重复关闭事件不会提前结束退场或重复通知', () => {
    const { container, onDismiss } = mount()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    finish(dialog, 'ds-dialog-exit', dialog.querySelector('input')!)
    finish(dialog, 'ds-dialog-enter')
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(container.querySelector('dialog')).toBe(dialog)
    expect(onDismiss).toHaveBeenCalledOnce()
    finish(dialog)
    expect(container.querySelector('dialog')).toBeNull()
  })
  it('遗漏 animationend 时也能兜底卸载，不让透明弹窗锁住界面', () => {
    vi.useFakeTimers()
    const { container } = mount()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    act(() => { vi.advanceTimersByTime(139) })
    expect(container.querySelector('dialog')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(container.querySelector('dialog')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('退场过程中重新打开时保留弹窗，不会被上一次的计时器卸载', () => {
    vi.useFakeTimers()
    const { container } = mount()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    fireEvent.click(screen.getByRole('button', { name: '打开动画弹窗' }))
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(dialog.getAttribute('data-state')).toBe('open')
    expect(dialog.hasAttribute('inert')).toBe(false)
    finish(dialog)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(container.querySelector('dialog')).toBe(dialog)
  })
  it.each([false, true])('减少动态效果在关闭前或退场中启用时立即卸载：%s', reduced => {
    const media = new EventTarget() as EventTarget & { matches: boolean }
    media.matches = reduced
    vi.stubGlobal('matchMedia', vi.fn(() => media))
    const { container } = mount()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    if (!reduced) {
      expect(container.querySelector('dialog')).not.toBeNull()
      media.matches = true
      act(() => { media.dispatchEvent(new Event('change')) })
    }
    expect(container.querySelector('dialog')).toBeNull()
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
  })
  it('忙碌时 Escape 不进入退场', () => {
    const { onDismiss } = mount(true, true)
    const dialog = screen.getByRole('dialog')
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(onDismiss).not.toHaveBeenCalled()
    expect(dialog.getAttribute('data-state')).toBe('open')
  })
  it('完整退场后才恢复触发焦点，卸载后重新打开不会保留输入状态', async () => {
    const { container } = mount(false)
    const trigger = screen.getByRole('button', { name: '打开动画弹窗' })
    trigger.focus(); fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog')
    const input = screen.getByRole('textbox', { name: '编辑内容' })
    fireEvent.change(input, { target: { value: '临时内容' } })
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(document.activeElement).not.toBe(trigger)
    finish(dialog)
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(container.querySelector('dialog')).toBeNull()
    fireEvent.click(trigger)
    expect((screen.getByRole('textbox', { name: '编辑内容' }) as HTMLInputElement).value).toBe('保留内容')
  })
  it.each(['关闭', 'Escape', '遮罩'])('通过%s退出后恢复图标触发焦点，不自动弹出 Tooltip，后续悬停和 Tab 聚焦仍正常', async method => {
    function Example() {
      const [open, setOpen] = useState(false)
      return <><DsButton iconOnly aria-label="更多会话操作" onClick={() => setOpen(true)}>…</DsButton>
        <DsDialogPresence>{open && <DsDialog titleId="return-title" busy={false} onDismiss={() => setOpen(false)}>
          <h2 id="return-title">接续目标设置</h2><DsDialogClose onClick={() => setOpen(false)} />
        </DsDialog>}</DsDialogPresence></>
    }
    render(<Example />)
    const trigger = screen.getByRole('button', { name: '更多会话操作' })
    act(() => trigger.focus())
    expect(screen.getByRole('tooltip').textContent).toBe('更多会话操作')
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog')
    expect(screen.queryByRole('tooltip')).toBeNull()
    if (method === 'Escape') fireEvent(dialog, new Event('cancel', { cancelable: true }))
    else if (method === '遮罩') {
      vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 400, 300))
      fireEvent(dialog, new MouseEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 200, button: 0 }))
      fireEvent.click(dialog, { clientX: 50, clientY: 200 })
    } else fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    finish(dialog)
    await act(async () => {})
    expect(document.activeElement).toBe(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(trigger.hasAttribute('aria-describedby')).toBe(false)
    vi.useFakeTimers()
    fireEvent.mouseEnter(trigger)
    act(() => { vi.advanceTimersByTime(150) })
    expect(screen.getByRole('tooltip').textContent).toBe('更多会话操作')
    fireEvent.mouseLeave(trigger)
    act(() => trigger.blur())
    fireEvent.keyDown(document.body, { key: 'Tab' })
    act(() => trigger.focus())
    expect(screen.getByRole('tooltip').textContent).toBe('更多会话操作')
  })
  it('面板轻微缩放并淡入淡出，遮罩只渐变，减少动态效果覆盖伪元素', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.ds-dialog\[open\]\s*\{[^}]*animation: ds-dialog-enter 180ms/)
    expect(styles).toMatch(/\.ds-dialog\[data-state=['"]closing['"]\]\s*\{[^}]*animation: ds-dialog-exit 140ms/)
    expect(styles).toMatch(/@keyframes ds-dialog-enter\s*\{\s*from\s*\{\s*opacity: 0;\s*transform: scale\(0\.97\);/)
    expect(styles).toMatch(/@keyframes ds-dialog-exit\s*\{\s*from\s*\{\s*opacity: 1;\s*transform: scale\(1\);/)
    expect(styles).toMatch(/\.ds-dialog::backdrop\s*\{[^}]*animation: ds-dialog-backdrop-enter 180ms/)
    expect(styles).toMatch(/\.ds-dialog\[data-state=['"]closing['"]\]::backdrop\s*\{[^}]*animation: ds-dialog-backdrop-exit 140ms/)
    expect(styles).toMatch(/@media\s*\(prefers-reduced-motion: reduce\)\s*\{[^]*?\.ds-dialog::backdrop\s*\{[^}]*animation: none !important;/)
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
