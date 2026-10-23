# Pinekin Engine

Pinekin Engine 是 Pinekin「跨客户端会话互通」能力的核心：发现各客户端的本机会话日志，把会话读成结构化记录 `pinekin.transcript` v1。Pinekin App 和 NewMax 都是它的宿主；NewMax 按固定版本内置引擎产物，用户不需要安装或打开 Pinekin App。

## 边界

- 源码在 `src/engine/`，只依赖 Node 内置模块和 `zod`（由宿主提供同一主版本），不得引用 Electron、界面或数据库写入。
- 只读：不修改来源文件，不执行会话里的命令或工具调用；读取时拒绝越出授权根目录和经过符号链接的路径。
- 已知不支持的边界（分叉、子会话回退、压缩、多分支等）抛出 `PinekinUnsupportedError`，宿主应记录为「不支持」而不是错误。
- 当前来源：Codex、Qwen Code。其他来源仍只在 Pinekin App 内以文本投影阅读，接入引擎前需要补结构化解析与契约测试。

## 接口

| 导出 | 说明 |
|------|------|
| `ENGINE_VERSION` | 引擎版本；解析规则变化时递增，宿主据此作废增量状态 |
| `engineSources()` | 能力清单：每个来源分别声明 `discover`、`structured`、`workingDirectory`、`verifiedPlatforms`，不互相外推 |
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

`tests/engine.test.ts` 用合成的 Codex／Qwen Code 日志覆盖结构化映射、工作目录、子会话、不支持边界、取消与路径限制。不使用真实会话。NewMax 侧另有内置产物哈希、来源清单一致性和同步落库测试。
