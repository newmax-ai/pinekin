# 国内可接触的 AI 客户端与 harness：Staithe 接入调研

日期：2026-10-16。用途：产品与工程决策，不是支持清单或实机验收报告。

## 调研方法与证据边界

- 以官方文档、官方隐私说明和官方开源仓库为依据；仅在用户授权的当前 Staithe 仓库内读取代码，没有扫描真实客户端目录、读取凭据或运行第三方代码。
- “官方说明有该功能”“源码中已有实现”“Staithe 实机验证通过”是三个不同等级。本轮只有前两类证据。
- 国内官网、境内部署或中文版证明面向国内的产品定位，不保证任何地区、网络、账号和套餐下均可用。本轮没有进行大陆网络和账号实测。
- “未验证”不是“不存在”。分享页面不一定包含完整历史，导出不一定支持回导，消费者聊天历史也不能通过模型 API 自动取得。
- 产品名不能代替运行时身份：Claude Desktop ≠ Claude Code，ChatGPT ≠ Codex，WorkBuddy ≠ CodeBuddy，Kimi 聊天 ≠ Kimi Code。

## 1. 国内产品与开源桌面客户端

| 产品 | 身份与国内适用性证据 | 已发现的会话能力 | Staithe 建议 |
| --- | --- | --- | --- |
| Cindy | 官方开源本地桌面/移动客户端；README 区分大陆 `cn` 与 global 服务，也描述不登录运行本地 Agent 的模式。[S1] | 源码有 `.cshare` 分享包，兼容 `.xdtshare`；有导出与导入编排，涉及消息、媒体及 harness 转录。[S2–S4] | 高优先级只读导入包；固定格式版本、处理加密与缺失项。回导须另做实机验证，不能凭开源宣称已支持。 |
| DeepSeek 聊天 | 官方中文政策确认国内运营及账号服务。[S5] | 明确支持在设置的数据管理中导出全部历史。具体文件布局、回导和外部恢复未验证。 | 高优先级导出样本验证；先做档案，不读浏览器登录态。 |
| DeepSeek Harness / dsh | 官方另有开源 harness，处于开发者预览；不是聊天网页的本地版。[S6–S7] | 官方资料包含日志持久化、resume/fork 及导出插件；日志可能使用 Zstandard，不能一律按纯 JSONL 读取。 | 独立实验适配器，先验证导出 ZIP；不与 DeepSeek 消费者账号历史混用。 |
| 腾讯 WorkBuddy | 国内官方 AI 办公工作台及中文桌面文档。[S8–S9] | 任务分享、历史继续有文档；Qoder 的官方迁移入口包含本机 WorkBuddy 任务。[S10] | 第一阶段文本或用户选择的分享内容归档。其内部格式、Staithe 回导仍未验证。 |
| Qoder CN 桌面 | 官方区分 CN 与 Global，CN 产品介绍说明境内部署。[S11] | 任务导出、继续；支持导入指定来源，如同区域 IDE、QoderWork CN 和 WorkBuddy。[S10,S12] | 优先研究官方导出；把供应商支持的迁移组合登记为特定边，不当作通用导入。 |
| TRAE CN IDE / IDE 内 SOLO | 官方中国版文档与更新日志。[S13–S14] | 更新日志说明历史对话导出；设置文档描述用户数据导出。不同入口范围与格式需样本验证。 | 导出包导入候选；不把 IDE 能力外推到独立 TraeWork。 |
| Kimi 消费者聊天 | 官方中文站与帮助文档。[S15] | 会话分享；官方帮助也建议把总结复制到新对话，属于上下文交接。全量可解析导出与回导未验证。 | 用户主动提交文本或分享内容；保留“摘录而非完整备份”提示。 |
| 豆包 | 官方国内产品及隐私政策。[S16] | 可查阅、复制、删除历史；本次未确认批量导出、公开本地 schema、外部恢复入口。 | 先提供手动文本归档及交接，不做 Cookie 提取或未公开接口爬取。 |
| 千问消费者客户端 | 官方中文产品与客户端下载页。[S17] | 本次未取得足以确认批量会话导出、回导或外部恢复的官方依据。 | 标为待验证；不要用百炼模型 API、海外 Qwen Chat 或千问办公的能力代替。 |

