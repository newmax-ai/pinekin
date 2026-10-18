# 第一批只读导入：格式与边界

实施日期：2026-10-16。阶段 A 的第一个闭环；不是全部接入路线完成。

> 2026-10-18 起，本文仅描述「已有档案」兼容入口及解析格式，不再代表默认产品流程。默认改为连接来源、目录发现和按需正文读取，详见 [来源直读契约](source-browser.md)。下文关于“不直接接受数据库／不扫描目录”的表述限定于档案导入 API；来源浏览有独立授权入口和严格 SQLite 门禁。

## 用户流程

1. 点击「导入会话文件」，使用系统选择框授权读取一个普通文件。
2. 主进程最多读取 5 MiB，识别文件内容而非扩展名；生成内存快照。
3. 预览来源、标题、消息数、大小、验证等级与损失报告。预览、取消和解析失败不写档案。
4. 用户确认后保存原件和文本投影；完全相同文件复用已有档案。源文件在预览后被修改，不影响确认的快照。
5. 档案详情可以展开导入报告，报告也进入文本交接。原件不默认随文本包或交接导出。

IPC 只有 `previewImport()`、`confirmImport(token)`、`cancelImport(token)`，不接受渲染进程提供的路径或待保存 Session。主进程校验发送窗口、顶层 frame 和 UUID token。一个待确认快照，token 十分钟有效；新预览、窗口刷新/关闭和取消会使旧预览失效。确认进入写入阶段后不提供中途取消。

## 能力矩阵

| 输入 | 当前状态 | 允许内容 | 明确不支持 |
| --- | --- | --- | --- |
| Staithe / Ember v1 | 兼容读取 | 原有文本会话 | 扩展字段、未知版本 |
| Staithe 文本快照 v2 | 合成夹具验证 | 新来源标识、文本、来源摘要与损失报告 | 原始二进制文件、附件、结构化事件树 |
| Cindy `.cshare` / `.xdtshare` | 固定源码格式 + 合成夹具验证 | 未加密、普通单会话 v1 包的文本投影 | 加密包、Orca 协同包、v2/未来格式、原生恢复 |
| Pinekin Cindy 本地快照 v1 | 合成回归 + 0.1.97 本机 3 段核验 | 普通桌面主会话的字段白名单快照、当前用户/助手文本 | 非官方分享包；不自动连接数据库；分叉、bot、Orca、远程和原生恢复不支持 |
| DeepSeek Harness v4 JSONL / JSONL.ZSTD | 合成回归 + 0.2.1-rc.1 环境下 3 份现有日志核验 | 序号从 0 连续、非继承/非子会话的用户输入和助手文本 | 网页聊天导出、未来格式、表面替换、截断或超限日志、原生恢复 |
| DeepSeek 消费者聊天导出 | 官方有导出说明；Staithe 未支持 | 无 | 缺少官方 schema 或获授权脱敏样本，不能猜测适配 |
| Codex 独立主会话 JSONL / JSONL.ZST | 合成回归 + 少量获授权本机文件抽样 | legacy 或从 0 连续编号、无引用的分页主会话；有界解压、原件与来源报告 | 有引用/缺序号的分页、继承、子会话、超限文件；不重建有效分支、不启动 resume |
| Pinekin NewMax 本地快照 v1 | 合成回归 + 1.1.22 本机 10 段核验并归档 | 普通非隐私、非分叉主会话的字段白名单快照，用户展示文本与助手当前正文 | 非官方包；桌面入口不直接接受数据库；未来版本、内部轮次、附件和原生恢复不支持 |
| Claude Code 原生 JSONL | 合成回归 + 2.1.286 环境下 10 段归档 | 完整单根、非子会话混合事件图中末条消息父链的文本投影，追加块合并与损失报告 | 不保证全部分支或原生活动链；压缩/逻辑父链、跨文件、自动扫描与 resume 不支持 |

