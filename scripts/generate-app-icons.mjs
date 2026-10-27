import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 仅在更新品牌资产时运行；普通开发、CI 和打包直接使用已生成的图标。
// 依赖 ImageMagick 7，以及 macOS 自带的 iconutil。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'design/brand/pinekin-icon-approved.png')
const output = join(root, 'resources')
const approved = readFileSync(source)
if (approved.length < 33 || approved.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    approved.readUInt32BE(16) !== 1024 || approved.readUInt32BE(20) !== 1024 || approved[25] !== 6) {
  throw new Error('图标定稿必须为 1024×1024 RGBA PNG；保留原有资源，停止生成。')
}
const temporary = mkdtempSync(join(tmpdir(), 'pinekin-icons-'))
const iconset = join(temporary, 'pinekin.iconset')

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} 退出码：${result.status}`)
}

try {
  mkdirSync(output, { recursive: true })
  mkdirSync(iconset)
  const master = join(output, 'pinekin.png')
  // 原样保留用户上传的光影、底板、颜色、透明通道及 16-bit 位深；不描摹、裁切或重建。
  copyFileSync(source, master)

  // macOS 静态 ICNS / Dock PNG 需要在画布内留边；不能直接套用 iOS 满幅导出。
  // 824px 是本项目的光学尺寸选择：1024px 画布四周留 100px，原稿内部比例不变。
  const tile = join(temporary, 'macos-tile.png')
  const shadowMask = join(temporary, 'macos-shadow-mask.png')
  const shadow = join(temporary, 'macos-shadow.png')
  const macMaster = join(output, 'pinekin-macos.png')
  run('magick', [master, '-filter', 'Lanczos', '-resize', '824x824', '-background', 'none',
    '-gravity', 'center', '-extent', '1024x1024', `PNG32:${tile}`])
  // 只按底板 alpha 制作外部软阴影，不修改松貂或底板已有的光影。
  run('magick', [tile, '-alpha', 'extract', '-blur', '0x12', '-evaluate', 'multiply', '0.24', '-strip', shadowMask])
  run('magick', ['-size', '1024x1024', 'xc:black', shadowMask, '-alpha', 'off',
    '-compose', 'CopyOpacity', '-composite', `PNG32:${shadow}`])
  run('magick', ['-size', '1024x1024', 'xc:none', shadow, '-geometry', '+0+10', '-compose', 'Over', '-composite',
    tile, '-geometry', '+0+0', '-compose', 'Over', '-composite', `PNG32:${macMaster}`])

  // Dock PNG 和所有 ICNS 尺寸均来自同一 macOS 母图，避免开发版与安装包不一致。
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
      run('magick', [macMaster, '-filter', 'Lanczos', '-resize', `${size * scale}x${size * scale}`,
        `PNG32:${join(iconset, name)}`])
    }
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', join(output, 'pinekin.icns')])
  run('magick', [master, '-depth', '8', '-define', 'icon:auto-resize=256,128,96,64,48,40,32,24,20,16', join(output, 'pinekin.ico')])
  console.log('已保留用户定稿，并生成 macOS 专用 PNG / ICNS 和 Windows ICO。')
} finally {
  // 当前目录始终为项目目录；临时清理失败不覆盖已经完成的资产生成结果。
  try { rmSync(temporary, { recursive: true, force: true }) }
  catch (error) { console.warn(`临时图标目录未清理：${temporary}`, error) }
}
