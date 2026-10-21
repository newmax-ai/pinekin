# 原会话打开与跨 App 接续

更新：2026-10-20。源码实现、官方程序契约验证、OS 打开请求与真实桌面展示分别记录，不互相冒充。

## 默认路径：通用上下文交接

「复制接续文件」不再列出或选择目标 App，一次点击生成完整可读历史的通用 Markdown 并复制文件本身，保留来源快照、角色、原文及读取说明。没有默认启动、目标连接或原生 API 前提；「更多 → 保存接续文件」可显式导出后手动添加。macOS 文件剪贴板已实现，Windows／Linux 暂未支持；不把文件已复制当作目标已接收。文件格式、新的具名 IPC、权限及副本保留预算见 [通用接续文件](context-handoff.md)。真实跨 App 附件粘贴与模型接续效果尚待单独验收。

## 高级路径：原生历史迁移

原通用注册表保留在更多菜单。自 2026-10-21 起仅列出当前平台已注册原生适配的目标，不再把已连接来源作为迁移目标占位；未适配 App 的卡片和未支持说明已移除，主进程仍拒绝其原生创建。已实现目标配置故障保留具体原因，不能把默认文本交接冒充这条路径成功。

当前已注册 macOS Codex 和需要正式接口的 NewMax（macOS / Linux）；NewMax 的正常运行下会话定位在 2026-10-20 现场验收中仍不稳定，完整接续未通过。其它目标原生链路未完成，不影响默认文本交接。详见 [原生目标](native-targets.md) 和 [NewMax 专项](newmax-target.md)。

以下项目选择、备份、原生发布与协议说明均属于高级路径，不是默认交接的前提。

- **更多 → 原生历史迁移（高级）→ 点击目标卡片 → 点选已有项目**：Codex 使用下述本地项目语义。NewMax 已实现正式协议适配，使用已有工作区或默认工作区，不提供任意文件夹入口，见 [NewMax 专项](newmax-target.md)。选定 App 后列出真实保存的本地项目名称和目录，支持搜索、刷新、点选即接续；只读取列表不创建。保留「独立会话继续」，「选择其他文件夹」才打开系统目录选择器，取消不配置、不创建。打开目标面板本身不读取项目列表，只有选定 Codex 后读取固定项目元数据。
- **在原 App 打开**：保留 NewMax／Codex 既有会话的白名单深链，不创建副本。
- **更多 → 接续目标设置**：调整 App 安装／数据位置，与项目目录区分。正常接续不要求用户确认这些内部位置，不恢复「连接并继续」按钮。复制／导出仍是独立辅助操作。
- 结果区区分「已创建并核验、已请求打开」与「已创建但未能打开」。同一来源快照、同一项目重试复用已创建会话；不提供「撤销接续」入口。目标 App 打开后可能更新会话文件，无法仅靠删除原日志可靠撤回；不绕过散列保护或删除新增内容。

当前只承接**普通主会话的完整可读取 user/assistant 文本**，不是完整原生会话恢复。附件、推理、工具事件、权限、分支树、模型配置、原工作区和运行状态不迁移；项目需本次明确选择，不能从来源路径推断。用户已确认原有独立会话接续接通；新增项目归属的桌面展示及下一轮对话仍待实机验收。

## 自动识别与项目选择

