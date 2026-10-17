// 原创合成记录，不包含真实会话、数据库路径或用户信息。
export function cindyLocalSnapshot() {
  return { format: 'pinekin.cindy-local-snapshot', version: 1, sourceVersion: '0.1.97',
    session: { id: 'synthetic-cindy', title: 'Cindy 本地合成会话', source: 'desktop', status: 'active',
      createdAt: 1_790_000_000_000, updatedAt: 1_790_000_001_000, parentSessionId: null, remoteHostId: null, orcaRole: null, clearedAt: null },
    messages: [
      { id: 'z-user', role: 'user', content: JSON.stringify({ text: '合成用户问题', images: [], files: [] }), createdAt: 1_790_000_000_000, rewindAt: null },
      { id: 'a-answer', role: 'assistant', content: '合成助手回答', createdAt: 1_790_000_000_000, rewindAt: null },
      { id: 'thinking', role: 'thinking', content: JSON.stringify({ text: '不展示的推理' }), createdAt: 1_790_000_000_001, rewindAt: null },
      { id: 'tool', role: 'tool_use', content: JSON.stringify({ toolName: 'shell', input: '不执行' }), createdAt: 1_790_000_000_002, rewindAt: null },
      { id: 'result', role: 'tool_result', content: '不展示的工具结果', createdAt: 1_790_000_000_003, rewindAt: null },
      { id: 'switch', role: 'agent_switch', content: '{}', createdAt: 1_790_000_000_004, rewindAt: null },
    ],
  }
}
export function cindyLocalFixture() { return Buffer.from(JSON.stringify(cindyLocalSnapshot())) }
