import { execFile } from 'node:child_process'
import { extname, join, win32 } from 'node:path'
import { promisify } from 'node:util'

type Run = (file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number; windowsHide: boolean; maxBuffer: number }) => Promise<unknown>
const execute = promisify(execFile) as Run
const failure = '无法写入文件剪贴板，请通过「更多 → 保存完整接续文件」保存后手动添加。'

/**
 * Electron 的命名格式桥无法写预定义的 CF_HDROP，这里交给系统自带的 Windows PowerShell。
 * 路径只经环境变量传递，脚本是固定常量；不走 PATH，避免被同名程序替换。
 */
export async function writeWindowsFileClipboard(path: string,
  { run = execute, env = process.env }: { run?: Run; env?: NodeJS.ProcessEnv } = {}) {
  if (!win32.isAbsolute(path) || path.startsWith('\\\\') || extname(path) !== '.md') throw new Error('无效的接续文件路径。')
  const root = env.SystemRoot ?? env.SYSTEMROOT
  if (!root) throw new Error('无法定位 Windows 系统目录，未写入文件剪贴板。')
  const shell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe').replaceAll('/', '\\')
  try {
    await run(shell, ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -LiteralPath $env:PINEKIN_CLIPBOARD_FILE'],
      { env: { ...env, PINEKIN_CLIPBOARD_FILE: path }, timeout: 15_000, windowsHide: true, maxBuffer: 64 * 1024 })
  } catch { throw new Error(failure) }
}
