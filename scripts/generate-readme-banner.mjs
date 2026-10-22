import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

// 仅在更新 README 页头或仓库 Social preview 时运行。图标使用用户定稿原图，不重绘；背景为无文字、无动物的氛围图。
// 文字由系统字体排版，因此需在装有 SF / PingFang 与 Google Chrome 的 macOS 上运行。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const brand = join(root, 'design/brand')

// 两种输出共用排版，以 CSS 像素定义、2× 截图：README 横幅 1600×600，Social preview 1280×640（GitHub 推荐 2:1）。
const variants = [
  { file: 'pinekin-readme-banner.jpg', width: 800, height: 300, pad: 76, gap: 30, icon: 148, title: 62, tagline: 25, meta: 13 },
  { file: 'pinekin-social-preview.jpg', width: 640, height: 320, pad: 56, gap: 28, icon: 156, title: 64, tagline: 26, meta: 14 },
]

const dataUri = (file, type) => `data:${type};base64,${readFileSync(file).toString('base64')}`
const icon = dataUri(join(brand, 'pinekin-icon-approved.png'), 'image/png')
const background = dataUri(join(brand, 'banner/pinekin-banner-bg.jpg'), 'image/jpeg')

const html = (v) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${v.width}px; height: ${v.height}px; overflow: hidden; }
  body {
    position: relative;
    background: #f4f3f1 url('${background}') center / cover no-repeat;
    font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  body::before {
    content: ''; position: absolute; inset: 0;
    background: linear-gradient(90deg, rgba(244,243,241,.92) 0%, rgba(244,243,241,.7) 48%, rgba(244,243,241,0) 78%);
  }
  .row { position: absolute; inset: 0; display: flex; align-items: center; gap: ${v.gap}px; padding-left: ${v.pad}px; }
  img { width: ${v.icon}px; height: ${v.icon}px; filter: drop-shadow(0 10px 16px rgba(0,0,0,.14)); }
  h1 { font-size: ${v.title}px; font-weight: 700; letter-spacing: -0.025em; color: #1d1d1f; line-height: 1; }
  .tagline { margin-top: 14px; font-size: ${v.tagline}px; font-weight: 500; color: #2c2c2e; letter-spacing: 0.04em; }
  .meta { margin-top: 12px; font-size: ${v.meta}px; color: #86868b; letter-spacing: 0.06em; }
</style></head><body>
  <div class="row">
    <img src="${icon}" alt="">
    <div>
      <h1>Pinekin</h1>
      <p class="tagline">换个地方，继续思考。</p>
      <p class="meta">本地优先 · 跨 App 会话接续 · macOS</p>
    </div>
  </div>
</body></html>`

// 使用本机 Google Chrome，避免为一次性品牌资产下载 Playwright 浏览器。
const browser = await chromium.launch({ channel: 'chrome' })
try {
  for (const v of variants) {
    const output = join(brand, 'banner', v.file)
    const page = await browser.newPage({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: 2 })
    await page.setContent(html(v))
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: output, type: 'jpeg', quality: 90 })
    await page.close()
    console.log(output)
  }
} finally {
  await browser.close()
}
