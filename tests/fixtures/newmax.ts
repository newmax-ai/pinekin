// 仅合成数据；不包含真实会话、路径、附件或认证配置。
export function newmaxSnapshot() {
  const time = 1_790_000_000_000
  return {
    format: 'pinekin.newmax-local-snapshot', version: 1, sourceVersion: '1.1.22',
    session: { id: 'newmax-synthetic', title: 'NewMax 合成会话', source: 'app', createdAt: time, updatedAt: time + 1000,
      forkedFromConversationId: null, isPrivate: false, messageCount: 2 },
    messages: [
      { seq: 10, id: 'u1', role: 'user', content: '合成问题：整理项目计划', timestamp: time, internal: false },
      { seq: 12, id: 'a1', role: 'assistant', content: '合成答复：先确认目标。', timestamp: time + 1000, internal: false },
    ],
  }
}
export function newmaxFixture(snapshot = newmaxSnapshot()) { return Buffer.from(JSON.stringify(snapshot)) }
