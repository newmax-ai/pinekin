# 来源直读改造与验证

日期：2026-10-18。代码基线：`1b8d2d9` 之后的未提交改动。

## 完成范围与未完成范围

本批将默认入口从“本地档案 → 导出”改为“连接来源 → 浏览／查找目录 → 按需读取 → 检查目标能力”。来源服务完全不依赖档案库，旧档案保留在独立兼容入口。

**未完成用户所期望的全部链路：目标自动创建、打开与继续仍未启用；活跃 WAL 数据库无法安全直读；Cindy 仅提供受限目录能力。** 不把这批称为已完成“一键跨 App 同步”。

本批没有扫描真实客户端会话目录、读取凭据、修改真实客户端数据库或重新导入真实会话。自动验证只使用本仓库构造的合成日志、合成数据库和隔离 userData。

## IPC 契约

具名桥：`window.staithe.sources`。每个通道同时检查发送窗口和顶层 frame。

| 方法 | 通道 | 校验与行为 |
| --- | --- | --- |
| `connections()` | `pinekin:sources-connections` | 仅读连接配置和内存状态，不触发来源扫描 |
| `autoConnect(source)` | `pinekin:sources-auto-connect` | 默认入口；来源枚举，主进程定位固定会话位置并复用已有连接；返回 `{ connections, warnings }`，不打开文件选择器，不接受 renderer 路径 |
| `connect(source)` | `pinekin:sources-connect` | 显式备用入口；系统对话框选择根，不接受 renderer 路径；用户确认位置后保存授权并开始遍历 |
| `refresh(id)` | `pinekin:sources-refresh` | UUID；取消旧代次，清空该来源内存目录并重新遍历 |
| `cancel(id)` | `pinekin:sources-cancel` | UUID；扫描失效，保留已发现目录，`total=null` |
| `disconnect(id)` | `pinekin:sources-disconnect` | UUID；串行移除持久化授权，撤销读取并清空索引，不删除来源 |
| `page(query)` | `pinekin:sources-page` | strictObject；可选来源／连接 ID，查询 ≤200 字，offset ≥0，limit 1–100；返回已发现元数据 |
| `read(id)` | `pinekin:sources-read` | 64 位十六进制 opaque ID；只从当前索引映射路径，完整解析并返回文本和损失说明，不归档 |

正文预算沿用既有解析器：输入 5 MiB，压缩展开与窗口另有预算，未知布局明确拒绝。读取失败更新条目可读状态，不将条目删除。

## 自动定位（2026-10-18）

新增 `src/main/source-discovery.ts`，默认交互是「选 App → 连接」。打开弹窗或切换 App 不触发探测；点击后才授权固定来源入口的只读发现，不递归搜索主目录，不读取认证／配置文件，不启动客户端。主进程通过 Electron 提供 home / appData；CLI 环境覆盖只使用 Pinekin 进程实际继承的变量，不读取 shell 配置、不猜测另一个进程的启动环境。

