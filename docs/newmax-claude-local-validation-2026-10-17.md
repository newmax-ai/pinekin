# NewMax / Claude Code 接入与首批本地归档

日期：2026-10-17。用户明确授权只读核验 NewMax、Claude Code、Codex 的本机会话，并把兼容会话的文本副本保存到 Pinekin。不读取认证配置、不修改来源、不运行历史指令；真实正文、标题、ID、路径清单与样本不进入仓库或测试。

## 本批交付

| 来源 | 本次新增 | 回读后总数 | 保存形式 |
| --- | ---: | ---: | --- |
| NewMax | 10 | 10 | 字段白名单快照 + 文本投影 |
| Claude Code | 10 | 10 | 精确 JSONL 原件 + 显式末条消息父链文本投影 |
| Codex | 3 | 3 | 精确日志原件 + 现有文本投影 |
| Cindy | 0 | 3 | 保留此前档案 |
| DeepSeek Harness | 0 | 3 | 保留此前档案 |

最终 `Library.list()` 回读 **29 段**。本次新增的 23 份原件均通过 `Library.findImport()` 再校验 SHA-256。每个来源最多归档 10 个兼容候选，这是有界批次，不是全量扫描或持续同步。

Codex 在本批有界候选中检查 50 个文件，接受 3 个、跳过 47 个：46 个未通过现有格式/资源校验，1 个无法读取或超过输入预算。不降低继承、子会话、序号、展开或容量校验来凑数量，不据此推断整机只有 3 段可导入历史。

数据沿用系统 `appData/@newmax-ai/ember/imports/<sha256>/`。它们不在 Git 工作区，不属于代码 Review/撤销的范围。新增档案是明文；原件和 `record.json` 必须整体备份/移除。

## NewMax 白名单快照 v1

- 本机版本：`1.1.22`，依据本机客户端包元数据及其 SQLite 读取实现核对。源码仅只读参考，不建立跨仓库运行依赖。
- 入口：`src/main/newmax-local.ts`。格式 `pinekin.newmax-local-snapshot`、版本 `1`、`sourceVersion=1.1.22`；不是官方导出包，也不直接接受 SQLite 文件进入桌面选择框。
- 仅 `source=app`、非隐私、无来源分叉的普通主会话。其他来源、未来版本与分叉边界拒绝。
- 会话字段：`id/title/source/createdAt/updatedAt/forkedFromConversationId/isPrivate/messageCount`。
- 消息字段：`seq/id/role/content/displayContent?/timestamp/internal`。按 SQLite 当前行 `seq ASC` 排序；校验 ID 唯一、顺序、数量和字段。用户优先使用 `displayContent`，助手使用当前 `content`，不拼接历史变体或将内容块副本重复加入。
- `taskContinuationTurn` 或带 `goalMeta.type` 的内部轮次在生成快照时标为 internal，不进入正文。未标记的自动内容仍可能保留，报告提示交接前检查。
- 不复制数据库、认证、设置、账户表、工具输出、推理、subagent、回答变体、附件或工作区文件。不实例化来源 `ConversationStore`，避免构造器迁移、checkpoint 和其他写入副作用。
- 显式开发读取使用 `DatabaseSync({ readOnly: true })`、`query_only` 和单一读取事务。对 `data` 中 ID/role/content/timestamp 与独立列做一致性检查；字段不一致拒绝。不走 JSONL 镜像补读。
- 单次最多检查最近 50 个符合来源条件且至少 60 秒未更新的候选。每段最多 10,000 行消息，原始消息 JSON 总量预算 32 MiB，生成后的快照仍须不超过 5 MiB；超限不截断。

## Claude Code JSONL

本机 CLI `claude --version` 为 **2.1.286**。两个有界结构样本证实消息、附件与元数据混存；少量样本不代表所有版本兼容。

入口：`src/main/claude-code.ts`。

1. 最多 5 MiB、20,000 行、单行 512 KiB。来源识别最多检查前 64 行，允许 file-history 等元数据开头；不把普通 `history.jsonl` 当会话转录。
2. 对 user、assistant、system、attachment、progress 的 UUID/parentUuid 建图；验证单根、无环、无缺失父指针和一致的 sessionId。附件与工具结果节点不得在建图前删去。
3. 按文件物理顺序选择最后一条 user/assistant 为内容端点，沿其父链做 **latest-message 投影**。它不是原生活动链，也不保证包含整段对话或全部有效历史。链外节点计数和损失明确写入报告；不根据 last-prompt.leafUuid 猜测活动叶，也不补拼同 ID 的离链内容块。
4. 只提取 user 字符串/文本块和 assistant text。工具结果可能由 user 承载，不能冒充人工输入；isMeta、attachment、thinking、tool_use、tool_result 与其他非文本块不进入正文。未知顶层事件拒绝，不解释其指令。
5. 本机样本的相同 assistant message.id 是 apiBlockIndex 递增的追加块，而不是累计快照。选中链中按顺序合并；重复 ID 的索引缺失/回退或无法判断的重放拒绝，不能只保留最后一块。原件保留所有分支。
6. isSidechain、isCompactSummary、isVisibleInTranscriptOnly、非空 logicalParentUuid、system compact_boundary 尚未验证，直接拒绝，不猜测压缩后的逻辑父链。父指针引用外部日志也不补读。
7. 标题由首条选中用户文本生成，不宣称是客户端标题。版本只作为输入声明。无原生恢复、resume、工具/权限迁移或历史指令执行。

