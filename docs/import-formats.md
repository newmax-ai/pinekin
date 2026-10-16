# 第一批只读导入：格式与边界

实施日期：2026-10-16。阶段 A 的第一个闭环；不是全部接入路线完成。

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
| DeepSeek 消费者聊天导出 | 官方有导出说明；Staithe 未支持 | 无 | 缺少官方 schema 或获授权脱敏样本，不能猜测适配 |
| Claude Code / Codex 日志 | 本轮未实现 | 无 | 不自动扫描本地日志、不启动 resume |

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

下一步：获得用户主动提供的 Cindy / DeepSeek 脱敏导出样本，先核对格式差异，再扩充夹具；继续一个 Claude Code 或 Codex 固定版本日志适配。原生恢复仍需独立授权与验收。
