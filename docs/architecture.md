# 架构与能力边界

## 分层

| 层 | 路径 | 职责 |
| --- | --- | --- |
| 桌面主进程 | `src/main/index.ts` | 窗口、受限 IPC、原生选择框、剪贴板、协议入口 |
| 选择文件读取 | `src/main/import-file.ts` | 非阻塞打开、句柄类型检查、有界读取快照 |
| 导入协调 | `src/main/imports.ts` | 内容识别、快照、预览 token、失效/确认与重复检测 |
| 外部格式解析 | `src/main/cindy.ts`、`codex.ts`、`zip.ts` | 固定格式映射、ZIP / JSONL 资源约束、来源校验、损失报告 |
| 本地档案服务 | `src/main/library.ts` | 串行入库、原件与记录整体发布、旧库读取和损坏保护 |
| 安全桥 | `src/preload/index.ts` | 只暴露具名能力，不暴露任意 IPC、路径读写或 Node.js |
| 会话核心 | `src/core/` | 文本模型、版本校验、搜索、交接文本、深链、来源能力 |
| 界面 | `src/renderer/` | 列表、过滤、详情、导入预览、损失报告与文本交接 |

界面无 Node.js 权限，开启 `contextIsolation` 与 `sandbox`。主进程校验 IPC 发送者及顶层 frame，拒绝窗口导航、新窗口和权限请求。导入内容只作为 React 文本节点，不解析 HTML、不执行历史工具调用或授权描述。

内部桥使用 `window.staithe`、`StaitheAPI` 与 `staithe:*` IPC。选择文件由主进程系统对话框完成，渲染进程不能指定路径或直接提交待保存会话。确认参数为短期 UUID token，关联已经验证的内存快照。

## 文本包兼容

历史 v1 示例保持不变：

```json
{
  "format": "staithe.session",
  "version": 1,
  "session": {
    "id": "example-id",
    "title": "一段值得继续的思考",
    "source": "other",
    "updatedAt": "2026-10-16T00:00:00.000Z",
    "tags": ["思考"],
    "messages": [{ "role": "user", "content": "接下来做什么？" }],
    "demo": false
  }
}
```

v1 只接受原有四个来源枚举及原有字段，同时接受 `staithe.session` / `ember.session`。不放松 v1 校验以塞入新字段。

v2 只接受 `staithe.session`，扩展 Cindy / DeepSeek 来源标识和可选的 `archive` 报告。无扩展字段的会话继续导出 v1，新增档案使用 v2。**这是文本快照协议，不是最终的结构化事件和附件容器**；定义及兼容边界见 [导入格式文档](import-formats.md)。新增来源枚举不等于已实现该来源解析。

未知版本、额外协议字段及不合法数据拒绝，不静默降级。导入外部包时允许保存未映射字段所在的整个原件，并在报告中说明文本投影的损失；这不等于 v2 会携带原件。再次导出不会携带包内附件、转录或运行权限。

## 四种动作分开建模与验收

1. **档案导入**：能阅读和保存历史；当前 Cindy 和 Codex JSONL 仅合成夹具验证，不代表全部真实版本兼容。Codex 为追加日志文本投影，不重建当前有效分支。
2. **上下文交接**：把文本原文、角色与损失报告交给目标工具；不自动发送，不保证目标模型抵抗提示注入。
3. **打开来源**：当前只有 Staithe 自身本地定位；未接入来源客户端打开入口。
4. **原生恢复／迁移**：涉及原会话 ID、工作区、工具状态、权限、模型、客户端版本和正式恢复入口；本版全部未支持。

`SessionAdapter.capabilities` 描述 Staithe 实际实现：Cindy 与 Codex `importArchive=true`，并标记 `archiveStatus=fixture-tested` 和范围限制；DeepSeek 标记 `documented`，但 `importArchive=false`。所有外部来源的 `readLocal/nativeResume/deepLink` 仍为 false。文件选择读取不等于连接或扫描客户端。

## 深链

新协议 `newmax-staithe://session/<本地ID>`，旧协议 `newmax-ember://session/<本地ID>` 保留，两者走相同解析和分发逻辑。

- 原始字符串严格匹配，不接受查询、片段、用户信息、端口或额外路径。
- 仅定位本机档案，不取远程文件、不传 prompt、不触发工具执行；找不到则明确提示。
- 开发模式不注册系统协议；打包配置两种协议声明。
- 测试覆盖冷启动参数、应用内事件与消息桥，不代表安装后的系统级协议验收。
- 首次导入分配新 ID；相同字节文件重复导入复用已有档案 ID。跨设备不能只传本地链接。
- 更名不重写旧 ID，保留 `demo-ember` 演示 ID。

## 持久化

旧 `userData/library.json` 不自动改写或迁移。新导入保存 `imports/<sha256>/original.bin` 与 `record.json`，同文件系统暂存目录内写完后整体 rename，保证读者只看到完整提交。串行队列保护进程内并发；完全相同字节幂等，不做跨账户或正文语义合并。损坏数据明确报错，不清空覆盖。

产品显示名为 Staithe，默认 `userData` 仍为系统 `appData` 下的 `@newmax-ai/ember`。开发模式优先使用 `STAITHE_DATA_DIR`，兼容 `EMBER_DATA_DIR`；打包忽略两者。测试始终使用隔离临时目录。

当前是有界小包验证：无 SQLite、大库索引、后台解析 worker、目录监听、整库容量限制、自动备份、加密或删除界面。原件按内容散列存储，但文本索引仍逐个读取 JSON；这不是大规模存储完成状态。最终结构化模型与数据库迁移需要独立方案及备份/校验/回滚。

## 验证边界

- 单元：v1/v2 schema、搜索、交接、深链、能力标记；Cindy 格式、原件校验、错误内容、ZIP 路径和资源边界。
- 集成：隔离文件系统中的普通文件/FIFO 拒绝、快照预览/取消/确认、并发去重、失败重试、损坏保护。
- 组件：来源过滤、导入预览与确认、重复提示、错误反馈、导入报告、导出和深链。
- 桌面：真实 Electron + preload + IPC + 文件服务；对话框与剪贴板替换，只用合成数据。Cindy 第三方客户端自身未在测试中运行。
- 覆盖率阈值 80%，包括 `src/core`、主进程纯解析/存储/文件读取模块和 App；类型、演示数据、启动事件编排及 preload 不计入数值，后两者通过 E2E 验证主要路径。这不是全仓覆盖率承诺。

验收见 [第一批只读导入验收](import-verification.md) 和 [Codex 后续验收](codex-verification.md)；Codex 字段与不支持范围见 [专项格式说明](codex-import.md)。
