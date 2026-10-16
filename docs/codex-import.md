# Codex JSONL / JSONL.ZST 只读归档

实施日期：2026-10-16 至 2026-10-17（本地时间）。阶段 A 的本地 harness 输入。适配器版本 `0.2.0`：固定官方源码布局、合成回归，并在用户明确授权后做过少量本机文件的只读解析抽样。**抽样成功不代表所有 CLI 发布版本、全部日志或原生恢复兼容。**

## 使用范围

点击「导入会话文件」，主动选择一个普通 `.jsonl` 或 `.jsonl.zst` 文件。通过内容识别，不依赖扩展名：明文首条非空记录须为 `session_meta`；压缩日志须以标准 Zstandard 魔数开头，展开后仍须符合 Codex rollout。普通 `history.jsonl`、`codex exec --json` 事件流和任意聊天 JSONL 不作为 rollout 导入。

复用只读快照 → 来源/缺失预览 → 用户确认 → 原件与文本记录保存 → 相同字节去重。压缩输入保留**压缩原件**，不悄悄替换为展开内容。取消或失败不新建档案。产品不会自动扫描 `~/.codex`，不会沿工作区、媒体或历史引用读取其他文件，不启动 CLI 或执行 `resume`。

### 支持的单文件布局

- UTF-8、可选 BOM、LF / CRLF 和空行。
- 普通 `legacy` 主会话；兼容缺少 `history_mode` 及旧记录没有 `session_id`。
- 独立 `paginated` 主会话：`session_meta.ordinal=0`，之后每条非空记录的 ordinal 严格递增 1，无缺失、重复或乱序，且没有下述引用/子会话边界。
- 顶层 `response_item` 中 `type=message` 的文本，按原始日志顺序显示。
- 原件、原始会话 ID、输入声明版本和损失报告；导出沿用 Staithe 文本 v2，不新增协议版本。

连续序号只能证明所选文件的序列一致，不能证明会话已结束或文件包含来源全部历史。不会根据序号发起额外文件读取，也不会重放分页状态。

### 明确拒绝

- 未知历史模式；分页文件不从 0 起步或序号不连续。
- 非空 `history_base`、`forked_from_id`：不猜测其他历史是否已经完整包含。
- 子会话边界：非空 `parent_thread_id` / `subagent_history_start_ordinal`，声明的 `session_id` 与 `id` 不同，或 `source` 指示 subagent。
- 第二条 `session_meta`、未知顶层记录类型、非法时间/字段、未知消息角色、重复显式消息 ID、截断 JSONL。
- 只有元数据、事件或压缩摘要而没有顶层消息；不会使用事件副本伪造成功。
- gzip、外部字典、嵌套压缩、超限内容及损坏 Zstandard；解压后的其他产品数据不自动转交其他解析器。

这是保守的兼容子集。拒绝不代表上游日志非法，只代表 Staithe 暂时不能可靠解释或超出资源预算。

## 格式证据

官方源码固定提交：`34420d42648f627f766bd347532dcaad5475a68b`。未运行上游代码。

- `https://github.com/openai/codex/blob/34420d42648f627f766bd347532dcaad5475a68b/codex-rs/history/src/rollout_payload.rs`，L30–71：type / payload wire 布局及 response_item.metadata。
- `https://github.com/openai/codex/blob/34420d42648f627f766bd347532dcaad5475a68b/codex-rs/history/src/lib.rs`，L213–249、L289–310、L364–375：历史项、压缩记录、timestamp / ordinal。
- `https://github.com/openai/codex/blob/34420d42648f627f766bd347532dcaad5475a68b/codex-rs/protocol/src/protocol.rs`，L882–908、L3254–3329、L3386–3396、L3813–3817：历史模式、元数据、旧 session_id 兼容、回退事件。
- `https://github.com/openai/codex/blob/34420d42648f627f766bd347532dcaad5475a68b/codex-rs/protocol/src/models.rs`，L880–910、L1045–1086：内容块、消息与推理记录。
- `https://github.com/openai/codex/blob/34420d42648f627f766bd347532dcaad5475a68b/codex-rs/rollout/src/recorder.rs`，L2078–2111：JSONL 序列化与写入。

