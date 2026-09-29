const { chromium } = require('playwright-core')
const { findChromium, shot, BASE_URL } = require('./helpers.cjs')
const PROJECTS = [
  { id: 1, name: 'proj-one', repository: 'owner/proj-one', token: 't', openPrs: 0 },
]
let failures = 0

function check(name, cond) {
  if (cond) console.log(`PASS ${name}`)
  else { failures++; console.log(`FAIL ${name}`) }
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/projects') return route.fulfill({ json: PROJECTS })
    if (path === '/api/deployment/targets') return route.fulfill({ json: [] })
    if (path === '/api/settings') return route.fulfill({ json: { prHead: 'dock', prBase: 'master', mergeMethod: 'merge' } })
    if (path === '/api/meta') return route.fulfill({ json: { version: '9.9.9', dataPath: '/tmp/x' } })
    return route.fulfill({ json: {} })
  })

  await page.goto(`${BASE_URL}/#/deployments`, { waitUntil: 'networkidle' })
  check('hash 直开 #/deployments 生效', await page.locator('.deploy-group').isVisible())

  await page.locator('.topbar-nav .nav-item', { hasText: '设置' }).click()
  check('切换设置后 hash 更新', new URL(page.url()).hash === '#/settings')
  check('设置区块可见', await page.locator('.settings-section').first().isVisible())
  check('导航高亮正确', (await page.locator('.topbar-nav .nav-item.active').textContent()) === '设置')

  await page.reload({ waitUntil: 'networkidle' })
  check('刷新后仍在设置页', await page.locator('.settings-section').first().isVisible())

  await page.goto(`${BASE_URL}/#/whatever`, { waitUntil: 'networkidle' })
  check('非法 hash 回退项目页', await page.locator('.project-grid').isVisible())

  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' })
  check('无 hash 默认项目页', await page.locator('.project-grid').isVisible())
  await page.locator('.topbar-nav .nav-item', { hasText: /^PR$/ }).click()
  check('切换 PR 页 hash 正确', new URL(page.url()).hash === '#/pulls')

  await page.screenshot({ path: shot('nav.png') })
  await browser.close()
  console.log(failures ? `\n${failures} failed` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
