const { chromium } = require('playwright-core')
const { findChromium, shot, BASE_URL } = require('./helpers.cjs')
const PROJECTS = [
  { id: 1, name: 'proj-one', repository: 'owner/proj-one', token: 't', openPrs: 1 },
  { id: 2, name: 'proj-two', repository: 'owner/proj-two', token: 't', openPrs: 3 },
]
const PRS_ONE = [{ number: 7, title: 'one feature', user: { login: 'alice' }, head: { ref: 'dock' }, base: { ref: 'master' }, created_at: '2026-09-20T10:30:00+08:00', state: 'open' }]
const PRS_TWO = [
  { number: 13, title: 'chore deps', user: { login: 'dave' }, head: { ref: 'chore-x' }, base: { ref: 'dock' }, created_at: '2026-09-28T09:00:00+08:00' },
  { number: 16, title: 'cancel case', user: { login: 'erin' }, head: { ref: 'cancel-x' }, base: { ref: 'dock' }, created_at: '2026-09-18T09:00:00+08:00' },
  { number: 12, title: 'two fix', user: { login: 'carol' }, head: { ref: 'fix-y' }, base: { ref: 'master' }, created_at: '2026-09-27T23:59:00+08:00' },
  { number: 11, title: 'two feature', user: { login: 'bob' }, head: { ref: 'feat-x' }, base: { ref: 'main' }, created_at: '2026-09-25T08:05:00+08:00' },
]
const saved = { approves: [], merges: [], tests: [], creates: [], runs: [], evaluates: [], testRuns: [], refreshes: [], draftToggles: [] }
const mergedNumbers = []
let createdNumber = 13
let merge14Failed = false
let slowRefresh = false
let target22Failed = false
let projTwoPullsFail = false
const deployLogs = [{ id: 1, projectId: 2, projectName: 'proj-two', targetName: 'PR#13 测试', kind: 'test', prNumber: 13, host: 'local', output: 'running...\n[测试通过]', aiSummary: '整体通过:全部用例成功。\n• 无失败项', success: 1, createdAt: '2026-09-30 12:00:00' }]
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
    if (path === '/api/pulls') {
      const open = [...PRS_ONE, ...PRS_TWO, { number: 4, title: 'chore deps', state: 'merged', merged: true, user: { name: 'old' }, head: { ref: 'dock' }, base: { ref: 'master' }, created_at: '2026-09-01T00:00:00+08:00', __project: 2 }].filter((pull) => !mergedNumbers.includes(pull.number))
      const ended = [
        { number: 5, title: 'old feature', state: 'merged', user: { name: 'erin' }, head: { ref: 'feat-old' }, base: { ref: 'master' }, created_at: '2026-09-10T08:00:00+08:00', __project: 1 },
        { number: 6, title: 'abandoned', state: 'closed', user: { name: 'frank' }, head: { ref: 'wip' }, base: { ref: 'master' }, created_at: '2026-09-11T08:00:00+08:00', __project: 2 },
      ]
      return route.fulfill({ json: [...open, ...ended].flatMap((pull) => {
        const isOne = pull.__project ? pull.__project === 1 : PRS_ONE.includes(pull)
        return [{
          projectId: isOne ? 1 : 2,
          projectName: isOne ? 'proj-one' : 'proj-two',
          repository: isOne ? 'owner/proj-one' : 'owner/proj-two',
          token: 't',
          number: pull.number,
          title: pull.title,
          body: '',
          author: pull.user?.name || '',
          headRef: pull.head?.ref || '',
          baseRef: pull.base?.ref || '',
          headSha: pull.head?.sha || '',
          mergeable: pull.number === 13 ? 0 : 1,
          draft: pull.number === 12 ? 1 : 0,
          state: (pull.state ?? 'open') === 'open' ? (pull.number === 13 ? 'needs_test' : pull.number === 12 ? 'ai_reviewing' : 'new') : (pull.state || 'new'),
          statusNote: pull.number === 13 ? '包含 SQL 变更' : '',
          aiResult: pull.number === 13 ? JSON.stringify({ needs_test: true, reason: '包含 SQL 变更', risk_level: 'high' }) : '',
          aiEvaluatedAt: '',
          createdAt: pull.created_at,
          updatedAt: pull.created_at,
        }]
      }) })
    }
    if (path === '/api/gitee/toggle-draft') { saved.draftToggles.push(req.postDataJSON()); return route.fulfill({ json: {} }) }
    if (path === '/api/test/configs') return route.fulfill({ json: [{ project_id: 2, server_mode: 'ssh', host: 'a.com', username: 'deploy', workdir_template: '~/TEST/{project}_{pr}', commands: '[{"label":"全量","command":"vendor/bin/phpunit tests"}]', ai_decides: 0, ai_prompt: '', timeout_sec: 600, projectName: 'proj-two' }] })
    if (path === '/api/test/run') { saved.testRuns.push(req.postDataJSON()); deployLogs.unshift({ id: deployLogs.length + 1, projectId: 2, projectName: 'proj-two', targetName: 'PR#13 测试', kind: 'test', prNumber: 13, host: 'local', output: 'running...\n[测试通过]', aiSummary: '整体通过:全部用例成功。\n• 无失败项', success: 1, createdAt: '2026-09-30 13:00:00' }); return route.fulfill({ json: 'running...\n[测试通过]' }) }
    if (path === '/api/deployment/run') {
      const targetId = req.postDataJSON().targetId
      saved.runs.push(targetId)
      if (targetId === 22 && !target22Failed) { target22Failed = true; return route.fulfill({ status: 500, json: { message: 'mock 目标宕机' } }) }
      deployLogs.unshift({ id: deployLogs.length + 1, projectId: 2, projectName: 'proj-two', targetName: targetId === 21 ? 'web-1' : 'web-2', kind: 'deploy', prNumber: 0, host: 'deploy@a.com', output: 'deploy out\n[部署完成]', aiSummary: '', success: 1, createdAt: '2026-09-28 12:00:00' })
      return route.fulfill({ json: 'deploy out\n[部署完成]' })
    }
    if (path === '/api/pr/evaluate') {
      const input = req.postDataJSON()
      saved.evaluates.push(input)
      const verdict = { needs_test: input.number === 13, reason: input.number === 13 ? '包含 SQL 变更' : '文档变更无需测试', risk_level: input.number === 13 ? 'high' : 'low' }
      return route.fulfill({ json: { verdict } })
    }
    if (path === '/api/pulls/refresh') {
      const payload = req.postDataJSON().projectId ?? 0
      if (slowRefresh) return new Promise((resolve) => setTimeout(() => resolve(route.fulfill({ json: { results: [] } })), 900))
      saved.refreshes.push(payload)
      if (projTwoPullsFail) return route.fulfill({ json: { results: [{ projectId: 2, name: 'proj-two', error: 'mock token 失效' }] } })
      return route.fulfill({ json: { results: [{ projectId: 1, name: 'proj-one', error: '' }, { projectId: 2, name: 'proj-two', error: '' }] } })
    }
    if (path === '/api/sync/status') {
      return route.fulfill({ json: [
        { projectId: 1, name: 'proj-one', lastSyncAt: '2026-09-29 10:00:00', lastError: projTwoPullsFail ? '' : '', enabled: 1 },
        { projectId: 2, name: 'proj-two', lastSyncAt: '2026-09-29 10:00:00', lastError: projTwoPullsFail ? 'mock token 失效' : '', enabled: 1 },
      ] })
    }
    if (path === '/api/gitee/pulls') {
      const repository = req.postDataJSON().repository
      return route.fulfill({ json: repository === 'owner/proj-one' ? PRS_ONE : PRS_TWO.filter((pull) => !mergedNumbers.includes(pull.number)) })
    }
    if (path === '/api/gitee/approve-pull') { saved.approves.push(req.postDataJSON()); return route.fulfill({ json: {} }) }
    if (path === '/api/gitee/test-pull') { saved.tests.push(req.postDataJSON()); return route.fulfill({ json: {} }) }
    if (path === '/api/gitee/merge-pull') {
      const input = req.postDataJSON()
      if (input.number === 15) return route.fulfill({ status: 405, json: { message: 'Pull Request 已合并或已关闭。' } })
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

  check('PR 页聚合 5 个 PR(跨 2 个项目)', (await page.locator('.pr-item').count()) === 5)
  const badges = await page.locator('.pr-item .project-badge').allTextContents()
  check('每个 PR 标注所属项目', JSON.stringify(badges) === JSON.stringify(['proj-two', 'proj-two', 'proj-two', 'proj-one', 'proj-two']))
  check('按创建时间倒序排列', (await page.locator('.pr-item strong').first().textContent()).includes('#13'))
  check('列表显示创建时间', (await page.locator('.pr-item').first().locator('.pr-time').textContent()) === '2026-09-28 09:00')
  await page.screenshot({ path: shot('pulls-aggregate.png') })

  // 选中 PR 写入 URL;刷新后恢复选中
  await page.locator('.pr-item').first().click()
  await page.waitForTimeout(300)
  check('选中后 URL 带 PR 标识', new URL(page.url()).hash === '#/pulls/2/13')
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  check('刷新后仍选中该 PR', (await page.locator('.pr-item.selected strong').textContent()).includes('#13'))

  await page.locator('.filter-select .dropdown-toggle').click()
  await page.locator('.dropdown-menu button', { hasText: 'proj-two' }).click()
  await page.waitForTimeout(100)
  check('筛选后仅显示该项目 PR', (await page.locator('.pr-item').count()) === 4)
  await page.locator('.filter-select .dropdown-toggle').click()
  await page.locator('.dropdown-menu button', { hasText: '全部项目' }).click()
  await page.waitForTimeout(100)

  // 双击分支徽章复制(不触发行选中)
  const selectedBefore = await page.locator('.pr-item.selected').count()
  await page.locator('.pr-item').first().locator('.branch-head').dblclick()
  await page.waitForTimeout(400)
  check('双击复制后 toast 提示', (await page.locator('.toast').textContent().catch(() => '')).includes('已复制分支'))
  check('双击复制不触发行选中', (await page.locator('.pr-item.selected').count()) === selectedBefore)

  // 分组 tab:默认进行中(不含已结束),可切换已结束
  check('默认进行中 tab 不含已结束 PR', (await page.locator('.pr-item', { hasText: '#5' }).count()) === 0 && (await page.locator('.pr-item').count()) === 5)
  await page.locator('.pr-list-tabs button', { hasText: '已结束' }).click()
  await page.waitForTimeout(100)
  check('已结束 tab 展示历史 PR', (await page.locator('.pr-item').count()) === 3 && (await page.locator('.pr-item', { hasText: 'old feature' }).count()) === 1 && (await page.locator('.pr-item', { hasText: '#4' }).count()) === 1)
  check('已结束徽章标注', (await page.locator('.pr-item', { hasText: 'old feature' }).locator('.state-badge').textContent()) === '已合并')
  await page.locator('.pr-list-tabs button', { hasText: '进行中' }).click()
  await page.waitForTimeout(100)
  check('切回进行中恢复', (await page.locator('.pr-item').count()) === 5)

  // 选中 非 dock→dock 的 PR:显示一键 master
  await page.locator('.pr-item').first().click()
  await page.waitForTimeout(400)
  check('折叠态显示摘要行', await page.locator('.automation-summary-row').isVisible())
  await page.locator('.automation-summary-row').click()
  await page.waitForTimeout(100)
  check('Gitee 跳转链接存在', (await page.locator('.pr-item').first().locator('.gitee-link').getAttribute('href')) === 'https://gitee.com/owner/proj-two/pulls/13')
  check('冲突 PR 显示冲突标记', (await page.locator('.pr-item', { hasText: '#13' }).locator('.conflict-chip').count()) === 1)
  check('草稿 PR 显示草稿标记', (await page.locator('.pr-item', { hasText: '#12' }).locator('.draft-chip').count()) === 1)
  check('无冲突 PR 不显示标记', (await page.locator('.pr-item', { hasText: '#12' }).locator('.conflict-chip').count()) === 0)
  check('选中行高亮', (await page.locator('.pr-item.selected').count()) === 1)
  check('标题栏显示已选 PR', (await page.locator('.page-heading .selected-project-badge').textContent()) === 'proj-two' && (await page.locator('.page-heading .selected-pr-ref').textContent()).includes('#13'))
  check('标题栏项目徽章为紫色高亮', (await page.locator('.page-heading .selected-project-badge').evaluate((el) => getComputedStyle(el).backgroundColor)) === 'rgb(251, 239, 255)')
  const aiRow = page.locator('.automation-row').first()
  check('自动化面板 AI 行展示结论', (await aiRow.textContent()).includes('需要测试') && (await aiRow.textContent()).includes('包含 SQL 变更'))
  check('高风险结论红色徽章', (await aiRow.locator('.verdict-chip').evaluate((el) => getComputedStyle(el).backgroundColor)) === 'rgb(255, 235, 233)')
  check('测试行显示未执行', (await page.locator('.automation-row').nth(1).textContent()).includes('未执行'))
  check('人工标记按钮在面板', (await page.locator('.automation-row').nth(3).locator('button').count()) === 2)
  check('待测试徽章显示', (await page.locator('.pr-item.selected .state-badge').textContent()) === '待测试')

  const oneClickBtn = page.locator('.heading-actions button', { hasText: '一键 master' })
  check('非 dock→dock 显示一键 master', (await oneClickBtn.count()) === 1)

  // 发起测试
  const testBtn = page.locator('.automation-row').nth(1).locator('button', { hasText: '发起测试' })
  check('已配置测试时按钮可用', !(await testBtn.isDisabled()))
  await testBtn.click()
  await page.waitForTimeout(400)
  check('测试请求发出', saved.testRuns.at(-1)?.projectId === 2 && saved.testRuns.at(-1)?.number === 13)
  check('测试输出展示', (await page.locator('.automation-test-output').textContent()).includes('[测试通过]'))
  check('状态更新为通过', (await page.locator('.automation-row').nth(1).textContent()).includes('✓ 通过'))
  check('测试完成后显示 AI 汇总卡片', (await page.locator('.test-summary-card').textContent()).includes('整体通过'))

  // 手动重新评审
  await page.locator('.automation-row').first().locator('button', { hasText: '重新评审' }).click()
  await page.waitForTimeout(300)
  check('手动评审请求发出', saved.evaluates.at(-1)?.projectId === 2 && saved.evaluates.at(-1)?.number === 13)
  check('评审结论即时更新', (await page.locator('.automation-row').first().textContent()).includes('包含 SQL 变更'))

  // 一键部署:两击确认 → 进度弹窗在当前页显示步骤与部署日志
  const oneDeployBtn = page.locator('.heading-actions button.one-click', { hasText: '一键部署' })
  check('一键部署按钮显示', (await oneDeployBtn.count()) === 1)
  await oneDeployBtn.click()
  check('一键部署首击进入确认态', (await page.locator('.heading-actions button.confirming', { hasText: '再次点击确认' }).count()) === 1)
  await page.locator('.heading-actions button.confirming').click()
  await page.waitForTimeout(2500)
  check('仍在当前页面(未跳转部署页)', new URL(page.url()).hash.startsWith('#/pulls'))
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
  check('同名已合并 PR 不阻止创建', saved.creates.length === 1 && saved.creates[0].repository === 'owner/proj-two')
  check('自动创建 dock→master PR', saved.creates.at(-1)?.repository === 'owner/proj-two' && saved.creates.at(-1)?.head === 'dock' && saved.creates.at(-1)?.base === 'master' && saved.creates.at(-1)?.title === 'chore deps')
  check('阶段二合并新建 PR #14(而非历史 #5)', JSON.stringify(saved.merges.map((item) => item.number)) === JSON.stringify([13, 14]) && !saved.merges.some((item) => item.number === 4))
  check('重试未重复前置步骤', saved.creates.length === 1)
  check('重试仅重跑失败目标 web-2', JSON.stringify(saved.runs) === JSON.stringify([21, 22, 22]))
  check('查找新 PR 前触发了强制同步', saved.refreshes.includes(2))
  check('审查+测试覆盖两个 PR(重试合法重复)', JSON.stringify([...new Set(saved.approves.map((item) => item.number))].sort((a, b) => a - b)) === JSON.stringify([13, 14]) && saved.approves.at(-1)?.number === 14 && saved.tests.at(-1)?.number === 14)
  check('弹窗内显示部署日志', (await page.locator('.one-click-modal .deploy-output').textContent()).includes('[部署完成]'))
  check('弹窗显示部署目标(项目2 web-2)', (await page.locator('.deploy-target-info').first().textContent()).includes('web-2'))
  check('弹窗显示将执行的完整命令', (await page.locator('.deploy-target-info').nth(1).textContent()).includes('cd /srv/two && ./deploy.sh'))
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
  check('弹窗显示部署目标(项目1)', (await page.locator('.deploy-target-info').first().textContent()).includes('/srv/one'))
  await page.locator('.one-click-modal button', { hasText: '关闭' }).click()

  // 普通 PR 两击合并(确认超时还原)
  await page.locator('.pr-item', { hasText: '#12' }).click()
  await page.waitForTimeout(400)
  if (!(await page.locator('.automation-row').first().isVisible().catch(() => false))) {
    await page.locator('.automation-summary-row').click()
    await page.waitForTimeout(100)
  }
  await page.locator('.automation-row', { hasText: '草稿' }).locator('button', { hasText: '转为正式 PR' }).click()
  await page.waitForTimeout(300)
  check('切换草稿请求发出', saved.draftToggles.at(-1)?.number === 12 && saved.draftToggles.at(-1)?.draft === false)
  check('自动化评审中时面板显示评审中', (await page.locator('.automation-row').first().textContent()).includes('评审中'))
  check('自动化评审中时手动按钮禁用', await page.locator('.automation-row').first().locator('button').first().isDisabled())
  const mergeBtn = page.locator('.merge-action')
  const mergesBefore = saved.merges.length
  await mergeBtn.click()
  check('首次点击进入确认态', (await mergeBtn.textContent()).includes('再次点击确认合并'))
  await page.waitForTimeout(2300)
  check('2 秒后未点击自动还原', (await mergeBtn.textContent()).includes('一键合并'))
  check('超时未触发合并', saved.merges.length === mergesBefore)
  await mergeBtn.click(); await mergeBtn.click()
  await page.waitForTimeout(300)
  check('二次点击执行合并(仅 mock)', saved.merges.at(-1)?.repository === 'owner/proj-two' && saved.merges.at(-1)?.number === 12)
  check('合并完成后强制同步该项目', saved.refreshes.at(-1) === 2)

  await page.screenshot({ path: shot('pulls-final.png') })

  // 一键流程取消:发起后立即取消(非部署阶段可打断)
  slowRefresh = true
  await page.locator('.pr-item', { hasText: '#16' }).click()
  await page.waitForTimeout(300)
  await page.locator('.automation-summary-row').click().catch(() => { })
  await page.waitForTimeout(100)
  await page.locator('.heading-actions button.one-click', { hasText: '一键部署' }).click()
  await page.locator('.heading-actions button.confirming').click()
  await page.waitForTimeout(400)
  const cancelBtn = page.locator('.one-click-modal .cancel-btn', { hasText: '取消任务' })
  check('运行中显示取消按钮', (await cancelBtn.count()) === 1)
  await cancelBtn.click()
  await page.waitForTimeout(1500)
  check('取消后流程停止(失败态)', await page.locator('.one-click-modal button', { hasText: '重试' }).isVisible().catch(() => false))
  slowRefresh = false
  await page.locator('.one-click-modal button', { hasText: '关闭' }).click().catch(() => { })
  await page.waitForTimeout(200)

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