Codex 的消息/事件去重、压缩/回退语义及独立限额见 [Codex 专项说明](codex-import.md)。下列 ZIP 和清单规则仅用于 Cindy，不套用到 Codex JSONL。

Cindy 实现锚点为官方仓库提交 `e532ef3d8fe8271a3decf7f478d09d8ce959f824`，不是对全部发布版本的兼容承诺。所有夹具都是本仓库自己构造的虚构内容；尚未用真实 Cindy 客户端生成的脱敏包验收。来源包里的产品版本和完整度仅是输入声明，不是身份或完整性的认证。

## Cindy 容器

外层魔数 `XDTSHARE`，头版本严格为 1；首版只接受 cipher=0、保留位为零的 12 字节头。后续内容为 ZIP，不接受将加密内容当 JSON 或猜测解密。

必须包含：

- `manifest.json`：`formatVersion=1`、`minReaderVersion=1`，无 `orca`。
- `session.json`：提取标题及原始更新时间；无有效时间则拒绝，不用导入时间冒充。
- `messages.jsonl`：逐行校验字符串字段、角色及毫秒时间戳，拒绝重复消息 ID，核对消息数。
- `media-map.json`：只核对引用，不渲染或下载媒体。

`manifest.entries` 不包含 manifest 自身；本实现要求它覆盖所有实际文件（目录项除外），逐条验证字节数和 SHA-256，拒绝重复、缺失及未声明文件。媒体和非空转录引用必须指向包内文件。校验散列只能检查内部一致性，不能证明来源可信。

### 资源与 ZIP 安全边界

| 项目 | 本版上限 |
| --- | --- |
| 选择的输入文件 | 5 MiB |
| ZIP 条目数（含目录） | 1,024 |
| 单条展开大小 | 5 MiB |
| 累计展开大小 | 20 MiB |
| 累计处理的压缩数据（含重复引用） | 5 MiB |
| 单条展开 / 压缩大小 | 200 倍 |
| 消息条数 | 10,000 |
| 单消息 content 长度 | 200,000 字符 |

这些是 Staithe 原型的资源策略，不是 Cindy 格式规范上限。较大的合法包也可能被拒绝，不会截断后宣称成功。

使用锁定版本 `yauzl@3.3.0` 在内存中逐条解压，并限制声明和实际展开字节，检查 CRC32。拒绝绝对路径、盘符、反斜杠、空路径段、`.` / `..`、重复名、符号链接/特殊文件，以及 ZIP 自带加密或非 STORE/DEFLATE 压缩。包内路径**从不**作为磁盘落盘路径。新依赖纳入 lockfile，不运行上游 Cindy 代码。

### 文本映射与损失

- `message.content` 是字符串，可能内含 JSON。JSON 字符串直接显示，数组只提取 `type=text` 的文本块。
- 裸文本按原文保留并提示；未知结构和工具/图片等块显示明确占位符，原字段留在原件。
- 不把未知角色映射成用户或助手：当前不能安全解释时拒绝整个导入。
- 消息 ID、时间、工具关联、Agent 元数据、分支、回退状态、模型配置和转录不进入当前文本模型；损失明确报告。
- 已回退消息按包中顺序展示，并提示不重建有效分支或执行顺序；不能用于原生恢复。
- 媒体已缺失或尚未映射时提示，不联网补齐；已有媒体留在原件。
- 不采用 `agentMeta` 中的授权文字，不执行历史工具调用，不恢复工作区权限。
- 上游 `exportFidelity=full` 也不保证媒体齐全；界面始终标记当前结果为文本投影。
- 普通分享快照没有可靠的原 Cindy 档案 ID，因此 `originalSessionId=null`，不借用 harness session ID 或伪造原始 ID。

## Staithe 文本快照 v2

v1 schema 保持原样，仍严格拒绝新字段。v2 仅接受 `format: staithe.session`，扩展来源枚举并允许 `session.archive`：