### Cindy 为什么值得优先研究

上游源码给出了比“本地有一个数据库”更完整的互操作线索：

- 包有外层标识、版本门槛、清单、条目散列与可选加密。
- 完整度有 `full`、`partial`、`db-only` 等区分，消息存在不等于恢复所需转录齐全。
- 导出涉及消息、附件和底层运行时材料；导入有预检、解锁、冲突检测与回滚流程。

这些事实说明它可作为**格式设计参考及首批验证对象**，不代表 Staithe 应复制其内部库结构或直接伪造可恢复包。第一批先读用户导出的包；明文、加密和旧版本分别验收。[S2–S4]

### WorkBuddy / Qoder 给出的产品信号

Qoder 官方提供特定来源迁移，说明跨产品导入是现实需求，也存在供应商维护的专用通道。但这类通道往往依赖本机数据、来源版本和运行时条件。Staithe 的价值应是中立管理与清楚展示支持边界，不是绕开供应商入口强写数据库。[S10]

## 2. ChatGPT、Claude Desktop 与 CLI

**大陆适用性必须单列**：本次查到的 ChatGPT 官方支持地区与 Anthropic 支持地区政策均不包括中国大陆。不能把“国内有人使用”写成“官方面向大陆提供服务”，也不建议把两者作为国内首版唯一依赖。Staithe 离线读取用户合法取得的导出文件，与自动连接其在线账号是不同能力。[S26–S27]

| 产品 | 官方证据 | Staithe 接入判断 |
| --- | --- | --- |
| ChatGPT 消费者聊天 | 可导出含聊天历史的 ZIP；将 `conversations.json` 上传到另一账号的新聊天，不会重建原历史或合并账号。[S18–S19] | 导出包可作为档案输入，上传历史仅标为上下文参考。具体导出 schema 与附件保真需样本验证。 |
| ChatGPT 分享 | 当前官方帮助说明，接收者继续分享会话会创建自己账号内独立私有会话，不是多人共同续写原会话。[S20] | 可记录为供应商支持的“从快照创建副本”能力，不能当作原会话迁移；自动化入口尚未验证。 |
| ChatGPT desktop 导入 | 现行官方文档提供从 Claude Code、Cowork、Cursor 导入受支持配置、项目与最近 30 天聊天的流程。[S21] | 这是具体的供应商迁移通道，不应笼统说 ChatGPT 无导入；也不能外推为任意 Staithe 包可导入或完整运行态恢复。 |
| Claude Desktop 普通聊天 | 网页/Desktop 可以导出；官方说明个人账号导出不能导入另一账号，不支持个人账号间数据迁移。[S22] | 先接档案导出与文本交接，不宣称回导。 |
| Claude 聊天分享与记忆导入 | 官方分享说明为只读快照；记忆导入处理提取后的信息，而非重建全部聊天。[S23–S25] | 分享、记忆、原始会话分别建模，不能用记忆迁移冒充会话恢复。 |
| Claude Code | 官方会话文档描述 JSONL 历史及 `--continue`、`--resume`；恢复支持 ID、名称或绝对 JSONL 路径，但格式可随版本变化，且并非所有启动配置都会恢复。[S28] | 高价值的只读日志适配对象；有条件的同运行时恢复单独验证。不能外推到 Claude Desktop。 |
| Codex CLI | 官方源码描述 `.codex/sessions/YYYY/MM/DD` 下的 JSONL；命令文档提供 `codex resume` 与相应筛选行为。[S29–S30] | 先做授权目录的只读索引，记录线程 ID 与工作区；恢复前验证安装版本、来源和参数，不执行历史命令。 |

**接口纠偏**：OpenAI 的 API 会话状态接口与 Claude 的 Messages API 都不等于消费者客户端历史读写接口。本轮未验证供 Staithe 批量读取这些个人聊天历史的官方 API，不能拿到模型密钥就宣称已接入账号历史。[S31–S32]

旧搜索索引与新帮助文档可能存在措辞差异，尤其是 ChatGPT 分享后的继续方式。实现时需要按账号、客户端版本和实际界面验证，不把过时的“禁止继续”或过度宽泛的“完全支持迁移”硬编码为能力。

## 3. 对项目的建议

