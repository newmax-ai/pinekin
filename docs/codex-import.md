# Codex JSONL 只读归档

实施日期：2026-10-16 至 2026-10-17（本地时间）。阶段 A 的第二类输入：本地 harness 日志。状态为 **固定官方源码布局 + 合成夹具验证**，未用真实 Codex 会话或客户端实机验收，不承诺全部 CLI 发布版本兼容。

## 使用范围

点击「导入会话文件」，主动选择一个普通 JSONL 文件。只有首条非空记录为 `session_meta` 且符合已识别结构，才进入 Codex 解析器。文件扩展名不构成来源证明；普通 `history.jsonl`、`codex exec --json` 事件流和任意聊天 JSONL 不作为 rollout 导入。

复用已有流程：只读快照 → 来源/缺失预览 → 用户确认 → 保存原件与文本记录 → 相同字节文件去重。取消或失败不新建档案；不扫描 `~/.codex`，不沿工作区、媒体、历史引用读取其他文件，不启动 CLI，不执行 `resume`。

### 当前支持

- UTF-8、可选 BOM、LF / CRLF 和空行。
- 普通单文件 `legacy` 历史，兼容 `history_mode` 未声明及旧记录没有 `session_id` 的布局。
- 顶层 `response_item` 中 `type=message` 的文本内容；按原始日志顺序显示。
- 原件、会话 ID、输入声明的 CLI 版本、损失报告；包导出沿用现有 Staithe 文本 v2，不新增协议版本。

### 明确拒绝

- `history_mode=paginated` 或未知历史模式。
- 非空 `history_base`、`forked_from_id`：不猜测其他历史是否已完整包含在当前文件。
- 子会话边界：非空 `parent_thread_id` / `subagent_history_start_ordinal`，声明的 `session_id` 与 `id` 不同，或 `source` 指示 subagent。
- 同一文件第二条 `session_meta`、未知顶层记录类型、非法时间/字段、未知消息角色、重复显式消息 ID、截断 JSONL。
- 只有元数据、事件或压缩摘要，没有顶层消息的文件。不会用事件副本伪造成功导入。
- gzip / zstd 等压缩日志。本版只有 Cindy 容器具备受限 ZIP 解析，Codex 输入只接受明文 JSONL。

这是保守的兼容子集。拒绝不代表上游日志非法，只代表 Staithe 暂时不能可靠解释。

## 证据锚点

固定官方仓库提交：`34420d42648f627f766bd347532dcaad5475a68b`。本次只读源码，不运行上游代码、不读取本机 Codex 安装或账户数据。

- `https://github.com/openai/codex/blob/34420d42648f627f766bd347532dcaad5475a68b/codex-rs/history/src/rollout_payload.rs`，L30–71：wire 顶层 type / payload，response_item 额外 metadata。
- `https://github.com/openai/codex/blob/34420d42648f627f766bd347532dcaad5475a68b/codex-rs/history/src/lib.rs`，L213–249、L289–310、L364–375：历史项、压缩记录、时间戳和 ordinal 封装。
- `https://github.com/openai/codex/blob/34420d42648f627f766bd347532dcaad5475a68b/codex-rs/protocol/src/protocol.rs`，L882–908、L3254–3329、L3386–3396、L3813–3817：legacy/paginated、会话元数据、旧 session_id 兼容、回退事件。
- `https://github.com/openai/codex/blob/34420d42648f627f766bd347532dcaad5475a68b/codex-rs/protocol/src/models.rs`，L880–910、L1045–1086：内容块、消息及推理记录。
- `https://github.com/openai/codex/blob/34420d42648f627f766bd347532dcaad5475a68b/codex-rs/rollout/src/recorder.rs`，L2078–2111：JSONL 序列化与换行写入。

测试中的 `cli_version: "0.0.0-synthetic"` 是明确虚构的夹具标识，不是已验收的发布版本。解析器校验布局而非把版本字符串当可信证明；未来字段变更可能导致拒绝或需要扩展映射。

## 映射与损失

| 输入 | 处理 |
| --- | --- |
| session_meta.id | `archive.originalSessionId`，Staithe 入库后另分配本地 UUID |
| session_meta.cli_version | `archive.sourceVersion`，只是输入声明 |
| 标题 | 生成 `Codex · <ID 前八位>`，不冒充原始标题，也不猜测首条 user 内容是不是实际提问 |
| 更新时间 | 元数据时间及全部记录时间的最大值，规范化为 UTC；不使用导入时间，不改写日志顺序 |
| message.role | user / assistant / system 保留；developer 映射 system 并明确警告；其他角色拒绝 |
| input_text / output_text | 保留文字并按块换行，不渲染 HTML |
| 图片、音频、未知内容块 | 占位符与数量报告，不下载或读取引用 |
| encrypted_content | 保留已有明文并添加未解密占位符，不尝试解密 |
| phase / status | 不进入当前文本模型；存在阶段或非 completed 状态时提示，不据此推断任务完成 |
| function/custom/local-shell/web-search 调用或结果 | 计数报告，仅存原件，不执行，不伪装成助手答复 |
| reasoning | 计数报告，仅存原件，不进入正文或交接 |
| event_msg | 计数报告，不重复导入 user_message / agent_message 等事件中的消息副本 |
| compacted | 报告存在压缩，不把摘要或 replacement_history 当作新的普通消息重复添加 |
| thread_rolled_back | 报告回退，仍保留日志里已写入的消息；不重建当前有效分支 |
| 其他已知顶层状态与未知响应项 | 分类计数报告，只保留原件；未知顶层记录则整体拒绝 |

**这是追加日志的文本投影，不是当前有效会话重建。** 尤其在回退或压缩之后，历史正文可能含已撤销记录，也可能不包含仅存在于压缩快照中的内容。预览、导入报告和交接材料均提示这一点，用户必须在交接前检查。未来若要提供有效分支视图，应实现独立的历史重放模型，不能悄悄改变当前归档语义。

来源的权限、工作区、base instructions、Agent 元数据、运行配置、引用与消息时间等留在原始文件中。未映射内容不等于可以恢复；当前文本包不携带原件。原件可能包含敏感内容，确认前有明文保存提示。

## 限额与错误

- 输入沿用 5 MiB 上限。
- 最多 20,000 个物理行（空白行也计数），逐行扫描，不一次性拆成无限长数组。
- 单行最多 512 KiB；最多 10,000 条消息、每条最多 10,000 个内容块。
- 映射后单消息最多 200,000 字符。超过预算整份拒绝，不截断后报告成功。
- 使用 strict UTF-8 解码；所有已识别记录均检查 ISO 时间戳和对象边界。
- JSON/字段错误只报告行号与错误类别，不把正文、角色载荷或原始解析异常拼进用户错误消息。

现有快照 token、取消/过期、原件散列、原子发布、精确字节去重和损坏保护全部复用，不增加外部读写权限或依赖。

## 合成验证与后续

`tests/fixtures/codex.ts` 手写虚构日志；`tests/codex.test.ts` 覆盖事件去重、损失、控制记录、继承边界、截断、角色/ID/时间与资源上限。存储集成和桌面 E2E 验证同一来源可预览、确认、重启加载并导出带报告的 v2 包。

下一步仍是用户主动提供的脱敏 Codex / Cindy 导出样本，以及 DeepSeek 官方导出样本。未取得样本前不扫描真实目录，也不将合成测试升级标为实机兼容。完整验收记录见 `codex-verification.md`。
