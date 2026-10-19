# 国内 Agent Harness 来源：WorkBuddy 与 Qwen Code

日期：2026-10-19。仅讨论**来源只读浏览**，不是目标写入、完整档案导入、运行态迁移或原生恢复。

## 本批范围

连接 App 在既有五种来源之外增加 WorkBuddy、Qwen Code；弹窗、侧栏统一使用 `browsableSources`，避免新来源只出现在连接卡片而无法筛选。原有卡片样式、small 开关和即时授权交互不变。打开弹窗不探测，开启某个开关才读取该 App 的固定位置；断开撤销授权，不删除来源。

| 来源 | 自动定位 | 手动位置 | 已实现范围 |
| --- | --- | --- | --- |
| WorkBuddy | `~/.workbuddy/projects/<project>/*.jsonl`；支持 Pinekin 继承的绝对目录 `WORKBUDDY_CONFIG_DIR` | `projects` 或单个普通项目目录 | 本地普通主会话元数据、搜索和有界问答阅读 |
| Qwen Code | `~/.qwen/projects/<project>/chats/*.jsonl`；`QWEN_RUNTIME_DIR` 优先于 `QWEN_HOME`，覆盖值须为绝对目录 | `projects`、单项目或 `chats` | 独立普通主会话的完整单根父链文本 |

环境变量只取本进程已继承的值，不读取 shell、登录、设置、认证或其他进程环境。虽然 WorkBuddy 包内 resolver 还接受 `CODEBUDDY_CONFIG_DIR`，Pinekin **不沿用独立 CodeBuddy 的变量**，避免错误归属；自定义 WorkBuddy 根使用专属变量或系统位置选择器。没有查证或接入独立 CodeBuddy，不因此展示其开关。

## WorkBuddy 一手证据

检查官方 macOS arm64 分发包，不运行下载代码、不读取本机客户端数据。证据是本次固定包的实现契约，不是公开的跨版本稳定 schema，也不是安装版本探测。

- 版本：`5.8.3.41334564-db0e9b51`，包版本 `5.8.3`，Bundle ID `com.tencent.workbuddy.mac`。
- 官方包大小：366,942,863 字节。
- SHA-256：`ecd404f16f9e9f97ada77cf8211202ceb1ecd0a86ebffe1782dfea0ac7eae626`。
- 签名静态验证通过；Team ID `FN2V63AD2J`，Tencent Technology (Shanghai) Company Limited。
- 官方归档：`https://www.workbuddy.cn/docs/workbuddy/Download-History`。
- 本次分发包：`https://acc-1258344699.cos.ap-guangzhou.myqcloud.com/workbuddy/saas/darwin-arm64/WorkBuddy-darwin-arm64-5.8.3.41334564-db0e9b51.dmg`。
- 官方更新日志：`https://www.workbuddy.cn/docs/workbuddy/Changelog`。5.8.3 发布日期 2026-10-19；2026-10-15 的包构建／签名时间不等同发布日期。

关键包内路径：

- `main/workbuddy-product-config.js`：默认产品配置根为 `.workbuddy`。
- `main/sidecar-manager.js`：把 WorkBuddy 自身 configDir 注入 sidecar 的 WorkBuddy／CodeBuddy 环境变量。
- `cli/dist/codebuddy-lite-wb.mjs`：`getHomeProjectsDir`、`getSessionFilePath`、`LocalJsonlSessionStore`、`transformItemForSaveAsync`、`deserializeSessionFromPath`、`HistoryUtils`。
- `main/server.js`：另有 `projects/cloud/user-*` 云缓存。Pinekin 不将它当作普通本地主会话。

### WorkBuddy 格式与保守边界

- 每行是明文 JSON payload，普通消息为 `type: message`、`role: user/assistant`，文本块 `input_text/output_text`。
- 使用 `id/parentId/logicalParentId`，**不使用 Claude 的 `uuid/parentUuid`**；不会因底层格式相似就借用 Claude 归属。
- 自定义标题优先于自动标题、topic，再取首条真实用户输入；`session-meta`、标题、usage 和已知事实记录不是问答。
- 只有已知消息类型进入投影；系统／开发者、工具、推理和带已知运行时标记的注入不冒充用户或助手答复。工具只计数，不读取工具输出引用或执行参数。
- 无 `parentId` 的完整旧式追加记录可读；一旦出现父链，要求普通消息与工具节点按完整单链追加。缺失父节点、循环、多分支、未知类型和结构损坏保留可重试错误，不猜测修复。
- `logicalParentId`、compact 标记、重发回退 notice、内容过滤分支、文件 ID 与运行时会话 ID 不同，均在目录发布前排除。目录不递归进入 `subagents`；`cloud` 云缓存不连接。
- 同名 `.meta.json` 只读取会话元数据白名单字段 `isForkedCompactionSession/forkedFrom/forkedAt`；侧车与行内元数据出现分叉标记都拒绝。不读 `workbuddy.db` 或凭据。
- **官方允许某些相邻重复 ID 和缺 ID 的旧记录**。本适配器暂时拒绝，不猜测其快照／追加块语义；这是额外保守限制，不声称官方禁止重复，也不把这些错误档从来源删除。
- 本轮仅核对该 macOS arm64 包；Windows/Linux、其他版本、外置附件、压缩／分叉／云会话完整性及目标恢复未验证。

