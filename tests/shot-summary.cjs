const { chromium } = require('playwright-core')
const { findChromium, shot } = require('./helpers.cjs')
const PROJECTS = [{ id: 1, name: 'proj-one', repository: 'owner/proj-one', token: 't', openPrs: 0 }]
const FILES = [
  { filename: 'src/a.ts', patch: '+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n-x\n+y' },
  { filename: 'db/migrate.sql', patch: '+++ b/db/migrate.sql\n@@ -1,1 +1,2 @@\n-old\n+ALTER TABLE users ADD x;' },
]
const LOGS = [
  { id: 2, projectId: 1, projectName: 'proj-one', targetName: 'PR#7 测试', kind: 'test', prNumber: 7, host: 'local', output: 'running tests...\nFAIL a.spec\n[测试失败,退出码 1]', aiSummary: '整体失败:1 个测试断言失败。\n• a.spec 断言不匹配,疑为最近字段改动导致', success: 0, createdAt: '2026-09-30 12:00:00' },
]
;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/projects') return route.fulfill({ json: PROJECTS })
    if (path === '/api/settings') return route.fulfill({ json: { prHead: 'dock', prBase: 'master', mergeMethod: 'merge' } })
    if (path === '/api/pulls') return route.fulfill({ json: FILES.filter((file) => !file.filename.endsWith('.sql')).map((file) => ({ projectId: 1, projectName: 'proj-one', repository: 'o/p', token: 't', number: 7, title: 't', body: '', author: 'a', headRef: 'dock', baseRef: 'master', headSha: '', state: 'needs_test', statusNote: '包含 SQL 变更', aiResult: '', aiEvaluatedAt: '', createdAt: '', updatedAt: '' })) })
    if (path === '/api/gitee/pull-logs') return route.fulfill({ json: [] })
    if (path === '/api/gitee/pull-files') return route.fulfill({ json: FILES })
    if (path === '/api/gitee/pull-commits') return route.fulfill({ json: [] })
    if (path === '/api/sync/status') return route.fulfill({ json: [] })
    if (path === '/api/deployment/logs') return route.fulfill({ json: LOGS.map((row) => ({ ...row })) })
    return route.fulfill({ json: {} })
  })
  await page.goto(`${process.env.BASE_URL || 'http://localhost:5199'}/#/pulls`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  await page.locator('.pr-item').first().click()
  await page.waitForTimeout(400)
  await page.locator('.sidebar-tabs button', { hasText: '提交记录' }).click()
  await page.waitForTimeout(200)
  await page.screenshot({ path: shot('sql-pop-commits.png') })
  // 滚动验证 pop 跟随
  await page.evaluate(() => window.scrollTo(0, 300))
  await page.waitForTimeout(300)
  const popBox = await page.locator('.sql-pop').boundingBox()
  const checkFollow = popBox && popBox.y > -50 && popBox.y < 300
  console.log(checkFollow ? 'PASS pop 滚动后仍在视口合理位置' : `FAIL pop 位置异常 y=${popBox?.y}`)
  await browser.close()
  process.exit(checkFollow ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(1) })
