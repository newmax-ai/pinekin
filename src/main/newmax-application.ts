import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
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
