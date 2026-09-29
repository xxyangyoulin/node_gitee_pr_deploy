const { chromium } = require('playwright-core')
const { findChromium, shot, BASE_URL } = require('./helpers.cjs')
const PROJECTS = [
  { id: 1, name: 'proj-one', repository: 'owner/proj-one', token: 't', openPrs: 1 },
  { id: 2, name: 'proj-two', repository: 'owner/proj-two', token: 't', openPrs: 3 },
]
const PRS_ONE = [{ number: 7, title: 'one feature', user: { login: 'alice' }, head: { ref: 'dock' }, base: { ref: 'master' }, created_at: '2026-09-20T10:30:00+08:00' }]
const PRS_TWO = [
  { number: 13, title: 'chore deps', user: { login: 'dave' }, head: { ref: 'chore-x' }, base: { ref: 'dock' }, created_at: '2026-09-28T09:00:00+08:00' },
  { number: 12, title: 'two fix', user: { login: 'carol' }, head: { ref: 'fix-y' }, base: { ref: 'master' }, created_at: '2026-09-27T23:59:00+08:00' },
  { number: 11, title: 'two feature', user: { login: 'bob' }, head: { ref: 'feat-x' }, base: { ref: 'main' }, created_at: '2026-09-25T08:05:00+08:00' },
]
const saved = { approves: [], merges: [], tests: [], creates: [], runs: [] }
const mergedNumbers = []
let createdNumber = 13
let merge14Failed = false
let target22Failed = false
let projTwoPullsFail = false
const deployLogs = [{ id: 1, projectId: 2, projectName: 'proj-two', host: 'deploy@a.com', output: 'old run', success: 1, createdAt: '2026-09-01 10:00:00' }]
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
    const req = route.request()
    const path = new URL(req.url()).pathname
    if (path === '/api/projects') return route.fulfill({ json: PROJECTS })
    if (path === '/api/settings') return route.fulfill({ json: { prHead: 'dock', prBase: 'master', mergeMethod: 'merge' } })
    if (path === '/api/gitee/pulls') {
      const repository = req.postDataJSON().repository
      if (projTwoPullsFail && repository === 'owner/proj-two') return route.fulfill({ status: 500, json: { message: 'mock token 失效' } })
      return route.fulfill({ json: repository === 'owner/proj-one' ? PRS_ONE : PRS_TWO.filter((pull) => !mergedNumbers.includes(pull.number)) })
    }
    if (path === '/api/gitee/approve-pull') { saved.approves.push(req.postDataJSON()); return route.fulfill({ json: {} }) }
    if (path === '/api/gitee/test-pull') { saved.tests.push(req.postDataJSON()); return route.fulfill({ json: {} }) }
    if (path === '/api/gitee/merge-pull') {
      const input = req.postDataJSON()
      saved.merges.push(input)
      mergedNumbers.push(input.number)
      return route.fulfill({ json: {} })
    }
    if (path === '/api/gitee/create-pull') {
      const input = req.postDataJSON()
      saved.creates.push(input)
      createdNumber += 1
      PRS_TWO.push({ number: createdNumber, title: input.title, user: { login: 'dave' }, head: { ref: input.head }, base: { ref: input.base }, created_at: '2026-09-28T09:30:00+08:00' })
      return route.fulfill({ json: {} })
    }
    if (path === '/api/deployment/logs') {
      const url = new URL(req.url())
      const projectId = Number(url.searchParams.get('projectId')) || 0
      const rows = projectId ? deployLogs.filter((log) => log.projectId === projectId) : deployLogs
      return route.fulfill({ json: rows.slice(0, Number(url.searchParams.get('limit')) || 20).map((log) => ({ ...log })) })
    }
    if (path === '/api/deployment/run') {
      const targetId = req.postDataJSON().targetId
      saved.runs.push(targetId)
      if (targetId === 22 && !target22Failed) { target22Failed = true; return route.fulfill({ status: 500, json: { message: 'mock 目标宕机' } }) }
      deployLogs.unshift({ id: deployLogs.length + 1, projectId: 2, projectName: 'proj-two', targetName: targetId === 21 ? 'web-1' : 'web-2', host: 'deploy@a.com', output: 'deploy out\n[部署完成]', success: 1, createdAt: '2026-09-28 12:00:00' })
      return route.fulfill({ json: 'deploy out\n[部署完成]' })
    }
    if (path === '/api/gitee/pull-logs') return route.fulfill({ json: [] })
    if (path === '/api/gitee/pull-files') return route.fulfill({ json: [] })
    if (path === '/api/deployment/targets') return route.fulfill({ json: [
      { id: 11, projectId: 1, projectName: 'proj-one', name: 'main-1', host: 'a.com', username: 'deploy', remotePath: '/srv/one', command: './deploy.sh', position: 0 },
      { id: 21, projectId: 2, projectName: 'proj-two', name: 'web-1', host: 'a.com', username: 'deploy', remotePath: '/srv/two', command: './deploy.sh', position: 0 },
      { id: 22, projectId: 2, projectName: 'proj-two', name: 'web-2', host: 'b.org', username: 'root', remotePath: '/srv/two', command: './deploy.sh', position: 1 },
    ] })
    return route.fulfill({ json: {} })
  })

  await page.goto(`${BASE_URL}/#/pulls`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)

  check('PR 页聚合 4 个 PR(跨 2 个项目)', (await page.locator('.pr-item').count()) === 4)
  const badges = await page.locator('.pr-item .project-badge').allTextContents()
  check('每个 PR 标注所属项目', JSON.stringify(badges) === JSON.stringify(['proj-two', 'proj-two', 'proj-two', 'proj-one']))
  check('按创建时间倒序排列', (await page.locator('.pr-item strong').first().textContent()).includes('#13'))
  check('列表显示创建时间', (await page.locator('.pr-item').first().locator('.pr-time').textContent()) === '2026-09-28 09:00')
  await page.screenshot({ path: shot('pulls-aggregate.png') })

  await page.locator('.filter-select .dropdown-toggle').click()
  await page.locator('.dropdown-menu button', { hasText: 'proj-two' }).click()
  await page.waitForTimeout(100)
  check('筛选后仅显示该项目 PR', (await page.locator('.pr-item').count()) === 3)
  await page.locator('.filter-select .dropdown-toggle').click()
  await page.locator('.dropdown-menu button', { hasText: '全部项目' }).click()
  await page.waitForTimeout(100)

  // 选中 非 dock→dock 的 PR:显示一键 master
  await page.locator('.pr-item').first().click()
  await page.waitForTimeout(400)
  check('选中行高亮', (await page.locator('.pr-item.selected').count()) === 1)
  check('标题栏显示已选 PR', (await page.locator('.page-heading .selected-project-badge').textContent()) === 'proj-two' && (await page.locator('.page-heading .selected-pr-ref').textContent()).includes('#13'))
  check('标题栏项目徽章为紫色高亮', (await page.locator('.page-heading .selected-project-badge').evaluate((el) => getComputedStyle(el).backgroundColor)) === 'rgb(251, 239, 255)')
  const oneClickBtn = page.locator('.heading-actions button', { hasText: '一键 master' })
  check('非 dock→dock 显示一键 master', (await oneClickBtn.count()) === 1)

  // 一键部署:两击确认 → 进度弹窗在当前页显示步骤与部署日志
  const oneDeployBtn = page.locator('.heading-actions button.one-click', { hasText: '一键部署' })
  check('一键部署按钮显示', (await oneDeployBtn.count()) === 1)
  await oneDeployBtn.click()
  check('一键部署首击进入确认态', (await page.locator('.heading-actions button.confirming', { hasText: '再次点击确认' }).count()) === 1)
  await page.locator('.heading-actions button.confirming').click()
  await page.waitForTimeout(2500)
  check('仍在当前页面(未跳转部署页)', new URL(page.url()).hash === '#/pulls')
  check('进度弹窗已打开', await page.locator('.one-click-modal').isVisible())
  console.log('实际 runs 序列:', JSON.stringify(saved.runs), '| 弹窗步骤:', JSON.stringify(await page.locator('.progress-steps li').allTextContents()))
  check('逐台执行且失败终止', JSON.stringify(saved.runs) === JSON.stringify([21, 22]))
  check('失败步骤标红', (await page.locator('.progress-steps li.failed').count()) === 1 && (await page.locator('.progress-steps li.failed').textContent()).includes('执行部署'))
  check('重试按钮出现', (await page.locator('.one-click-modal button', { hasText: '重试' }).count()) === 1)

  // 重试:跳过已完成步骤与已部署目标,从失败处继续
  await page.locator('.one-click-modal button', { hasText: '重试' }).click()
  await page.waitForTimeout(2500)
  check('重试后 4 步全部完成', (await page.locator('.progress-steps li.done').count()) === 4)
  check('阶段一合并 #13', saved.merges[0]?.number === 13)
  check('自动创建 dock→master PR', saved.creates.at(-1)?.repository === 'owner/proj-two' && saved.creates.at(-1)?.head === 'dock' && saved.creates.at(-1)?.base === 'master' && saved.creates.at(-1)?.title === 'chore deps')
  check('阶段二合并新建 PR #14', JSON.stringify(saved.merges.map((item) => item.number)) === JSON.stringify([13, 14]))
  check('重试未重复前置步骤', saved.creates.length === 1)
  check('重试仅重跑失败目标 web-2', JSON.stringify(saved.runs) === JSON.stringify([21, 22, 22]))
  check('审查+测试覆盖两个 PR(重试合法重复)', JSON.stringify([...new Set(saved.approves.map((item) => item.number))].sort((a, b) => a - b)) === JSON.stringify([13, 14]) && saved.approves.at(-1)?.number === 14 && saved.tests.at(-1)?.number === 14)
  check('弹窗内显示部署日志', (await page.locator('.one-click-modal .deploy-output').textContent()).includes('[部署完成]'))
  check('弹窗显示部署目标(项目2 web-2)', (await page.locator('.deploy-target-info').first().textContent()).includes('web-2'))
  check('弹窗显示上次部署记录(重试后为最新一次)', (await page.locator('.deploy-target-info').last().textContent()).includes('2026-09-28 12:00:00'))
  await page.locator('.one-click-modal button', { hasText: '关闭' }).click()
  check('关闭进度弹窗', (await page.locator('.one-click-modal').count()) === 0)
  await page.screenshot({ path: shot('pulls-oneclick.png') })

  // 选中 dock→master 的 PR:不显示一键 master
  await page.locator('.pr-item', { hasText: '#7' }).click()
  await page.waitForTimeout(400)
  check('dock→master 不显示一键 master', (await page.locator('.heading-actions button', { hasText: '一键 master' }).count()) === 0)
  check('dock→master 显示一键部署', (await page.locator('.heading-actions button', { hasText: '一键部署' }).count()) === 1)

  // dock→master 的一键部署:直接合并当前 PR 后执行部署(不创建二级 PR)
  const mergesBeforeDirect = saved.merges.length
  const createsBeforeDirect = saved.creates.length
  await page.locator('.heading-actions button', { hasText: '一键部署' }).click()
  await page.locator('.heading-actions button.confirming').click()
  await page.waitForTimeout(2500)
  check('直连流程仅合并当前 PR #7', saved.merges.length === mergesBeforeDirect + 1 && saved.merges.at(-1)?.number === 7)
  check('未创建二级 PR', saved.creates.length === createsBeforeDirect)
  check('部署已执行', saved.runs.at(-1) === 11)
  check('进度弹窗 2 步全部完成', (await page.locator('.progress-steps li.done').count()) === 2)
  check('弹窗显示部署日志', (await page.locator('.one-click-modal .deploy-output').textContent()).includes('[部署完成]'))
  check('弹窗显示部署目标(项目1)', (await page.locator('.deploy-target-info').textContent()).includes('/srv/one'))
  await page.locator('.one-click-modal button', { hasText: '关闭' }).click()

  // 普通 PR 两击合并(确认超时还原)
  await page.locator('.pr-item', { hasText: '#12' }).click()
  await page.waitForTimeout(400)
  const mergeBtn = page.locator('.merge-action')
  const mergesBefore = saved.merges.length
  await mergeBtn.click()
  check('首次点击进入确认态', (await mergeBtn.textContent()).includes('再次点击确认合并'))
  await page.waitForTimeout(2300)
  check('2 秒后未点击自动还原', (await mergeBtn.textContent()).includes('一键审查、测试并合并'))
  check('超时未触发合并', saved.merges.length === mergesBefore)
  await mergeBtn.click(); await mergeBtn.click()
  await page.waitForTimeout(300)
  check('二次点击执行合并(仅 mock)', saved.merges.at(-1)?.repository === 'owner/proj-two' && saved.merges.at(-1)?.number === 12)

  await page.screenshot({ path: shot('pulls-final.png') })

  // 项目加载失败警告条
  projTwoPullsFail = true
  await page.locator('.heading-actions button', { hasText: '刷新' }).click()
  await page.waitForTimeout(500)
  check('项目加载失败显示警告条', (await page.locator('.load-warning').count()) === 1 && (await page.locator('.load-warning').textContent()).includes('proj-two') && (await page.locator('.load-warning').textContent()).includes('mock token 失效'))
  projTwoPullsFail = false
  await page.locator('.heading-actions button', { hasText: '刷新' }).click()
  await page.waitForTimeout(500)
  check('恢复后警告条消失', (await page.locator('.load-warning').count()) === 0)

  await browser.close()
  console.log(failures ? `\n${failures} failed` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
