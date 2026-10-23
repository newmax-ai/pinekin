# macOS 打包

只产出 Apple 芯片（arm64）DMG，不打 Intel 或 universal 包。Windows / Linux 安装包不在本范围。

```bash
npm run dist:mac   # typecheck + 构建 + 打包，产物 release/Pinekin-<version>-arm64.dmg
npm run pack       # 只生成 release/mac-arm64/Pinekin.app，不出 DMG
```

## 签名策略

`package.json` 的 `build.mac` 固定为 ad-hoc 签名：

| 配置 | 值 | 原因 |
| --- | --- | --- |
| `identity` | `-` | 不需要证书即可满足 Apple 芯片的签名要求；也避免 electron-builder 在缺少 Developer ID 时自动拾取钥匙串里的 `Apple Development` 证书，签出只能本机运行、却看似「已签名」的包 |
| `hardenedRuntime` | `false` | ad-hoc 签名无法公证，开启 hardened runtime 只会触发库校验导致启动失败 |
| `notarize` | `false` | 显式跳过，不因环境里恰好有 Apple 凭据而尝试公证 |

因此该 DMG **未经 Developer ID 签名和公证**。从网络下载后，Gatekeeper 会拦截首次打开，需要在「系统设置 → 隐私与安全性」中点「仍要打开」。适合自用和小范围测试，不适合公开分发。

## 正式分发：Developer ID 签名 + 公证

```bash
node scripts/dist-mac-signed.mjs --check   # 只校验凭据与钥匙串证书，不构建
npm run dist:mac:signed                    # typecheck + 构建 + 签名 + 公证，产物在 release/signed/
```

前置条件：

1. 钥匙串「登录」中已安装 `Developer ID Application` 证书（`.p12` 双击导入），`security find-identity -v -p codesigning` 能看到它。
2. 仓库根目录有 `.env.signing`（被 `.gitignore` 的 `.env.*` 忽略，权限建议 `600`），与 NewMax 主仓库共用同一份：

   ```bash
   APPLE_ID=...                       # Apple 开发者账号邮箱
   APPLE_APP_SPECIFIC_PASSWORD=...    # appleid.apple.com 生成的 App 专用密码
   APPLE_TEAM_ID=...                  # 10 位团队 ID
   CSC_NAME="Developer ID Application: <名称> (<团队 ID>)"
   ```

`scripts/dist-mac-signed.mjs` 在 `package.json` 的 `build` 配置上只覆盖签名相关字段，不改动自用包配置：

| 覆盖项 | 值 | 原因 |
| --- | --- | --- |
| `mac.identity` | `CSC_NAME` 去掉 `Developer ID Application:` 前缀 | electron-builder 要求无前缀名称；显式指定证书，不自动拾取钥匙串里的第一张 |
| `mac.hardenedRuntime` | `true` | 公证的硬性要求；未指定 entitlements，使用 electron-builder 内置的 Electron 默认值（JIT、未签名可执行内存、关闭库校验） |
| `mac.notarize` | `true` | 用 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 经 notarytool 公证并 staple 到 `.app` |
| `directories.output` | `release/signed` | 与 ad-hoc 产物分开，避免同名 DMG 互相覆盖 |

失败关闭：缺 `.env.signing`、缺任一变量、证书不是 `Developer ID Application`、证书团队与 `APPLE_TEAM_ID` 不一致或钥匙串里找不到证书时，脚本直接退出，不会退回 ad-hoc。外部环境里的 `CSC_NAME` / `CSC_LINK` / `CSC_KEY_PASSWORD` 会被清除，只用钥匙串中指定的证书。

公证报认证失败时，通常是 App 专用密码过期或被撤销，到 appleid.apple.com 重新生成后替换 `.env.signing` 中对应一行。DMG 本身不签名、不单独公证；里面的 `.app` 已 staple 公证票据，下载后可直接打开。

## 产物核验

不启动应用，只做静态检查：

```bash
A=release/mac-arm64/Pinekin.app
codesign --verify --deep --strict "$A"          # 签名完整
codesign -dv "$A" 2>&1 | grep Signature         # 应为 Signature=adhoc
lipo -archs "$A/Contents/MacOS/Pinekin"         # 应为 arm64
hdiutil verify release/Pinekin-*-arm64.dmg      # DMG 校验和有效
```

`spctl --assess` 对 ad-hoc 包返回 `rejected` 属于预期。

## 验证记录

2026-10-23，macOS arm64、Node.js 24.22.0、electron-builder 26.15.3、Electron 44.8.0：

- `npm run dist:mac` 成功，生成 `Pinekin-0.1.0-arm64.dmg`（约 131 MB）。
- `codesign --verify --deep --strict` 通过；`Signature=adhoc`、`TeamIdentifier=not set`，主程序仅 arm64。
- Info.plist：`CFBundleIdentifier=ai.newmax.staithe`、版本 `0.1.0`、`LSMinimumSystemVersion=13.0`、协议 `newmax-staithe` / `newmax-ember`。
- `app.asar` 含 `out/`、`resources/pinekin.png`、`resources/pinekin-macos.png` 与运行时依赖；`hdiutil verify` 通过。
- 未验证：安装后实际启动、首次打开的 Gatekeeper 流程、系统协议注册、覆盖安装升级。

签名分发包，同日同环境：

- `npm run dist:mac:signed` 成功，Developer ID 签名、`notarization successful`，生成 `release/signed/Pinekin-0.1.0-arm64.dmg`（约 132 MB）。
- `codesign --verify --deep --strict` 通过；`Authority=Developer ID Application`、`TeamIdentifier` 与证书一致、`flags=0x10000(runtime)`，带安全时间戳；主程序仅 arm64。
- `xcrun stapler validate` 通过；`spctl --assess --type execute` 为 `accepted`、`source=Notarized Developer ID`；`hdiutil verify` 通过。
- 证书必须位于「登录」钥匙串：装进「系统」钥匙串时每个文件签名都会弹管理员授权且无法记住。
- 未验证：从网络下载 DMG 后的实际安装与启动、系统协议注册、覆盖安装升级。
