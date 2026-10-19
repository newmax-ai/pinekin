import { lstat, opendir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
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
    // 不沿用独立 CodeBuddy 的环境覆盖；它可能指向另一个客户端的数据根。
    case 'workbuddy': return [join(configuredHome(context, 'WORKBUDDY_CONFIG_DIR', '.workbuddy'), 'projects')]
    case 'qwen-code': return [join(configuredHome(context, context.env.QWEN_RUNTIME_DIR ? 'QWEN_RUNTIME_DIR' : 'QWEN_HOME', '.qwen'), 'projects')]
    case 'deepseek': return [join(configuredHome(context, 'DSH_HOME', '.dsh'), 'sessions')]
    case 'cindy': return [join(context.appData, 'Cindy'), join(context.appData, 'CindyGlobal')]
    // NewMax 源码 appDataPaths + ConversationStore 确认；不扫描旧迁移目录或推测其他进程环境。
    case 'newmax': return [join(configuredHome(context, 'NEWMAX_USER_DATA_DIR', '.newmax'), 'newmax.db')]
  }
}
async function checkedLocation(path: string) {
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error('会话位置经过符号链接，未自动读取；可显式指定可信位置')
  return stat
}
function absent(error: unknown) { return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') }

async function checkedNewMaxLocation(path: string, context: SourceLocationContext): Promise<string> {
  const entry = await lstat(path)
  let canonical: string
  try { canonical = await realpath(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('NewMax 数据库链接存在循环，请检查链接目标')
    if (entry.isSymbolicLink() && absent(error)) throw new Error('NewMax 数据库链接目标不存在或已失效，请检查来源位置')
    throw error
  }
  const target = await lstat(canonical)
  if (!target.isFile() || target.isSymbolicLink()) throw new Error('NewMax 数据库目标不是普通文件')
  // 开发副本会把配置目录中的 newmax.db 链接到默认数据目录。只允许这两个明确入口，不能借链接读取其他文件。
  let allowed = false
  for (const directory of new Set([dirname(path), join(context.home, '.newmax')])) {
    try {
      if (canonical === join(await realpath(directory), 'newmax.db')) { allowed = true; break }
    } catch (error) { if (!absent(error)) throw error }
  }
  if (!allowed) throw new Error('NewMax 数据库链接目标不在默认或配置的数据目录中，请手动选择实际数据库文件')
  const current = await lstat(path)
  if (current.dev !== entry.dev || current.ino !== entry.ino || await realpath(path) !== canonical || await realpath(canonical) !== canonical) {
    throw new Error('NewMax 会话位置在连接期间变化，请重试')
  }
  return canonical
}

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
    let location = path
    try {
      if (source === 'newmax') location = await checkedNewMaxLocation(path, context)
      else {
        const stat = await checkedLocation(path)
        const sqlite = source === 'cindy'
        if (sqlite ? !stat.isFile() : !stat.isDirectory()) throw new Error(sqlite ? '会话位置不是数据库文件' : '会话位置不是文件夹')
      }
    } catch (error) {
      if (absent(error)) continue
      result.warnings.push(locationFailure(path, error)); continue
    }
    // 异步文件检查后重新确认调用方仍持有授权，失效时不继续连接其他位置。
    assertAuthorized()
    try {
      const connection = source === 'newmax'
        ? await browser.connect(source, location, { requireCanonicalPath: true })
        : await browser.connect(source, location)
      if (!result.connections.some(item => item.id === connection.id)) result.connections.push(connection)
    } catch (error) { result.warnings.push(locationFailure(path, error)) }
  }
  // 添加位置不等于读取成功。等待首次扫描，批量界面才能逐项报告真实结果。
  for (const connection of result.connections) { assertAuthorized(); await browser.waitForScan(connection.id) }
  assertAuthorized()
  const latest = await browser.connections()
  result.connections = result.connections.map(connection => latest.find(item => item.id === connection.id) ?? connection)
  for (const connection of result.connections) {
    if (connection.error) result.warnings.push(`${connection.label}：${connection.error}`)
    else if (connection.status === 'cancelled') result.warnings.push(`${connection.label}：统计已暂停，可在管理连接中刷新`)
  }
  if (!result.connections.length && !result.warnings.length) {
    result.notices = [`未找到 ${sourceNames[source]} 的本机会话，可能尚未安装或尚未创建会话，也可使用自定义位置。`]
  }
  result.warnings = [...new Set(result.warnings)]
  return result
}
function locationFailure(path: string, error: unknown) {
  const code = (error as NodeJS.ErrnoException).code
  const message = code === 'EACCES' || code === 'EPERM' ? '没有读取权限，请检查系统授权后重试' : error instanceof Error ? error.message : '连接失败，请重试'
  return `${basename(path)}：${message}`
}
