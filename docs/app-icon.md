# Pinekin 应用图标

日期：2026-10-17。环境：macOS arm64。

## 来源与制作

当前使用用户于 2026-10-17 上传的 `Icon-iOS-Default-1024@1x.png`，保存为仓库内可复用的 `design/brand/pinekin-icon-approved.png`。该定稿为 1024×1024、16-bit RGBA PNG，自带透明边角；不再由旧黑白概念稿重建。

- `resources/pinekin.png` 与用户定稿逐字节一致，保留造型、颜色、光影、底板、原始透明通道及位深，不描摹、裁切、加留白或重新着色。
- SHA-256：`e166d2402a1afaff62470d26c9e63c89d580d40cdc0970e8fc4128ca3253daed`，由测试锁定，避免误用旧图。
- Windows ICO 继续由定稿按原有布局转换；macOS 使用独立的 `resources/pinekin-macos.png` 和 ICNS：将完整定稿等比缩为 824×824，居中于 1024×1024 透明画布，四边各留 100px。
- 824px 是针对本项目 Dock 视觉比例的选择，不宣称是所有 Apple 图标格式的统一硬性尺寸。原 iOS 导出图的底板在画布内几乎满幅，直接用于静态 Mac 图标会显得过大。
- macOS 外阴影只从底板 alpha 生成：Gaussian sigma 12px、最大不透明度 24%、向下偏移 10px；不重画原图内部光影。生成灰度阴影蒙版时移除其不适用的 RGB profile，不改源图色彩配置。
- 开发 Dock PNG 与所有 ICNS 尺寸共用这张 Mac 母图，避免开发版尺寸正常但安装包仍满幅。
- 这是静态光栅应用图标，不是 Icon Composer 分层资产或动态 Liquid Glass 图标。
- 之前交付的 `pinekin-mark.svg`、`pinekin-app-icon.svg` 及其预览仍是旧扁平版本的编辑素材，本轮未覆盖，不能当作当前含光影定稿的矢量等价文件。

## 资产

| 文件 | 用途 |
| --- | --- |
| `design/brand/pinekin-icon-approved.png` | 用户上传定稿的原样副本；生成脚本的唯一输入 |
| `resources/pinekin.png` | 1024×1024、16-bit RGBA PNG，与用户定稿逐字节一致；非 Mac 运行时与 Linux 图标 |
| `resources/pinekin-macos.png` | 1024×1024、8-bit RGBA Mac 母图，824px 底板、100px 留边与外阴影；开发 Dock 使用 |
| `resources/pinekin.icns` | 基于 Mac 母图的应用包图标，包含 16 / 32 / 128 / 256 / 512 逻辑像素及各自 @2x 表示 |
| `resources/pinekin.ico` | Windows 多图层图标，16 / 32 / 48 / 64 / 128 / 256px |
| `design/brand/pinekin-icon-sizes.png` | 原始定稿的 16 / 32 / 64 / 128px 对比图，不代表 Mac 留白适配后的尺寸 |
| `design/brand/pinekin-macos-comparison.png` | 同为 96px 画布的适配前后对比，由资产渲染，并非实际 Dock 截图 |
| `scripts/generate-app-icons.mjs` | 从用户定稿生成通用 PNG、Mac PNG、ICNS 与 ICO |

重新生成资产需要 macOS 自带的 `iconutil` 和 ImageMagick 7：

```bash
node scripts/generate-app-icons.mjs
```

普通开发、CI 和打包直接读取生成好的资源，不要求安装图像工具。脚本在独立临时目录处理图层，最终资产写入项目 `resources/`；清理临时目录不改变终端当前目录。

小尺寸检查：32 / 64 / 128px 保留松貂整体轮廓；16px 主要依赖剪影，眼睛与腿部细缝会合并，尚未单独手绘小尺寸光学修正版。

## 接入

