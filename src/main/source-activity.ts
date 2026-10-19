import type { SourcePresentation } from '../core/sources'

/** 仅在已校验的来源记录上调用；工具参数和结果始终是惰性显示的文本。 */
export class SourceActivities {
  readonly presentation: SourcePresentation = { kind: 'conversation', textMessages: 0, toolCalls: 0, toolResults: 0,
    attachments: 0, omittedRecords: 0, activities: [], activitiesTruncated: false }
  private readonly names = new Map<string, string>()
  add(kind: 'call' | 'result', id: unknown, name: unknown, value: unknown) {
    const p = this.presentation
    if (kind === 'call') p.toolCalls += 1
    else p.toolResults += 1
    const label = typeof name === 'string' && name.trim() ? name.slice(0, 100) : typeof id === 'string' ? this.names.get(id) ?? '未知工具' : '未知工具'
    if (kind === 'call' && typeof id === 'string' && id.length <= 512 && p.activities.length < 100) this.names.set(id, label)
    if (p.activities.length >= 100) { p.activitiesTruncated = true; return }
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
    const truncated = text.length > 1024
    p.activities.push({ kind, name: label, content: text.slice(0, 1024), ...(truncated ? { truncated: true } : {}) })
    if (truncated) p.activitiesTruncated = true
  }
  claudeBlock(block: Record<string, unknown>) {
    if (block.type === 'tool_use') this.add('call', block.id, block.name, block.input)
    else if (block.type === 'tool_result') {
      // 二进制、图片、文件引用不复制到活动预览，也不尝试加载。
      const value = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
        ? block.content.flatMap(item => item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []).join('\n') : ''
      this.add('result', block.tool_use_id, undefined, value)
    } else if (['image', 'document', 'audio'].includes(String(block.type))) this.presentation.attachments += 1
    else if (block.type !== 'text') this.presentation.omittedRecords += 1
  }
}