## Qwen Code 一手证据

固定官方源码提交 `62c86c594fb2a0f68bf66b157e953790188cbeaa`，不使用第三方教程推测格式：

- `https://github.com/QwenLM/qwen-code/blob/62c86c594fb2a0f68bf66b157e953790188cbeaa/packages/core/src/config/storage.ts`
- `https://github.com/QwenLM/qwen-code/blob/62c86c594fb2a0f68bf66b157e953790188cbeaa/packages/core/src/services/chatRecordingService.ts`

`Storage.getRuntimeBaseDir/getProjectDir` 与 `ChatRecordingService.ensureChatsDir/getSessionFilePath` 确认 projects/chats 路径。`ChatRecord` 的 `uuid/parentUuid/sessionId/timestamp/cwd/version/type` 与 Gemini `message.role/parts` 确认独立格式。不是把 Qwen 当成 Claude Code 或 Gemini CLI 的别名。

### Qwen Code 格式与保守边界

- 普通用户为 `type: user`、`message.role: user`；助手为 `type: assistant`、`message.role: model`。
- 只投影 `parts[].text` 且 `thought !== true`。functionCall、functionResponse、inlineData、fileData 仅计数；不沿附件路径读取。
- 系统 custom_title 使用 `systemPayload.customTitle`，缺失时首问兜底；有 `subtype` 的用户通知、Agent 注入和非 real_user provenance 不作为真实提问。
- 完整检查所有节点 UUID 唯一、会话 ID 一致、父链无循环、无外部缺失节点且单根；只允许一条有效问答主链，系统元数据旁支不混入问答。
- 分叉、子会话、rewind、chat_compression、parent_session、branch_checkpoint、managed_session_* 及未知系统历史语义，在目录发布前排除。未知／损坏消息仍保留诊断。
- 仅核对上述源码契约，不代表所有安装版本、桌面壳或云托管存储均已验收；Qwen 网页聊天和 Gemini CLI 未因此获得支持。

## 读取与快照安全

实现入口：`qwen-source.ts`、`workbuddy-source.ts`、`workbuddy-metadata.ts`；复用既有 `source-log-file.ts` 与 `source-log-reader.ts` 的限流、有界扫描、严格 UTF-8、文件身份检查和授权复核。

- 目录扫描完整检查结构、归属和已知不支持边界，只保留短标识、行号、长度、标题与计数；不返回或落盘正文，不创建全文缓存。未变文件复用内存目录。
- 普通阅读两遍流式检查，只返回当前 100 条以内文本，每条最多 16,384 个 Unicode 码点；长单条可在消息内续读。
- 单行 8 MiB、轻量结构索引 32 MiB、单次工作 30 秒等现有保护不取消；压缩日志没有为这两种来源启用。
- WorkBuddy 侧车限制 64 KiB，拒绝符号链接、目录、非法 JSON／UTF-8、越权和读取中变化；指纹合入目录 revision 和正文 snapshot。新增、删除或改变侧车都会使旧片段失效，检查前后重复核验，不能把 JSONL 未变当作会话语义未变。
- `connections.json` 仍是来源浏览唯一持久化文件，版本仍为 1，只扩展来源枚举；旧连接无需迁移，断开不删除原件。
- 没有新增任意路径 IPC。仍由来源枚举、opaque entry ID、严格游标、主窗口与顶层 frame 验证控制读取。
- 本批未增加原 App 深链、目标新建或原生恢复能力；已有档案的复制与导出保持原有边界，不能根据来源可读就外推目标写入能力。

## 验证约束

测试全部使用仓库合成 JSONL、合成 sidecar 和临时隔离 home/userData，不用真实会话或凭据。新增来源测试先 RED 再实现；组件验证连接卡片、完成后侧栏筛选及断开。新增 `tests/e2e/domestic-sources.spec.ts` 提供隔离桌面流程，但按用户“仅主 dev、不另起 Electron、不扰动 Dock、不自行重启”的要求，本轮不运行该桌面用例，不以单元测试或构建冒充 GUI 验收。

本批实际验证：

- 新增来源服务测试 **42 项通过**（WorkBuddy 23、Qwen Code 19），先分别复现 23／18 项预期失败再实现；授权失效拒绝的既有保护在 Qwen RED 阶段已通过。
- Qwen 初始接入与原连接界面定向 **6 文件、121 项通过**。
- 最终共享工作区完整覆盖率 **88 文件、1,237 项通过**；行 **98.43%**、分支 **88.22%**、语句 **93.54%**、函数 **95.64%**。其中三个新增模块分支均达到 80% 或以上。该结果包含共享工作区的其他既有／并行任务测试，不把它们称为本批新增测试。
- `npm run typecheck`、`npm run build`（含类型检查）与 `git diff --check` 通过。构建不会启动桌面实例；未运行 `npm run test:e2e`、未自行重启主 dev、未扫描真实客户端数据，未宣称当前运行主进程已加载新适配器。
