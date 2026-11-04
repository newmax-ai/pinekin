import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve, win32 } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

const bundleIds = ['cc.newmax.desktop', 'com.newmaxai.app', 'cc.newmax.desktop.cn.dev', 'cc.newmax.desktop.intl.dev'] as const
const identity = z.object({ CFBundleIdentifier: z.enum(bundleIds) })
const protocols = z.array(z.object({ CFBundleURLSchemes: z.array(z.string()) }))

/** 只检查 OS 已关联的精确应用包，不搜索安装位置，不执行目标程序。
 * 开发版运行时注册协议，Info.plist 不含 URLTypes；仅接受其专属 bundle ID。
 */
export async function resolveNewMaxApplication(selection: string) {
  if (!isAbsolute(selection) || /[\x00-\x1f]/.test(selection)) throw new Error('NewMax 应用位置必须为绝对路径。')
  const application = resolve(selection)
  if (!application.endsWith('.app')) throw new Error('系统关联位置不是受支持的 NewMax 应用包。')
  const packageStat = await lstat(application)
  if (packageStat.isSymbolicLink() || await realpath(application) !== application) throw new Error('NewMax 应用包经过符号链接，不能确认身份。')
  if (!packageStat.isDirectory()) throw new Error('系统关联位置不是受支持的 NewMax 应用包。')
  const metadata = join(application, 'Contents/Info.plist'), stat = await lstat(metadata)
  if (stat.isSymbolicLink() || await realpath(metadata) !== metadata) throw new Error('NewMax 应用信息经过符号链接或越出应用包。')
  if (!stat.isFile()) throw new Error('NewMax 应用信息不是普通文件。')
  if (stat.size > 256 * 1024) throw new Error('NewMax 应用信息超过识别上限。')
  let info: unknown
  try {
    const { stdout } = await promisify(execFile)('/usr/bin/plutil', ['-convert', 'json', '-o', '-', metadata], { timeout: 5000, maxBuffer: 256 * 1024 })
    info = JSON.parse(stdout)
  } catch { throw new Error('无法解析 NewMax 应用包的 Info.plist。') }
  const parsed = identity.safeParse(info)
  if (!parsed.success) throw new Error('系统关联应用的 NewMax 包身份不匹配；不会放行通用 Electron。')
  const bundleId = parsed.data.CFBundleIdentifier, development = bundleId.endsWith('.dev')
  const declared = (info as Record<string, unknown>).CFBundleURLTypes
  const types = protocols.safeParse(declared)
  if (declared !== undefined && !types.success || !development && (!types.success || !types.data.some(type => type.CFBundleURLSchemes.includes('newmax')))) {
    throw new Error('NewMax 应用包的 newmax 协议声明不匹配。')
  }
  const current = await lstat(metadata)
  if (current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || await realpath(metadata) !== metadata) {
    throw new Error('NewMax 应用信息在检查期间变化，请重试。')
  }
  return { path: application, bundleId, mode: development ? 'development' as const : 'packaged' as const }
}

// 官方 NSIS 包的可执行文件名与其版本信息产品名一一对应：国内版 NewMax、国际版 NewMax AI。
const windowsProducts = new Map([['newmax.exe', 'NewMax'], ['newmax ai.exe', 'NewMax AI']])
const PRODUCT_SCRIPT = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;[System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:PINEKIN_APPLICATION).ProductName'

export interface WindowsApplicationDeps {
  run(file: string, args: string[], env?: Record<string, string>): Promise<{ code: number; stdout: string }>
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isFile(): boolean; size: number; mtimeMs: number }>
  realpath(path: string): Promise<string>
  systemRoot: string
}
function defaultWindowsDeps(): WindowsApplicationDeps {
  return {
    systemRoot: process.env.SystemRoot || 'C:\\Windows', lstat, realpath,
    async run(file, args, env) {
      try {
        const { stdout } = await promisify(execFile)(file, args, { timeout: 8000, maxBuffer: 64 * 1024, windowsHide: true, env: { ...process.env, ...env } })
        return { code: 0, stdout }
      } catch (error) {
        const code = (error as { code?: unknown }).code
        if (typeof code === 'number') return { code, stdout: '' }
        throw error
      }
    },
  }
}

/** Windows 上只读检查 newmax:// 的注册表关联，不搜索安装位置，不执行目标程序。
 * 通过：无用户另选的默认应用；启动命令严格为 `"<本地绝对路径>" "%1"`；文件名为官方可执行文件名；
 * 路径不经符号链接或联接点；版本信息产品名与文件名配对。这能挡住通用 Electron 与随意改名的程序，
 * 但没有校验数字签名，也不能防止同用户进程改写注册表后伪造产品名——与 macOS 包身份校验的强度同级，不是安全边界。 */
export async function resolveNewMaxWindowsApplication(deps: WindowsApplicationDeps = defaultWindowsDeps()) {
  const system32 = win32.join(deps.systemRoot, 'System32')
  const reg = win32.join(system32, 'reg.exe'), powershell = win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const choice = await deps.run(reg, ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\newmax\\UserChoice', '/v', 'ProgId'])
  if (choice.code === 0) throw new Error('用户为 newmax 协议另选了默认应用，无法确认 NewMax 身份。')
  const query = await deps.run(reg, ['query', 'HKCR\\newmax\\shell\\open\\command', '/ve'])
  if (query.code !== 0) throw new Error('未找到 newmax 协议的注册信息。')
  // 默认值名称随系统语言本地化，只按 REG_SZ 类型解析。
  const value = /^\s+\S.*?\s+REG_SZ\s+(.+?)\s*$/m.exec(query.stdout)?.[1]
  const executable = value && /^"([^"]+)" "%1"$/.exec(value)?.[1]
  if (!executable) throw new Error('newmax 协议的启动命令格式不受信任。')
  if (!/^[A-Za-z]:\\/.test(executable) || /[\x00-\x1f<>|*?]/.test(executable) || executable.includes(':', 2) || win32.normalize(executable) !== executable) {
    throw new Error('NewMax 可执行文件必须是本地绝对路径。')
  }
  const product = windowsProducts.get(win32.basename(executable).toLowerCase())
  if (!product) throw new Error('NewMax 可执行文件名不是受支持的官方名称。')
  const before = await deps.lstat(executable)
  if (before.isSymbolicLink()) throw new Error('NewMax 可执行文件是符号链接，不能确认身份。')
  if (!before.isFile()) throw new Error('NewMax 可执行文件不是普通文件。')
  if ((await deps.realpath(executable)).toLowerCase() !== executable.toLowerCase()) throw new Error('NewMax 可执行文件路径经过符号链接或联接点，不能确认身份。')
  const info = await deps.run(powershell, ['-NoProfile', '-NonInteractive', '-Command', PRODUCT_SCRIPT], { PINEKIN_APPLICATION: executable })
  if (info.code !== 0) throw new Error('无法读取 NewMax 可执行文件的版本信息。')
  if (info.stdout.trim() !== product) throw new Error('可执行文件的产品名与文件名不匹配，不能确认 NewMax 身份。')
  const after = await deps.lstat(executable)
  if (after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || (await deps.realpath(executable)).toLowerCase() !== executable.toLowerCase()) {
    throw new Error('NewMax 可执行文件在检查期间变化，请重试。')
  }
  return { path: executable, productName: product }
}
