# 架构与能力边界

## 主数据流（2026-10-18 起）

**连接来源 → 发现会话目录 → 元数据分页／查找 → 按需读取正文 → 目标能力检查。**

来源直读不依赖 `Library`，也不调用 `ImportCoordinator.prepare/commit`。已有档案只作为独立兼容入口。目标创建／打开／接续尚未通过验收，当前不提供目标写入 IPC。

| 层 | 路径 | 职责 |
| --- | --- | --- |
| 桌面主进程 | `src/main/index.ts` | 窗口、顶层 frame 与 IPC 校验、系统位置选择框、档案深链路由 |
| 来源契约 | `src/core/sources.ts` | 连接状态、目录条目、查询与响应 schema；将发现、正文能力和总数状态分开 |
| 来源服务 | `src/main/source-browser.ts` | 位置授权配置、全量目录发现、分页搜索、取消、刷新、断开、正文按需读取、只读数据库门禁 |
| 安全桥 | `src/preload/index.ts` | `window.staithe.sources` 的具名方法；旧档案 API 保留；不暴露 Node、任意 IPC 或路径读写 |
| 默认界面 | `src/renderer/src/SourceApp.tsx` | 来源列表、元数据搜索、分页、连接管理、正文、能力检查与过期请求隔离 |
| 页面路由／兼容界面 | `src/renderer/src/App.tsx` | 默认 `SourceApp`，显式切换 `ArchiveApp`；旧深链进入档案入口 |
| 导入协调 | `src/main/imports.ts` | 独立兼容路径的内容识别、预览 token、确认、去重；其纯 `parseArchive` 也供来源正文投影复用 |
| 外部格式解析 | `cindy.ts`、`cindy-local.ts`、`newmax-local.ts`、`claude-code.ts`、`deepseek.ts`、`codex.ts`、`codex-zstd.ts`、`zip.ts` | 受限文本投影、资源预算、来源验证与损失报告；解析器不能自行寻找外部引用 |
| 本地档案服务 | `src/main/library.ts` | 旧档案读取、串行入库、原件与记录整体原子发布；与来源目录计数隔离 |
| 历史开发批次 | `scripts/import-local.mjs`、`src/main/local-import.ts` | 旧的显式小批量归档；不参与新的来源浏览或自动启动 |
| 本地设计系统 | `tokens.css`、`styles.css`、`components/` | 沿用原有主题、布局、图标、插画、ScrollArea、Tooltip、侧栏和模态焦点管理；来源模式不增加独立视觉样式 |

## 来源状态与计数

- `SourceConnection` 保存 `status`、`discovered`、可空 `total`、不可访问目录数 `issues` 和跳过链接数 `ignoredLinks`。
- `idle / scanning / ready / partial / cancelled / error` 不可混同。只有完成且无目录错误的扫描才能给出完整 `total`；其余均为 `null`。
- `SourceEntry` 只含标题、来源会话 ID、相对项目目录、时间与正文可读状态。renderer 获得 opaque hash ID，不能传任意路径读取。
- `SourcePage.total` 是当前查询下**已发现**的匹配条目数量，不表示正在统计来源的最终总数。UI 同时参考连接状态。
- 目录发现不调用完整解析器，不因正文不兼容而删除条目。日志头只读取前 64 KiB 的显式元数据；无标题／压缩文件退回文件名。
- 文件树分批异步遍历，数据库行每 200 条让出事件循环，直至结束而不是在旧批次上限停止。renderer 每页最多 100 条，界面默认 50；统计中不追加后续页，避免排序变化引发漏项。
- 配置支持多个独立授权位置；相同来源和规范化根路径重复连接复用授权。不做跨位置或正文语义去重，重叠来源可能出现多条。
- 刷新替换当前内存索引，取消／断开使旧扫描失效；断开也让在途正文请求失效。UI 使用请求代次防止旧正文覆盖新选择。

## 安全与无副作用读取

保留 Electron `sandbox`、`contextIsolation`、禁用 Node integration；拒绝导航、新窗口与权限请求。每个 IPC 校验发送者与主 frame，参数由严格 schema 验证。

默认调用 `pinekin:sources-auto-connect`，仅接受来源枚举；主进程的 `src/main/source-discovery.ts` 根据已验证的固定位置／CLI home 环境覆盖自动定位，同时刷新已有授权连接。只在用户点击连接时触发，不读取配置或凭据；Codex 同时处理活跃与归档目录，Cindy 仅浅层枚举两种地区目录中的 `cindy-*.db`。单个位置失败与未找到分开报告，成功位置仍返回；重复路径复用连接。