| 来源 | 自动定位入口 | 明确边界 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects`，或 `$CLAUDE_CONFIG_DIR/projects` | 递归覆盖项目子目录；环境根必须是绝对路径 |
| Codex | `~/.codex/sessions` 与 `~/.codex/archived_sessions`，支持 `$CODEX_HOME` | 两个位置都检查，不在找到第一个后停止；环境根必须是绝对路径 |
| DeepSeek Harness | `~/.dsh/sessions`，支持 `$DSH_HOME` | 空白覆盖按未设置，支持 `~` 展开；另行配置的 persistence root 需要自定义位置；自动找到不扩大 v4 正文兼容范围 |
| Cindy | 系统 appData 下 `Cindy` 与 `CindyGlobal` 中的 `cindy-*.db` | 仅浅层枚举普通文件／链接后校验，不读设置、令牌、备份或其他数据库；所有账号库均会尝试连接；SQLite 门禁与正文限制不变 |
| NewMax | 复用之前已授权的数据库位置 | 默认数据库精确位置未验证，不能由示例 `newmax.db` 或 `~/.newmax/logs` 推断；首次自动定位未支持 |

所有来源都复用已有授权位置（包含自定义位置），重启后再次点连接即可刷新，不要求重复选择文件。发现同一规范化路径复用连接 ID，不增加条目。默认候选存在符号链接或经过链接时拒绝自动读取；自定义位置只能通过主进程对话框明确选定。权限失败与未找到区分，单点失败以 warnings 返回，不吞掉已连接位置；异步探测后、每个连接前再次核验发送者。`autoConnect` 返回连接不等于后台扫描已经成功，数据库 WAL／结构问题仍通过连接状态显示。

界面在未找到时保留弹窗和重试能力，才显示「手动指定位置」；高级自定义入口一直收在折叠说明内。连接期间禁用来源切换与重复提交。主布局、样式和关闭按钮初始焦点修复均保留。NewMax 未支持首次自动定位、Cindy 仅受限列表简短明示，不用通用成功文案掩盖。

路径证据（2026-10-18 核验的公开上游，不代表安装版本探测）：

- Claude Code：`https://code.claude.com/docs/en/sessions#session-storage` 与 `https://code.claude.com/docs/en/env-vars`。
- Codex 固定 `rust-v0.163.0`：`https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/utils/home-dir/src/lib.rs`；`https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/rollout/src/lib.rs`。
- DeepSeek 固定 `687f282e8625c6b8d11ff58211a90524be2e4317`：`https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/base/cordis.patch.yml`；同提交 `packages/util/home-paths/src/index.ts` 与 `packages/session/session-persistence-jsonl/README.md`。
- Cindy 固定 `77e2c32d0b028920116bfac744a04c6b6876257a`：`https://github.com/makecindy/cindy/blob/77e2c32d0b028920116bfac744a04c6b6876257a/packages/maker-shared/src/brandIdentity.ts`；同提交 `apps/desktop/src/main/localDb/modelDefaultsProfile.ts` 与 `apps/desktop/src/main/devCliFlags.ts`。打包版不按开发环境变量 `XDT_USER_DATA_DIR` 探测。
- NewMax：仓库既有验证文档只有显式输入的示例，内置帮助未说明数据库默认位置，因此不猜测、不扫描真实用户目录来补证据。

## 总数的含义

- 不连接时显示“未连接”，不是 `0`。
- 连接配置恢复但未刷新时显示“待刷新”，不自动扫描真实数据。
- 统计中显示已发现数量；只有 `ready` 才给出完整 `total`。
- 无权限子目录、取消和失败保持 `total=null`，管理连接中显示原因与未访问／链接计数。
- 目录包含全部授权范围内的匹配文件／会话行，正文不支持不影响发现。无 10／50 条发现上限，每页默认 50 条只是显示分页。
- 同一来源根重复连接复用连接；多个位置的条目不做语义合并。此数量不是账户云端总量，也不是独立逻辑线程的跨文件去重总量。
- 搜索覆盖全部已发现标题、相对项目目录、来源 ID。日志仅读取前 64 KiB 的显式元数据；无标题／压缩文件显示文件名。未实现全文搜索或持久化正文索引。

## 数据落地范围

仅 `connections.json` 保存 `{ version: 1, connections: [{ id, source, path }] }`。原子替换、串行修改、配置损坏停止而不覆盖。标题、消息、搜索词不写入该文件。

正文通过纯解析器投影，返回 session 的 UI ID 是目录 opaque ID，**没有 `archive` 归档记录**。解析器警告里的“原件”指来源自身文件，Pinekin 未复制它。

旧 `Library`、导入 preview/confirm/cancel、导出与剪贴板 API 不改；只是从默认入口移到“已有档案”。旧深链切换到该入口，保留兼容。

## 文件与 SQLite 安全补强

1. 不跟随符号链接；授权根只规范化一次，访问前再次核验范围。
2. 普通日志打开前后对照 dev/ino，交付前再验证路径身份；正文中途变化则拒绝。合成竞态测试确认打开到外部不同 inode 时，在 `read` 前即拒绝。
3. 不能仅依赖 SQLite `readOnly` 来宣称无写入：WAL/SHM 仍存在副文件维护风险。
4. 当前仅 macOS 验证固定只读 fd 与 SQLite `file:/dev/fd/<fd>?mode=ro&immutable=1`；只允许非 WAL、无事务副文件的库，结束时再验证身份／时间／大小与副文件。Node 和 Electron 两种运行时均有合成回归。
5. WAL、事务副文件和其他平台数据库路径 fail closed。不会忽略 WAL、自动 checkpoint 或删除副文件。**不要要求用户手动删除 WAL/SHM。** 该门禁确实会限制当前 NewMax／Cindy 真实活跃数据库的可用性。
6. 数据库 ID 必须是非空、有限长度字符串且唯一；重复 ID 停止扫描，不能静默 Map 覆盖后报完整总数。

