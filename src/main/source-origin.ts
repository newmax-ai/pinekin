export class UnsupportedSourceError extends Error {}
export type ClaudeOrigin = 'client' | 'sdk'

/** 日志格式不等于客户端归属；只使用顶层来源字段，不检查正文、路径或工具名。 */
export class ClaudeLogOrigin {
  private main?: ClaudeOrigin
  private side?: ClaudeOrigin
  private hasMain = false

  observe(record: Record<string, unknown>): void {
    if (!['user', 'assistant'].includes(String(record.type)) || record.isMeta === true) return
    const origin: ClaudeOrigin | undefined = record.entrypoint === 'cli' || record.entrypoint === 'claude-desktop' ? 'client'
      : record.promptSource === 'sdk' || (typeof record.entrypoint === 'string' && record.entrypoint.startsWith('sdk')) ? 'sdk' : undefined
    if (record.isSidechain === true) this.side ??= origin
    else { this.hasMain = true; this.main ??= origin }
  }

  value(complete = false): ClaudeOrigin | undefined {
    // 有主线时旁支不影响归属；只有完整独立子链才可使用其自身入口，不能拿头部残片猜整份文件。
    return this.hasMain ? this.main : complete ? this.side : undefined
  }
}

export const sdkOriginReason = '这是 Claude Agent SDK 的执行日志，不属于可确认的 Claude Code 客户端会话；不能把执行内核当作来源 App。NewMax 主会话应从已连接的 NewMax 数据库读取，不凭 SDK 标记猜测具体客户端。'
