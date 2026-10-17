import type { Dock } from 'electron'

type IconEnvironment = { platform: string; isPackaged: boolean; backgroundTesting: boolean }

export function getAppIconFilename(platform: string) {
  return platform === 'darwin' ? 'pinekin-macos.png' : 'pinekin.png'
}

// 已打包应用使用原生应用包图标；隐藏测试不能通过 Dock API 干扰桌面。
export function setDevelopmentDockIcon(
  dock: Pick<Dock, 'setIcon'> | undefined,
  iconPath: string,
  environment: IconEnvironment,
) {
  if (environment.platform === 'darwin' && !environment.isPackaged && !environment.backgroundTesting) {
    dock?.setIcon(iconPath)
  }
}