- 应用位置来自系统协议关联，不递归搜索 Applications 或磁盘。数据位置优先复用已授权配置，其次使用当前 Pinekin 进程的绝对 `CODEX_HOME`，否则采用标准 `~/.codex`；不读取 Codex 配置、账户或凭据。自定义数据位置仍在设置中调整。
- 用户选择独立会话或项目后，后台自动识别系统关联、完成必要配置、读取完整文本、离线预演、创建、回读与请求打开。已连接位置不重复配置；首次也不要求确认 App 安装或数据路径。
- **项目不是数据存储目录**：项目目录成为新会话的 `session_meta.cwd`；独立会话使用 Pinekin 创建的空工作目录。不自动继承源工作区，不读取或迁移项目 AGENTS、文件、权限或工具状态，不自动发送消息；之后用户在 Codex 继续时，由目标处理该项目环境。
- 项目来自主进程核验的已有项目列表，或系统目录选择器；不允许 renderer 传任意路径。现有列表直接读取受支持的 `local-projects` 元数据，旧根、信任目录及历史 cwd 不作为替代；多根、空根、共享目录等项标注限制，不猜原生项目归属。点选时复核同一数据根及项目仍存在，选择令牌绑定来源 ID、目录真实路径及 dev/ino，5 分钟有效。进入事务后继续检查目录身份，不回退独立会话。格式证据、原生 projectId 指派边界及本批验证见 [已有项目列表](codex-project-catalog.md)。
- 项目失败后可在同一项目重试，或明确更换项目／改选独立会话；过期令牌必须重新选择。未选位置就关闭不产生写入；保存目标设置也不创建会话。
- 主进程原有目标配置候选、版本探测、发送者校验、备份与回滚保持。隔离预演不授予项目文件读取权限；项目模式必须由目标实际回读确认相同 `cwd`，不能仅比较文字就认为项目适配成功。
- 在途防重复点击；项目选择、识别和配置返回后均检查当前会话及请求代次，迟到结果不会创建旧会话。旧 preload 缺少项目接口时要求重启，防止忽略新参数后静默创建独立会话。
- 错误展示去掉内部 IPC 英文包装；来源变化或项目令牌错误提示直接重试／重选，不误导用户改 App 数据位置。
- **来源快照修复（2026-10-19）**：NewMax／Cindy 的快照校验为所选会话状态与完整文本摘要，同库其他会话写入或 WAL checkpoint 不误报；真正的正文和边界变化仍拒绝。

### 项目接续验证（2026-10-19）

- 相关 69 项合成回归通过：独立／项目选择、取消、迟到结果、令牌与目录替换、跨项目去重、回读 cwd、撤销保留项目文件。
- 全量 82 文件、1141 项通过，行覆盖率 98.40%、分支 88.35%；类型检查与构建通过。
- 安装包内 Codex CLI 的完整隔离副本已通过生产事务契约，包含项目 cwd 实际回读、同项目复用、独立会话隔离及撤销；不启动 GUI，不接触真实会话或凭据。日志：`.newmax/outputs/codex-project-contract.log`。
- 桌面 E2E 断言已同步，因会另开实例而未运行；不把隔离 CLI 验证当成新增项目归属的 GUI 验收。此次主进程和 preload 均有变化，需经用户授权启动主 dev 后生效。

## Codex 接续实现

### 为什么不用 `thread/inject_items`

固定官方源码 `rust-v0.163.0` / `83086188ae0614bd882818ff1aa23f3194962012` 的 `thread/inject_items` 只写模型 ResponseItem；普通用户和助手 ResponseItem 不会自动产生界面问答。此前据此停在「未支持」过早：会话日志同时具有模型记录和界面事件两条投影，可以验证另一条实现路径。

新适配器生成独立日志：

1. 全新 UUID、独立 `session_meta`；不复用来源 session ID。
2. `response_item.message` 保留模型可承接的角色和原文。
3. `event_msg.user_message / agent_message` 保留界面可见历史。
4. 用已完成的 `task_started / task_complete` 界定历史，不留下等待执行的轮次。
5. 不写 `turn_context`、工具调用、继承父链、权限或来源系统指令；`base_instructions: null`。工作目录使用本次明确选择的项目，或独立会话的空目录；不沿来源路径读取文件。

这属于**受验证的会话日志适配**，不是 Codex 官方导入 API，也不修改其私有 SQLite 数据库。目标标题由 Codex 自身的历史展示规则决定，不声称复制了所有元数据。

### 每次新建的门禁

