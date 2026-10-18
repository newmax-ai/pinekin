import type { SourceConnection } from '../../../core/sources'
import { DsButton } from './ui'
import disconnected from '../assets/empty-states/disconnected.svg'
import empty from '../assets/empty-states/empty.svg'
import search from '../assets/empty-states/search.svg'
import selection from '../assets/empty-states/selection.svg'
import unavailable from '../assets/empty-states/unavailable.svg'
import messages from '../assets/empty-states/messages.svg'

type EmptyPreset = { title: string; description?: string; image?: string; role?: 'status' | 'alert'; pending?: boolean }
export const emptyStatePresets = {
  loading: { title: '正在读取来源目录…', role: 'status', pending: true },
  'archive-loading': { title: '正在读取本地档案…', role: 'status', pending: true },
  scanning: { title: '正在发现会话…', role: 'status', pending: true },
  disconnected: { title: '尚未连接会话来源', image: disconnected },
  'needs-refresh': { title: '等待刷新', image: empty },
  paused: { title: '会话统计已暂停', image: empty },
  partial: { title: '部分位置未能读取', description: '当前结果可能不完整。', image: unavailable },
  'connection-error': { title: '暂时无法读取来源', description: '可在连接详情中查看具体原因。', image: unavailable, role: 'alert' },
  'list-error': { title: '暂时无法读取会话列表', image: unavailable, role: 'alert' },
  empty: { title: '还没有可浏览的会话', description: '新对话需在来源 App 中创建。', image: empty },
  'no-results': { title: '没有找到匹配的会话', image: search },
  selection: { title: '尚未选择会话', image: selection },
  'read-error': { title: '暂时无法读取这段会话', image: unavailable, role: 'alert' },
  unsupported: { title: '会话已发现，正文暂不可用', description: '此格式暂不支持正文读取。', image: unavailable, role: 'alert' },
  messages: { title: '这段会话暂时没有消息', image: messages },
  'archives-empty': { title: '还没有会话档案', image: empty },
  'source-empty': { title: '此来源还没有会话档案', image: empty },
  'archive-error': { title: '暂时无法读取档案', image: unavailable, role: 'alert' },
  'connections-empty': { title: '尚未保存连接', image: disconnected },
} satisfies Record<string, EmptyPreset>
export type EmptyStateKind = keyof typeof emptyStatePresets
export type EmptyStateAction = { label: string; onClick: () => void; disabled?: boolean }

/** 标题说明状态，描述补充原因、范围或能力；具体操作交给按钮，不重复引导。 */
const heroDescriptions: Record<EmptyStateKind, string> = {
  loading: '此时只读取会话列表，不加载正文。',
  'archive-loading': '仅加载已保存的会话档案。',
  scanning: '已发现的会话会陆续显示。',
  disconnected: '支持 Claude Code、Codex 等来源。',
  'needs-refresh': '连接位置已保留，会话列表尚未更新。',
  paused: '当前统计结果可能不完整。',
  partial: '当前列表可能缺少部分会话。',
  'connection-error': '可在连接详情中查看具体原因。',
  'list-error': '已保存的连接不受此次加载失败影响。',
  empty: '新对话需在来源 App 中创建。',
  'no-results': '结果仅限当前筛选的来源。',
  selection: '正文与来源信息将在这里显示。',
  'read-error': '会话列表仍可正常浏览。',
  unsupported: '此会话的正文格式暂未支持。',
  messages: '标题与来源信息仍可查看。',
  'archives-empty': '导入前可预览内容与兼容性。',
  'source-empty': '其他来源的档案不受此筛选影响。',
  'archive-error': '可检查档案目录的访问权限。',
  'connections-empty': '连接按来源 App 分别管理。',
}

/** 小空间只用一句提示，不复用主阅读区的标题与说明组合。 */
const quietDescriptions: Record<EmptyStateKind, string> = {
  loading: '正在读取会话…',
  'archive-loading': '正在读取档案…',
  scanning: '正在发现会话…',
  disconnected: '连接来源后查看会话',
  'needs-refresh': '刷新后查看会话',
  paused: '统计已暂停，可刷新重试',
  partial: '部分位置未读完，可刷新重试',
  'connection-error': '来源读取失败，请检查连接',
  'list-error': '列表读取失败，请重试',
  empty: '暂无会话',
  'no-results': '未找到匹配的会话',
  selection: '选择会话查看内容',
  'read-error': '会话读取失败，请重试',
  unsupported: '暂不支持读取此格式',
  messages: '暂无消息',
  'archives-empty': '暂无会话档案',
  'source-empty': '此来源暂无档案',
  'archive-error': '档案读取失败，请重试',
  'connections-empty': '暂无连接',
}

/** 仅对当前筛选的连接作判断；有数据时始终保留列表，局部异常由现有提示说明。 */
export function resolveSourceEmptyState({ loaded, error, count, connections, query }: {
  loaded: boolean; error: string; count: number; connections: SourceConnection[]; query: string
}): EmptyStateKind | undefined {
  if (count > 0) return undefined
  if (error) return 'list-error'
  if (!loaded) return 'loading'
  if (!connections.length) return 'disconnected'
  if (connections.some(item => item.status === 'scanning')) return 'scanning'
  if (connections.some(item => item.status === 'error')) return 'connection-error'
  if (connections.some(item => item.status === 'partial')) return 'partial'
  if (connections.some(item => item.status === 'cancelled')) return 'paused'
  if (connections.some(item => item.status === 'idle')) return 'needs-refresh'
  return query.trim() ? 'no-results' : 'empty'
}

export function resolveArchiveEmptyState({ loaded, error, total, count, query, filtered }: {
  loaded: boolean; error: string; total: number; count: number; query: string; filtered: boolean
}): EmptyStateKind | undefined {
  if (count > 0) return undefined
  if (error) return 'archive-error'
  if (!loaded) return 'archive-loading'
  if (!total) return 'archives-empty'
  if (query.trim()) return 'no-results'
  return filtered ? 'source-empty' : 'archives-empty'
}

/** 同一区域只显示一套占位；quiet 用于列表摘要，避免与阅读区重复插画和行动。 */
export function EmptyState({ kind, layout = 'compact', title, description, action }: {
  kind: EmptyStateKind; layout?: 'hero' | 'compact' | 'quiet'; title?: string; description?: string; action?: EmptyStateAction
}) {
  const preset: EmptyPreset = emptyStatePresets[kind]
  const defaultDescription = layout === 'hero' ? heroDescriptions[kind] : layout === 'quiet' ? quietDescriptions[kind] : preset.description
  const summary = description ?? defaultDescription
  const Heading = layout === 'hero' ? 'h2' : 'h3'
  return <div className={`empty-state empty-state-${layout}`} data-empty-state={kind} role={layout === 'quiet' ? undefined : preset.role} aria-atomic={preset.role ? true : undefined}>
    {preset.pending ? layout !== 'quiet' && <span className="empty-progress" aria-hidden="true"><i /><i /><i /></span>
      : layout !== 'quiet' && preset.image && <img className="empty-illustration" src={preset.image} alt="" aria-hidden="true" draggable={false} width={160} height={160} />}
    {layout !== 'quiet' && <Heading>{title ?? preset.title}</Heading>}
    {summary && <p className="empty-description">{summary}</p>}
    {!preset.pending && action && <DsButton variant="tertiary" disabled={action.disabled} onClick={action.onClick}>{action.label}</DsButton>}
  </div>
}
