<div align="center">

<img src="design/brand/banner/pinekin-readme-banner.jpg" width="100%" alt="Pinekin — 换个地方，继续思考。">

本地优先的跨 App 会话中转桌面工具：读取你在各家 AI 客户端里的对话，整理成一份通用接续文件，带到下一个 App 里接着聊。

![version](https://img.shields.io/badge/version-0.1.0-4b5563)
![platform](https://img.shields.io/badge/platform-macOS%20优先-111827)
![electron](https://img.shields.io/badge/Electron-44-47848f)
![license](https://img.shields.io/badge/license-MIT-2563eb)

[快速开始](#快速开始) · [支持的来源](#支持的来源) · [数据与隐私](#数据与隐私) · [开发](#开发与验证) · [文档](#文档)

</div>

---

## 它解决什么问题

在 Codex 里聊到一半想换到 NewMax，或者想把 Claude Code 的一段排查记录交给另一个 Agent，通常只能手动复制粘贴，角色、顺序和上下文很容易丢。Pinekin 直接读取已授权客户端的本地会话，按原文生成一份**不绑定目标 App 的 Markdown 接续文件**，复制后粘贴到任何支持文件附件的 App 即可。

```mermaid
flowchart LR
  A[连接来源 App] --> B[浏览和查找会话]
  B --> C[按需读取正文]
  C --> D[复制接续文件]
  D --> E[粘贴到目标 App 继续]
```

它**不是**档案库：默认不复制、不保存对话正文；也不会自动新建会话、自动发送或生成摘要。

## 核心特性

- **一键接续**：把完整可读历史打包成一个 `.md` 接续文件复制到剪贴板，保留角色、原文与读取说明；不用选目标，也不会打开其他 App。
- **七类来源**：NewMax、Cindy、Claude Code、Codex、DeepSeek Harness、WorkBuddy、Qwen Code，在侧栏统一浏览与搜索。
- **长会话也能读**：列表只读元数据，点开才解析正文；长会话分段加载，不按总大小或消息条数拒读。
- **本地优先**：只读取你授权的固定位置，不搜遍磁盘，不上传云端。
- **只读安全**：SQLite 在系统沙箱中以只读事务访问；历史 Markdown 经白名单渲染，不执行任何历史命令或 HTML。
- **状态如实**：不支持、损坏或超限的会话会标注原因；部分可读不冒充完整，复制成功也不等于目标已接收。

## 快速开始

1. 打开 Pinekin，点击侧栏 **连接 App**，打开对应卡片的开关即完成授权；关闭开关撤销该 App 的所有位置，不删除原会话。
2. 在会话列表中浏览，或按 `Cmd+K` / `Ctrl+K` 搜索标题等元数据。
3. 点开一条会话阅读正文；macOS 点击右上角 **复制接续文件**，Windows／Linux 点击 **保存接续文件**。
4. 切到目标 App，把文件粘贴、拖入或上传为附件，继续对话。

> [!NOTE]
> 文件复制目前只在 macOS 实现；Windows／Linux 主按钮直接保存完整文件，更多菜单也保留保存入口。NewMax／Cindy 数据库直读在非 macOS 连接面板提前标明不支持，不提供无效的位置选择。真实跨 App 文件粘贴效果仍在验收中，详见 [通用接续文件](docs/context-handoff.md)。

### 接续方式

| 方式 | 入口 | 内容 | 适用场景 |
| --- | --- | --- | --- |
| 复制接续文件 | macOS 页头主按钮 | 完整可读历史 + 接续说明 | 粘贴到支持文件附件的 App |
| 保存完整接续文件 | Windows／Linux 页头主按钮；各平台更多菜单 | 与上面相同的文件 | 手动拖入／上传 |
| 导出聊天记录 | 更多菜单 | 当前已读文本 | 存档或分享当前片段 |
| 原生历史迁移（高级） | 更多菜单 | 在目标客户端创建会话 | 仅 macOS：Codex／NewMax；Linux：NewMax |

接续文件上限 64 MiB，超出时明确报错，不静默截断；文件预算也不等于模型上下文。原生迁移保留备份、预演、回读和失败回滚，但实机验收未全部通过，见 [原生目标机制](docs/native-targets.md)。

## 支持的来源

| 来源 | 自动查找位置 | 正文支持范围 |
| --- | --- | --- |
| NewMax | `~/.newmax/newmax.db`、`NEWMAX_USER_DATA_DIR` | 普通主会话；隐私、分叉、非 App 会话不支持 |
| Cindy | `Cindy` / `CindyGlobal` 下的账号库 | 普通桌面会话当前问答；分叉、协作、远程、隐藏会话不支持 |
| Claude Code | `~/.claude/projects` 或单项目目录 | 当前文件单根父链；不追读父文件，压缩日志不支持 |
| Codex | `sessions`、`archived_sessions` | 当前文件内主／子会话；跨文件继承历史不追读 |
| DeepSeek Harness | `~/.dsh/sessions`、`DSH_HOME`；其他位置手动选择 | v4 独立主会话问答文本；不是 DeepSeek 网页聊天 |
| WorkBuddy | `.workbuddy/projects` | 本地普通主会话；分叉、压缩、重发回退不支持 |
| Qwen Code | `.qwen/projects` | 独立主会话单根父链；分叉、子会话、压缩不支持 |

- 显示数量是授权位置内**排除已知不支持条目后**的会话数，不是客户端全部记录；过滤不删除原件。
- 当前搜索只覆盖标题等元数据，不是全文搜索。
- 七类来源共用运行时上下文投影：身份、环境、IDE 等已知前置包装不进入问答和接续文件。

每类来源的路径、版本契约与限制见 [来源直读](docs/source-browser.md)、[国内来源契约](docs/domestic-sources.md) 和 [统一上下文规则](docs/source-context-projection.md)。

Pinekin Engine 0.3.1 已向宿主提供 Codex、Qwen Code、WorkBuddy 和 DeepSeek Harness 的统一记录接口，并修复 Electron 自带旧 Node 的多帧 Zstandard 读取兼容。Harness 首批仅含问答文本，不迁移推理、工具或附件；普通运行态事件按官方契约省略，未知事件和历史表面替换仍保守拒绝，不能将 App 文本阅读能力等同于引擎完整兼容。构建与边界见 [引擎说明](docs/engine.md)。

## 数据与隐私

- **不扫描**：未授权时不读取任何客户端目录、主目录或凭据；文件选择框由主进程控制。
- **不留存正文**：浏览时正文只在内存中；普通使用仅持久化 `connections.json` 中的连接位置。
- **接续文件是明文**：复制时会在 `userData/clipboard-handoffs/` 保存 `.md` 副本（文件 `0600`、目录 `0700`），以保证之后仍可粘贴；它和系统剪贴板都不是加密存储。
- **只读数据库**：SQLite 直读目前仅在 macOS 验证，通过 `sandbox-exec` 禁止写入与网络，使用固定白名单 SQL。**请不要手动删除 WAL 等副文件。**
- **不执行内容**：不沿日志中的路径或附件读取其他文件，不执行历史命令，HTML 以源码文字显示。

完整的存储位置、配额与回滚规则见 [通用接续文件](docs/context-handoff.md) 和 [架构与能力边界](docs/architecture.md)。

## 平台支持

| 能力 | macOS | Linux | Windows |
| --- | :---: | :---: | :---: |
| 日志类来源浏览（Claude Code、Codex 等） | ✅ | 未实机验收 | 未实机验收 |
| SQLite 来源直读（NewMax、Cindy） | ✅ | 暂不支持 | 暂不支持 |
| 复制接续文件到剪贴板 | ✅ | 用保存代替 | 用保存代替 |
| 原生历史迁移（高级） | Codex／NewMax | NewMax | 暂不支持 |

Windows 首版边界为日志类来源浏览、阅读和保存完整接续文件；没有已接入原生目标时隐藏迁移与目标设置入口。CI 已配置 macOS／Windows 双平台测试、Engine 构建与 Windows x64 NSIS 测试包生成，**配置不等于运行通过或安装包验收完成**。安装、升级、路径、缩放和协议投递仍需 Windows 原生验收，详见 [Windows 适配与验收](docs/windows-support.md)。

## 已知限制

- **接续效果未逐一实测**：接续文件粘贴进各目标 App 后的接续效果，还没有逐个客户端验收。
- **原生迁移只搬文本**：只承接普通主会话的 user / assistant 文本，不迁移附件、推理、工具调用、权限和分支树；目标桌面展示与下一轮对话尚未实机验收，NewMax 的会话定位仍不稳定。
- **部分会话不可读**：Cindy 的分叉／协作会话、DeepSeek 网页版聊天暂不支持。
- **不会自动脱敏**：接续文件原样保留历史内容，发送前请自行检查敏感信息。
- **仅 Apple 芯片**：目前只提供 Apple 芯片 DMG。`npm run dist:mac:signed` 产出 Developer ID 签名并公证的分发包（需本机证书与 `.env.signing`）；`npm run dist:mac` 产出的自用包仅 ad-hoc 签名，首次打开需在「隐私与安全性」中放行；没有自动更新。见 [macOS 打包](docs/macos-packaging.md)。

开发计划见 [接入路线](docs/roadmap.md)。

## 开发与验证

需要 Node.js 22.15+（建议 24.22）和 npm。

```bash
npm ci
npm run dev            # 启动桌面开发版
npm run test:coverage  # 单元测试与覆盖率
npm run build          # typecheck + 构建
npm run test:e2e       # Playwright 桌面 E2E
npm run dist:mac       # 打包 Apple 芯片 DMG（ad-hoc 签名）
npm run dist:win       # 在 Windows 打包 x64 NSIS 测试安装包，未配置分发签名
```

| 改动范围 | 需要执行 |
| --- | --- |
| 任意改动 | 相关最小测试 → `npm run typecheck` |
| 核心逻辑或界面 | 再加 `npm run test:coverage` |
| IPC／桌面流程 | 再加 `npm run build && npm run test:e2e` |

E2E 只使用合成数据和隔离的 userData，替换文件选择框与系统剪贴板；`STAITHE_TEST_BACKGROUND=1` 让测试窗口全程隐藏、不抢前台。贡献约束见 [AGENTS.md](AGENTS.md)。

技术栈：Electron 44 · React 19 · TypeScript · Vite · Vitest · Playwright。Electron 保持 `sandbox`、`contextIsolation`、具名 preload API 与 IPC 参数校验。

## 文档

| 主题 | 文档 |
| --- | --- |
| 架构 | [架构与能力边界](docs/architecture.md) · [目标能力](docs/target-capabilities.md) · [接入路线](docs/roadmap.md) |
| 来源 | [来源直读](docs/source-browser.md) · [国内来源](docs/domestic-sources.md) · [上下文投影](docs/source-context-projection.md) |
| 接续 | [通用接续文件](docs/context-handoff.md) · [原生目标](docs/native-targets.md) · [NewMax 接续](docs/newmax-target.md) · [Codex 项目列表](docs/codex-project-catalog.md) |
| 界面 | [界面设计](docs/ui-design.md) · [空占位规范](docs/empty-states.md) · [连续圆角](docs/continuous-corners.md) · [图标](docs/app-icon.md) |
| 档案 | [档案格式与资源限制](docs/import-formats.md) · [Codex 格式](docs/codex-import.md) |
| 发布 | [macOS 打包](docs/macos-packaging.md) · [Windows 适配与验收](docs/windows-support.md) |
| 核验 | [NewMax／Claude 核验](docs/newmax-claude-local-validation-2026-10-17.md) · [Cindy／DeepSeek 核验](docs/cindy-deepseek-local-validation-2026-10-17.md) · [品牌兼容](docs/pinekin-rename-verification.md) |

<details>
<summary><b>已有档案（兼容入口）</b></summary>

旧版档案功能保留在兼容界面，可通过原有本地深链访问，不与实时来源计数混合，也不自动删除已有档案：

- 文件选择 → 只读预览 → 确认后保存原件与文本档案；取消不落盘。
- 支持 Staithe v1/v2、Ember v1、NewMax 白名单快照、Claude Code JSONL、Cindy 未加密分享包与本地快照、Codex 日志、DeepSeek Harness v4 日志。
- 内容散列去重、损失报告，原件与记录原子发布到 `imports/<sha256>/`。
- 导出文本包／Markdown 均是手动文本交接，不是目标会话创建或原生恢复。
- `npm run import:local` 仅为历史开发批次工具，默认预演，`--confirm` 才保存。

原件、记录和连接配置均为本机明文。格式细节见 [档案格式](docs/import-formats.md)。

</details>

<details>
<summary><b>兼容身份</b></summary>

项目原名 Staithe，GitHub 仓库现为 `newmax-ai/pinekin`。品牌已改为 Pinekin，安装身份与历史数据格式保持兼容，不耦合修改 NewMax 主仓库。

- 显示名 Pinekin，包名 `@newmax-ai/pinekin`，安装身份 `ai.newmax.staithe` 保留。
- 默认 userData 沿用系统 appData 下的 `@newmax-ai/ember`，不自动搬迁。
- 开发隔离支持 `STAITHE_DATA_DIR`，兼容 `EMBER_DATA_DIR`，打包版忽略二者。
- 文本包 `staithe.session` v1/v2，兼容 `ember.session` v1；深链 `newmax-staithe://session/<本地ID>`，兼容 `newmax-ember://`。开发模式不注册系统协议。
- 内部桥仍为 `window.staithe`，旧 `staithe:*` 接口不变。
- 演示内容仅在测试夹具；旧演示档案不展示，也不自动删除。

</details>

## 许可

Pinekin 采用 [MIT 许可证](LICENSE)，版权声明为 `Copyright (c) 2026 newmax-ai`。第三方依赖和素材遵循各自的许可证及归属声明；README 中提到的客户端名称属于相应权利人，不表示品牌背书。

Pinekin 是项目采用的品牌名，不代表已完成商标、域名或排他性审查。
