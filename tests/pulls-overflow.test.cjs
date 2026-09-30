const { chromium } = require('playwright-core')
const { findChromium, shot, BASE_URL } = require('./helpers.cjs')
const PROJECTS = [{ id: 1, name: 'proj-one', repository: 'owner/proj-one', token: 't', openPrs: 45 }]
const PRS = Array.from({ length: 45 }, (_, i) => ({
  number: i + 1,
  title: `pr ${i + 1}`,
  user: { login: 'u' },
  head: { ref: `feat-${i + 1}` },
  base: { ref: 'master' },
  created_at: `2026-09-01T00:${String(i % 60).padStart(2, '0')}:00+08:00`,
}))
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
  await page.waitForTimeout(400)

  check('渲染 45 个 PR', (await page.locator('.pr-item').count()) === 45)

  const list = page.locator('.pr-list')
  const scroll = await list.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowY: getComputedStyle(el).overflowY }))
  check('列表内容超高且容器可滚动', scroll.scrollHeight > scroll.clientHeight && scroll.overflowY === 'auto')

  // 容器高度固定不被内容撑开(不溢出页面布局)
  const listBox = await list.boundingBox()
  check('容器高度固定不被撑开', listBox.height < scroll.scrollHeight && Math.abs(listBox.height - 2 - scroll.clientHeight) < 1)

  // 滚动到底后最后一项进入可视范围
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.waitForTimeout(200)
  const lastAfter = await page.locator('.pr-item').last().boundingBox()
  check('滚动到底可见最后一项', lastAfter.y >= listBox.y - 1 && lastAfter.y + lastAfter.height <= listBox.y + listBox.height + 2)
  await page.screenshot({ path: shot('pulls-overflow.png') })

  await browser.close()
  console.log(failures ? `\n${failures} failed` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
