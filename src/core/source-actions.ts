import type { BrowsableSource } from './sources'

export interface SourceActionAvailability {
  available: boolean
  app: string
  reason?: string
}
export interface SourceActionCapabilities {
  original: SourceActionAvailability
  // 具备创建适配的目标；实际提交前仍用本机所选版本隔离预演、回读。
  targets: { id: BrowsableSource; name: string; configured?: boolean }[]
}
export interface CodexTransferResult {
  status: 'created' | 'existing'; receipt: string; threadId: string; app: 'Codex'; messageCount: number; opened: boolean; error?: string
}
export type CodexSetupMode = 'automatic' | 'directory' | 'application'
export interface CodexTargetPreview {
  app: 'Codex'; applicationPath?: string; applicationName?: string; dataPath: string; token?: string; configured: boolean
  locationSource: 'saved' | 'default' | 'environment' | 'custom'
  canChooseApplication: boolean; reason?: string
}
export interface CodexProjectPreview { token: string; path: string; name: string }
export interface CodexSavedProject { id: string; name: string; path: string; reason?: string }
export interface CodexProjectList { projects: CodexSavedProject[]; warning?: string }
export type CodexContinueDestination = { kind: 'standalone' } | { kind: 'project'; token: string }
export interface SourceActionsAPI {
  inspect(id: string): Promise<SourceActionCapabilities>
  openOriginal(id: string): Promise<{ status: 'requested'; app: string }>
  exportText(text: string): Promise<boolean>
  inspectCodexTarget?(mode?: CodexSetupMode): Promise<CodexTargetPreview | null>
  configureCodex?(token: string): Promise<boolean>
  listCodexProjects?(id: string): Promise<CodexProjectList>
  chooseCodexProject?(id: string, projectId?: string): Promise<CodexProjectPreview | null>
  continueInCodex?(id: string, destination: CodexContinueDestination): Promise<CodexTransferResult>
  rollbackTransfer?(receipt: string): Promise<void>
}
