# 已连接 App 的原生接续目标

更新：2026-10-21。

## 要求与当前完成边界

本页仅描述「更多 → 原生历史迁移（高级）」。默认「在其他 App 继续」已改为独立的[通用上下文交接](context-handoff.md)，所有已连接目标可准备文本，不再以原生创建为前提。高级入口仍必须真实创建并核验历史，不能用复制、导出或仅唤起应用冒充原生迁移；两条路径不自动互相回退。

**通用目标机制及 Codex、NewMax 独立适配已实现，但没有完成全部 App 的接续，也没有据此宣称 NewMax GUI 与下一轮模型调用已验收。** NewMax 需要提供 `newmax.native-transfer` v1 正式接口的目标版本；macOS / Linux 注册，Windows 暂不支持。按用户选择，仅移除未接通 App 的迁移入口：Claude Code、Cindy、DeepSeek Harness、WorkBuddy、Qwen Code 不再列出灰色占位和缺口说明，但来源连接与读取保持不变。缺口保留在本文研究表中，不能将暂未接通断言为上游永远不可能实现。

## 目标发现与安全分发

- `NativeTargets.list()` 仅枚举已注册适配器，不再读取或依赖来源连接列表。不会扫描应用目录、读取会话正文或凭据、新建来源连接。
- macOS 保留 Codex／NewMax，Linux 保留 NewMax，Windows 返回空列表；目标是否展示与其是否连接为来源无关。
- 目标列表由主进程生成，返回 `implemented:true` 与运行时 `available`，分别表示已注册适配和配置检查可用；一个适配器的配置检查失败仍保留该目标和具体原因，显示「暂不可用」，不冒充未配置成功。
- `implemented` 为向后兼容可选字段。renderer 接收旧主进程列表时，只保留显式可用项及既有 Codex／NewMax 适配的故障提示；显式 `implemented:false` 始终隐藏。过滤不提高 `available` 权限，不改变主进程创建门禁。渲染层可热更新，主进程列表收紧在下一次获准重启后生效，本轮不自行重启。
- 未注册目标在主进程拒绝所有识别、配置、项目选择和创建操作；renderer 隐藏或禁用不是唯一门禁。不会回退 Codex、复制文本、执行恢复命令或直接写外部数据库。
- 通用接口按目标 ID 分发给独立适配器。Codex 的新旧接口复用同一实现，保留项目令牌、完整来源读取、快照重验、备份、隔离预演、幂等与回滚。
- renderer 新桥不完整时明确要求更新主实例，不能混用新旧接口。旧 preload 只兼容原有 Codex 路径，不允许将其他目标交给 Codex 创建。
- 切换目标清空目标预览、错误和项目选择；项目列表按目标重新挂载，迟到的旧列表不会显示或提供旧令牌。

## 具名 preload / IPC

所有通道只接受主窗口顶层 frame。注册表严格校验 App 枚举、64 位来源 opaque ID、UUID 令牌、设置模式及严格的继续位置对象，不接受任意路径、URL、命令或 renderer 提交的历史。异步动作前后检查发送者，适配器同时接收门禁供提交前复核。

| preload 方法 | IPC 后缀（前缀 `pinekin:source-actions-`） | 参数 |
| --- | --- | --- |
| `inspectTarget` | `inspect-target` | 目标 ID，设置模式（默认 automatic） |
| `configureTarget` | `configure-target` | 目标 ID，主进程候选 UUID |
| `listTargetProjects` | `list-target-projects` | 目标 ID，来源 opaque ID |
| `chooseTargetProject` | `choose-target-project` | 目标 ID，来源 opaque ID，可选项目列表 UUID |
| `continueInTarget` | `continue-target` | 来源 opaque ID，目标 ID，显式 standalone 或 project 令牌 |
| `rollbackTargetTransfer` | `rollback-target` | 目标 ID，事务回执 UUID；按目标的完整性门禁执行底层回滚 |

