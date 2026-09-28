const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright')
  const dirs = fs.existsSync(cache)
    ? fs.readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : []
  for (const dir of dirs) {
    for (const bin of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const full = path.join(cache, dir, bin)
      if (fs.existsSync(full)) return full
    }
  }
  throw new Error('未找到 Chromium:请设置 CHROME_PATH 环境变量,或执行 pnpm exec playwright install chromium')
}

function shot(name) {
  const dir = path.join(__dirname, 'screenshots')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, name)
}

module.exports = { findChromium, shot, BASE_URL: process.env.BASE_URL || 'http://localhost:5199' }
