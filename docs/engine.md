# Pinekin Engine

Pinekin Engine 是 Pinekin「跨客户端会话互通」能力的核心：发现各客户端的本机会话日志，把会话读成结构化记录 `pinekin.transcript` v1。Pinekin App 和 NewMax 都是它的宿主；NewMax 按固定版本内置引擎产物，用户不需要安装或打开 Pinekin App。

## 边界

- 源码在 `src/engine/`，只依赖 Node 内置模块和 `zod`（由宿主提供同一主版本），不得引用 Electron、界面或数据库写入。
- 只读：不修改来源文件，不执行会话里的命令或工具调用；读取时拒绝越出授权根目录和经过符号链接的路径。
- 已知不支持的边界（分叉、子会话回退、压缩、多分支等）抛出 `PinekinUnsupportedError`，宿主应记录为「不支持」而不是错误。
- 体量上限同理：消息条数超过 10,000、累计字符超过 48,000,000 对同一份日志是确定结果，也抛出 `PinekinUnsupportedError`，宿主记录后不再重读。单条日志记录超过 8 MiB 仍是可重试的普通错误，不标为不支持。
- 当前来源：Codex、Qwen Code、WorkBuddy。其他来源仍只在 Pinekin App 内以文本投影阅读，接入引擎前需要补结构化解析与契约测试。
- **归属范围 `scope`**：`workspace` 来源（Codex、Qwen Code）的每条会话带可信绝对工作目录，宿主用 `workingDirectoryWithin` 归入工作区；`global` 来源（WorkBuddy）没有可信工作目录，`SessionRef.workingDirectory` 恒为空，宿主不得从目录名等线索猜测归属。

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

## WorkBuddy 来源（引擎 0.2.0）

- 位置：`~/.workbuddy/projects/<任务目录>/<会话 ID>.jsonl`，`WORKBUDDY_CONFIG_DIR` 覆盖根目录；不沿用独立 CodeBuddy 的变量。云缓存 `projects/cloud`、子代理目录、`projects` 根级文件不属于普通本地主会话，列表阶段排除。
- 为什么是全局来源：任务目录是 WorkBuddy 自建文件夹（形如 `Users-<用户>-WorkBuddy-<时间>`）的不可逆转义，日志行与侧车白名单字段里都没有工作目录，因此不推断归属。
- 结构校验与 App 的来源浏览共用 `createWorkbuddyIndexer`（父链、相邻同 ID 助手分块、压缩／分叉／逻辑父链／子会话边界），引擎只在同一遍扫描里额外产出块：用户／助手文本、`function_call` → `tool_call`、`function_call_result|output` → `tool_result`、图片／文件／音频 → 附件说明。推理记录不导入（以警告说明），运行时注入和用户前置上下文只保留真实请求。
- 侧车 `<会话 ID>.meta.json` 只读白名单字段；其指纹并入修订号，侧车变化会触发宿主重读。侧车声明的分叉／压缩会话在列表阶段即带 `unsupportedReason`。
- 验证范围：合成日志契约测试（macOS）。Windows 与其他 WorkBuddy 版本未验证；官方包字段契约见 [国内来源](domestic-sources.md)。
