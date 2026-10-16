export const sources = ['newmax', 'claude-code', 'codex', 'other'] as const
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
}
export interface SessionAdapter {
  id: Source
  name: string
  capabilities: { readLocal: boolean; importArchive: boolean; nativeResume: boolean; deepLink: boolean }
  // 未来接入只能读取用户明确授权的位置，不默认扫描主目录。
  read?: (authorizedPath: string) => Promise<Session[]>
}
export interface StaitheAPI {
  list(): Promise<Session[]>
  importBundle(): Promise<Session | null>
  exportSession(id: string, format: ExportFormat, target: Target): Promise<boolean>
  copy(text: string): Promise<void>
  onOpenSession(callback: (id: string) => void): () => void
}