`pinekin:sources-connect` 保留为显式手动备用入口，同样仅接受来源枚举，路径必须来自主进程系统对话框。两个连接通道共用互斥锁和发送者校验，renderer 不可指定任意路径。NewMax 默认数据库位置未核实，不猜测；已授权位置可直接复用。连接授权包括范围内的隐私、分叉、归档会话元数据，折叠说明中告知；未点击连接不探测默认位置。日志中的附件、工作区、父会话路径和历史指令都不执行或跟随。

文件读取规范化授权根、不跟随符号链接；每次按需读取重新核验范围、普通文件类型及实际句柄的 dev/ino。打开前、打开后和交付前检查文件身份，避免祖先目录替换让读取逃出授权根。正文读取发现大小、mtime 或 ctime 改变时拒绝交付片段。

### SQLite 特别门禁

普通 `readOnly: true` 不能单独保证 WAL/SHM 副文件零写入，因此不得直接通过原始来源路径打开数据库：

- 当前只验证 macOS：先以只读、禁止最终符号链接的文件描述符固定来源，检查文件身份和 SQLite 头。
- **拒绝 WAL 模式以及存在 `-wal/-shm/-journal` 的库**，不自动 checkpoint、不删副文件、不把 WAL 内容忽略后称为完整读取。
- 通过固定 `/dev/fd/<fd>` 与 `mode=ro&immutable=1` 打开，附加 `query_only`、`trusted_schema=OFF` 和读取事务；结束前核验原文件身份、大小、mtime/ctime 与副文件状态，发现变化则不交付正文／完整计数。
- Windows／Linux 数据库直读尚未验证，明确拒绝；日志目录浏览不依赖该路径。
- 仅查询会话表结构、列表和选中会话消息，不复制整库、不访问设置／认证表，不运行来源 Store。ID 非法或重复导致统计失败，不能通过 Map 覆盖伪装完整。

这意味着 **处于常见 WAL 布局的 NewMax／Cindy 数据库当前可能无法连接**。这是明确的尚未支持边界，不应让用户手动删除 WAL 文件。后续需独立实现和验证可消费 WAL 的无写入读取方案或来源官方只读 API。

## 发现、阅读、接续分开声明

`SessionAdapter.capabilities`：

- `listLocal`：可在已授权位置发现元数据，不代表所有平台／数据库模式适用。
- `readLocal`：可按需投影受支持正文；NewMax、Claude Code、Codex、Harness 有受限实现，Cindy 暂为 false。
- `importArchive`：旧档案格式解析与保存能力。
- `nativeResume` / `deepLink`：外部目标恢复／打开能力，全部仍为 false。

NewMax 的数据库结构匹配不等于探测到真实安装版本；1.1.22 仅为既有白名单读取契约。官方文档有目标接口不等于 Pinekin 已完成创建、持久化回读、打开与回滚验收。当前目标弹窗仅展示门禁，不创建目标、不发送 prompt、不操作剪贴板来伪装同步。

## 持久化与兼容

- 新来源模式只保存 `userData/connections.json`（版本 1）：来源枚举、UUID、规范化根路径。串行写入、临时文件 + rename 原子替换，文件 `0600`。标题、搜索词和正文不持久化。
- 重启后连接为 `idle`，显式刷新才读来源。断开清除授权配置和该连接索引，不删除来源内容。
- 旧 `library.json` 与 `imports/<sha256>/{original.bin,record.json}` 不自动迁移、改写或删除。损坏档案和损坏连接配置分别报错。
- `staithe.session` v1/v2、`ember.session` v1 继续兼容；严格版本、字段与预算校验。v2 是文本投影，不是附件和运行态容器。
- 深链 `newmax-staithe://session/<本地ID>` / `newmax-ember://session/<本地ID>` 仅定位本机档案，自动切到兼容入口；不下载远程文件、不携带 prompt、不触发外部操作。
- Pinekin 安装身份 `ai.newmax.staithe`、默认 userData `appData/@newmax-ai/ember` 保留；开发隔离 `STAITHE_DATA_DIR` 优先，兼容 `EMBER_DATA_DIR`，打包忽略覆盖。
- 所有配置、档案都是明文；没有加密、自动脱敏、云同步或自动备份。

## 验证

单元／集成覆盖完整发现、分页、跨页搜索、损坏／超限条目、取消／刷新／断开、配置重启、链接和文件身份竞态、SQLite 无副文件、重复 ID 以及来源不修改。

组件覆盖空档案主入口、连接授权、未连接非零、正文懒读取、请求竞态、能力门禁与档案兼容。

E2E 经过真实 Electron、preload、IPC、系统对话框替身与隔离文件；新增空库来源流程，原档案 E2E 显式进入兼容入口继续验证。后台窗口从创建起隐藏、不聚焦，监听 show/focus 事件；不用真实聊天、客户端凭据或目标写入测试。

覆盖率阈值仍为 80%，新增 `source-browser.ts` 纳入覆盖范围。来源端验证不能作为目标接续的验证证明。
