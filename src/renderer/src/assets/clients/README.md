# 来源客户端图标

2026-10-17 按用户要求加入本地静态图标。运行时不请求外部图片，不读取客户端安装目录。所有图标仅用于标识档案来源，不表示连接、迁移支持或品牌背书。

| 文件 | 实际标识 | 本次只读来源与转换 |
| --- | --- | --- |
| `newmax.svg` | NewMax 符号 | `newmax-client/src/components/ui/LogoSymbolMark.tsx` 的 `NEWMAX_SYMBOL_PATH`；viewBox `0 0 40 40` |
| `claude.svg` | Claude 品牌太阳花，用于 Claude Code 来源 | `newmax-client/src/components/icons/ProviderLogo.tsx` 的 `default/anthropic` 分支；viewBox `0 0 1200 1200` |
| `openai.svg` | OpenAI 品牌标识，用于 Codex 来源 | 同上 `openai` 分支；viewBox `0 0 159 158`。本机标准路径没有 Codex.app，本文件不是从 Codex 桌面应用提取的专属图标 |
| `deepseek.svg` | DeepSeek 鲸鱼 | 同上 `deepseek` 分支；viewBox `0 0 512 509.64` |
| `cindy.png` | Cindy 桌面应用图标 | `/Applications/Cindy.app/Contents/Info.plist` 指定的 `Resources/electron.icns`，用系统 `sips` 转为 64×64 PNG；没有读取会话或凭据 |

SVG 只提取静态 viewBox、fill 和 path 数值，不复制 TSX 组件、脚本、事件、外链或宿主依赖。NewMax / OpenAI 为单色，在系统深色主题下反色；Claude、DeepSeek 和 Cindy 保留原色。`其他来源` 使用通用档案图标，不伪造品牌。

品牌名称与标识属于相应权利人。这里记录来源，不为上游素材授予新许可证；发布再分发时需核对适用的品牌与资产使用条款。
