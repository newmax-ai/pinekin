# NewMax 正式本机接续

更新：2026-10-20。此适配使用 NewMax 提供的 `newmax.native-transfer` v1，不直接写 NewMax 数据库，不以复制粘贴、内部 IPC 或开发 CDP 代替正式接口。

## 使用路径与能力边界

在来源会话选择「更多 → 原生历史迁移（高级）→ NewMax」，再选 NewMax 已有工作区，或选「独立会话继续」。默认「在其他 App 继续」使用[通用上下文交接](context-handoff.md)，不调用本页协议，不要求目标支持原生创建。独立会话放在 NewMax 已有默认工作区，不创建 Codex 式空目录。没有默认工作区时明确报错，需选择已有工作区；不猜当前标签或静默改目的地。

需要加载了该协议的 NewMax 版本，并在同一 OS 用户下运行。Pinekin 自动采用已授权目标位置，其次使用自身继承的 `NEWMAX_USER_DATA_DIR` 或标准 `~/.newmax`；只探测该数据根的私有描述文件，不扫描其它副本。自定义位置通过「更多 → 接续目标设置 → NewMax → 使用自定义位置」选择。

当前 macOS / Linux 注册客户端，Windows 未支持。Linux GUI、正式发行包、主 dev 实际按钮和用户下一轮模型调用均须独立验收，不能从 socket/SQLite 测试外推。

## 实现

- `src/main/newmax-target.ts`：严格的正式协议客户端、授权候选、工作区令牌、幂等索引与回执。
- `src/main/newmax-target-adapter.ts`：接入 `NativeTargetAdapter`，复用 `SourceBrowser.transfer()` 的完整来源读取；提交前后复核 sender、来源连接与快照。
- `src/main/native-targets.ts` / `native-targets-ipc.ts`：按目标分发，并提供 `rollbackTargetTransfer(target, receipt)`，不将 NewMax 回执交给旧 Codex 回滚通道。
- 目标能力 `destinationKind:workspace` 使界面使用已有工作区说明，不显示任意文件夹入口。主进程仍拒绝未知、过期、跨来源或跨实例的令牌。

Pinekin 生产代码不 import NewMax 源码；跨项目修改只在本次明确授权的 `/Users/jaylee/Documents/GitHub/newmax-client` 中增加目标正式协议，不扩大为其它项目写入授权。

## 安全事务

1. 读取 `0600` 的 `native-transfer.json`，验证同用户所有者、私有 socket/目录权限、规范化数据根、实例 ID、协议 v1、应用版本与完整能力集；不接受 TCP、任意 URL 或命令。
2. 只上传完整可读取 user/assistant 文字；32 MiB / 100000 条上限，传输封装另限 64 MiB，超限不截断。系统、工具、附件、原生 session、权限、Skill、原模型与运行态不迁移。
3. NewMax 用真实临时 SQLite / JSONL 做隔离预演并重开回读，不调用模型、执行工具或沿历史路径复制附件。Pinekin 比对角色、原文摘要与条数。
4. Pinekin 再次复核来源及同一目标实例；NewMax 用宿主 SQLite `backup()` 创建一致性快照，提交前复核工作区与有效期。
5. NewMax 新 UUID 对话、文字与回执在同一 SQL 事务中写入，JSONL 同步发布并比较摘要。不覆盖既有会话。
6. Pinekin 再回读回执及摘要后请求正式定位；NewMax 只有收到目标原窗口对工作区、活动会话及已加载历史的精确确认，才返回 opened:true。超时或未确认保留已创建结果。

这属于**文本历史重建**；新会话没有原 App session，下一次由用户主动发送，沿 NewMax 的历史重建路径接续，不保证原生运行时无损迁移。

## 持久化、重试与回滚

Pinekin 自己的 userData 下保存：

- `newmax-target.json`：授权数据根；不保存端点令牌或账号凭据。
- `newmax-transfers/<sha256>.json`：源 ID、快照、文本、目标根及目的地形成的索引，只保存 requestId/摘要键/目标根，不保存历史正文。
- `newmax-transfer-receipts/<UUID>.json`：本次正式回执定位信息。

索引在提交前保存，网络断线或调用超时重试复用同一 requestId。目标返回已有结果时不重复创建。工作区令牌绑定来源条目和实例、5 分钟有效；过期需刷新列表。目标应用重启后重新握手，不复用旧运行期令牌。

NewMax 自己保存新历史、SQL 事务回执及 `backups/native-transfer/` 下的**明文全库一致性备份**；它可能包含原有数据库资料，并非加密或完整附件备份，目前不自动轮转。Pinekin 不读取该备份内容。

底层按目标的回滚仅删除完整元数据和全部消息仍与创建快照相同的新会话；用户续聊、改名、改归属或创建模型 session 后拒绝删除，保留新增内容。界面仍不提供接续后撤销按钮；不能把手动删原始日志作为可靠撤销。

## 验证与未通过项

- 新增协议客户端和适配器测试，覆盖真实 Unix socket 封装、工作区、权限／协议失败关闭、来源变化、摘要不一致、幂等重试、未确认打开与具名回滚。
- 联合契约测试使用两个仓库的真实实现：临时 NewMax SQLite、正式 socket、Pinekin 客户端、目标重开、原回执重试和续聊后的回滚保护。只使用合成历史，不启动桌面或调用模型。
- Pinekin 全量：102 文件 / 1545 项通过，行覆盖率 98.35%、分支覆盖率 88.54%；类型检查与构建通过。
- NewMax 主入口、具名 preload 和渲染端确认单独测试，并执行目标仓库规定的类型与回归检查；完整结果在本轮交付中区分无关失败。
- 桌面 E2E 会另开 Electron，与仅复用主 dev 限制冲突，未运行。NewMax 主 dev 原有 LOAD_TIMEOUT/空页面问题与原窗口 GUI 验收分开记录；测试通过不等于实际界面或下一轮已跑通。
- 本机专项复现资产：`.newmax/outputs/newmax-transfer-contract.{test.ts,vitest.config.ts}` 与验证日志，不纳入 git。
