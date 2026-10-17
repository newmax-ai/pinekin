# Pinekin 品牌更名与验收

日期：2026-10-17。环境：macOS arm64。

## 品牌决定与边界

采用 **Pinekin** 作为项目品牌，延续已确认的黑白松貂图标方向。图标仍是概念 PNG，尚未替换安装包图标或制作最终 `.icns` / `.ico`。

公开名称检索未发现明确的同名会话管理软件，但不能据此认定名称空闲。2017 年的 Pinekin 品牌设计论文记载了芬兰定制装饰制品企业对该名称的使用；不能把历史记录当作该企业当前仍在运营的证明。本轮没有完成商标数据库、近似商标、域名注册状态和各地区应用商店名称可用性核验，不构成法律可用性结论。

参考资料：`https://www.theseus.fi/bitstream/handle/10024/135300/Mantyla_Marja.pdf?sequence=1`。

## 本轮变更

- npm 包名及锁文件根身份：`@newmax-ai/pinekin`。
- 打包产品名、Electron 应用名和窗口标题：`Pinekin`。
- 页面标题、侧栏文字 `pinekin.`、交接标题和导出提示采用新品牌。
- 导出默认文件名前缀为 `pinekin-`，包扩展名仍为 `.staithe.json`。
- README、开发约束、架构和当前界面说明同步更新；历史验收记录不改写。
- 保留工作树已有的界面、主题、窗口和测试改动；不修改 NewMax 仓库、不读真实客户端目录、不迁移真实档案。

## 保持不变的兼容身份

| 项目 | 保留值 / 行为 |
| --- | --- |
| 应用安装标识 | `ai.newmax.staithe` |
| 默认数据位置 | 系统 `appData/@newmax-ai/ember` |
| 开发隔离目录 | `STAITHE_DATA_DIR`，兼容 `EMBER_DATA_DIR` |
| 后台测试开关 | `STAITHE_TEST_BACKGROUND` |
| 导出包格式 | `staithe.session` v1 / v2，继续读取 `ember.session` v1 |
| 本地链接 | 继续生成 `newmax-staithe://`，同时接受 `newmax-ember://` |
| 安全桥 | `window.staithe`、`StaitheAPI` 与 `staithe:*` IPC |
| 历史内容 | 正文、标签、已有会话 ID 与历史演示内容不做品牌替换 |

没有新增 `pinekin.session`、Pinekin 深链协议或数据迁移逻辑。安装标识不变不代表已经验证操作系统级升级。

## 实际验证

| 检查 | 结果 |
| --- | --- |
| 先写品牌测试 | 旧实现出现 8 项预期失败、36 项通过；覆盖包元数据、页面标题、交接标题、侧栏文字、导出按钮与未知会话提示 |
| 最小回归 | `npm test -- tests/branding.test.ts tests/core.test.ts tests/app.test.tsx`，44 项通过 |
| 类型检查 | `npm run typecheck` 通过 |
| 完整覆盖率 | `npm run test:coverage`，12 个文件、108 项通过 |
| 配置范围覆盖率 | 语句 95.56%，分支 92.46%，函数 97.33%，行 99.20%；不是全仓覆盖率 |
| 生产构建 | `npm run build` 通过，包含类型检查 |
| 桌面回归 | `npm run test:e2e`，17 项全部通过 |
| 界面检查 | 已查看合成数据桌面截图，侧栏显示 `pinekin.`；正文和标签中的 Staithe 为刻意保留的历史演示内容 |
| 差异检查 | `git diff --check` 通过 |

桌面测试验证新应用名和页面标题、旧包导入及重启持久化、旧默认数据目录不重写、两种深链冷启动与事件定位、导出默认文件名与保留的格式字段。窗口隐藏且不聚焦，原生 show / focus 事件检查通过；只使用合成数据和隔离 userData，替换系统文件对话框及剪贴板。

## 未做事项

- 未更名远端 GitHub 仓库、未移动本地项目目录、未提交或推送。
- 未运行安装包打包；本轮验证生产构建和打包配置，未生成或验收 Pinekin 安装包。
- 未做安装后的系统协议注册、应用升级、签名、公证及 Windows / Linux 实机安装验收。
- 未主动重启用户正在使用的开发窗口；主进程名称需下次重启后生效。

截图位于被忽略的 `test-results/staithe-desktop.png` 等既有测试路径；截图文件名保留不影响品牌显示。构建与截图不提交 Git。
