// Pinekin Engine 公共契约。本文件不得引用其他模块，构建时作为独立类型声明随引擎分发。

/** 引擎当前能输出结构化记录的来源；其余来源仍只在 Pinekin App 内以文本投影阅读。 */
export type EngineSource = 'codex' | 'qwen-code'

export interface LocationContext {
  home: string
  appData: string
  platform: string
  env: Record<string, string | undefined>
}

export interface SourceCapability {
  source: EngineSource
  name: string
  /** 能在默认位置自动列出会话。 */
  discover: boolean
  /** 能输出 pinekin.transcript v1 结构化记录（思考、工具调用与结果）。 */
  structured: boolean
  /** 每条会话带可信的绝对工作目录，可按工作区归属。 */
  workingDirectory: boolean
  /** 已有合成样本契约测试的平台；未列出的平台不代表不可用，只是未验证。 */
  verifiedPlatforms: string[]
}

export type SessionKind = 'conversation' | 'subagent'

export interface SessionRef {
  source: EngineSource
  /** 来源客户端自己的会话 ID，与 source 一起构成跨次同步的稳定身份。 */
  sessionId: string
  path: string
  /** 授权根目录；读取时拒绝越出该目录或经过符号链接。 */
  root: string
  compressed: boolean
  /** 文件大小与修改时间的指纹；不变即可跳过读取。 */
  revision: string
  updatedAt: string
  workingDirectory?: string
  kind: SessionKind
  /** 已知不支持的边界；有值时 readTranscript 会拒绝。 */
  unsupportedReason?: string
}

export type TranscriptBlock =
  | { type: 'text'; text: string; truncated?: boolean }
  | { type: 'thinking'; text: string; truncated?: boolean }
  | { type: 'tool_call'; id: string; name: string; input: string; truncated?: boolean }
  | { type: 'tool_result'; callId: string; output: string; isError?: boolean; truncated?: boolean }
  | { type: 'attachment'; kind: 'image' | 'file' | 'other'; note: string }

export interface TranscriptMessage {
  /** 同一来源文件只追加时保持稳定，可作为下游消息主键的一部分。 */
  id: string
  role: 'user' | 'assistant'
  timestamp: string
  blocks: TranscriptBlock[]
}

export interface Transcript {
  format: 'pinekin.transcript'
  version: 1
  engineVersion: string
  source: EngineSource
  sessionId: string
  kind: SessionKind
  title: string
  workingDirectory?: string
  sourceVersion?: string
  createdAt: string
  updatedAt: string
  revision: string
  messages: TranscriptMessage[]
  /** 已知的投影边界（回退、压缩、加密内容等），只用于展示说明。 */
  warnings: string[]
}

export interface ListOptions {
  /** 覆盖默认位置；必须是用户授权的绝对路径。 */
  roots?: string[]
  context?: Partial<LocationContext>
  signal?: AbortSignal
}

export interface ReadOptions {
  signal?: AbortSignal
}
