// Pinekin Engine：不依赖 Electron 与界面的会话读取引擎。Pinekin App 与 NewMax 共用同一份来源知识。
import { homedir } from 'node:os'
import { isAbsolute, posix, win32 } from 'node:path'
import { sourceCandidates } from '../main/source-discovery'
import { PinekinUnsupportedError } from './blocks'
import { listCodex, readCodex } from './codex'
import { listQwen, readQwen } from './qwen'
import { listWorkbuddy, readWorkbuddy } from './workbuddy'
import { listDeepseek, readDeepseek } from './deepseek'
import type { EngineSource, ListOptions, LocationContext, ReadOptions, SessionRef, SourceCapability, Transcript } from './types'

export type * from './types'
export { PinekinUnsupportedError }

export const ENGINE_VERSION = '0.3.1'

const capabilities: SourceCapability[] = [
  { source: 'codex', name: 'Codex', discover: true, structured: true, workingDirectory: true, scope: 'workspace', verifiedPlatforms: ['darwin', 'linux'] },
  { source: 'qwen-code', name: 'Qwen Code', discover: true, structured: true, workingDirectory: true, scope: 'workspace', verifiedPlatforms: ['darwin', 'linux'] },
  // 日志与侧车都没有工作目录，projects/ 下是 WorkBuddy 自建任务文件夹：只能作为全局来源。
  { source: 'workbuddy', name: 'WorkBuddy', discover: true, structured: true, workingDirectory: false, scope: 'global', verifiedPlatforms: ['darwin'] },
  { source: 'deepseek', name: 'DeepSeek Harness', discover: true, structured: true, workingDirectory: true, scope: 'workspace', verifiedPlatforms: ['darwin'] },
]

/** 能力清单：调用方按此渲染来源列表，不自行假设来源支持范围。 */
export function engineSources(): SourceCapability[] {
  return capabilities.map(item => ({ ...item, verifiedPlatforms: [...item.verifiedPlatforms] }))
}

function isEngineSource(value: unknown): value is EngineSource {
  return capabilities.some(item => item.source === value)
}

function locationContext(context: Partial<LocationContext> = {}): LocationContext {
  return { home: context.home ?? homedir(), appData: context.appData ?? '', platform: context.platform ?? process.platform, env: context.env ?? process.env }
}

/** 与 Pinekin App 自动连接相同的默认位置；环境变量不是绝对路径时返回空列表而不是猜测。 */
export function defaultLocations(source: EngineSource, context?: Partial<LocationContext>): string[] {
  if (!isEngineSource(source)) throw new Error(`不支持的来源：${String(source)}`)
  try { return sourceCandidates(source, locationContext(context) as Parameters<typeof sourceCandidates>[1]) } catch { return [] }
}

export async function* listSessions(source: EngineSource, options: ListOptions = {}): AsyncGenerator<SessionRef> {
  if (!isEngineSource(source)) throw new Error(`不支持的来源：${String(source)}`)
  const roots = options.roots ?? defaultLocations(source, options.context)
  if (roots.some(root => !isAbsolute(root))) throw new Error('来源位置必须是绝对路径')
  yield* source === 'codex' ? listCodex(roots, options.signal)
    : source === 'qwen-code' ? listQwen(roots, options.signal)
      : source === 'workbuddy' ? listWorkbuddy(roots, options.signal) : listDeepseek(roots, options.signal)
}

export async function readTranscript(ref: SessionRef, options: ReadOptions = {}): Promise<Transcript> {
  if (!isEngineSource(ref.source)) throw new Error(`不支持的来源：${String(ref.source)}`)
  return ref.source === 'codex' ? readCodex(ref, options, ENGINE_VERSION)
    : ref.source === 'qwen-code' ? readQwen(ref, options, ENGINE_VERSION)
      : ref.source === 'workbuddy' ? readWorkbuddy(ref, options, ENGINE_VERSION) : readDeepseek(ref, options, ENGINE_VERSION)
}

/** 工作目录是否等于或位于工作区内；Windows 与 macOS 默认文件系统按不区分大小写比较。 */
export function workingDirectoryWithin(directory: string, workspace: string, platform: string = process.platform): boolean {
  const windows = platform === 'win32'
  const path = windows ? win32 : posix
  const fold = (value: string) => windows || platform === 'darwin' ? value.toLowerCase() : value
  const child = fold(path.resolve(directory)), parent = fold(path.resolve(workspace))
  const part = path.relative(parent, child)
  return part === '' || part !== '..' && !part.startsWith('..' + path.sep) && !path.isAbsolute(part)
}
