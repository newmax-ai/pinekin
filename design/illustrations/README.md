# Pinekin 本地收纳插画

## 素材与角色约束

- `pinekin-local-storage-character.png`：以第一版生图 `src/renderer/src/assets/pinekin-local-storage.png` 为参考，生成的收文件动作原稿。
- 品牌形象对照：`design/brand/pinekin-icon-approved.png`。
- 应用使用的文件：`src/renderer/src/assets/pinekin-local-storage.svg`。PNG 是制作原稿，不由界面加载。
- 保留第一版的长脸、小眼、圆耳、长颈、粗长尾巴及细腻线稿质感，只调整前爪与文件盒的关系；不重新设计成另一只动物。

## 制作方式

1. 使用图片生成能力编辑参考图，获得完整插画，而非直接手写 SVG 路径。
2. 将原稿归并为白色、轮廓灰褐、浅杏和陶土四类平面色，去除外部连通白底，保留角色与文件内部白色。
3. 裁去冗余留白，按比例居中于 1024 × 1024 画布，内容最长边 920px。
4. 各色层经 3px 中值滤波后分别用 VTracer 的 `binary` / `spline` 模式描摹，合并真实贝塞尔曲线路径；不以几何简笔画替代原图，也不使用 `<image>` 嵌入位图。
5. 按 `paper`、`apricot`、`ear`、`ink` 分层，以 SVG 内的 `prefers-color-scheme` 适配深浅主题，保持外部透明背景。

描摹参数：VTracer 0.6.15，`filter_speckle=12`、`corner_threshold=90`、`length_threshold=3.5`、`max_iterations=10`、`splice_threshold=45`、`path_precision=2`。SVG 的 `metadata` 记录生图原稿路径、SHA-256、裁切范围及参数，便于追溯。

## 验收边界

- 组件测试检查本地 SVG 引用、装饰语义、分色曲线路径、原稿哈希及无脚本 / 外链 / 位图嵌入。
- 后台 Electron 验收检查实际解码、透明边角、文件盒主题色及窄侧栏下文案与插画布局。
- 自动测试不判断角色是否获得用户认可；视觉一致性仍需对照 Logo 和第一版检查。
- 图像生成仅用于素材制作；应用运行时不请求图片生成服务，不增加 Python / VTracer 运行依赖。

## 空占位插画套件（2026-10-18）

- 原稿：`empty-states/source/pinekin-empty-states.png`，以当前定稿 app icon 为参考生成的六宫格。
- 六张生产 SVG：`src/renderer/src/assets/empty-states/`，分别为 `disconnected`、`empty`、`search`、`selection`、`unavailable`、`messages`。
- 复现脚本：`scripts/vectorize-empty-states.py`，使用已有 Pillow 11.3.0 与 VTracer 0.6.15 环境。等分格子、分色、去外部连通白底、真实曲线描摹与统一视觉边界；不嵌入位图，不补画暖色色块。
- 每张 `viewBox="0 0 512 512"`，真实内容最长边 400；大小约 31–62KB，内建深浅主题。元数据记录原稿哈希与描摹过程。
- `selection` 原稿身体轮廓局部开放，分色后该区域透底；保留真实线稿，不擅自补封闭轮廓。其他闭合纸白仍保留。角色细节属于首版美术，不以自动测试代替用户视觉确认。
- 显示规则、场景映射与验证见 [空占位规范](../../docs/empty-states.md)。本套素材不替换既有本地收纳插画或 app icon。