优先选择三种不同输入做格式验证：Cindy 分享包、一个云端聊天导出、一个本地 harness 日志。国内第二批扩展 Qoder CN、TRAE CN、WorkBuddy；Kimi、豆包、千问先提供不依赖私有接口的手动归档和交接。

完整实施建议见 `integration-proposal-2026-10-16.md`。本次没有实现适配器，没有修改现有协议，也没有执行原生迁移。

## 4. 官方资料索引

来源的 `main` 分支与在线帮助会变化；正式实现应固定版本并补充脱敏夹具，不能将调研日期作为永远有效的兼容承诺。

- [S1] Cindy 官方 README：`https://github.com/makecindy/cindy`
- [S2] Cindy 分享包格式：`https://github.com/makecindy/cindy/blob/main/apps/desktop/src/main/session-share/xdtshareFormat.pure.ts`
- [S3] Cindy 分享导出：`https://github.com/makecindy/cindy/blob/main/apps/desktop/src/main/session-share/sessionShareExport.ts`
- [S4] Cindy 分享导入：`https://github.com/makecindy/cindy/blob/main/apps/desktop/src/main/session-share/sessionShareImport.ts`
- [S5] DeepSeek 官方隐私政策：`https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html`
- [S6] DeepSeek Harness 官方介绍：`https://www.deepseek.com/harness/en/`
- [S7] DeepSeek Harness 官方导出插件：`https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/session-query/session-log-export`
- [S8] WorkBuddy 官方产品页：`https://cloud.tencent.com/product/workbuddy`
- [S9] WorkBuddy 任务管理：`https://www.workbuddy.cn/docs/workbuddy/Task-Management`
- [S10] Qoder CN 数据导入：`https://docs.qoder.cn/qoder/data-import`
- [S11] Qoder CN 产品介绍：`https://docs.qoder.cn/en/product-overview/introduction-of-qodercn`
- [S12] Qoder CN 任务管理：`https://docs.qoder.cn/qoder/task-management`
- [S13] TRAE CN 更新日志：`https://docs.trae.cn/ide_changelog`
- [S14] TRAE CN 设置：`https://docs.trae.cn/ide_ide-settings`
- [S15] Kimi 会话问题：`https://www.kimi.com/help/others/chat-issues`
- [S16] 豆包隐私政策：`https://www.doubao.com/legal/privacy`
- [S17] 千问客户端下载：`https://www.qianwen.com/download`
- [S18] ChatGPT 历史导出：`https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data`
- [S19] ChatGPT 账号间转移说明：`https://help.openai.com/en/articles/9106926-transfer-exported-conversations-between-chatgpt-accounts`
- [S20] ChatGPT 分享与继续：`https://help.openai.com/en/articles/7925741-sharing-conversations-and-scheduled-tasks-in-chatgpt`
- [S21] ChatGPT desktop 导入：`https://learn.chatgpt.com/docs/import`
- [S22] Claude 数据导出：`https://support.claude.com/en/articles/9450526-export-your-claude-data`
- [S23] Claude 公开聊天链接：`https://support.claude.com/en/articles/16762437-public-links-for-shared-chats`
- [S24] Claude 定向分享：`https://support.claude.com/en/articles/16762496-share-a-chat-with-specific-people`
- [S25] Claude 记忆导入与导出：`https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude`
- [S26] ChatGPT 官方支持地区：`https://help.openai.com/en/articles/7947663-chatgpt-supported-countries`
- [S27] Anthropic 官方支持地区：`https://www.anthropic.com/legal/supported-regions`
- [S28] Claude Code 会话管理：`https://code.claude.com/docs/en/sessions`
- [S29] Codex 日志源码：`https://raw.githubusercontent.com/openai/codex/main/codex-rs/rollout/src/recorder.rs`
- [S30] Codex 命令说明：`https://learn.chatgpt.com/docs/developer-commands?surface=cli`
- [S31] OpenAI API 会话状态：`https://developers.openai.com/api/docs/guides/conversation-state`
- [S32] Claude Messages API：`https://platform.claude.com/docs/en/api/messages/create`

注意：腾讯云某些以 WorkBuddy Enterprise 为目录标题的页面，正文实际描述 CodeBuddy IDE。能力归属以正文具体产品为准，不能只凭搜索结果标题认定 WorkBuddy 支持某种导出。