- `package.json` 分别为 macOS / Windows / Linux 指定 ICNS / ICO / PNG。
- `resources/pinekin.png` 与 `resources/pinekin-macos.png` 均显式包含在 `build.files`，保证 `app.asar` 内运行时路径存在。
- `src/main/index.ts` 以编译后主进程位置解析 `../../resources/`，通过 `getAppIconFilename(process.platform)` 选择图标：darwin 使用 Mac 专用 PNG，win32 / linux 使用通用 PNG。该路径同时供 BrowserWindow 与开发 Dock 使用，不依赖进程当前工作目录或测试 bootstrap 的 appPath。
- 正常 macOS 开发启动在 ready 后设置 Dock 图标；打包应用使用原生包图标，不覆盖系统呈现。`setDevelopmentDockIcon` 对后台测试、其他平台和缺失 Dock API 做保护。
- 不改侧栏纯文字 Logo，不替换 NewMax / Claude / Codex 等来源客户端标识；不新增 IPC 或修改数据身份。
- 图标变化需重启主进程，只有 renderer 热更新不足以更新 Dock 图标。本次 Mac 尺寸修正通过后台验收后，经用户明确确认重启了 Pinekin dev；未重启系统 Dock，未覆盖系统 Applications 中的安装，也未操作 NewMax。

## 首版扁平图标接入验收（历史）

以下为替换用户定稿之前的接入记录，不代表本次新图的验收结果。

1. 新增测试先因缺少实现模块失败。随后最小回归发现 ICNS 编码块断言过窄：当前系统 `iconutil` 使用 `ic04` / `ic05`，不是仅 `icp4` / `icp5`。用系统工具反解验证 10 个尺寸表示后，测试接受对应合法编码，不改变尺寸要求。
2. 最小图标 / 品牌 / 后台窗口测试 22 项通过；`npm run typecheck` 通过。
3. `npm run test:coverage`：13 个文件、118 项通过。配置范围内行覆盖率 99.20%、分支 92.53%、语句 95.58%、函数 97.35%；包含新增 Dock 保护逻辑，不是全仓覆盖率。
4. `npm run build` 通过。
5. 未签名 macOS 应用目录打包通过：

   ```bash
   CSC_IDENTITY_AUTO_DISCOVERY=false npx --no-install electron-builder --mac --dir -c.mac.identity=null
   ```

   产物 `release/mac-arm64/Pinekin.app`。打包在开发入口 E2E 之前运行，使用生产构建而非开发测试重写的 out。
6. `Info.plist` 的 `CFBundleName=Pinekin`、`CFBundleIdentifier=ai.newmax.staithe`、`CFBundleIconFile=icon.icns`。应用内 `icon.icns` 与 `resources/pinekin.icns` 逐字节一致；`app.asar` 中 `resources/pinekin.png` 与源资产逐字节一致。
7. `npm run test:e2e`：18 项全部通过。新增真实 Electron PNG 解码测试检查 1024px 尺寸、四角 alpha=0，以及足量不透明黑色主体 / 白色底板。原有导入、导出、旧数据目录、两种深链和界面回归全部通过。
8. ICNS 经 `iconutil -c iconset` 反解，全部 10 个尺寸表示可读；ICO 图层尺寸与容器范围检查通过。已查看 PNG 母图和四档实际尺寸预览。
9. 后台窗口依旧隐藏、未激活、未聚焦；测试只使用合成数据及隔离 userData，系统文件对话框与剪贴板有替身。`git diff --check` 通过。

## 用户定稿替换验收（2026-10-17）

- 来源为本轮用户附件 `Icon-iOS-Default-1024@1x.png`；原图副本与运行时 PNG 保持 16-bit RGBA、1024px、透明边角，SHA-256 与本文件所列一致。
- 先补定稿一致性测试：旧资源出现 2 项预期失败（位深不一致、缺少用户定稿），其余 9 项通过。更新资产与生成脚本后，图标 / 品牌最小测试 14 项通过。
- `npm run typecheck`、`npm run test:coverage`、`npm run build` 全部通过。完整覆盖率 13 个文件、119 项测试；行 99.20%、分支 92.53%、语句 95.58%、函数 97.35%，不是全仓覆盖率。
- 未签名 macOS 应用目录重新打包成功，产物仍为 `release/mac-arm64/Pinekin.app`。运行时 PNG 与 ASAR 中 PNG 都与用户定稿逐字节一致；应用内 `icon.icns` 与本轮生成的 ICNS 一致，Info.plist 正确引用该图标。
- 相关后台 Electron E2E 1 项通过：解码后的全部像素与定稿一致，四角 alpha=0、中心不透明。未重复运行与资源替换无关的其他 17 项桌面场景，不把历史结果算作本轮重跑。
- 已更新并查看四档实际尺寸预览。16px 主要保留剪影；保留原 SVG 编辑稿及其预览，不自动重描摹用户的新图。
- 本轮未修改应用主进程 / IPC 行为，未重启正在运行的开发窗口、未覆盖已安装应用、未提交代码。Dock 中已加载的旧图仍需下一次启动主进程更新。

