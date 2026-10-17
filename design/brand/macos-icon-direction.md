# Staithe · macOS App 图标设计依据

研究日期：2026-10-17。

## 核实的官方依据

本轮直接读取 Apple 官网与官方设计文档，不以此前对 macOS 版本的印象为依据。

- Apple 当前 macOS 产品页标题：`OS - macOS 27 Golden Gate - Apple`。
  - 来源：<https://www.apple.com/macos/>
- Apple Human Interface Guidelines：App icons。
  - 来源：<https://developer.apple.com/design/human-interface-guidelines/app-icons>
  - 可读取正文：<https://developer.apple.com/design/human-interface-guidelines/app-icons.md>
  - 页面变更记录最近一项为 2026-06-08：Refined guidance for Liquid Glass。
- Icon Composer 官方页面：<https://developer.apple.com/icon-composer/>

## 官方规范与本项目设计判断的区别

### 官方规范

1. iOS、iPadOS、macOS 图标以背景与一层或多层前景构成；系统提供高光、折射、半透明等 Liquid Glass 效果。
2. 简单而独特的核心概念、少量形状、清晰边缘优先；可以使用填充、叠合的形状建立深度，不依赖细线或复杂细节。
3. 导入 Icon Composer 的前景优先用矢量，背景应满幅且不透明。
4. 提交方形、未预裁切圆角的图层，最终遮罩由系统处理。当前规范的 macOS 图标布局尺寸为 1024 × 1024 px。
5. 不默认把高光、投影、倒角、模糊、发光烘焙进图层；这些效果主要由系统处理。必要的自定义效果需专门验证。
6. default、dark、clear、tinted 外观应保持核心造型一致，并检查各外观中的可辨识性。

### Staithe 的设计判断（不是 Apple 强制要求）

- 保留用户选定 B 方向的互补、嵌合关系，但不把前稿黑色构件仅换成玻璃材质。
- 将两块粗重零件改成两片宽幅、圆转、相扣的形体，以整体轮廓作为识别主体。
- 用蓝色实体与浅色半透明前景建立轻微前后关系，中央留出清楚的通道。
- 不引入船、船锚、下载托盘、双箭头、AI 环结或说明文字。
- 优先研究同一造型的默认与深色外观；避免四个近似符号反复排列。

## 本轮交付范围

生成静态 App 图标效果研究图，模拟浅色与深色环境下的观感。预期文件：`staithe-macos-icon-v4.png`；生成成功与否以工具返回为准。

此图不是矢量母版、独立分层资源、Icon Composer 工程、动态 Liquid Glass 实现或已验收的安装包图标。模拟图里显示的圆角和光影不能直接当作最终图层制作规范。

本轮不改应用代码、不替换应用图标、不启动前台应用、不宣称已通过 16/32 px 或 Dock 实机验收。项目现有未提交修改保持不动。

## 后续制作门槛

1. 确认可识别的主轮廓，再重建可控的矢量前景。
2. 将背景、前景、分组与材质配置分离，不从生成图假装拆出准确图层。
3. 在 Icon Composer 中检查默认、深色、透明、着色外观；验证项目实际打包链支持的交付格式，不预先声称 Electron 已支持。
4. 对实际导出的 16、32、64、128 px 图像做辨识度检查，不把生成图里的小图称为测试。
5. 实际 Dock 或前台系统验收须先征得用户同意。
