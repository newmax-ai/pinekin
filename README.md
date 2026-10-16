# Staithe

**换个地方，继续思考。**

Staithe 是一个独立的、本地优先的 AI 会话档案桌面客户端，归属 `newmax-ai`。它像一个让对话停靠、汇聚与再次出发的码头：收好散落在不同客户端里的对话，再带着上下文去另一个工具继续。

仓库：`https://github.com/newmax-ai/staithe`

> 当前是桌面原型与第一批只读导入验证，不是已经完成所有客户端迁移的正式产品。启动时展示 3 段明确标记的虚构演示会话，不读取任何真实客户端目录。外部格式目前仅完成合成夹具验证。

## 已实现

- Electron + React + TypeScript 桌面应用；会话列表、来源筛选、标题 / 标签 / 正文搜索、纯文本详情。
- 「导入会话文件」：用户选文件 → 只读预览来源和损失 → 明确确认 → 保存原件与文本档案；取消不落盘。
- Staithe 文本包 v1 / v2，兼容旧 Ember v1 包；严格版本和字段校验。
- **Cindy `.cshare` / `.xdtshare` 未加密普通 v1 包**的文本投影。固定官方源码提交、合成夹具验证；加密包、Orca 协同包及未来版本明确拒绝，尚未用真实客户端导出包验收。
- 5 MiB 输入上限；ZIP 展开、累计压缩数据处理量、条目数、压缩比与路径限制；逐文件 CRC32、SHA-256 和长度校验。不执行或落盘解压包内文件。
- 新档案保存在 `userData/imports/<sha256>/`，原件与索引暂存后整体原子发布；旧 `library.json` 继续读取，不自动改写。
- 相同文件重复导入复用已有本地 ID，不按正文合并不同会话；预览后源文件变化不会替代已确认的快照。
- 导入报告在详情和上下文交接中保留；导出 Staithe 文本包、Markdown 或复制交接文本。支持通用、NewMax、Claude Code、Codex 作为**文本交接目标**。
- `newmax-staithe://session/<本地ID>` 会话定位，兼容 `newmax-ember://`；支持冷启动参数、macOS `open-url` 与第二实例事件。

## 明确未实现

- **DeepSeek 导出适配**：官方有导出入口，但没有已验证的格式契约或脱敏样本；不能用模型 API / Harness 格式代替聊天产品格式。
- NewMax、Claude Code、Codex 等客户端的真实目录扫描、日志接入与数据库读取。
- 写入其他客户端数据库、原生会话恢复、自动创建目标会话或跨 harness 跳转。
- 附件、结构化工具状态、权限、模型状态、分支树的迁移；Cindy 原包中的这些内容只保留在本地原件，不进入文本快照。
- SQLite、后台解析 worker、大库分页/增量索引、逐会话删除界面与自动备份。
- 云同步、公开分享页面、自动脱敏、加密存储、AI 自动摘要。
- 安装包签名、公证、自动更新，以及 Windows / Linux 实机验收。

“选择接续目标”只改变交接文本中的目标说明，不会自动发送给目标应用，也不表示该应用支持原生恢复。导出 v2 文本快照不携带原始二进制文件；不能把它当成完整 Cindy 分享包。

## 开发

需要 Node.js 22.12+（建议 24）和 npm。

```bash
npm ci
npm run dev
```

```bash
npm run test:coverage  # 核心逻辑、归档解析、文件存储与界面组件
npm run build         # TypeScript 检查 + Electron 构建
npm run test:e2e       # 构建后启动真实 Electron，临时档案隔离
npm run preview       # 运行构建产物
npm run pack          # 生成未签名的当前平台应用目录
```

E2E 通过 Playwright 启动项目安装的 Electron，无需下载浏览器。文件选择框被替换为临时合成文件路径，真实经过 preload、IPC、解析和持久化；系统剪贴板被替换，不影响真实用户档案。Linux E2E 需要图形会话或 Xvfb。CI 使用 macOS 运行桌面测试。

开发模式不注册系统协议。已打包应用使用独立协议 `newmax-staithe`，保留 `newmax-ember` 兼容入口。本地链接只携带 ID，不包含正文；跨设备需先传递并导入文件包。首次导入会分配新本地 ID，相同字节文件的后续导入复用该 ID。

## 从 Ember 更名的兼容约定

- 产品名 **Staithe**，npm 包名 `@newmax-ai/staithe`，应用标识 `ai.newmax.staithe`。
- 新导出使用 `.staithe.json` 和 `format: "staithe.session"`。无扩展数据的旧会话继续输出 v1；含新来源或来源报告的文本快照使用 v2。读取旧 `ember.session` v1；不支持 Ember v2。旧版不能读取新版扩展格式。
- 用户正文和已有 ID 不做品牌替换；演示 ID `demo-ember` 保留。
- **存储目录保留旧身份**：默认 `userData` 为系统 `appData` 下的 `@newmax-ai/ember`，不因更名自动搬动已有档案。
- 开发隔离目录优先使用 `STAITHE_DATA_DIR`，兼容 `EMBER_DATA_DIR`；打包应用忽略两者。
- 历史验收文档保留当时名称，新增验收单独记录，不改写历史结果。

## 数据与隐私

- 不配置云端、不自动上传、不扫描主目录；只读取用户通过文件选择框授权的文件。
- `library.json`、新档案记录和 `original.bin` 都是**明文**。新归档目录创建权限 `0700`，文件 `0600`；这不是加密，Windows 权限语义也不同。
- 确认导入会保存整个原始包，可能包含附件、工作区路径和敏感信息；预览明确告知。原件默认不随对外导出传递。
- 导出的文本仍可能包含凭据、个人信息和项目机密；当前没有自动脱敏。
- 历史以纯文本展示，不执行 HTML、脚本、工具命令或授权字段，不自动加载外部媒体。交接中的提示不构成对目标模型的提示注入防护保证。
- 档案损坏明确报错，不静默覆盖。备份时保留 `library.json` 与完整 `imports`；新档案的原件和记录不能分开删除。详细恢复/删除边界见格式文档。

## 文档

- [架构与迁移边界](docs/architecture.md)
- [只读导入格式、支持矩阵与资源限制](docs/import-formats.md)
- [第一批只读导入验收](docs/import-verification.md)
- [后续接入路线](docs/roadmap.md)
- [产品调研](docs/research/harness-landscape-2026-10-16.md) · [接入方案](docs/research/integration-proposal-2026-10-16.md)
- [首版验证与依赖告警](docs/verification.md) · [Staithe 更名验收](docs/rename-verification.md)
- [贡献约束](AGENTS.md)

## 品牌与许可

Staithe 是本项目确认的产品名，不代表已经完成商标或品牌排他性审查。仓库公开不等于已授予开源许可；当前尚未选定许可证。
