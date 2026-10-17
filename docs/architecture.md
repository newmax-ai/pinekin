# 架构与能力边界

## 分层

| 层 | 路径 | 职责 |
| --- | --- | --- |
| 桌面主进程 | `src/main/index.ts` | 窗口、受限 IPC、原生选择框、剪贴板、协议入口 |
| 窗口装饰与展示策略 | `src/main/window-options.ts` | macOS 原生红绿灯布局；其他平台保留系统装饰；仅未打包且显式标记的后台测试禁用显示 / 聚焦，正常启动不变 |
| 选择文件读取 | `src/main/import-file.ts` | 非阻塞打开、句柄类型检查、有界读取快照 |
| 导入协调 | `src/main/imports.ts` | 内容识别、快照、预览 token、失效/确认与重复检测 |
| 外部格式解析 | `src/main/cindy.ts`、`cindy-local.ts`、`deepseek.ts`、`codex.ts`、`codex-zstd.ts`、`zip.ts` | 固定格式映射、ZIP / Zstandard / JSONL 资源约束、来源校验、损失报告；Cindy 本地快照仅解析已提取文件，不连接数据库 |
| 本地档案服务 | `src/main/library.ts` | 串行入库、原件与记录整体发布、旧库读取和损坏保护 |
| 安全桥 | `src/preload/index.ts` | 只暴露具名能力，不暴露任意 IPC、路径读写或 Node.js |
| 会话核心 | `src/core/` | 文本模型、版本校验、搜索、交接文本、深链、来源能力 |
| 界面 | `src/renderer/src/App.tsx` | 侧栏文字 Logo 与图标搜索、按需搜索弹窗、窗口内浏览历史、可收起来源侧栏、三栏档案工作台、来源/搜索组合过滤、加载恢复、只读阅读、导入与文本交接；不包含演示分类 |
| 本地设计系统 | `src/renderer/src/tokens.css`、`styles.css`、`components/ui.tsx` | NewMax DS 语义/尺度基础上的独立中性主题、Lucide 通用图标、原生模态焦点管理 |
| 消息排版 | `src/renderer/src/components/MessageContent.tsx` | 只读文本与成对代码围栏，不解析 HTML 或外部媒体 |
| 可调宽侧栏 | `src/renderer/src/components/Sidebar.tsx` | 指针/键盘调宽、拖拽清理、响应式宽度限制；仅宽度偏好进入本地 localStorage，不触及档案或 IPC |
| 单行文字渐隐 | `src/renderer/src/components/FadeText.tsx` | 依据真实溢出启用 16px 末端 mask，保留完整名称；不遮罩品牌图标或数量 |

界面无 Node.js 权限，开启 `contextIsolation` 与 `sandbox`。主进程校验 IPC 发送者及顶层 frame，拒绝窗口导航、新窗口和权限请求。导入内容只作为 React 文本节点，不解析 HTML、不执行历史工具调用或授权描述。

UI 的视觉参考来源、独立化决策与操作说明见 [桌面工作台设计](ui-design.md)。不存在对 NewMax 源码或运行时的跨仓库依赖；来源筛选不代表客户端连接状态。界面排版不修改存储消息或交接原文。返回 / 前进只恢复窗口内的会话与筛选位置，最多 100 项，不操作网页 history 或持久化搜索内容；侧栏开关独立于浏览历史，不更改筛选。

Pinekin 更名只改变品牌显示，安装身份 `ai.newmax.staithe`、文本包格式和深链保持兼容。内部桥继续使用 `window.staithe`、`StaitheAPI` 与 `staithe:*` IPC。选择文件由主进程系统对话框完成，渲染进程不能指定路径或直接提交待保存会话。确认参数为短期 UUID token，关联已经验证的内存快照。

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

1. **档案导入**：能阅读和保存历史；Cindy 与 Codex 均有合成回归，Codex 另做过少量获授权本机文件只读抽样，不代表全部版本兼容。Codex 支持受限 Zstandard 以及序号从 0 连续、无继承的分页主会话，但始终是追加日志文本投影，不重建有效分支。
2. **上下文交接**：把文本原文、角色与损失报告交给目标工具；不自动发送，不保证目标模型抵抗提示注入。
3. **打开来源**：当前只有 Pinekin 自身本地定位；未接入来源客户端打开入口。
4. **原生恢复／迁移**：涉及原会话 ID、工作区、工具状态、权限、模型、客户端版本和正式恢复入口；本版全部未支持。

