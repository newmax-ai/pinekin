import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'

// 仅调整 macOS 窗口装饰；不关闭原生控制按钮，也不改变沙箱或内容隔离。
export function getWindowChrome(platform: string): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'trafficLightPosition'> {
  return platform === 'darwin'
    ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 12 } }
    : {}
}

export function getBackgroundTestMode(isPackaged: boolean, flag: string | undefined): boolean {
  return !isPackaged && flag === '1'
}

// 隐藏窗口仍绘制内容，供 CDP 操作与截图；不要先 show 再 hide，避免前台快闪。
export function getTestWindowOptions(background: boolean): Pick<BrowserWindowConstructorOptions, 'show' | 'focusable' | 'skipTaskbar' | 'paintWhenInitiallyHidden'> {
  return background ? { show: false, focusable: false, skipTaskbar: true, paintWhenInitiallyHidden: true } : {}
}

export function presentWindow(window: Pick<BrowserWindow, 'isMinimized' | 'restore' | 'show' | 'focus'> | null, background: boolean): void {
  if (!window || background) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
