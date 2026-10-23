# Pinekin Engine

Pinekin Engine 是 Pinekin「跨客户端会话互通」能力的核心：发现各客户端的本机会话日志，把会话读成结构化记录 `pinekin.transcript` v1。Pinekin App 和 NewMax 都是它的宿主；NewMax 按固定版本内置引擎产物，用户不需要安装或打开 Pinekin App。

## 边界

- 源码在 `src/engine/`，只依赖 Node 内置模块和 `zod`（由宿主提供同一主版本），不得引用 Electron、界面或数据库写入。
- 只读：不修改来源文件，不执行会话里的命令或工具调用；读取时拒绝越出授权根目录和经过符号链接的路径。
- 已知不支持的边界（分叉、子会话回退、压缩、多分支等）抛出 `PinekinUnsupportedError`，宿主应记录为「不支持」而不是错误。
- 体量上限同理：消息条数超过 10,000、累计字符超过 48,000,000 对同一份日志是确定结果，也抛出 `PinekinUnsupportedError`，宿主记录后不再重读。单条日志记录超过 8 MiB 仍是可重试的普通错误，不标为不支持。
- 当前来源：Codex、Qwen Code、WorkBuddy、DeepSeek Harness。DeepSeek Harness 当前仅把问答文本封装为 `pinekin.transcript` v1，不代表已映射思考或工具块；其余来源接入引擎前仍需补解析与契约测试。
- **工作目录能力 `scope`**：`workspace` 来源（Codex、Qwen Code、DeepSeek Harness）可携带可信绝对工作目录，但单条记录可能缺失；`global` 来源（WorkBuddy）没有可信工作目录。宿主不得从目录名猜测缺失路径；NewMax 无论 `scope` 均全局可见，工作目录只参与排序，缺失时仍允许导入。

## 接口

| 导出 | 说明 |
|------|------|
| `ENGINE_VERSION` | 引擎版本；解析规则变化时递增，宿主据此作废增量状态 |
| `engineSources()` | 能力清单：每个来源分别声明 `discover`、`structured`、`workingDirectory`、`scope`、`verifiedPlatforms`，不互相外推 |
| `defaultLocations(source, context?)` | 来源的默认日志目录 |
| `listSessions(source, options?)` | 异步枚举 `SessionRef`：稳定身份（`source` + `sessionId`）、修订号（大小与修改时间指纹）、绝对工作目录、主会话／子会话 |
| `readTranscript(ref, options?)` | 读出 `Transcript`：文本、思考、工具调用、工具结果、附件说明，每条消息带稳定 ID 与时间戳 |
| `workingDirectoryWithin(dir, workspace, platform?)` | 按平台规则判断工作目录是否位于工作区内 |

类型定义见 `src/engine/types.ts`，它不引用其他模块，构建时作为独立声明分发。

## 构建与内置

```bash
node scripts/build-engine.mjs   # 输出 dist/engine/：index.js、*.d.ts、manifest.json
```

`manifest.json` 记录引擎版本、transcript 格式版本、来源 commit、工作区是否有未提交改动（`sourceDirty`）和每个文件的 SHA-256。`dist/` 不提交。

NewMax 用自己的 `scripts/sync-pinekin-engine.mjs` 复制产物到 `vendor/pinekin-engine/`，校验哈希，默认拒绝 `sourceDirty` 产物。正式发布前，先提交 Pinekin 源码再重建。

## 验证

`tests/engine.test.ts` 用合成的 Codex／Qwen Code／WorkBuddy 日志覆盖结构化映射、工作目录、子会话、不支持边界、取消与路径限制。不使用真实会话。NewMax 侧另有内置产物哈希、来源清单一致性和同步落库测试。

## DeepSeek Harness 来源（引擎 0.3.1）

