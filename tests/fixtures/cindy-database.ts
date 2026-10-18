import type { DatabaseSync } from 'node:sqlite'

/** 完全合成；列名来自授权只读核对的 Cindy 0.1.110 结构，不复制真实记录。 */
export function createCindySchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT, source TEXT DEFAULT 'desktop', status TEXT DEFAULT 'active',
    created_at INTEGER DEFAULT 1000, updated_at INTEGER, parent_session_id TEXT, forked_at_message_id TEXT,
    remote_host_id TEXT, orca_role TEXT, cleared_at INTEGER, agent_device_id TEXT, orca_remote_lead TEXT, hidden_at INTEGER);
    CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at INTEGER, rewind_at INTEGER);
    CREATE TABLE orca_workers(session_id TEXT);
    CREATE TABLE orca_teams(lead_session_id TEXT);
    CREATE TABLE credentials(secret TEXT); INSERT INTO credentials VALUES('NEVER_READ_CREDENTIALS');`)
}

export function createCindyDatabase(db: DatabaseSync, id = 'synthetic-session') {
  createCindySchema(db)
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)').run(id, 'Cindy 合成正文', 'desktop', 'active', 1000, 2000)
  const insert = db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)')
  insert.run('z-user', id, 'user', JSON.stringify({ text: '合成用户问题', files: ['/synthetic/do-not-read'] }), 1500, null)
  insert.run('a-assistant', id, 'assistant', '## 合成回答\n\n**先确认目标**', 1500, null)
  insert.run('thinking', id, 'thinking', 'DO_NOT_PROJECT_REASONING', 1600, null)
  insert.run('tool', id, 'tool_result', 'DO_NOT_PROJECT_TOOL_PAYLOAD', 1700, null)
  insert.run('rewound', id, 'assistant', 'DO_NOT_PROJECT_REWOUND', 1800, 1900)
}
