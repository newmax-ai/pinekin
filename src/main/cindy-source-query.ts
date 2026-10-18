import { MAX_BYTES } from '../core/session'

// 对应授权核对的 0.1.110 表结构；表示字段契约，不冒充当前安装版本探测。
export const CINDY_SOURCE_SCHEMA = '0.1.110-schema'
export const cindySessionColumns = ['id', 'title', 'source', 'status', 'created_at', 'updated_at', 'parent_session_id',
  'forked_at_message_id', 'remote_host_id', 'orca_role', 'cleared_at', 'agent_device_id', 'orca_remote_lead', 'hidden_at']
export const cindyMessageColumns = ['id', 'session_id', 'role', 'content', 'created_at', 'rewind_at']
export const cindyRequiredTables = { sessions: cindySessionColumns, messages: cindyMessageColumns,
  orca_workers: ['session_id'], orca_teams: ['lead_session_id'] }

// 目录与正文共用相同边界，不能等用户打开后才识别已知不支持的会话。
const allowed = `s.source='desktop' AND s.status IN ('active','archived')
  AND s.parent_session_id IS NULL AND s.forked_at_message_id IS NULL AND s.remote_host_id IS NULL AND s.orca_role IS NULL
  AND s.agent_device_id IS NULL AND s.orca_remote_lead IS NULL AND s.hidden_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM orca_workers w WHERE w.session_id=s.id)
  AND NOT EXISTS(SELECT 1 FROM orca_teams t WHERE t.lead_session_id=s.id)`

export function cindyDirectoryQuery(): string {
  return `SELECT json_object('kind','row','value',json_object('id',s.id,'title',s.title,'updated_at',s.updated_at,
    'readable',CASE WHEN ${allowed} THEN 1 ELSE 0 END)) FROM sessions s ORDER BY s.id;`
}

/** 固定 SQL；ID 由调用方编码成十六进制值，不能传入 SQL 片段。 */
export function cindySourceQuery(rowId: string): string {
  const id = `CAST(X'${Buffer.from(rowId).toString('hex')}' AS TEXT)`
  const current = `session_id=${id} AND rewind_at IS NULL AND role IN ('user','assistant')
    AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=${id} AND ${allowed} AND (s.cleared_at IS NULL OR messages.created_at>s.cleared_at))`
  const budget = `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(content AS BLOB))),0) AS bytes FROM messages WHERE ${current}`
  const fields = cindySessionColumns.flatMap(field => [`'${field}'`, `s.${field}`]).join(',')
  return `SELECT json_object('kind','session','value',json_object(${fields},'readable',CASE WHEN ${allowed} THEN 1 ELSE 0 END)) FROM sessions s WHERE s.id=${id};
    SELECT json_object('kind','budget','value',json_object('count',count,'bytes',bytes)) FROM (${budget});
    SELECT json_object('kind','row','value',json_object('id',id,'role',role,'content',content,'created_at',created_at,'rewind_at',rewind_at))
    FROM messages WHERE ${current} AND (SELECT count<=10000 AND bytes<=${MAX_BYTES} FROM (${budget})) ORDER BY created_at ASC,rowid ASC;`
}
