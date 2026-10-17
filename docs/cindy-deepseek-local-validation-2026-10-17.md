# Cindy 与 DeepSeek Harness：本地接入和更新核验

日期：2026-10-17。范围：用户明确授权读取本机两个应用的真实会话，并保存副本到 Pinekin 供查看。不是自动扫描功能上线，也不是原生会话恢复。

## 安装版本与日志版本分开记录

- DeepSeek Harness：调查开始时为 `0.2.0-rc.2`；用户更新后重新核对 `Info.plist` 和 `app.asar/package.json`，均为 **`0.2.1-rc.1`**。
- 新版内置 `@deepseek-ai/dsh-session` 仍声明 `SESSION_FORMAT_VERSION = 4`；持久化包默认使用 `.jsonl.zstd`。
- 本机 3 份现有日志均为 v4，非继承、委派深度为 0、序号从 0 连续且仅有 append 表面操作。读取成功不证明它们全部由新版创建，也不等于覆盖全部新版行为。
- Cindy：`0.1.97`。只读数据库结构及安装包中的读取逻辑，不运行上游脚本、不读取认证配置。

## 真实数据核验与交付

| 来源 | 核验并保存的会话 | 可展示用户/助手消息 | 保存形式 |
| --- | ---: | ---: | --- |
| DeepSeek Harness | 3 | 7（3 / 2 / 2） | 精确压缩原件 + 文本投影 |
| Cindy | 3 | 24（15 / 6 / 3） | 会话字段白名单快照 + 文本投影 |

Cindy 共发现 5 段会话；本批排除 bot 和分叉边界，共 2 段。仅接收 `source=desktop`、active/archived、无父会话、非远程、非 Orca，且不属于协同 worker/lead 的普通会话。

六份副本已通过现有 `ImportCoordinator.prepare/commit` 流程入库；首次导入均非重复，重新读取本地库确认 Cindy 3 段、DeepSeek 3 段。默认位置为系统 `appData/@newmax-ai/ember/imports/<sha256>/`，沿用已有存储身份。它们不在 Git 工作区，不受代码 Review/撤销管理。

用户可以在当前开发窗口点击「已导入」，或通过 Cindy / DeepSeek 来源筛选查看。原来的 3 段演示数据未删除。

## DeepSeek Harness v4 映射

实现：`src/main/deepseek.ts`；共享现有有界 Zstandard 解码路径。

- 严格校验 v4 header、`isSeeded=false`、`delegationDepth=0`；未知 header 字段、父会话和子会话边界拒绝。
- 所有事件序号须从 0 连续，不能只导入部分尾部并宣称完整。
- 仅 `user/message` 且 `source.kind=user` 的文本进入正文；运行时上下文和技能目录不冒充用户输入。
- 助手只取 `assistant/message.data.message.content` 的 text 块；不复制流式轨迹、推理或工具状态。
- `session/title` 使用最后记录值；缺失时取首条用户文本。保留来源 ID、日志格式版本和事件更新时间。
- 表面替换、损坏/截断内容、未知格式、空文本会话拒绝。支持的是有限文本投影，不重放运行时。
- 输入和展开上限各 5 MiB，解码窗口上限 8 MiB，最多 50,000 行；限制不是上游产品上限。
- 原始压缩日志可能含路径、工具输入及敏感信息，明文保存在本机，不随文本交接导出。

**DeepSeek 网页聊天导出仍未支持。** Harness 日志不能用来推断网页聊天的导出格式或回导能力。

## Cindy 本地快照契约

实现：`src/main/cindy-local.ts`。这是 Pinekin 自有的内部快照，不是 Cindy 官方分享包，也不直接接受任意 SQLite 数据库文件。

```text
format: pinekin.cindy-local-snapshot
version: 1
sourceVersion: 0.1.97
session: id/title/source/status/createdAt/updatedAt/
         parentSessionId/remoteHostId/orcaRole/clearedAt
messages: id/role/content/createdAt/rewindAt[]
```

- 开发核验使用只读 SQLite 连接和同一读取事务，仅读取上列字段。协同表仅用于排除 worker/lead；不读配置、认证、账户或凭据表。
- 消息查询按 `created_at ASC, rowid ASC`，保持 Cindy 桌面顺序；同时间戳不能改按消息 ID 排序。
- 解析器验证时间单调、ID 唯一。已回退消息和清空时间以前的消息不进入当前正文，但仍保存在选定字段快照中。
- user 内容是 JSON 对象时仅取 `text`；JSON 字符串解码，普通文本保持原样；未知对象报告并跳过，不把文件路径拼入正文。
- thinking、工具调用/结果及引擎切换不进入正文；不沿附件或原生日志路径读取其他文件。
- 原始数据库、完整消息元数据、底层 harness 转录、附件文件均不复制。本地快照不可当作数据库完整备份。
- 快照版本和 sourceVersion 是输入声明，不是来源认证。产品仍没有数据库连接、自动扫描或同步入口。

## 自动验证（仅合成数据）

- 先确认 Cindy 未接通时 4 项相关测试失败，再实现路由；能力矩阵先确认 1 项失败，再更新声明。
- 最小适配/导入回归：45 项通过；能力矩阵回归 11 项通过。
- 最终单元/集成/组件：**162 项通过**；行覆盖率 **99.31%**，分支 **92.24%**。
- `npm run typecheck`、构建通过。
- 完整后台桌面 E2E：**29 项通过**，包含 DeepSeek `.zstd` 选择框、压缩解码、Cindy 本地快照、预览确认、精确原件保存、重复定位及重启读取。
- 能力矩阵收尾后重新构建，两个新增来源的桌面定向回归再次通过；未重复运行无关的全套 E2E。
- 后台测试始终使用隔离 userData 与合成文件；原生 show/focus 事件为空、窗口不可见且未聚焦；不使用真实聊天跑测试或截图。
- 主 dev 已按用户约定补启动，清除测试隐藏和数据目录覆盖，使用正常本地档案目录。

本机真实数据只做用户授权的核验和实际归档，不作为自动测试夹具，也不把正文、标题、真实会话 ID 或数据库副本写入项目文档。

## 后续边界

仍未支持：Cindy 分叉谱系、bot/协同/远程会话、附件补全、DeepSeek 继承/表面替换、超限大日志、自动同步、原生恢复。Cindy 数据库快照成功不能替代 `.cshare` 官方导出包的真实验收。
