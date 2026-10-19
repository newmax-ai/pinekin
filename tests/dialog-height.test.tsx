// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { DsDialog, DsDialogPresence } from '../src/renderer/src/components/ui'

let height = 180
const observers: { callback(): void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
beforeEach(() => {
  height = 180; observers.length = 0
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.closest('dialog')?.hasAttribute('open') ? height : 0
  })
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn(); disconnect = vi.fn()
    constructor(public callback: () => void) { observers.push(this) }
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function panel(animateHeight = true, content = '选择 App') {
  return <DsDialog titleId="height-title" busy={false} onDismiss={() => {}} animateHeight={animateHeight}>
    <h2 id="height-title">接续面板</h2><div>{content}</div><button>继续</button>
  </DsDialog>
}
function resize(next: number) { height = next; act(() => observers[0].callback()) }

it('只观察自然内容高度，首次显示后设置像素高度，不测量带缩放动画的外框', () => {
  render(panel())
  const dialog = screen.getByRole('dialog')
  const content = dialog.querySelector('.ds-dialog-size-content')!
  expect(content).not.toBeNull()
  expect(observers[0].observe).toHaveBeenCalledExactlyOnceWith(content)
  expect(dialog.getAttribute('data-animate-height')).toBe('true')
  resize(180)
  expect(dialog.style.height).toBe('180px')
})
it('展开、异步列表返回、搜索收起和连续更新均更新目标高度，不替换原节点与焦点', () => {
  const view = render(panel())
  const dialog = screen.getByRole('dialog'), button = screen.getByRole('button', { name: '继续' })
  button.focus(); resize(180)
  view.rerender(panel(true, '正在加载项目')); resize(290)
  expect(dialog.style.height).toBe('290px')
  view.rerender(panel(true, '已有项目列表')); resize(530)
  expect(dialog.style.height).toBe('530px')
  view.rerender(panel(true, '搜索后仅一条')); resize(340)
  expect(dialog.style.height).toBe('340px')
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(screen.getByRole('button', { name: '继续' })).toBe(button)
  expect(document.activeElement).toBe(button)
})
it('零尺寸不将弹窗收缩到零，视口变化后的受限内容高度仍同步', () => {
  render(panel()); resize(530); resize(0)
  expect(screen.getByRole('dialog').style.height).toBe('530px')
  resize(320)
  expect(screen.getByRole('dialog').style.height).toBe('320px')
})
it('默认弹窗不增加包装或测量，不影响已有固定高度弹窗', () => {
  const view = render(panel(false))
  const dialog = screen.getByRole('dialog')
  expect(dialog.querySelector('.ds-dialog-size-content')).toBeNull()
  expect(dialog.style.height).toBe('')
  expect(observers).toHaveLength(0)
  view.rerender(panel()); resize(340)
  view.rerender(panel(false))
  expect(dialog.style.height).toBe('')
  expect(observers[0].disconnect).toHaveBeenCalledOnce()
})
it('未启用时保留其他弹窗自行设置的内联高度，包括退场阶段', () => {
  const view = render(<DsDialogPresence>{panel(false)}</DsDialogPresence>)
  const dialog = screen.getByRole('dialog')
  dialog.style.height = '420px'
  view.rerender(<DsDialogPresence>{null}</DsDialogPresence>)
  expect(dialog.style.height).toBe('420px')
})
it('退场冻结高度，卸载断开观察器，迟到通知不再写入', () => {
  const view = render(<DsDialogPresence>{panel()}</DsDialogPresence>)
  const dialog = screen.getByRole('dialog'); resize(340)
  view.rerender(<DsDialogPresence>{null}</DsDialogPresence>)
  expect(dialog.getAttribute('data-state')).toBe('closing')
  resize(180)
  expect(dialog.style.height).toBe('340px')
  view.unmount(); resize(500)
  expect(observers[0].disconnect).toHaveBeenCalled()
  expect(dialog.style.height).toBe('340px')
})
it('没有尺寸观察器时保留自然布局，不锁定高度', () => {
  vi.stubGlobal('ResizeObserver', undefined)
  render(panel())
  expect(screen.getByRole('dialog').style.height).toBe('')
})
it('仅过渡高度并复用设计系统曲线，内容独立测量且遵守视口上限与减少动态效果', () => {
  const css = readFileSync('src/renderer/src/styles.css', 'utf8')
  expect(css).toMatch(/\.ds-dialog\[data-animate-height='true'\]\s*\{[^}]*transition: height var\(--ds-motion-soft\);/)
  const content = /\.ds-dialog-size-content\s*\{([^}]*)\}/.exec(css)?.[1]
  expect(content).toContain('flex: 0 0 auto;')
  expect(content).toContain('max-height: inherit;')
  expect(content).toContain('flex-direction: column;')
  expect(css).toMatch(/@media\s*\(prefers-reduced-motion: reduce\)\s*\{[^]*?transition: none !important;/)
})
