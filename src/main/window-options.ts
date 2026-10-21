import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'

// 原生磨砂只用于 macOS 外壳；内容区由渲染层实色覆盖，保留原生控制按钮与窗口行为。
export function getWindowChrome(platform: string): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'trafficLightPosition' | 'vibrancy' | 'visualEffectState' | 'backgroundColor'> {
  return platform === 'darwin'
    ? {
      titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 12 },
      vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000',
    }
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