- 程序与数据路径只能由主进程识别或系统选择器提供。自动识别返回有时限的候选令牌；用户明确确认后才能保存授权。renderer 只能回传令牌及来源 opaque ID，不能指定任意路径。
- 核对系统 `codex://` 关联的应用二进制与所选验证程序一致，不能拿另一版 CLI 的成功证明桌面版本支持。
- 探测并原样保留 CLI 版本，包括桌面正式发行包内置的 `0.163.0-alpha.10.2` 等预发布标签；不把带标签误当非法程序。是否兼容仍由当前程序的隔离历史回读决定，不凭版本标签跳过预演；预演后再次检查程序文件身份，更新途中停止重试。
- 从来源第 0 条重新读到结束，所有分页绑定同一快照；按原始消息位置合并长消息，保留 Unicode、换行和全空白中间片段，内部记录不误接到前一条消息。
- 最多 32 MiB 文本、100000 条消息；超过预算明确失败，不自动截断、摘要或创建半份会话。来源自身的单页安全预算仍有效。
- 为本次验证创建独立 HOME、CODEX_HOME、临时目录。macOS `sandbox-exec` 默认拒绝，放行系统运行库、所选程序和本次临时目录；没有网络权限、真实用户目录读取权限或任意其他程序执行权限。环境变量不继承凭据。
- 调用所选程序的 `--version` 和 `app-server` 的 `initialize → thread/read(includeTurns)`，**不调用 thread/start、thread/resume 或 turn/start**。把目标自己返回的已完成问答按角色、顺序和原文字节对应的字符串逐条比对；无历史、角色变化、异常状态均拒绝。
- 新日志在写入目标前已保存 `0600` 明文备份。事务目录 `0700`；不用复制整个客户端目录或数据库来“备份”。
- 复核来源授权和快照后，在已授权 `CODEX_HOME/sessions/YYYY/MM/DD/` 下独占创建临时文件、fsync，以不覆盖既有文件的硬链接发布完整 JSONL，再校验落盘散列。拒绝符号链接及越界路径。
- 独立会话沿用 `(来源 ID, 来源快照, 文本, 目标根)` 索引；项目模式再加入项目路径与 dev/ino。同一快照和项目重试复用同一目标，换项目不会打开上次目标；目标工作目录变化则拒绝自动打开。
- 创建后、打开前验证失败时，只回滚散列仍一致的本次文件；打开失败保留已创建会话及备份，供重试。界面不提供创建后的手动撤销；底层保留原有受散列保护的回滚能力，不删除继续对话后的新历史。
- 最后发送 `codex://threads/<新 UUID>`。`opened` 返回字段只表示 `openExternal` 请求被系统受理，界面文案始终写「已请求打开」，不是目标展示回执。

### 持久化

- `userData/codex-target.json`：用户明确授权的程序与数据目录。
- `userData/codex-transfers/<receipt UUID>/backup.jsonl`：本次目标日志的明文备份。
- 同目录 `receipt.json`：新线程 ID、目标位置、版本、散列、消息数和 prepared/created/rolled-back 状态。
- 同目录 `workspace/`：仅为独立会话创建的空工作区；项目模式不创建它，也不向用户选择的项目写文件。
- `userData/codex-transfers/index/<sha256>.json`：重试幂等索引。

这些数据只在用户发起目标配置／接续时创建。普通浏览不会持久化正文。底层回滚仅删除本次未变化的目标日志，保留备份及事务记录；不操作 Codex 运行中的内存视图或内部索引数据库，因此不把它作为接续后的用户撤销功能。

## 具名 IPC

所有通道校验主窗口及顶层 frame；不暴露任意 URL、路径、shell 或历史载荷接口。

| 方法 | 通道 | 输入与行为 |
| --- | --- | --- |
| `inspect(id)` | `pinekin:source-actions-inspect` | 64 位来源 opaque ID；返回原会话打开能力及 Codex 是否已配置；不扫描目标正文 |
| `inspectCodexTarget(mode?)` | `pinekin:source-actions-inspect-codex` | automatic 默认识别；directory/application 为显式手动备用；返回位置、状态与候选令牌，手动取消返回 null |
| `configureCodex(token)` | `pinekin:source-actions-configure-codex` | 仅接受主进程候选 UUID；用户点击接续目标后按需自动调用，或在设置中保存时调用；探测版本后保存配置，拒绝任意路径、未知和过期令牌 |
| `listCodexProjects(id)` | `pinekin:source-actions-list-codex-projects` | 来源 opaque ID；返回已有本地项目名称、路径、限制说明和临时列表 UUID，不创建 |
| `chooseCodexProject(id, projectId?)` | `pinekin:source-actions-choose-codex-project` | 带列表 UUID 时重新核验并选择已有项目；不带才打开系统选择器。返回绑定来源的短期令牌，不接受任意路径 |
| `continueInCodex(id, destination)` | `pinekin:source-actions-continue-codex` | 必须明确 `{kind:'standalone'}` 或 `{kind:'project',token}`，拒绝附加路径；补读完整文本，写入前重查授权、快照与项目身份 |
| `rollbackTransfer(receipt)` | `pinekin:source-actions-rollback-transfer` | 保留的兼容接口，界面不再调用；事务 UUID，仅删除散列未变化的本次目标文件 |
| `openOriginal(id)` | `pinekin:source-actions-open-original` | 从授权元数据构造白名单深链 |
| `exportText(text)` | `pinekin:source-actions-export-text` | 辅助 Markdown 导出；≤5 MiB，不创建客户端会话 |

