export const legacySources = ['newmax', 'claude-code', 'codex', 'other'] as const
export const sources = [...legacySources, 'cindy', 'deepseek'] as const
export type Source = typeof sources[number]
export type Target = '通用' | 'NewMax' | 'Claude Code' | 'Codex'
export type ExportFormat = 'bundle' | 'markdown'
export interface Message { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }
export interface Session {
  id: string
  title: string
  source: Source
  updatedAt: string
  tags: string[]
  messages: Message[]
  demo: boolean
  archive?: ArchiveMetadata
}
export interface ArchiveMetadata {
  adapterId: string
  adapterVersion: string
  sha256: string
  importedAt: string
  originalSessionId: string | null
  sourceVersion?: string
  fidelity: 'text-only'
  warnings: string[]
}
export interface ImportPreview {
  token: string
  sourceName: string
  evidence: 'fixture-tested'
  title: string
  messageCount: number
  byteLength: number
  sha256: string
  warnings: string[]
  duplicate: boolean
}
export interface ImportResult { session: Session; duplicate: boolean }
export interface ParsedArchive {
  session: Session
  adapterId: string
  adapterVersion: string
  sourceName: string
  sourceVersion?: string
  originalSessionId?: string | null
  warnings: string[]
}
export interface SessionAdapter {
  id: Source
  name: string
  capabilities: { listLocal: boolean; readLocal: boolean; importArchive: boolean; nativeResume: boolean; deepLink: boolean }
  archiveStatus?: 'unknown' | 'documented' | 'fixture-tested' | 'integration-tested' | 'unsupported'
  constraints?: string
  // 未来接入只能读取用户明确授权的位置，不默认扫描主目录。
  read?: (authorizedPath: string) => Promise<Session[]>
}
export interface StaitheAPI {
  readonly platform: string
  readonly sources: import('./sources').SourceBrowserAPI
  list(): Promise<Session[]>
  previewImport(): Promise<ImportPreview | null>
  confirmImport(token: string): Promise<ImportResult>
  cancelImport(token: string): Promise<void>
  exportSession(id: string, format: ExportFormat, target: Target): Promise<boolean>
  copy(text: string): Promise<void>
  onOpenSession(callback: (id: string) => void): () => void
}
