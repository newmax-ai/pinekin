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
