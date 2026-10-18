# Pinekin

**换个地方，继续思考。**

Pinekin 是一个独立的、本地优先的 AI 会话档案桌面客户端，归属 `newmax-ai`。收好散落在不同客户端里的对话，再带着上下文去另一个工具继续。品牌采用黑白松貂形象，已接入透明边缘 PNG、macOS ICNS 与 Windows ICO 静态图标；macOS 应用目录已打包验证，Windows / Linux 仅完成图标配置，未做实机验收。macOS 使用带透明安全留白与轻微外阴影的专用图标，开发 Dock 与应用包保持一致；不直接使用满幅 iOS 导出。侧栏仍保留纯文字 Logo。

原名 Staithe。仓库暂保留：`https://github.com/newmax-ai/staithe`；本地目录未随品牌更名搬动。

> 当前是桌面原型与受限只读导入验证，不是已经完成所有客户端迁移的正式产品。启动仅展示已保存的本地档案，不再内置或追加演示会话；空库显示导入引导，不自动扫描客户端目录。外部格式有合成夹具测试；Codex、Cindy 本地快照和 DeepSeek Harness 另有获授权本机样本核验，不代表所有版本兼容或原生恢复验收。

## 已实现

- 所有内容滚动区域统一接入本地适配的 NewMax ScrollArea mask：侧栏、会话列表、消息、导入报告、搜索结果、弹窗内容、交接预览与代码块共用 48px 平滑渐隐（对齐 NewMax 侧栏实际配置），距边界 4px 内恢复该侧完整显示；横向代码支持左右渐隐，双轴使用 mask 交集。无溢出不遮罩，尺寸、内容和字体就绪后自动重测，保留原生滚动和现有布局，不依赖 NewMax 运行时。详见 [界面设计说明](docs/ui-design.md#统一滚动区域-mask2026-10-17)。

- 纯图标操作统一接入本地适配的 NewMax Tooltip：悬停 150ms 提示、300ms 内跨按钮快速切换，键盘聚焦立即提示；覆盖导航、侧栏开关、搜索和关闭操作。沿用浅深色提示表面、10px 连续圆角与阴影，移除重复原生 title，不依赖 NewMax 运行时。导入使用有可见文字的侧栏菜单，不重复显示 Tooltip。

- Electron + React + TypeScript 桌面应用；沿用 NewMax 控件尺度的独立三栏工作台，中性灰浅 / 深色主题与蓝色品牌强调、纯文字 Logo、本地客户端 / 品牌图标；通用图标采用 Lucide React；导航、搜索和关闭图标统一使用设计系统的 small relaxed 按钮（28px 高、15px 图标、左右各 10px 内边距）。左侧上方仅保留「导入会话」图标＋文字菜单行，沿用 36px 导航行样式，不属于来源筛选；下方「会话来源」分组首先显示「所有会话」，再列出各客户端来源；左下角不显示版本。会话预览沿用右侧用户气泡与左侧无头像助手正文。
- macOS 隐藏独立标题栏：原生红绿灯靠左上边缘，38px 顶行依次排列返回、前进、侧栏开关；28px 按钮上下各留 5px，并与红绿灯同轴（Windows 保持 32px 顶行，上下各 2px）；下一行 36px 的文字 Logo 与搜索图标位于侧栏内部。会话列表不再显示「会话库」标题栏或空白占位，直接从卡片顶边显示当前来源与数量；阅读区同样从卡片顶边展示会话标题，标题下不再显示横向分割线。全局导入入口归属左侧菜单，侧栏收起时随之隐藏，展开后可用。顶部保留窗口拖动区，交互控件不参与拖动。Windows 保留相同布局，取消红绿灯占位后导航从左侧 12px 开始。Windows / Linux 均保留系统标题栏；Linux 仅保留列表栏内原有 64px 导航工具栏，不显示「会话库」标题或横向分割线。
- 侧栏无竖向分割线，右侧页头、会话列表与阅读区整体包入 18px 逻辑圆角卡片，沿用连续圆角补偿；右侧和底部各留 8px，收起侧栏后左侧也留 8px。macOS / Windows 共享结构，Logo 与搜索仍属于侧栏。
- 来源名称保持单行，实际溢出时按 NewMax 的 16px 末端 mask 渐隐；图标与数量不参与遮罩，悬停可见完整名称。侧栏右边缘可拖拽调宽（240–360px，默认 240px，窄窗口自动限宽但不低于 240px），旧版本保存的小于 240px 的宽度按新下限显示，本地记住宽度；双击恢复默认，聚焦边界后可用左右键或 Home/End 调整。
- 仅保留来源与搜索组合筛选，移除「全部 / 已导入 / 演示」分类和演示计数。Logo 右侧默认仅显示放大镜图标；点击或按 `Cmd+K` / `Ctrl+K` 打开搜索弹窗，搜索标题 / 标签 / 正文、清空查询或打开结果。Escape 关闭并恢复焦点，侧栏收起时仍可用快捷键搜索。支持加载、空态、失败重试和清空筛选。返回 / 前进恢复会话和组合筛选，连续搜索合并为一个历史项，新导航截断前进历史；最近 100 个位置仅保存在当前窗口内存。
- 连续圆角复用 NewMax 当前规则：卡片、输入框、弹窗和消息气泡使用 `superellipse(1.5)` 与 1.348 倍半径补偿；操作按钮保留胶囊，正圆控件保持普通圆角。不支持时回退普通圆角，详见 [圆角适配与验证](docs/continuous-corners.md)。
- 安全的文本与代码围栏排版，不渲染不可信 HTML 或外部图片；导入报告按需展开，模态框支持键盘焦点圈定与返回。
- 「导入会话文件」：用户选文件 → 只读预览来源和损失 → 明确确认 → 保存原件与文本档案；取消不落盘。
- Staithe 文本包 v1 / v2，兼容旧 Ember v1 包；严格版本和字段校验。
- **Cindy `.cshare` / `.xdtshare` 未加密普通 v1 包**的文本投影。固定官方源码提交、合成夹具验证；加密包、Orca 协同包及未来版本明确拒绝，尚未用真实客户端导出包验收。
- **Pinekin NewMax 本地快照 v1**：NewMax 1.1.22 普通非隐私、非分叉主会话的字段白名单快照；按当前 SQLite 消息行顺序投影用户展示文本和助手正文，排除已标记内部续轮。不复制数据库、设置、工具或附件；不是官方导出包。
- **Claude Code 原生 JSONL**：完整单根、非子会话日志的显式末条消息父链文本投影；先建完整 UUID 图，再提取人类/助手文本并合并追加块，避免把工具结果冒充用户输入。其他分支仅保留在原件，压缩/逻辑父链尚未支持；不是原生活动链或原生恢复。
- **Pinekin Cindy 本地快照 v1**：依据 Cindy 0.1.97 普通桌面主会话生成的字段白名单快照，按桌面时间线顺序读取，排除已清空/回退正文。不是官方 `.cshare`；不自动打开数据库。
- **DeepSeek Harness session-v4 JSONL / JSONL.ZSTD**：独立、非继承、非子会话；只展示用户主动输入与助手文本，不混入运行时注入、推理、工具或流式副本。已在安装版本 0.2.1-rc.1 环境核验 3 份现有日志，不代表全部由该版本新建。
- **Codex 独立主会话 JSONL / JSONL.ZST** 的文本投影。支持 legacy，以及无外部引用、序号从 0 连续的 paginated 根日志；Zstandard 输入/展开均限 5 MiB，解码窗口限 8 MiB。只提取顶层消息，避免事件副本重复；工具、推理、压缩和回退的损失明确报告。继承、序号缺失与子会话仍拒绝，不自动扫描目录，不启动 resume。
- 5 MiB 输入上限；ZIP 展开、累计压缩数据处理量、条目数、压缩比与路径限制；逐文件 CRC32、SHA-256 和长度校验。不执行或落盘解压包内文件。
- 新档案保存在 `userData/imports/<sha256>/`，原件与索引暂存后整体原子发布；旧 `library.json` 继续读取，不自动改写。
- 相同文件重复导入复用已有本地 ID，不按正文合并不同会话；预览后源文件变化不会替代已确认的快照。
- 导入报告在详情和上下文交接中保留；导出 Pinekin 文本包（沿用 Staithe 格式）、Markdown 或复制交接文本。支持通用、NewMax、Claude Code、Codex 作为**文本交接目标**。
- `newmax-staithe://session/<本地ID>` 会话定位，兼容 `newmax-ember://`；支持冷启动参数、macOS `open-url` 与第二实例事件。

## 明确未实现

- **DeepSeek 网页聊天导出适配**：仍缺已验证格式；Harness 的日志支持不等于消费者聊天导出支持。
- 产品内自动扫描、持续同步与直接数据库连接入口。NewMax 白名单快照和 Claude Code 单根 JSONL 已有限接入；`npm run import:local` 仅供显式授权的开发期有界批次，默认预演、加 `--confirm` 才保存，不是桌面自动读取能力。Cindy 数据库读取仍仅为获明确授权的一次性开发核验。Codex 仅支持有限 JSONL / JSONL.ZST 布局，未做客户端恢复验收。
- 写入其他客户端数据库、原生会话恢复、自动创建目标会话或跨 harness 跳转。
- 附件、结构化工具状态、权限、模型状态、分支树的迁移；Cindy 原包中的这些内容只保留在本地原件，不进入文本快照。
- SQLite、后台解析 worker、大库分页/增量索引、逐会话删除界面与自动备份。
- 云同步、公开分享页面、自动脱敏、加密存储、AI 自动摘要。
- 安装包签名、公证、自动更新，以及 Windows / Linux 实机验收。

“选择接续目标”只改变交接文本中的目标说明，不会自动发送给目标应用，也不表示该应用支持原生恢复。导出 v2 文本快照不携带原始二进制文件；不能把它当成完整 Cindy 分享包。

## 开发

需要 Node.js 22.15+（新增原生 Zstandard API；建议使用本项目验收环境 Node.js 24.22）和 npm。

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

E2E 通过 Playwright 在后台启动项目安装的 Electron，无需下载浏览器。测试入口设置 `STAITHE_TEST_BACKGROUND=1`：窗口创建时即隐藏、不可抢焦点，不是显示后再隐藏；macOS 测试进程不显示 Dock 图标，深链与第二实例也不会唤起窗口。隐藏窗口继续绘制，支持 CDP 操作、焦点语义和截图；测试监听原生 `show` / `focus` 事件并检查窗口不可见、未聚焦及 macOS 应用未激活。开发入口验收与 Windows 布局模拟也默认后台。正常手动 `npm run dev` / `preview` 不设置该标记，打包应用忽略它；需要前台人工验收时须先征得用户同意。

文件选择框被替换为临时合成文件路径，真实经过 preload、IPC、解析和持久化；系统剪贴板被替换，不影响真实用户档案。Linux E2E 需要图形会话或 Xvfb；后台隐藏不等于脱离图形会话的 headless 模式。CI 使用 macOS 运行桌面测试。

开发模式不注册系统协议。已打包应用使用独立协议 `newmax-staithe`，保留 `newmax-ember` 兼容入口。本地链接只携带 ID，不包含正文；跨设备需先传递并导入文件包。首次导入会分配新本地 ID，相同字节文件的后续导入复用该 ID。

## Pinekin 更名与兼容约定

- 产品显示名 **Pinekin**，侧栏文字 `pinekin.`，npm 包名 `@newmax-ai/pinekin`。安装身份 `ai.newmax.staithe` 保留，不因品牌变化重建应用身份；尚未做已安装版本的升级实机验收。
- 导出默认文件名改为 `pinekin-<ID>.staithe.json` / `pinekin-<ID>.md`；包扩展名 `.staithe.json` 和 `format: "staithe.session"` 不变，不新增 `pinekin.session`。无扩展数据的旧会话继续输出 v1；含新来源或来源报告的文本快照使用 v2。读取旧 `ember.session` v1；不支持 Ember v2。旧版不能读取新版扩展格式。
- 深链仍生成 `newmax-staithe://`，继续接受 `newmax-ember://`；不新增未验收的 Pinekin 协议。内部 `window.staithe`、`StaitheAPI` 与 `staithe:*` IPC 不改。
- 用户正文、标签和已有 ID 不做品牌替换。旧协议的 `demo` 字段继续兼容，但标记为演示的旧库记录不展示，也不改写或删除原库；新导入始终保存为非演示档案。原示例仅迁移到 `tests/fixtures/sessions.ts` 作为隔离测试数据，不随产品加载。
- **存储目录保留旧身份**：默认 `userData` 为系统 `appData` 下的 `@newmax-ai/ember`，不因更名自动搬动已有档案。
- 开发隔离目录优先使用 `STAITHE_DATA_DIR`，兼容 `EMBER_DATA_DIR`；打包应用忽略两者。隐藏测试仍使用 `STAITHE_TEST_BACKGROUND`。
- 历史验收文档保留当时名称，新增验收单独记录，不改写历史结果。品牌更名不更改远端仓库、不搬动本地目录，不自动提交或推送；后续应用图标替换单独记录在 [图标资产与验收](docs/app-icon.md)。

## 数据与隐私

- 不配置云端、不自动上传、不扫描主目录；桌面仅读取用户通过文件选择框授权的文件。开发期 `import:local` 另需明确授权，只检查指定会话文件或约定日志层级，只读来源且不读取认证配置；默认预演、明确确认后真实副本只进入指定 Pinekin 档案目录，不进入仓库或测试。
- `library.json`、新档案记录和 `original.bin` 都是**明文**。新归档目录创建权限 `0700`，文件 `0600`；这不是加密，Windows 权限语义也不同。
- 确认导入会保存整个原始包，可能包含附件、工作区路径和敏感信息；预览明确告知。原件默认不随对外导出传递。
- 导出的文本仍可能包含凭据、个人信息和项目机密；当前没有自动脱敏。
- 历史作为不可信文本展示，仅为成对代码围栏增加只读排版；不执行 HTML、脚本、工具命令或授权字段，不自动加载外部媒体。交接中的提示不构成对目标模型的提示注入防护保证。
- 档案损坏明确报错，不静默覆盖。备份时保留 `library.json` 与完整 `imports`；新档案的原件和记录不能分开删除。详细恢复/删除边界见格式文档。

## 文档

- [架构与迁移边界](docs/architecture.md)
- [桌面工作台与 NewMax 设计系统复用](docs/ui-design.md)
- [只读导入格式、支持矩阵与资源限制](docs/import-formats.md)
- [第一批只读导入验收](docs/import-verification.md)
- [Codex 日志适配边界](docs/codex-import.md) · [首批 Codex 验收](docs/codex-verification.md)
- [本机只读抽样与格式修正验收](docs/local-validation-2026-10-17.md)
- [Cindy 与 DeepSeek Harness 本地接入及更新核验](docs/cindy-deepseek-local-validation-2026-10-17.md)
- [NewMax / Claude Code 接入、显式本地批次与首批归档核验](docs/newmax-claude-local-validation-2026-10-17.md)
- [后续接入路线](docs/roadmap.md)
- [产品调研](docs/research/harness-landscape-2026-10-16.md) · [接入方案](docs/research/integration-proposal-2026-10-16.md)
- [首版验证与依赖告警](docs/verification.md) · [Staithe 更名验收](docs/rename-verification.md)
- [Pinekin 品牌更名与验收](docs/pinekin-rename-verification.md)
- [贡献约束](AGENTS.md)

## 品牌与许可

Pinekin 采用 [MIT 许可证](LICENSE)，版权声明为 `Copyright (c) 2026 newmax-ai`。第三方依赖和素材仍遵循各自的许可证及归属声明。

Pinekin 是本项目采用的品牌名，不代表已经完成商标、域名或品牌排他性审查。已有其他行业使用该名称，公开重名初查不能代替正式核验。
