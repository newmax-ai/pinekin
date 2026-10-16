import type { Session } from './types'

// 全部为虚构演示内容，不来自用户的真实客户端。
export const demoSessions: Session[] = [
  {
    // 保留已发布的演示 ID，让旧链接仍能定位。
    id: 'demo-ember', title: '让思考跨越工具，继续生长', source: 'newmax',
    updatedAt: '2026-10-16T09:30:00.000Z', tags: ['产品构想', 'Staithe'], demo: true,
    messages: [
      { role: 'user', content: '我想把分散在不同 AI 客户端里的对话放在一起。不是简单备份，而是能带着上下文，换个地方继续思考。' },
      { role: 'assistant', content: '可以把它分成三层：\n\n01  档案：用统一格式保存对话与来源。\n02  交接：保留原文、角色和待办，让下一个工具理解上下文。\n03  接续：只有目标客户端确实支持时，才提供原生恢复。\n\n先保证记忆不会丢失，再逐个验证客户端的迁移能力。' },
      { role: 'user', content: '名字就叫 Staithe。像一个让对话停靠、汇聚与再次出发的码头。第一版先做好本地档案和上下文交接包。' },
      { role: 'assistant', content: '已明确方向：本地优先，不自动上传，不读取未经授权的客户端目录。\n\n下一步：验证各客户端的数据格式、工作区绑定、附件与工具消息，区分“可阅读的记录”和“可执行的会话状态”。' },
    ],
  },
  {
    id: 'demo-adapter', title: '一份不丢失来源的适配器契约', source: 'claude-code',
    updatedAt: '2026-10-15T14:10:00.000Z', tags: ['架构', '适配器'], demo: true,
    messages: [
      { role: 'user', content: '不同客户端的角色和工具消息不一样，怎么统一？' },
      { role: 'assistant', content: '先用最小公共模型：来源、标题、时间、角色、正文与标签。不要伪造工具执行结果。\n\n工具状态、分支关系和附件在后续版本中单独建模；目前的交接包只保证文本档案的可移植性。' },
    ],
  },
  {
    id: 'demo-migration', title: '迁移前，先画清安全边界', source: 'codex',
    updatedAt: '2026-10-14T11:20:00.000Z', tags: ['迁移', '安全'], demo: true,
    messages: [
      { role: 'user', content: '能直接修改其他客户端的会话数据库吗？' },
      { role: 'assistant', content: '第一版不这样做。先提供用户主动选择文件的导入，以及明确可预览的导出。\n\n未来原生迁移必须具备：版本探测、预演、冲突检测、备份和回滚。一个深度链接也不应该携带完整对话、凭据或自动执行指令。' },
    ],
  },
]
