const { chromium } = require('playwright-core')
const { findChromium, shot, BASE_URL } = require('./helpers.cjs')
const PROJECTS = [{ id: 1, name: 'proj-one', repository: 'owner/proj-one', token: 't', openPrs: 3 }]
const PRS = [
  { number: 7, title: 'to master', user: { login: 'a' }, head: { ref: 'dock' }, base: { ref: 'master' } },
  { number: 8, title: 'to main', user: { login: 'b' }, head: { ref: 'feat' }, base: { ref: 'main' } },
  { number: 9, title: 'label form', user: { login: 'c' }, head: { label: 'owner:dev' }, base: { label: 'owner:MASTER' } },
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
    if (path === '/api/pulls') {
      const project = PROJECTS.find((item) => item.id === 1)
      return route.fulfill({ json: PRS.filter((pull) => pull.state !== 'merged' && pull.state !== 'closed').map((pull) => ({
        projectId: 1, projectName: project?.name ?? 'proj-one', repository: project?.repository ?? '', token: project?.token ?? '',
        number: pull.number, title: pull.title, body: pull.body ?? '', author: pull.user?.name ?? pull.user?.login ?? '',
        headRef: pull.head?.ref ?? pull.head?.label ?? '', baseRef: pull.base?.ref ?? pull.base?.label ?? '', headSha: pull.head?.sha ?? '',
        state: 'new', statusNote: '', createdAt: pull.created_at ?? '', updatedAt: pull.created_at ?? '',
      })) })
    }
    if (path === '/api/pulls/refresh') return route.fulfill({ json: { results: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: [] })
    if (path === '/api/gitee/pulls') return route.fulfill({ json: PRS })
    if (path === '/api/gitee/pull-logs') return route.fulfill({ json: [] })
    if (path === '/api/gitee/pull-files') return route.fulfill({ json: [] })
    return route.fulfill({ json: {} })
  })

  await page.goto(`${BASE_URL}/#/pulls`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(300)

  const first = page.locator('.pr-item').first()
  check('head 徽章显示短分支名(ref 优先)', (await first.locator('.branch-head').textContent()) === 'dock')
  check('base 徽章显示 master', (await first.locator('.branch-base').textContent()) === 'master')
  check('无 ref 时回退 label', (await page.locator('.pr-item').nth(2).locator('.branch-head').textContent()) === 'owner:dev')
  const bg = (loc) => loc.evaluate((el) => getComputedStyle(el).backgroundColor)
  check('head 徽章绿色', (await bg(first.locator('.branch-head'))) === 'rgb(218, 251, 225)')
  check('base master 变红', (await bg(first.locator('.branch-base'))) === 'rgb(255, 235, 233)')
  check('base main 变红', (await bg(page.locator('.pr-item').nth(1).locator('.branch-base'))) === 'rgb(255, 235, 233)')
  check('label owner:MASTER 大小写识别变红', (await bg(page.locator('.pr-item').nth(2).locator('.branch-base'))) === 'rgb(255, 235, 233)')
  check('合并方向箭头存在', (await first.locator('.branch-arrow').textContent()) === '→')
  await page.screenshot({ path: shot('branches.png') })

  await browser.close()
  console.log(failures ? `\n${failures} failed` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