```ts
{
  adapterId: string
  adapterVersion: string
  sha256: string           // 最近一次导入原件的 SHA-256
  importedAt: string      // Staithe 导入时间，不是原始会话时间
  originalSessionId: string | null
  sourceVersion?: string  // 输入文件声明的产品版本，不是已认证身份
  fidelity: 'text-only'
  warnings: string[]
}
```

没有新增来源或归档报告的旧数据继续导出 v1；含扩展字段的档案导出 v2，避免静默降级。Ember v2 被拒绝。v2 **不是**研究方案中最终的结构化事件/附件容器，后者需单独版本化。

导出的 v2 包不携带 `original.bin`，只保留元数据和报告。再次导入时会保存这份文本包作为新的原件，不能借原报告声称原始 Cindy 包也已跨设备传输。当前没有跨多轮迁移谱系。文本包超过 5 MiB 时拒绝导出并建议 Markdown，避免生成无法重新导入的包。

## 本地存储与失败语义

旧 `userData/library.json` 保持不变、继续读取；本轮不自动搬库或改写旧 ID。新增导入落在：

```text
userData/imports/<sha256>/
  original.bin     # 精确输入字节，不自动执行或提取
  record.json      # { version: 1, session: ... }，包含来源摘要与损失报告
```

先在同目录 `.pending-<uuid>` 中写完原件和记录，再以目录 rename 发布；进程内串行化，避免同一文件并发重复入库。未完成临时目录不会出现在列表中；写入失败尽力清理，不伪造成功。旧库或归档记录损坏时明确报错，不静默覆盖；重复导入前重新核对已有原件散列。

去重只针对**完全相同的输入字节**。同一会话的新导出、格式化变化或不同来源不按正文哈希合并。旧 `library.json` 中无文件散列的记录不参与新文件去重。

原件和文本档案都是明文。目录创建使用 `0700`、文件使用 `0600`；这不是加密，Windows 权限语义不同。无逐会话删除 UI；退出应用后可按完整散列目录备份/移除一份新档案，不要只删 record 或 original 的其中一个。遗留 `.pending-*` 可在退出应用后清理。

目录 rename 是原子可见性，不是断电后的 fsync 持久性保证；不支持多个进程共享同一档案目录。当前无大库分页、后台解析 worker、SQLite、全库容量配额或自动备份。先在有界小包上验证，不声称能处理上游的全部大型档案。

## 固定证据

以下 URL 固定于同一官方提交，仅作格式依据，不表示执行过上游代码：

- `https://github.com/makecindy/cindy/blob/e532ef3d8fe8271a3decf7f478d09d8ce959f824/apps/desktop/src/main/session-share/xdtshareFormat.pure.ts`：L4–29、L149–195、L202–259。
- `https://github.com/makecindy/cindy/blob/e532ef3d8fe8271a3decf7f478d09d8ce959f824/apps/desktop/src/main/session-share/sessionShareExport.ts`：L176–186 消息、L774–895 ZIP/清单、L949–978 会话快照。
- `https://github.com/makecindy/cindy/blob/e532ef3d8fe8271a3decf7f478d09d8ce959f824/apps/desktop/src/main/session-share/__tests__/sessionShareImport.test.ts`：L289–338 合成正文编码。
- `https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html`：第 2.2(d) 说明导出入口，不提供具体 schema。

后续已接入 Codex 日志、Pinekin Cindy 本地快照与 DeepSeek Harness v4 文本投影；格式与本机核验范围见 [本地接入记录](cindy-deepseek-local-validation-2026-10-17.md)。新增 NewMax 白名单快照、Claude Code JSONL 的详细契约、资源边界、显式开发批次使用方式与首批归档统计见 [NewMax / Claude Code 接入](newmax-claude-local-validation-2026-10-17.md)。Cindy/NewMax 本地快照核验不等于官方导出包验收，Harness 不等于 DeepSeek 网页聊天。下一步仍需拓展版本、压缩/逻辑父链、附件、分叉和大文件样本；原生恢复须独立授权与验收。
