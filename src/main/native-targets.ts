import { z } from 'zod'
import { browsableSources, entryIdSchema, sourceNames, sourceSchema, type BrowsableSource, type SourceConnection } from '../core/sources'
import { continueDestinationSchema, targetSetupModeSchema, type CodexProjectList, type CodexProjectPreview, type CodexSetupMode,
  type NativeContinueDestination, type NativeTargetPreview, type NativeTransferResult, type SourceNativeTarget } from '../core/source-actions'

/** 每个适配器自行完成版本探测、隔离预演、备份、冲突处理、回读和回滚；注册表不将来源格式反向当作写入格式。 */
export interface NativeTargetAdapter {
  id: BrowsableSource
  destinationKind?: 'folder' | 'workspace'
  rollback?(receipt: string, assertAllowed: () => void): Promise<void>
  configured(): Promise<boolean>
  inspect(mode: CodexSetupMode, assertAllowed: () => void): Promise<NativeTargetPreview | null>
  configure(token: string, assertAllowed: () => void): Promise<boolean>
  listProjects(id: string, assertAllowed: () => void): Promise<CodexProjectList>
  chooseProject(id: string, projectId: string | undefined, assertAllowed: () => void): Promise<CodexProjectPreview | null>
  continue(id: string, destination: NativeContinueDestination, assertAllowed: () => void): Promise<NativeTransferResult>
}
const missingEvidence: Record<BrowsableSource, string> = {
  newmax: '尚未接通外部会话创建与回读接口；原会话深链不能导入历史。',
  'claude-code': '尚未验证外部历史的安全创建、隔离回读与指定会话启动；恢复既有会话不等于导入。',
  codex: '当前平台尚无已验证的隔离预演与创建适配。',
  cindy: '尚未接通官方分享包的生成、预检、提交、回滚及新会话定位。',
  deepseek: '尚未验证外部历史的创建、隔离回读与指定会话启动；恢复既有日志不等于导入。',
  workbuddy: '尚未验证外部历史导入、新会话创建与定位接口。',
  'qwen-code': '尚未验证外部历史的创建、隔离回读与指定会话启动。',
}
function unsupported(source: BrowsableSource) {
  return `${sourceNames[source]} 原生接续尚未支持：${missingEvidence[source]}`
}

/** 只枚举显式注册的原生适配；来源连接不代表写入能力，也不为列出目标读取或扫描客户端。 */
export class NativeTargets {
  private readonly adapters = new Map<BrowsableSource, NativeTargetAdapter>()
  constructor(private readonly deps: { connections(): Promise<Pick<SourceConnection, 'source'>[]>; adapters: NativeTargetAdapter[] }) {
    for (const adapter of deps.adapters) {
      const id = sourceSchema.parse(adapter.id)
      if (this.adapters.has(id)) throw new Error(`重复的原生目标：${id}`)
      this.adapters.set(id, adapter)
    }
  }
  async list(): Promise<SourceNativeTarget[]> {
    return Promise.all(browsableSources.filter(id => this.adapters.has(id)).map(async id => {
      const adapter = this.adapters.get(id)!
      const target = { id, name: sourceNames[id], implemented: true,
        ...(adapter.destinationKind ? { destinationKind: adapter.destinationKind } : {}) }
      try { return { ...target, available: true, configured: await adapter.configured() } }
      catch { return { ...target, available: false, reason: `${sourceNames[id]} 目标配置检查失败，请检查已授权配置后重试。` } }
    }))
  }
  private adapter(rawTarget: unknown, assertAllowed: () => void) {
    assertAllowed()
    const id = sourceSchema.parse(rawTarget), adapter = this.adapters.get(id)
    if (!adapter) throw new Error(unsupported(id))
    return adapter
  }
  async rollback(target: unknown, receipt: unknown, assertAllowed = () => {}) {
    const adapter = this.adapter(target, assertAllowed)
    if (!adapter.rollback) throw new Error('该目标尚未提供安全撤销接口')
    return adapter.rollback(z.uuid().parse(receipt), assertAllowed)
  }
  async inspect(target: unknown, mode: unknown = 'automatic', assertAllowed = () => {}) {
    return this.adapter(target, assertAllowed).inspect(targetSetupModeSchema.parse(mode), assertAllowed)
  }
  async configure(target: unknown, token: unknown, assertAllowed = () => {}) {
    return this.adapter(target, assertAllowed).configure(z.uuid().parse(token), assertAllowed)
  }
  async listProjects(id: unknown, target: unknown, assertAllowed = () => {}) {
    return this.adapter(target, assertAllowed).listProjects(entryIdSchema.parse(id), assertAllowed)
  }
  async chooseProject(id: unknown, target: unknown, projectId?: unknown, assertAllowed = () => {}) {
    return this.adapter(target, assertAllowed).chooseProject(entryIdSchema.parse(id), projectId === undefined ? undefined : z.uuid().parse(projectId), assertAllowed)
  }
  async continue(id: unknown, target: unknown, destination: unknown, assertAllowed = () => {}) {
    return this.adapter(target, assertAllowed).continue(entryIdSchema.parse(id), continueDestinationSchema.parse(destination), assertAllowed)
  }
}
