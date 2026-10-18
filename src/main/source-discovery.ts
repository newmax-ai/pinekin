import { lstat, opendir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { sourceNames, sourceSchema, type BrowsableSource, type SourceConnectResult } from '../core/sources'
import type { SourceBrowser } from './source-browser'

export interface SourceLocationContext {
  home: string
  appData: string
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
}
function configuredHome(context: SourceLocationContext, variable: string, fallback: string) {
  let value = context.env[variable]
  if (variable === 'DSH_HOME') {
    if (!value?.trim()) value = undefined
    else if (value === '~') value = context.home
    else if (value.startsWith('~/') || value.startsWith('~\\')) value = join(context.home, value.slice(2))
  }
  if (!value) return join(context.home, fallback)
  // 不用 Pinekin 的 cwd 推断另一个 CLI 启动时的相对 home。
  if (!isAbsolute(value)) throw new Error(`${variable} 必须为绝对路径；未搜索其他位置`)
  return resolve(value)
}

/** 明确的会话入口；Cindy 返回账号库所在目录，之后只枚举一层白名单文件名。证据见 docs/source-browser.md。 */
export function sourceCandidates(source: BrowsableSource, context: SourceLocationContext): string[] {
  sourceSchema.parse(source)
  switch (source) {
    case 'claude-code': return [join(configuredHome(context, 'CLAUDE_CONFIG_DIR', '.claude'), 'projects')]
    case 'codex': {
      const home = configuredHome(context, 'CODEX_HOME', '.codex')
      return [join(home, 'sessions'), join(home, 'archived_sessions')]
    }
    case 'deepseek': return [join(configuredHome(context, 'DSH_HOME', '.dsh'), 'sessions')]
    case 'cindy': return [join(context.appData, 'Cindy'), join(context.appData, 'CindyGlobal')]
    // 没有已验证的默认 DB 路径，不能用示例或日志路径推断；仍可复用已授权连接。
    case 'newmax': return []
  }
}
async function checkedLocation(path: string) {
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error('会话位置经过符号链接，未自动读取；可显式指定可信位置')
  return stat
}
function absent(error: unknown) { return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') }

/** 仅由用户点击连接触发。多个默认位置全部处理；单点失败不隐藏其他结果。 */
export async function autoConnectSource(browser: SourceBrowser, rawSource: BrowsableSource, context: SourceLocationContext,
  assertAuthorized: () => void = () => {}): Promise<SourceConnectResult> {
  const source = sourceSchema.parse(rawSource)
  const roots = [...new Set(sourceCandidates(source, context))]
  const result: SourceConnectResult = { connections: [], warnings: [] }
  assertAuthorized()
  // 自定义位置一经明确授权，下次连接直接复用，不要求再次选文件。
  for (const connection of (await browser.connections()).filter(item => item.source === source)) {
    assertAuthorized()
    if (connection.status !== 'scanning') await browser.refresh(connection.id)
    result.connections.push(connection)
  }
  const candidates: string[] = []
  if (source === 'cindy') {
    for (const root of roots) {
      assertAuthorized()
      try {
        if (!(await checkedLocation(root)).isDirectory()) throw new Error('会话位置不是文件夹')
        for await (const entry of await opendir(root)) {
          if ((entry.isFile() || entry.isSymbolicLink()) && /^cindy-[^/\\]+\.db$/.test(entry.name)) candidates.push(join(root, entry.name))
        }
      } catch (error) { if (!absent(error)) result.warnings.push(locationFailure(root, error)) }
    }
  } else candidates.push(...roots)
  for (const path of candidates) {
    assertAuthorized()
    try {
      const stat = await checkedLocation(path)
      const sqlite = source === 'newmax' || source === 'cindy'
      if (sqlite ? !stat.isFile() : !stat.isDirectory()) throw new Error(sqlite ? '会话位置不是数据库文件' : '会话位置不是文件夹')
    } catch (error) {
      if (absent(error)) continue
      result.warnings.push(locationFailure(path, error)); continue
    }
    // 异步文件检查后重新确认调用方仍持有授权，失效时不继续连接其他位置。
    assertAuthorized()
    try {
      const connection = await browser.connect(source, path)
      if (!result.connections.some(item => item.id === connection.id)) result.connections.push(connection)
    } catch (error) { result.warnings.push(locationFailure(path, error)) }
  }
  if (!result.connections.length && !result.warnings.length) {
    result.warnings.push(roots.length ? `未找到 ${sourceNames[source]} 的本机会话，请先在该 App 中创建会话后重试。使用自定义位置时可手动指定。` :
      `${sourceNames[source]} 的默认会话位置尚未验证，暂不能自动定位；已有连接可直接复用，否则需手动指定一次。`)
  }
  return result
}
function locationFailure(path: string, error: unknown) {
  const code = (error as NodeJS.ErrnoException).code
  const message = code === 'EACCES' || code === 'EPERM' ? '没有读取权限，请检查系统授权后重试' : error instanceof Error ? error.message : '连接失败，请重试'
  return `${basename(path)}：${message}`
}