## 目标接续状态

没有新增目标写入 IPC、启动命令、自动发送或“复制即成功”的替代按钮。目标面板逐目标显示未支持。

只读调查发现 Codex 官方 app-server 的 `thread/inject_items` 是后续候选，可与 `thread/start` 配合注入模型可见历史，不能直接当作已通过 Pinekin 的 UI／持久化／恢复测试。正式启用前仍需：固定版本、无模型请求的隔离验证、预演、备份、冲突与幂等、回读、回滚、按返回 ID 安全打开等待输入。

官方入口供后续核查：

- Codex app-server：`https://developers.openai.com/codex/app-server`
- Codex CLI：`https://developers.openai.com/codex/cli/reference`
- 固定发布版上游注入测试：`https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/tests/suite/v2/thread_inject_items.rs`

其余目标的既有会话 resume/fork、内部复制和自动执行任务入口，均不足以证明跨 App 任意历史静默创建与打开链路。不能伪造日志或猜测数据库写法补齐。

## 验证结果

遵循先写测试再实现：来源服务首次缺失模块失败；新主入口 8 项首次失败；能力矩阵 2 项首次失败；安全补强先复现 inode、WAL 和重复 ID 问题，再修复。全部使用合成数据。

- 最终单元／集成／组件：**25 文件、300 项通过**。
- 最终覆盖率：行 **97.20%**、语句 **90.84%**、分支 **85.46%**、函数 **89.70%**；全局 80% 门槛通过，新增来源服务纳入覆盖范围。不是逐文件 80% 或全仓覆盖率声明。
- `npm run typecheck` 通过。
- `npm run build` 通过（含 TypeScript 检查）。
- 全量 E2E 首跑 **34 通过、6 失败**：旧兼容测试在重载／Windows 模拟窗口未重新切到档案、键盘操作时机，以及新按钮无障碍名称空格匹配问题。
- 修正上述测试适配，并新增 Electron SQLite 门禁测试后，**定向 7 / 7 通过**（6 个失败项 + 1 个新用例）。复用此前其他 34 项通过证据，覆盖当前 41 个桌面用例；没有把定向复测描述成重新跑过一遍全量绿色。
- 来源 E2E 验证：空档案库、66 条发现／50 条首屏／追加分页、跨页搜索、按需正文、无 library/imports 落盘、重启仅位置授权、增删刷新、损坏保留、断开不删来源、IPC 非法输入、SQLite 无副文件与 WAL 明确拒绝、目标写入按钮禁用。
- 所有 E2E 隔离 userData、替换选择框与剪贴板，窗口创建起隐藏，原生 show/focus 事件为空；未打开真实目标客户端。

本轮未提交 Git。来源端验收不等于真实目标接续已经完成。

### 自动定位增量验收

- TDD：先复现模块缺失及 11 个界面失败，再实现；DeepSeek／Cindy 路径新增 3 项失败后补齐，保留未支持 NewMax 首次定位的真实状态。
- 最终单元／集成／组件：**27 文件、332 项全部通过**，包含 13 项隔离自动定位测试。覆盖默认位置、CLI home 覆盖、Codex 双目录、Cindy 两种地区／多账号白名单、重复连接、已有自定义授权复用、未找到、权限失败、链接拒绝、非法来源和调用方失效。
- 全局覆盖率：行 **97.48%**、语句 **91.45%**、分支 **87.19%**、函数 **90.52%**；新增 `source-discovery.ts` 纳入覆盖率，80% 门槛通过。
- 类型检查和构建通过；完整后台桌面 **45 / 45 通过**。自动连接测试断言系统选择框调用次数为 0；手动备用入口仍使用对话框替身。
- 来源 E2E 同时隔离 home、appData、userData，并清除 Claude / Codex home 环境覆盖；不扫描真实来源、不读取凭据、无前台 show/focus。截图：`test-results/pinekin-connect-auto.png`（不提交）。
- 本轮没有更改既有 WAL 读取、正文格式或目标接续门禁，也没有将自动找到路径等同于正文可读或迁移成功。