## 原会话协议

| 来源 | 地址模板 | 条件 |
| --- | --- | --- |
| NewMax | `newmax://open?conversation=<id>` | 普通主会话；ID 为 1–128 位字母、数字、下划线或连字符；macOS 校验系统关联的精确应用包身份，不依赖 Electron／NewMax 显示名；其它平台仍按原名称门禁，需独立实机验收 |
| Codex | `codex://threads/<uuid>` | 普通主会话；原 ID 为 UUID；macOS 校验关联包 `com.openai.codex` 及 `codex` 协议声明，不依赖 Codex／ChatGPT 显示名；其它平台仍需独立实机验收 |
| Claude Code／Cindy／DeepSeek Harness | 尚无打开适配 | 不猜命令、路径或 URL；但符合来源文本读取门禁的普通会话可以作为 Codex 接续来源 |

macOS 正式包接受 `cc.newmax.desktop`／`com.newmaxai.app` 且必须声明 `newmax` 协议。开发包仅接受专属 `cc.newmax.desktop.cn.dev`／`cc.newmax.desktop.intl.dev`；其协议由运行时注册，允许没有静态 `CFBundleURLTypes`，但必须由 OS 的协议查询返回该包位置。不会搜索安装目录、放行通用 Electron 或仅凭显示名信任应用；拒绝符号链接、超限或检查中变化的包信息。多个开发副本共用 bundle ID 时，系统关联可能指向另一副本；识别通过不代表会话一定在该副本可见，必须确认关联目标与实际主 dev 一致，并做合成会话界面验收。

原会话协议和新建目标协议都不携带数据目录。用户必须选择当前 Codex App 实际使用的数据根；Pinekin 不读取目标配置或凭据来猜测。系统受理不证明界面已找到会话。

此前只读调查正确确认 `newmax://` 仅有 install/uninstall/open，设置页内部 IPC 不能当外部 API。本批经用户明确授权，在 `/Users/jaylee/Documents/GitHub/newmax-client` 新增独立版本化的正式本机接续接口，并在 Pinekin 对接；不会把开发 CDP、UI 自动化、内部会话写 IPC 或外部直接写库包装成接续。目标自行保存并回读历史，界面定位需要精确回执。详见 [NewMax 正式接续](newmax-target.md)。

### 主 dev 现场验收（2026-10-20）

- 按用户当次明确授权，仅重启 Pinekin 主 dev 一次以加载主进程修复；不另起测试副本，不重启 NewMax。
- OS 实际返回的应用名为 `Electron.app`。按专属 bundle 身份识别后，生产「在原 App 打开」按钮可用；两个 NewMax 开发副本共用 bundle ID 的旧注册已纠正到主 dev，并记录原关联以便回滚。
- 合成目标由 NewMax 的正常「用此身份发起对话」界面创建，再通过客户端既有保存消息 IPC 补一条明确标注的合成文本；没有发送模型请求或直接修改外部数据库。Pinekin 只连接本项目内的合成 SQLite 来源，不读取真实会话正文。
- 点击生产按钮，未替换协议查询或 `shell.openExternal`；在 NewMax 主 dev 同时确认收到真实协议事件、选中的持久会话 ID 与合成目标一致。仅出现「已请求」反馈不算此项通过。
- 已删除合成目标、断开临时来源、移除文件对话框替身与协议观察监听。原标签临时快照在收尾时不可用，未强行覆盖现有标签状态；不声称已核验原标签恢复。
- 证据：`.newmax/outputs/newmax-original-open-live.json`；本次是复用主 dev 的实际链路验收，不等于已运行会额外启动窗口的整套 `npm run test:e2e`。
- 后续用户仍报告某条真实记录只唤起主 dev、未展示指定会话。获准的只读元数据核对确认该 ID 在主 dev 存在，但失败原因尚未定位；另一条记录重试后两端选中 ID 一致，不代表最初失败记录已修复。合成链路通过不能推广为全部真实记录验收通过。本地验收文件含定位元数据，不纳入 git。

