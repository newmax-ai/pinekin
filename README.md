# Staithe

**换个地方，继续思考。**

Staithe 是一个独立的、本地优先的 AI 会话档案桌面客户端，归属 `newmax-ai`。它像一个让对话停靠、汇聚与再次出发的码头：收好散落在不同客户端里的对话，再带着上下文去另一个工具继续。

仓库：`https://github.com/newmax-ai/staithe`

> 当前为可运行的桌面骨架，不是已经完成所有客户端迁移的正式产品。启动时展示 3 段明确标记的虚构演示会话，不读取任何真实客户端目录。

## 已实现

- Electron + React + TypeScript 桌面应用。
- 会话列表、来源筛选、标题 / 标签 / 正文全文搜索、纯文本详情。
- 用户主动选择 `.staithe.json` 文件导入，兼容旧 `.ember.json` 包；严格版本 / 字段校验，5 MB 上限。
- 导入档案保存到 Electron `userData` 下的 `library.json`，串行写入、原子替换；原始文件不被修改。
- 导出 Staithe 会话包；导出 Markdown 或复制上下文交接文本，支持选择通用、NewMax、Claude Code、Codex 作为文本交接目标。
- `newmax-staithe://session/<本地ID>` 会话定位，兼容旧 `newmax-ember://` 链接；支持冷启动参数、macOS `open-url` 与第二实例事件处理。
- 预留客户端适配器接口，能力显式声明，尚未实现的能力均为 `false`。

## 明确未实现

- NewMax、Claude Code、Codex 等客户端的真实数据扫描与读取。
- 写入其他客户端数据库、原生会话恢复、自动创建目标会话或跨 harness 跳转。
- 附件、工具执行状态、权限、模型状态、分支树的迁移。
- 云同步、公开分享页面、自动脱敏、加密存储、AI 自动摘要。
- 安装包签名、公证、自动更新，以及 Windows / Linux 实机验收。

“选择接续目标”只改变交接文本中的目标说明，不会自动把对话发送给目标应用，也不表示该应用支持原生恢复。

## 开发

需要 Node.js 22.12+（建议 24）和 npm。

```bash
npm ci
npm run dev
```

```bash
npm run test:coverage  # 核心逻辑、文件存储、界面组件
npm run build         # TypeScript 检查 + Electron 构建
npm run test:e2e       # 构建后启动真实 Electron，临时档案隔离
npm run preview       # 运行构建产物
npm run pack          # 生成未签名的当前平台应用目录
```

E2E 通过 Playwright 启动项目安装的 Electron，无需下载浏览器。测试选择框被替换为临时文件路径，真实经过 preload、IPC、文件校验和持久化；不会改动用户档案或系统剪贴板。Linux 运行 E2E 需要图形会话或 Xvfb。CI 使用 macOS 运行桌面测试。

开发模式不注册系统协议。已打包应用使用独立协议 `newmax-staithe`，并保留 `newmax-ember` 兼容入口。本地链接只携带 ID，不包含正文；不能用链接把会话传到其他设备。导入时分配新的本地 ID，因此原链接不会自动跟随导入。

## 从 Ember 更名的兼容约定

- 产品名改为 **Staithe**，npm 包名为 `@newmax-ai/staithe`，应用标识为 `ai.newmax.staithe`。
- 新导出使用 `.staithe.json` 和 `format: "staithe.session"`；仍接受 `format: "ember.session"` 的 v1 包。旧版 Ember 不支持新格式；本次兼容方向是旧包导入新版。
- 会话内容和已有 ID 不做品牌替换。演示会话的历史 ID `demo-ember` 保留，避免旧链接失效。
- **存储目录刻意保留旧身份**：默认 `userData` 为系统 `appData` 下的 `@newmax-ai/ember`，不因改名切换目录或自动搬动已有档案。
- 开发隔离目录优先使用 `STAITHE_DATA_DIR`，兼容 `EMBER_DATA_DIR`；打包应用忽略这两个变量。
- 首版验证记录保留当时的产品名称，新名称的验收单独记录，不改写历史结果。

## 数据与隐私

- 不配置云端、不自动上传、不扫描主目录；数据源目录接入必须另行授权。
- `library.json` 为明文。文件创建时使用 `0600` 权限，但这不是加密，Windows 权限语义也不同。
- 导出包和交接文本会包含原始会话内容。请先检查凭据、个人信息和项目机密；当前没有自动脱敏功能。
- 历史内容以纯文本展示，不执行 HTML、脚本、工具命令或历史指令。交接文本附带不可信历史资料提示，这不是对目标模型的提示注入防护保证。
- 档案损坏会明确报错，不静默清空后覆盖。需要自行保留和恢复 `library.json`。

## 文档

- [架构与迁移边界](docs/architecture.md)
- [后续接入路线](docs/roadmap.md)
- [首版验证与已知依赖告警](docs/verification.md)
- [Staithe 更名验收](docs/rename-verification.md)
- [贡献约束](AGENTS.md)

## 品牌与许可

Staithe 是本项目确认的产品名，不代表已经完成商标或品牌排他性审查。仓库公开不等于已授予开源许可；当前尚未选定许可证。
