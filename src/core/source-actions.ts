import { z } from 'zod'
import type { BrowsableSource } from './sources'
import type { HandoffAPI } from './handoff'

export interface SourceActionAvailability {
  available: boolean
  app: string
  reason?: string
}
export interface SourceNativeTarget {
  id: BrowsableSource; name: string; configured?: boolean
  // 旧主进程缺少此字段时，只兼容已有的 Codex 适配，不推断其他目标可写。
  available?: boolean; reason?: string; destinationKind?: 'folder' | 'workspace'
}
export interface SourceActionCapabilities {
  original: SourceActionAvailability
  // 已连接 App 与已注册原生目标；是否可创建由 available 明确说明。
  targets: SourceNativeTarget[]
}
export interface NativeTransferResult {
  status: 'created' | 'existing'; receipt: string; threadId: string; app: string; messageCount: number; opened: boolean; error?: string
}
export interface CodexTransferResult extends NativeTransferResult { app: 'Codex' }
export type CodexSetupMode = 'automatic' | 'directory' | 'application'
export const targetSetupModeSchema = z.enum(['automatic', 'directory', 'application'])
export const continueDestinationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('standalone') }),
  z.strictObject({ kind: z.literal('project'), token: z.uuid() }),
])
export type NativeContinueDestination = z.infer<typeof continueDestinationSchema>
export interface NativeTargetPreview {
  app: string; applicationPath?: string; applicationName?: string; dataPath: string; token?: string; configured: boolean
  locationSource: 'saved' | 'default' | 'environment' | 'custom'
  canChooseApplication: boolean; reason?: string
}
export interface CodexTargetPreview extends NativeTargetPreview { app: 'Codex' }
export interface CodexProjectPreview { token: string; path: string; name: string }
export interface CodexSavedProject { id: string; name: string; path: string; reason?: string }
export interface CodexProjectList { projects: CodexSavedProject[]; warning?: string }
export type CodexContinueDestination = NativeContinueDestination
export interface SourceActionsAPI extends HandoffAPI {
  inspect(id: string): Promise<SourceActionCapabilities>
  openOriginal(id: string): Promise<{ status: 'requested'; app: string }>
  exportText(text: string): Promise<boolean>
  inspectTarget?(target: BrowsableSource, mode?: CodexSetupMode): Promise<NativeTargetPreview | null>
  configureTarget?(target: BrowsableSource, token: string): Promise<boolean>
  listTargetProjects?(target: BrowsableSource, id: string): Promise<CodexProjectList>
  chooseTargetProject?(target: BrowsableSource, id: string, projectId?: string): Promise<CodexProjectPreview | null>
  continueInTarget?(id: string, target: BrowsableSource, destination: NativeContinueDestination): Promise<NativeTransferResult>
  inspectCodexTarget?(mode?: CodexSetupMode): Promise<CodexTargetPreview | null>
  configureCodex?(token: string): Promise<boolean>
  listCodexProjects?(id: string): Promise<CodexProjectList>
  chooseCodexProject?(id: string, projectId?: string): Promise<CodexProjectPreview | null>
  continueInCodex?(id: string, destination: CodexContinueDestination): Promise<CodexTransferResult>
  rollbackTargetTransfer?(target: BrowsableSource, receipt: string): Promise<void>
  rollbackTransfer?(receipt: string): Promise<void>
}
