const { chromium } = require('playwright-core')
const { findChromium, shot, BASE_URL } = require('./helpers.cjs')
const PROJECTS = [
  { id: 1, name: 'proj-one', repository: 'owner/proj-one', token: 't', openPrs: 0 },
  { id: 2, name: 'proj-two', repository: 'owner/proj-two', token: 't', openPrs: 0 },
]
const LOGS = [
  { id: 3, projectId: 1, projectName: 'proj-one', endpoint: 'pulls/7/merge', method: 'PUT', ok: 0, status: 500, errorMessage: 'Gitee 500: 服务器内部错误', durationMs: 812, createdAt: '2026-09-29 15:20:11' },
  { id: 2, projectId: 2, projectName: 'proj-two', endpoint: 'pulls?state=all', method: 'GET', ok: 1, status: 200, errorMessage: '', durationMs: 340, createdAt: '2026-09-29 15:19:41' },
  { id: 1, projectId: 1, projectName: 'proj-one', endpoint: 'pulls/7/files', method: 'GET', ok: 1, status: 200, errorMessage: '', durationMs: 120, createdAt: '2026-09-29 15:19:40' },
]
const saved = { queries: [] }
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
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === '/api/projects') return route.fulfill({ json: PROJECTS })
    if (path === '/api/request-logs') {
      const projectId = Number(url.searchParams.get('projectId')) || 0
      const status = url.searchParams.get('status') || 'all'
      saved.queries.push({ projectId, status })
      let rows = LOGS
      if (projectId) rows = rows.filter((row) => row.projectId === projectId)
      if (status === 'ok') rows = rows.filter((row) => row.ok)
      if (status === 'error') rows = rows.filter((row) => !row.ok)
      return route.fulfill({ json: rows.map((row) => ({ ...row })) })
    }
    return route.fulfill({ json: {} })
  })

  await page.goto(`${BASE_URL}/#/logs`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(300)

  check('日志页渲染 3 条', (await page.locator('.log-row').count()) === 3)
  check('最新在前', (await page.locator('.log-row').first().textContent()).includes('15:20:11'))
  check('失败行标红且含错误信息', (await page.locator('.log-row.error').count()) === 1 && (await page.locator('.log-row.error .log-error').textContent()).includes('Gitee 500'))
  check('成功行含耗时', (await page.locator('.log-row').last().textContent()).includes('120ms'))
  await page.screenshot({ path: shot('logs.png') })

  // 项目筛选
  const filters = page.locator('.heading-actions .filter-select')
  await filters.first().locator('.dropdown-toggle').click()
  await page.locator('.dropdown-menu button', { hasText: 'proj-two' }).click()
  await page.waitForTimeout(200)
  check('项目筛选后仅 1 条', (await page.locator('.log-row').count()) === 1 && saved.queries.at(-1).projectId === 2)

  // 状态筛选
  await filters.first().locator('.dropdown-toggle').click()
  await page.locator('.dropdown-menu button', { hasText: '全部项目' }).click()
  await filters.nth(1).locator('.dropdown-toggle').click()
  await page.locator('.dropdown-menu button', { hasText: '仅失败' }).click()
  await page.waitForTimeout(200)
  check('状态筛选仅失败', (await page.locator('.log-row').count()) === 1 && saved.queries.at(-1).status === 'error')

  await browser.close()
  console.log(failures ? `\n${failures} failed` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