## 已执行的官方程序契约验证

使用官方 `codex-aarch64-apple-darwin.tar.gz`，版本 **0.163.0**，发布包 SHA-256：

```text
61c4d9a92521bdb42b0c1d9f87c673f6da628a06de5945cbdd9a0010632f6d10
```

下载在独立临时目录，核对官方 release digest 和 macOS 签名；没有调用真实安装目录的程序或挂载真实 HOME。测试覆盖：

- 官方进程识别新日志，并逐条返回已完成的 UI 问答。
- 两次独立进程读取（含重启）一致。
- 大段 Unicode、换行、尾随空格，覆盖 stdout 多块拆分。
- 用生产 `CodexTarget.create` 完成合成目标的预演、备份、落盘、去重和撤销。
- OS 打开替换为记录 URL，不启动 Codex GUI，不发送模型请求。

复现入口（必须显式提供隔离下载并核验的二进制）：

```bash
PINEKIN_CODEX_TEST_BINARY=/absolute/path/to/verified-codex npm run test:codex-contract
```

官方固定源码依据：`codex-rs/protocol/src/protocol.rs` 的 SessionMeta / UserMessageEvent / AgentMessageEvent；`codex-rs/app-server-protocol/src/protocol/thread_history.rs` 的 user/agent 事件投影；`codex-rs/app-server/src/request_processors/thread_processor.rs` 的持久线程读取。对应固定 commit 为 `83086188ae0614bd882818ff1aa23f3194962012`；官方 release 为 `https://github.com/openai/codex/releases/tag/rust-v0.163.0`。

### 先前目标写入实现的验证结果

- 全量单元／集成／组件：72 文件、**987 项通过**；行覆盖率 **98.20%**、分支 **87.36%**。
- `codex-target.ts`：行 **98.46%**、分支 **84.52%**；其生产工厂另由官方二进制契约覆盖。
- 类型检查与 `npm run build` 通过。
- `npm run test:codex-contract` 通过：真实官方 0.163.0 CLI、长 Unicode、两次独立回读、生产事务创建／幂等／撤销；目标打开由替身记录。
- 已补 Electron 的首次目标配置取消及 IPC 参数拒绝用例，但**本批 Electron E2E 未运行**，遵守只复用主 dev、不新增或重启桌面实例的限制；没有将历史 E2E 成绩记为本批通过。
- 固定源码的 `thread-store/src/local/thread_rollout_resolver.rs:67–129` 确认未入 SQLite 索引的新线程会按 ID 回退查找日志；这是源码依据，不代替目标 GUI 的实际打开验收。

### 自动识别与目标选择改造验证（2026-10-19）

- 相关服务／IPC／组件回归 **45 项通过**：自动识别不弹框、不保存；首次明确确认；自定义选择取消；令牌失效与越权参数；保存设置不创建；已连接目标重试；旧主进程／preload 提示重启；延迟结果不覆盖新会话。
- 当前共享工作区全量 **75 文件、1016 项通过**；行覆盖率 **98.32%**、分支 **87.55%**。类型检查、构建通过。
- 首次类型检查遇到并行来源目录修复的构造参数尚未补齐；待该实现完成后重新检查通过，未修改或撤销其它任务的代码。
- Electron 合成夹具已更新为自动识别系统关联程序、默认零选择框、自定义才选择、取消无写入与拒绝任意路径参数。本批**未运行会启动独立实例的 Electron E2E**；不把组件测试冒充桌面验收。
- 本轮没有改动目标日志格式或模型执行协议，沿用先前官方二进制契约证据；没有重新下载或运行真实客户端程序来重复该验证。

### 本机应用识别故障修复与实测（2026-10-19）

用户实际点击发现识别失败后，只读查询系统协议关联及应用包元数据，确认：