本机核验只输出结构、计数及版本声明，没有将真实正文、文件名、路径或会话 ID 复制进仓库。初始 legacy-only 假设不适用于所选本机日志，因此补充了压缩与独立分页的有界支持；范围和结果见 [只读抽样记录](local-validation-2026-10-17.md)。

测试中的 `0.0.0-synthetic` 是虚构版本，不是已验收发布版；解析器校验布局，不把 CLI 版本字符串当可信证明。来源未来变化仍可能被拒绝或需要新映射。

## 映射与损失

| 输入 | 处理 |
| --- | --- |
| session_meta.id / cli_version | `archive.originalSessionId` / `sourceVersion`；本地 ID 另分配 UUID，版本仅作声明 |
| 标题 | 生成 `Codex · <ID 前八位>`，不冒充原始标题，也不猜测首条 user 内容是否真正提问 |
| 更新时间 | 元数据及全部记录时间的最大值，规范化 UTC；不使用导入时间、不重排日志 |
| role | user / assistant / system 保留；developer 映射 system 并警告；其他角色拒绝 |
| input_text / output_text | 保留文字，按块换行，不渲染 HTML |
| 多模态 / 未知内容块 | 占位符与数量报告，不下载或读取引用 |
| encrypted_content | 保留已有明文并添加未解密占位符，不尝试解密 |
| phase / status | 未结构化映射；报告阶段或非 completed 状态，不据此推断完成 |
| 工具调用和结果 / reasoning | 分类计数，只存原件，不执行、不伪装成普通答复 |
| event_msg | 计数报告，不重复添加其中的消息副本 |
| compacted | 报告压缩，不把摘要和 replacement_history 重复展开为新消息 |
| thread_rolled_back | 报告回退，仍保留已写入消息，不重建有效分支 |
| 其他已知状态 / 未知响应项 | 分类计数、仅存原件；未知顶层类型整体拒绝 |

**这是追加日志的文本投影，不是当前有效会话重建。** 回退后可能含已撤销记录；压缩后可能缺少仅存在于替代快照的内容。预览、报告和交接均有提示，需要用户检查。未来有效分支视图应使用独立重放模型，不能悄悄改变当前归档语义。

权限、工作区、指令、Agent 元数据、运行配置、引用和消息级时间等留在原件。原件可能敏感，确认前明确提示明文保存；当前文本包不携带原件或工具权限。

## 资源与解压限制

- 原始输入最多 5 MiB；Zstandard 展开结果也最多 5 MiB。
- 使用 Node.js 原生异步 `zstdDecompress`，`maxOutputLength` 限制输出；`ZSTD_d_windowLogMax=23` 将解码窗口独立限制为 8 MiB，拒绝尾随垃圾，不请求字典。
- 要求 Node.js 22.15+（该原生 API 的最低版本）；本轮开发与验收使用 Node.js 24.22.0，桌面再通过项目 Electron E2E 验证。
- 最多 20,000 个物理行（含空白行），逐行扫描，不一次性拆成无限数组。
- 单行最多 512 KiB；最多 10,000 条消息、每条最多 10,000 个内容块；映射后单消息最多 200,000 字符。
- strict UTF-8 解码，检查所有记录的 ISO 时间戳及对象边界。
- 超限整份拒绝，不截断后报告成功。错误只输出行号和类别，不回显正文或原始解析异常。

快照 token、取消/过期、原件散列、原子发布、精确字节去重和损坏保护均复用。无新的外部读写权限或第三方依赖。

## 验证与后续

测试仅用独立手写的合成夹具；不会把真实会话送入 Vitest / E2E。新增回归覆盖独立分页、序号缺失、历史引用、Zstandard 损坏/截断/尾随垃圾/展开和窗口预算、压缩原件保存与桌面确认。

历史首版验收见 `codex-verification.md`；本机核验与本次最终结果见 `local-validation-2026-10-17.md`。子会话、跨文件历史、大文件、有效分支重建、Cindy 实际分享包和 DeepSeek 导出仍需独立工作，不因几个本机样本成功就宣称全面支持。