旧 Codex 具名接口保留兼容；不会新增通用 shell、路径写入、内部客户端 IPC 或开发 CDP 接口。

## 逐 App 缺口（仓库证据，不是最新上游能力承诺）

| App | 当前可复用的证据 | 尚未接通的目标链路 |
| --- | --- | --- |
| Codex | 已有日志序列化、隔离程序回读与事务适配 | 真实桌面展示、项目归属与下一轮接续仍按既有文档分别验收；不能用本次 mock 回归替代 |
| NewMax | 已实现正式 v1 本机协议适配；目标自己完成真实隔离预演、备份、创建、回读、幂等和受保护回滚；已有工作区选择 | 主 dev GUI、下一轮模型调用、Linux 桌面及正式安装包分别待验收；Windows 未支持。见 [专项边界](newmax-target.md) |
| Claude Code | 既有 JSONL 来源读取与原生 resume 的历史调研 | 安全生成跨 App 历史、版本与隔离加载验证、持久化回读及指定会话启动 |
| Cindy | 分享包格式解析；上游预检、导入、冲突与回滚的历史研究 | 生成官方可接收的包、正式调用目标导入事务、回读和新会话定位 |
| DeepSeek Harness | v4 来源投影；既有日志 resume/fork 的历史调研 | 新建外部历史、隔离加载与回读、指定会话启动 |
| WorkBuddy | 固定官方分发包的本地日志读取契约 | 外部导入、新会话创建、回读及定位接口 |
| Qwen Code | 固定官方源码的 ChatRecord 读取契约 | 外部历史创建、安装版本探测、隔离加载与回读、指定会话启动 |

以上缺口表示 Pinekin 当前没有实现并验证对应目标，不表示断言所有上游当前版本都没有相关能力。来源解析器不能反向当成目标保存器，恢复已有会话的命令不能直接证明能创建任意外部历史。

继续实现每个目标之前，须先确认该版本的正式接口或可靠格式契约，并补齐版本探测、备份、无模型执行的隔离预演、冲突与幂等、回读和回滚。不得耦合修改 NewMax 主仓库；若确需目标端新增接口，需要另行取得跨项目授权并明确目标路径。

现有证据见 [目标能力](target-capabilities.md)、[已有研究](research/harness-landscape-2026-10-16.md)、[Cindy 分享包研究](research/integration-proposal-2026-10-16.md)、[国内来源契约](domestic-sources.md)。这些历史研究不代替后续目标版本的实际验证。

## 验证边界

- 回归仅用合成来源、适配器替身和本项目已有的生产 Codex 安全链路依赖替身；非 Codex 的成功分发测试只证明注册与 UI 不写死 Codex，不证明对应 App 已接通。
- 覆盖所有七种连接枚举、去重、断开、配置失败、未适配拒绝、参数与发送者校验、跨目标分发、新旧桥兼容、项目令牌与来源快照、旧项目列表迟到。
- 桌面 E2E 断言同步，但不自动启动额外 Electron 实例，也不自行重启或聚焦主 dev。新主进程和 preload 需在用户授权的主实例重启后加载；本轮不执行该重启。

### 本批验证（2026-10-20）

- 相关单元、IPC 与组件回归：5 文件、108 项通过。
- `npm run typecheck` 通过。
- 更新覆盖率清单纳入新注册表和 IPC 后，`npm run test:coverage`：100 文件、1535 项通过；行覆盖率 98.60%，分支覆盖率 89.00%。首轮曾出现无关图标文件比较超时，独立 15 项复跑及最终全量均通过，未修改图标测试或超时设置。
- `npm run build` 通过；只构建，不启动或重启应用。
- `npm run test:e2e` 未运行：会启动额外 Electron 实例，与只复用主 dev 的用户限制冲突。真实客户端创建、打开及下一轮验收未执行；不把合成回归当作这些项目通过。
- 本地验证日志：`.newmax/outputs/native-targets-{focused,typecheck,coverage,build}.log`，不纳入提交。