`SessionAdapter.capabilities` 描述 Pinekin 实际实现：Cindy、Codex 与 DeepSeek Harness 的 `importArchive=true`，标记 `archiveStatus=fixture-tested` 并限定具体格式。DeepSeek 网页聊天仍未支持。少量获授权本机核验单独记录，不将整个产品提升为全面集成验证。所有外部来源的 `readLocal/nativeResume/deepLink` 仍为 false；Cindy 一次性开发核验不等于产品具备数据库连接或自动扫描能力。

## 深链

新协议 `newmax-staithe://session/<本地ID>`，旧协议 `newmax-ember://session/<本地ID>` 保留，两者走相同解析和分发逻辑。

- 原始字符串严格匹配，不接受查询、片段、用户信息、端口或额外路径。
- 仅定位本机档案，不取远程文件、不传 prompt、不触发工具执行；找不到则明确提示。
- 开发模式不注册系统协议；打包配置两种协议声明。
- 测试覆盖冷启动参数、应用内事件与消息桥，不代表安装后的系统级协议验收。
- 首次导入分配新 ID；相同字节文件重复导入复用已有档案 ID。跨设备不能只传本地链接。
- 更名不重写已保存档案的 ID；不再注入内置演示会话，未保存的历史示例链接按未找到处理。

## 持久化

档案列表只返回持久化的非演示会话，不追加内置数据。空库返回空数组；旧记录的 `demo` 字段仅作兼容，标记为演示的记录过滤显示而不删除。渲染层也过滤旧主进程可能仍返回的演示记录，避免热更新时残留。测试数据全部放在 `tests/fixtures`，桌面验收仅向隔离 userData 显式种入合成档案。

旧 `userData/library.json` 不自动改写或迁移。新导入保存 `imports/<sha256>/original.bin` 与 `record.json`，同文件系统暂存目录内写完后整体 rename，保证读者只看到完整提交。串行队列保护进程内并发；完全相同字节幂等，不做跨账户或正文语义合并。损坏数据明确报错，不清空覆盖。

产品显示名为 Pinekin，默认 `userData` 仍为系统 `appData` 下的 `@newmax-ai/ember`。开发模式优先使用 `STAITHE_DATA_DIR`，兼容 `EMBER_DATA_DIR`；打包忽略两者。测试始终使用隔离临时目录。

当前是有界小包验证：无 SQLite、大库索引、后台解析 worker、目录监听、整库容量限制、自动备份、加密或删除界面。原件按内容散列存储，但文本索引仍逐个读取 JSON；这不是大规模存储完成状态。最终结构化模型与数据库迁移需要独立方案及备份/校验/回滚。

## 验证边界

- 单元：v1/v2 schema、搜索、交接、深链、能力标记；Cindy 格式、原件校验、错误内容、ZIP 路径和资源边界。
- 集成：隔离文件系统中的普通文件/FIFO 拒绝、快照预览/取消/确认、并发去重、失败重试、损坏保护。
- 组件：来源过滤、导入预览与确认、重复提示、错误反馈、导入报告、导出和深链。
- 桌面：真实 Electron + preload + IPC + 文件服务；对话框与剪贴板替换，只用合成数据。Cindy 第三方客户端自身未在测试中运行。
- 覆盖率阈值 80%，包括 `src/core`、主进程纯解析/存储/文件读取模块和渲染进程 TSX（包括本地控件与消息排版）；类型、演示数据、主进程启动事件编排及 preload 不计入数值，后两者通过 E2E 验证主要路径。这不是全仓覆盖率承诺。

验收见 [第一批只读导入](import-verification.md)、[Codex 首批](codex-verification.md) 和 [获授权本机抽样及格式修正](local-validation-2026-10-17.md)；Codex 当前支持边界见 [专项格式说明](codex-import.md)。