## 显式本地批次入口

`npm run import:local -- ...` 是开发期入口，不接入桌面 IPC、启动扫描或后台监听。需要 Node.js 22.15+；本批使用 24.22.0。使用项目已安装 Vite 加载本项目 TypeScript，绝不从来源目录加载或运行代码。默认预演不落盘，显式 `--confirm` 才保存；沿用 `ImportCoordinator.prepare/commit` 的原件保存与精确字节去重。每次运行重新读取来源并生成当次内存快照，预演与随后另一条确认命令不是同一个冻结批次。

```bash
# 默认只预演。路径必须由用户明确授权，不从配置或凭据推断。
npm run import:local -- --source newmax --input "/授权的/NewMax/newmax.db" --source-version 1.1.22 --destination "/Pinekin档案目录" --limit 10
npm run import:local -- --source claude-code --input "/授权的/Claude/projects" --destination "/Pinekin档案目录" --limit 10
npm run import:local -- --source codex --input "/授权的/Codex/sessions" --destination "/Pinekin档案目录" --limit 10

# 核对预演后，对同一命令显式追加 --confirm 才保存。
# Claude Code / Codex 也可把 --input 指向一个已授权的普通日志文件。
```

- 每次归档 1–20 个兼容候选，默认 10；目录扫描最多 64 个目录、4,096 个条目、512 个候选文件，再对有界集合按 mtime 排序选至多 50 个检查。`bounded=true` 表示被限额约束，不等于全局最新或全库完整。
- Claude Code 仅 projects 下一级项目目录；Codex 仅最多三层数字日期目录；不进入 subagents、未知层级，不接受符号链接来源或遍历遇到的符号链接。
- 来源与目标目录不能重叠；只写用户指定的 Pinekin 目标，不修改来源。库损坏、已有原件散列不符或写入错误中止，不当作来源不兼容隐藏。
- 统计只包含匿名计数与安全错误类别，不输出正文、标题或真实文件名。相同字节的重复确认只定位原档案；不按会话 ID 自动覆盖更新，不提供增量同步。不要让多个写入进程同时操作同一个档案目录。
- 新版窗口获得焦点时仅调用已有 `list()` 回读 Pinekin 档案，保留来源筛选与选中项；导入/交接弹窗或忙碌期间不刷新。这不是外部目录扫描。仍在运行的旧版本需刷新页面或重新启动后才具有新逻辑。

## 自动验证

全部使用合成数据、临时隔离目录和 SQLite，不把真实会话作为 Vitest 或 E2E 输入。

- 先验证缺失实现、未接通路由和能力矩阵的红灯，再实现；焦点刷新与特殊目录名重叠校验也先复现失败。
- 适配器/导入/能力矩阵定向回归：63 项通过；本地批次集成：6 项通过。
- 最新完整覆盖率运行：**277 项通过**，行 **99.61%**、语句 **95.27%**、分支 **91.72%**、函数 **98.31%**。新增解析器与本地批次模块纳入覆盖范围。
- `npm run typecheck` 与 `npm run build` 通过。
- 首次完整后台 E2E：36 项中 35 项通过，1 项在初次加载后立即发送搜索快捷键时未打开搜索框。保存日志定位后，重建并定向复测该项通过，未放宽断言或修改不相关行为，也未重跑整套。
- 定向后台 E2E 4 项通过：NewMax 导入/去重/重启读取、Claude Code 导入/去重/重启读取、新增外部批次后焦点回读计数、前述快捷键/焦点/主题用例。
- E2E 沿用隐藏窗口、隔离 userData、替换文件对话框/剪贴板；原生 show/focus 监测未发现抢前台。焦点刷新通过 DOM 事件模拟，不激活系统窗口。

## 仍未完成

全量接入、跨文件/跨分支关系、Claude Code 压缩逻辑、超限大日志、持续同步、版本广泛兼容、附件、隐私会话、原生恢复与外部数据库写入仍未支持。来源筛选不是连接状态，`readLocal/nativeResume/deepLink` 能力仍为 false。