## macOS 尺寸与阴影修正验收（2026-10-17）

- 用户 Dock 截图中 Pinekin 明显大于相邻图标。原定稿 alpha 阈值 50% 的包围范围为 `1024×1024+0+0`；根因是将 iOS 满幅导出直接作为 Mac 静态图标，不是动物造型需要重画。
- 先补平台选择、Mac 专用资源与打包声明回归：旧实现 5 项预期失败、10 项通过。实现后图标 / 品牌 / 窗口策略最小测试 27 项通过，类型检查通过。
- 完整覆盖率：13 个文件、123 项通过；行 99.21%、分支 92.56%、语句 95.58%、函数 97.36%。生产构建与未签名 Mac 应用目录打包通过。
- 完整后台桌面 E2E 19 项通过，新增测试实测 alpha≥250 的底板边界为 `824×824+100+100`；画布四边透明，底部阴影存在且低于 25% alpha、比上方更明显。96px 显示下不透明底板宽高落在 76–78px，不再占满 96px。
- `release/mac-arm64/Pinekin.app` 内两种运行时 PNG 和 ICNS 均与本轮资源逐字节一致。ICNS 经系统工具反解后的 1024px 图也具有 `824×824+100+100` 底板，验证了容器本身而不仅是配置文件。
- 已查看 `pinekin-macos-comparison.png`，左为之前满幅版本，右为 Mac 适配版本，同为 96px 画布。该图是资源预览，不冒充用户桌面的实机截图。
- 原始定稿及通用 PNG 的校验值保持不变；没有重新设计松貂、修改来源客户端标识、读取真实会话或修改 IPC。

## README 页头 Banner（2026-10-22）

README 页头改用横幅，替代旧扁平版 `pinekin-app-icon.svg`。

| 文件 | 用途 |
| --- | --- |
| `design/brand/banner/pinekin-banner-bg.jpg` | 1280×720 氛围背景：右侧雾中松林、左侧留白；AI 生成（grok-imagine-image-2.0），提示词明确不含动物、文字和标志 |
| `design/brand/banner/pinekin-readme-banner.jpg` | 1600×600（8:3）成品，README 以 `width="100%"` 引用 |
| `design/brand/banner/pinekin-social-preview.jpg` | 1280×640（2:1）仓库 Social preview，同一排版放大图标与字号；需在 GitHub 仓库 Settings → General → Social preview 手动上传，API 不支持设置 |
| `scripts/generate-readme-banner.mjs` | 用 HTML 排版定稿图标与文字，再由本机 Google Chrome（Playwright `channel: 'chrome'`）以 2× 截图同时输出以上两张图 |

- 松貂直接使用 `pinekin-icon-approved.png` 原图，只等比缩放并加外投影，AI 不参与重绘图标。
- 标题与标语使用系统 SF / PingFang 字体排版，没有放进生成图里，避免 AI 生成文字出现错字或字形问题。
- 横幅自带浅色底，在 GitHub 深色模式下也是一张完整的浅色卡片，不依赖页面背景。
- 重新生成：`node scripts/generate-readme-banner.mjs`。需在 macOS 上安装 Google Chrome，不会下载 Playwright 浏览器。

## 未验收边界

- 未签名、公证，未生成 DMG 安装器，未做系统安装或升级。
- Windows / Linux 仅配置图标和检查资源，未实际打包或做原生系统验收。
- 未在前台人工检查 Finder / Dock 的系统缓存刷新；不通过重启 Dock、强杀应用或修改系统缓存来强制更新。
- 资源可提交，应用构建目录与测试截图受 `.gitignore` 排除；本轮未提交代码。