- `codex://` 实际关联 `/Applications/ChatGPT.app`；包标识 `com.openai.codex`，包版本 `26.1013.40934`，声明了 `codex` 协议。
- 内置程序在 `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`，CLI 实际版本为 `0.163.0-alpha.10.2`。
- 旧代码错误地要求显示名／目录名为 Codex、只认两个旧 CLI 位置，并且只接受纯数字版本；三个硬编码均已修复。不是通过放行任意 ChatGPT 名称绕过校验。
- `resolveCodexApplication` 校验普通、非外跳链接的 Info.plist、包标识和协议声明，再读取已确认的包内 CLI 位置；同时兼容旧的 `Contents/Resources/codex` 与 `Contents/Resources/bin/codex`。应用 GUI 可执行文件不会被当作 CLI 运行。
- 原会话打开与新会话创建共用已校验的 Codex 能力标识，避免一个入口支持 ChatGPT 命名、另一个仍因显示名拒绝。面板显示实际承载应用名，并保留具体定位失败原因。

验证证据：

- 现场协议关联与实际应用包通过生产解析器核验；使用合成数据目录调用生产 `CodexTargetSetup`，确认可生成授权候选且不打开选择器、不保存授权。证据在 `.newmax/outputs/codex-installed-app-diagnosis.json`。
- 对截图中的 `~/.codex` 只核对目录属性与规范路径，没有列出目录内容、读取真实会话或凭据。
- 将内嵌 `CodexCLI.app` 完整复制到独立临时目录，保持签名有效；单独复制 Mach-O 会丢失签名所需的包上下文，不能以重新签名或关闭沙箱兜底。
- 该实际内置版本的隔离副本通过长 Unicode、两次独立历史回读以及生产创建／去重／撤销事务。CLI 全程使用合成 HOME/CODEX_HOME，OS 沙箱拒绝网络；没有启动目标 GUI、发送模型请求或写入真实会话位置。
- 相关 **81 项通过**；全量 **78 文件、1055 项通过**，行覆盖率 **98.39%**、分支 **87.84%**；类型检查和构建通过。Electron 合成夹具已补为 ChatGPT 命名与内嵌 CLI 布局，但未运行独立桌面 E2E。

显式本机应用元数据契约入口：

```bash
PINEKIN_CODEX_TEST_APP=/Applications/ChatGPT.app \
PINEKIN_CODEX_TEST_BINARY=/absolute/path/to/isolated/CodexCLI.app/Contents/MacOS/codex \
npm run test:codex-contract -- --reporter=verbose
```

`PINEKIN_CODEX_TEST_APP` 不设置时不运行本机程序包检查。不得把真实用户数据目录挂载给契约验证。

### 直接接续交互验证（2026-10-19）

- 首次和已连接目标均以点击目标卡片直接发起接续；路径、应用位置和保存按钮只出现在目标设置。未点击目标就关闭面板不识别、不配置、不写入。
- 相关 **81 项界面回归通过**，覆盖自动配置后接续、失败重试、防重复点击、仅设置保存，以及识别／配置结果迟到时不创建旧会话。
- 已复核并复用同一运行时代码状态下的共享工作区全量验证：**79 文件、1078 项通过**，行覆盖率 **98.33%**、分支 **87.90%**；构建通过。E2E 断言同步后，另行类型检查通过，不重复运行已通过的全套测试。
- 本轮没有修改主进程、preload 或创建协议；现有主 dev 的 Vite 已提供新版直接接续模块，可热更新，无需重启。未启动额外桌面实例，Electron E2E 仍未执行，也未用真实会话测试写入。

## 仍未验收与未支持

- **真实 Codex 桌面窗口展示及用户发出下一轮后的接续效果尚未实机验收**。官方进程回读与深链发送不能冒充这一步。
- 默认只用现有主 dev，不自行另起、重启或聚焦桌面实例。本轮目标选择改造完成后，用户通过问询卡片明确批准重启；已先关闭原实例，再从同一工作区和数据目录启动，确认仅一个主实例且新主进程／preload 已构建加载。没有运行会启动独立 Electron 的 E2E，不用真实会话替代合成测试。
- 其它版本在每次真实接续前经过本机隔离预演；未通过即拒绝创建，不宣称所有版本均支持。Windows／Linux 尚无等价验证沙箱。
- NewMax／Claude Code／Cindy／DeepSeek Harness／WorkBuddy／Qwen Code 作为目标的新建与打开适配尚未实现；列入通用目标列表不代表已接通，其来源可读能力不能外推为目标写入能力。
- 不迁移原生运行态、权限、工具、附件或真实工作目录；不是双向同步。
