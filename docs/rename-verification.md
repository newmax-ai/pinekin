# Staithe 更名验收

日期：2026-10-16。环境：macOS arm64。

## 变更范围

- GitHub 仓库改为 `newmax-ai/staithe`，保持公开；仓库描述与本地 `origin` 同步更新。
- 本地项目目录从 `projects/ember` 改为 `projects/staithe`。
- 产品显示名、包名、应用标识、界面文案、演示内容、内部桥、导出文件与文档改为 Staithe。
- 新包使用 `staithe.session`，新链接使用 `newmax-staithe`；保留旧包与旧协议兼容。
- 默认档案目录保留 `appData/@newmax-ai/ember`。已有正文、会话 ID 和档案文件不做品牌替换。
- 原首版验证文档保留当时的名称和结果。未变更依赖版本，也未重新运行依赖审计。

## 实际验证结果

| 检查 | 结果 |
| --- | --- |
| 改名前测试 | 新品牌相关 5 项预期失败，确认测试能检测旧实现 |
| 最小核心与界面测试 | 15 项通过 |
| 单元 / 存储集成 / 组件测试 | 18 项通过 |
| 配置范围内覆盖率 | 行 97.82%，分支 91.37%，函数 96.22%，语句 97.54% |
| TypeScript 检查与生产构建 | 通过 |
| 桌面 E2E | 7 项通过，覆盖两种包导入与重启、导出格式及默认文件名、旧目录读取、两种深链的冷启动与事件处理 |
| 开发入口 E2E | 1 项通过，隔离宿主 Electron 环境并渲染界面 |
| 界面截图 | 已查看主界面与交接面板，名称和导出按钮均为 Staithe |
| macOS arm64 目录打包 | 成功；未签名，仍使用默认 Electron 图标 |
| 应用元数据 | `CFBundleName` / `CFBundleDisplayName` / `CFBundleExecutable` 为 Staithe；标识为 `ai.newmax.staithe`；包含新旧两种协议声明 |
| Git 差异检查 | `git diff --check` 通过 |

测试过程修正了 E2E 环境变量类型、保存对话框替身的重载类型和分号问题，以及将装饰图标误计入品牌文本的断言。桌面测试最初被该品牌断言阻塞；修正后只重跑受影响的 7 项桌面用例，保留已通过的开发入口结果。开发测试会更新构建目录，因此桌面复测前重新生成了生产构建；打包使用该生产构建。

所有桌面测试使用临时目录与合成会话；旧默认目录测试先重定向 `appData`，没有读取真实用户档案。文件对话框返回值和剪贴板均由替身控制。

覆盖率范围仍为 `src/core/session.ts`、`src/main/library.ts`、`src/renderer/src/App.tsx`，不是全仓覆盖率。

## 产物

- 应用目录：`release/mac-arm64/Staithe.app`
- 桌面截图：`test-results/staithe-desktop.png`
- 交接截图：`test-results/staithe-handoff.png`
- 工作区预览：`outputs/staithe-desktop-preview.png`、`outputs/staithe-handoff-preview.png`（相对于 NewMax 工作区，不在本仓库内）。

## 边界

没有验证安装后的操作系统级协议注册、签名、公证、Windows / Linux 实机安装或真实客户端接入。旧版 Ember 不支持新格式包；兼容方向为旧包导入 Staithe。既有打包工具链告警仍按首版记录处理，不因更名视为已解决。

本次只执行仓库改名和本地修改、验证与打包，未自动提交或推送代码。

## Pinekin 仓库名称对齐（2026-10-19）

以上为 2026-10-16 的历史验收记录。本次仅将仓库名称与现有 Pinekin 品牌对齐：

- GitHub 仓库从 `newmax-ai/staithe` 改为 `newmax-ai/pinekin`，保持公开，并同步仓库描述。
- 本地 `origin` 更新为 `https://github.com/newmax-ai/pinekin.git`。
- 本地项目目录从 `/Users/jaylee/Documents/GitHub/staithe` 改为 `/Users/jaylee/Documents/GitHub/pinekin`；因运行路径变更，在新目录恢复主 dev，保留原有未提交改动。
- 不修改应用安装身份、历史协议、数据目录或档案格式；不改动现有界面与业务代码，不自动提交或推送代码。
- 本次为仓库元数据、目录名称与文档变更，不沿用上述历史测试结果作为本次验收；仓库改名通过 GitHub 仓库信息回读、本地远程地址及远程 HEAD 查询验证；目录改名检查 Git 状态一致性，并在新路径执行 TypeScript 检查与主 dev 启动验证。
