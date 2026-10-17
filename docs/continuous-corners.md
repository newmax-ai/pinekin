# NewMax 连续圆角规则的 Pinekin 适配

日期：2026-10-17。范围：Pinekin 宿主界面；不改应用图标或系统窗口边框。

## 来源与版本

只读检查 `/Users/jaylee/Documents/GitHub/newmax-client` 的当前规则与源码：

- `90e321810`，2026-10-17 13:44:58 +08:00，`feat(ui): 统一连续圆角并保留胶囊与正圆例外`。
- 取样时 HEAD 为 `c98a9959d`，2026-10-17 14:00:54 +08:00；其媒体预览修改没有替代上述规则。取样时工作树无暂存或未暂存差异。
- 主规范：`docs/architecture/continuous-corners.md:5–7,29–60,70–76`。
- 样式实现：`src/styles/globals.css:635–642,3064–3086`。

复用的是最新的 `superellipse(1.5)` / 1.348 方案，不是之前的 `squircle` / 1.84 方案。它是 CSS 连续圆角近似，不宣称精确复刻 Apple 的几何算法。NewMax 仓库没有被本任务修改，也没有被作为运行时依赖导入。

## 规则映射

| Pinekin 视觉面 | 规则 |
| --- | --- |
| 卡片、导航行、搜索结果、输入框、弹窗、消息气泡、代码块及提示面板 | 连续曲线，使用已补偿的非 full token |
| `DsButton` 操作按钮，包括文字按钮与图标按钮 | 未补偿的 pill 半径，普通 round 曲线 |
| `.scope-filter` 外壳及全部 / 已导入 / 演示按钮 | 全层胶囊；选中背景随按钮，不另加连续曲线底板 |
| `::before` / `::after` | 继承本体的实际曲线，不只读取根变量 |
| 圆形内部的普通子元素 | 仍按全局连续曲线处理，例外不扩散至子树 |

导航与档案列表虽然使用 `<button>`，语义仍是列表行，不能与操作按钮一起改成 full。`iconOnly` 也不是圆形判定条件。

2026-10-17 列表密度迭代：会话列表项与侧栏导航行均使用 md 逻辑 12px 半径（原生支持时计算值 16.176px，回退 12px），会话项及同组导航项的行间距均为 1px。搜索结果仍为 sm 逻辑 8px，右侧整体工作区仍为 lg 逻辑 18px；不扩大其他视觉面的半径。

### 半径与回退

默认 token：`--ds-corner-shape: round`、`--ds-corner-radius-scale: 1`。

只有原生支持 `corner-shape: superellipse(1.5)` 时，`corners.css` 的能力块才启用曲率 1.5 和倍率 1.348。

| token | 逻辑半径 / 回退 | 连续圆角计算值 |
| --- | --- | --- |
| sm | 8px | 10.784px |
| md | 12px | 16.176px |
| lg | 18px | 24.264px |
| pill | 9999px | 9999px，不参与补偿 |

token 本身完成一次补偿，使用处不再相乘。保留 Pinekin 现有控件的逻辑半径、尺寸、padding、字体、阴影 token 与布局，不把搜索框改成上游聊天输入框的其他尺寸。

## 本地实现与范围取舍

- `src/renderer/src/tokens.css`：默认曲线、倍率和带补偿的半径 token。
- `src/renderer/src/corners.css`：原生能力检测、全局默认、伪元素继承、胶囊 / 正圆及列表语义例外。
- `src/renderer/src/styles.css`：导入圆角规则；分段筛选外壳和按钮使用 pill token。原有其他圆角使用处自动获得一次补偿。
- `src/renderer/src/components/ui.tsx`：`DsButton` 输出 `data-ds-pill-control="true"`，不按 `iconOnly` 推断圆形。

Pinekin 没有 Tailwind 圆角工具类或任意内联圆角；full 操作按钮使用胶囊声明，未来确有圆形视觉面时通过 `data-ds-round-control` 显式声明。因此不移植上游 MutationObserver / ResizeObserver 和构建插件，也不增加依赖、布局扫描或逐帧操作。以后新增动态圆形时应按真实几何显式处理，不能默认把方形控件视为正圆。紧凑阅读区调整已移除顶部「本地优先」及其状态圆点，也一并清理无用的 `.local-state i` 规则；其他连续圆角和胶囊规则不变。

没有引入 SVG / Canvas 曲线兜底。右侧工作区卡片使用 `overflow: hidden`，保证页头、会话列表和阅读区的背景不覆盖外部 18px 逻辑圆角；内部仍独立滚动，不用 mask 或额外 clip-path 模拟圆角。屏幕阅读器隐藏标题的 `clip-path: inset(50%)` 不是视觉圆角裁切，保持不变。不触碰品牌 SVG 路径、来源客户端图片、Dock PNG / ICNS、IPC、存储或会话数据。

## 验证结果

- 先写相关测试：旧实现出现 5 项预期失败、6 项通过，覆盖 token、能力块、例外范围、分段胶囊及组件标记。
- 最小回归：`npm test -- tests/continuous-corners.test.ts tests/ui-design.test.tsx tests/app.test.tsx`，42 项通过；`npm run typecheck` 通过。
- 完整覆盖率：14 个文件、129 项通过；行 99.22%、分支 92.79%、语句 95.65%、函数 97.41%。这是仓库配置范围，不是 CSS 像素覆盖率或全仓覆盖率。
- `npm run build` 通过。
- 完整桌面首轮：22 项中 20 项通过；两项新增用例因 Chromium 把 `round` 计算值规范化为等价的 `superellipse(1)` 而断言失败。只调整这两种等价表示的匹配，不修改或放宽连续曲率 1.5 的要求。
- 首轮开发入口测试重写过 `out`，因此先重建生产产物，再只复测两个新增场景；2 项均通过，保留此前 20 项成功结果，未重复整套覆盖率或桌面测试。
- 新增原生 Electron 检查覆盖：真实 CSS 支持、浅深色容器曲率与数值、胶囊 / 正圆、尺寸和内距不变、伪元素继承、子节点不受例外污染、焦点与输入框阴影。
- 回退测试通过删除 CSSOM 中的圆角 `@supports` 块模拟不启用能力规则，确认原逻辑半径与焦点行为恢复；这不是旧版本 Electron 实机验收。
- 已查看 `test-results/pinekin-continuous-corners-light.png` 与 `test-results/pinekin-continuous-corners-dark.png`；输入框聚焦环保持完整。原有浅深色裁切、键盘、窄窗、导入 / 导出和深链场景通过。

桌面验收使用隐藏窗口、隔离 userData 与合成数据，不读取真实会话，不激活或聚焦窗口，不主动重启用户开发实例。保留工作树中其他界面和焦点处理改动，没有修改 NewMax。未提交代码，也没有重新生成安装包；生产构建已更新。