- 默认读取 `~/.dsh/sessions`；支持绝对 `DSH_HOME` 与其 `~` 展开规则。不读取凭据，不搜索自定义 persistence root；其他位置需由宿主显式授权指定。
- 仅接收严格 `session-v4`、`isSeeded=false`、`delegationDepth=0` 的独立主会话。日志支持 `.jsonl`、`.jsonl.zst`、`.jsonl.zstd`；授权根内最多向下四层，跳过 `subagents` 与符号链接。
- 与 App 共用 `deepseekSourceSchemas`、`createLogIndexer('deepseek')`、`recordText`：连续 seq、append、角色、唯一消息 ID、标题和用户上下文净化保持一致；流式完整校验后才返回结果，不拼接分页预览。除了问答与标题，明确省略已确认的权限/沙箱、turn/step、request、tool/call、标题/搜索辅助请求、job 和 inbox 队列事件；不把其嵌套内容再次导入为问答。未知事件仍拒绝，不保证所有 v4 日志均可读。
- **所有表面事件都守门**：`system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result` 只接受 `surfaceOp='append'`，不能因不输出系统或工具文本就漏掉 replace。非表面事件带 `surfaceOp` 或 `sourceEventSeqs` 也拒绝。普通 `session/end-seed` 可以与非继承头部共存，但 `data.inherited=true` 或未知值与独立头冲突，整条拒绝。
- `structured=true` 仅表示输出统一 transcript 容器。首批只导入真实用户输入与助手 text 块；推理、工具、附件、流式副本和运行状态不导入，以 warnings 和宿主设置提示说明。不把无法确认调用关联的工具结果猜配到最近工具。
- 会话 ID、创建时间来自头部，更新时间与最终标题来自完整事件扫描，修订号沿用文件大小与 mtime。`cwd` 只保留可信绝对路径，无 cwd、空值或相对路径时不推断归属。
- 官方事件依据固定为提交 `687f282e8625c6b8d11ff58211a90524be2e4317`：[表面操作与种子边界](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/types.ts#L405-L479)、[独立头部与继承标记校验](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-format-v3-to-v4/src/validation.ts#L52-L79)、[inbox 只操作待处理队列](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/inbox.ts#L81-L155)。
- `tests/engine-deepseek.test.ts` 全部使用合成数据。2026-10-23 经授权，在 NewMax 主 dev 原窗口完成 4 条真实多帧日志与 3 条合成会话的同步、全局列表、原地更新及接续落点验证；未调用模型，测试记录与文件已清理。Windows 尚未验证。

### 多帧 Zstandard 读取与错误归属（0.3.1）

- **组件与数据流**：`withSourceLog` → `zstd-log-frames.ts` 解析物理帧/块边界 → 每个独立帧严格 `createZstdDecompress` → 同一 UTF-8/JSONL 行消费器 → 来源索引/引擎。帧边界不等于行边界；单行可以跨帧。
- **设计原因**：NewMax Electron 44.7.2 自带 Node 24.21 在严格模式下把后续合法帧当尾随垃圾；关闭严格模式又只交付首帧。终端 Node 24.22 不复现，不能仅用终端测试宣称宿主可用。逐帧解码不按运行时版本打补丁，也不降低校验。
- **预算与安全边界**：只缓存一个 64 KiB 输入块和小帧头，块正文切片转交；保持 8 MiB 解码窗口、8 MiB 原始行、30 秒时限与来源授权/稳定性检查。保留 checksum 校验，空/截断/未知帧、尾随垃圾与无效块头失败关闭；不支持外部字典或猜测 magic 边界。
- **错误归属与生命周期**：解析器异常即使带 `code` 也保留原异常，不标作压缩损坏；只有真实解码错误包装为 Zstandard 错误。每帧完成或提前取消都等待自有管道关闭，避免迟到 AbortError；不持久化局部结果。
- **验证与已知边界**：`source-log-zstd-frames.test.ts`、`source-log-error-propagation.test.ts` 验证多帧、跨帧行、大块、坏尾、checksum 和消费端异常；与引擎用例一起在终端 Node 和 Electron 无 GUI Node 模式执行。只支持标准 Zstandard 数据帧，不接受未知或 skippable 帧；旧档案导入的 5 MiB 一次性解压器未改动。

## WorkBuddy 来源（引擎 0.2.0）

- 位置：`~/.workbuddy/projects/<任务目录>/<会话 ID>.jsonl`，`WORKBUDDY_CONFIG_DIR` 覆盖根目录；不沿用独立 CodeBuddy 的变量。云缓存 `projects/cloud`、子代理目录、`projects` 根级文件不属于普通本地主会话，列表阶段排除。
- 为什么是全局来源：任务目录是 WorkBuddy 自建文件夹（形如 `Users-<用户>-WorkBuddy-<时间>`）的不可逆转义，日志行与侧车白名单字段里都没有工作目录，因此不推断归属。
- 结构校验与 App 的来源浏览共用 `createWorkbuddyIndexer`（父链、相邻同 ID 助手分块、压缩／分叉／逻辑父链／子会话边界），引擎只在同一遍扫描里额外产出块：用户／助手文本、`function_call` → `tool_call`、`function_call_result|output` → `tool_result`、图片／文件／音频 → 附件说明。推理记录不导入（以警告说明），运行时注入和用户前置上下文只保留真实请求。
- 侧车 `<会话 ID>.meta.json` 只读白名单字段；其指纹并入修订号，侧车变化会触发宿主重读。侧车声明的分叉／压缩会话在列表阶段即带 `unsupportedReason`。
- 验证范围：合成日志契约测试（macOS）。Windows 与其他 WorkBuddy 版本未验证；官方包字段契约见 [国内来源](domestic-sources.md)。
