const { chromium } = require('playwright-core')
const { findChromium, shot, BASE_URL } = require('./helpers.cjs')
const PROJECTS = [
  { id: 1, name: 'proj-one', repository: 'owner/proj-one', token: 't', openPrs: 0 },
  { id: 2, name: 'proj-two', repository: 'owner/proj-two', token: 't', openPrs: 0 },
]
const SERVERS = [
  { host: 'a.com', username: 'deploy' },
  { host: 'b.org', username: 'root' },
]
const targets = [
  { id: 11, projectId: 1, projectName: 'proj-one', name: 'web-1', host: 'a.com', username: 'deploy', remotePath: '/srv/one', command: './deploy.sh', position: 0 },
  { id: 12, projectId: 1, projectName: 'proj-one', name: 'web-2', host: 'b.org', username: 'root', remotePath: '/srv/two', command: './ship.sh', position: 1 },
]
const deployLogs = [{ id: 1, projectId: 1, projectName: 'proj-one', targetName: 'web-1', host: 'deploy@a.com', output: '历史输出', success: 1, createdAt: '2026-09-01 10:00:00' }]
const saved = { targets: [], deletes: [], runs: [], reorders: [], testConfigs: [] }
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
    const url = new URL(req.url())
    if (url.pathname === '/api/projects') return route.fulfill({ json: PROJECTS })
    if (url.pathname === '/api/deployment/targets' && req.method() === 'GET') return route.fulfill({ json: targets.map((row) => ({ ...row })) })
    if (url.pathname === '/api/deployment/targets' && req.method() === 'POST') {
      const input = req.postDataJSON()
      saved.targets.push(input)
      if (input.id) {
        const row = targets.find((item) => item.id === input.id)
        if (row) Object.assign(row, { name: input.name, host: input.host, username: input.username, remotePath: input.remotePath, command: input.command })
      } else {
        targets.push({ id: 99, projectId: input.projectId, projectName: input.projectId === 1 ? 'proj-one' : 'proj-two', name: input.name, host: input.host, username: input.username, remotePath: input.remotePath, command: input.command, position: 0 })
      }
      return route.fulfill({ json: { ...input } })
    }
    if (url.pathname === '/api/deployment/targets/reorder' && req.method() === 'POST') {
      saved.reorders.push(req.postDataJSON().ids)
      const ids = req.postDataJSON().ids
      targets.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
      ids.forEach((id, index) => { const row = targets.find((item) => item.id === id); if (row) row.position = index })
      return route.fulfill({ json: {} })
    }
    if (url.pathname === '/api/deployment/targets/delete' && req.method() === 'POST') {
      const input = req.postDataJSON()
      saved.deletes.push(input.id)
      const index = targets.findIndex((item) => item.id === input.id)
      if (index >= 0) targets.splice(index, 1)
      return route.fulfill({ json: {} })
    }
    if (url.pathname === '/api/deployment/servers') return route.fulfill({ json: SERVERS })
    const testConfigsStore = [{ project_id: 1, server_mode: 'ssh', host: 'a.com', username: 'deploy', workdir_template: '~/TEST/{project}_{pr}', commands: JSON.stringify([{ label: '全量', command: 'vendor/bin/phpunit tests' }]), ai_decides: 0, ai_prompt: '', timeout_sec: 600, projectName: 'proj-one' }]
    if (url.pathname === '/api/test/configs' && req.method() === 'GET') return route.fulfill({ json: testConfigsStore.map((row) => ({ ...row })) })
    if (url.pathname === '/api/test/configs' && req.method() === 'POST') {
      const input = req.postDataJSON()
      saved.testConfigs.push(input)
      const row = testConfigsStore.find((item) => item.project_id === input.projectId)
      const mapped = { project_id: input.projectId, server_mode: input.serverMode, host: input.host, username: input.username, workdir_template: input.workdirTemplate, commands: input.commands, ai_decides: input.aiDecides ? 1 : 0, ai_prompt: input.aiPrompt, timeout_sec: input.timeoutSec, projectName: input.projectId === 1 ? 'proj-one' : 'proj-two' }
      if (row) Object.assign(row, mapped); else testConfigsStore.push(mapped)
      return route.fulfill({ json: input })
    }
    if (url.pathname === '/api/deployment/run') {
      const targetId = req.postDataJSON().targetId
      saved.runs.push(targetId)
      deployLogs.unshift({ id: deployLogs.length + 1, projectId: 1, projectName: 'proj-one', targetName: targetId === 11 ? 'web-1' : 'web-2', host: 'deploy@a.com', output: 'step1\n[部署完成]', success: 1, createdAt: '2026-09-28 12:00:00' })
      return route.fulfill({ json: 'step1\n[部署完成]' })
    }
    if (url.pathname === '/api/deployment/logs') {
      const projectId = Number(url.searchParams.get('projectId')) || 0
      const rows = projectId ? deployLogs.filter((log) => log.projectId === projectId) : deployLogs
      return route.fulfill({ json: rows.slice(0, Number(url.searchParams.get('limit')) || 20).map((log) => ({ ...log })) })
    }
    return route.fulfill({ json: {} })
  })

  await page.goto(`${BASE_URL}/#/deployments`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(300)

  // 分组展示:2 个项目分组,proj-one 2 个目标,proj-two 未配置
  check('分组展示 2 个项目', (await page.locator('.deploy-group').count()) === 2)
  check('proj-one 分组含 2 个目标行', (await page.locator('.deploy-group').first().locator('.deploy-target-row').count()) === 2)
  check('proj-two 显示未配置', (await page.locator('.deploy-group').last().textContent()).includes('未配置目标'))
  check('目标行显示别名与主机', (await page.locator('.deploy-target-row').first().textContent()).includes('web-1') && (await page.locator('.deploy-target-row').first().textContent()).includes('deploy@a.com'))
  await page.screenshot({ path: shot('deploy-groups.png') })

  // 添加目标(proj-two)
  await page.locator('.deploy-group').last().locator('button', { hasText: '添加目标' }).click()
  const modal = page.locator('.modal')
  check('弹窗项目固定为 proj-two', (await modal.locator('input').first().inputValue()) === 'proj-two')
  await modal.locator('input').nth(1).fill('db-1')
  const hostInput = modal.locator('input[placeholder="example.com"]')
  await hostInput.click()
  const hostMenu = modal.locator('.combo-menu').first()
  check('聚焦地址出现建议', await hostMenu.isVisible())
  await hostMenu.locator('button', { hasText: 'a.com' }).dispatchEvent('mousedown')
  check('选中地址带出用户', (await modal.locator('input[placeholder="deploy"]').inputValue()) === 'deploy')
  await modal.locator('input[placeholder="/srv/app"]').fill('/srv/db')
  await modal.locator('input[placeholder="git pull && ./deploy.sh"]').fill('./ship.sh')
  await modal.locator('button[type=submit]').click()
  await page.waitForTimeout(300)
  check('保存请求写入项目 2', saved.targets.at(-1)?.projectId === 2 && saved.targets.at(-1)?.name === 'db-1')
  check('proj-two 分组出现新目标', (await page.locator('.deploy-group').last().locator('.deploy-target-row').count()) === 1)

  // 目标排序:下移 web-1
  check('初始顺序 web-1 在前', (await page.locator('.deploy-target-row').first().textContent()).includes('web-1'))
  await page.locator('.deploy-target-row').first().locator('.move-btn[title=下移]').click()
  await page.waitForTimeout(300)
  check('下移请求交换顺序', JSON.stringify(saved.reorders.at(-1)) === JSON.stringify([12, 11]))
  check('列表顺序更新 web-2 在前', (await page.locator('.deploy-target-row').first().textContent()).includes('web-2'))
  check('首行下移可用且上移禁用', !(await page.locator('.deploy-target-row').first().locator('.move-btn[title=下移]').isDisabled()) && (await page.locator('.deploy-target-row').first().locator('.move-btn[title=上移]').isDisabled()))
  await page.locator('.deploy-target-row').nth(1).locator('.move-btn[title=上移]').click()
  await page.waitForTimeout(300)
  check('上移恢复顺序', (await page.locator('.deploy-target-row').first().textContent()).includes('web-1'))

  // 历史按项目筛选
  await page.locator('.history-filter .dropdown-toggle').click()
  await page.locator('.dropdown-menu button', { hasText: 'proj-one' }).click()
  await page.waitForTimeout(200)
  const visibleNames = await page.locator('.history-row .history-name').allTextContents()
  check('筛选后仅显示该项目记录', visibleNames.length > 0 && visibleNames.every((name) => name === 'proj-one'))
  await page.locator('.history-filter .dropdown-toggle').click()
  await page.locator('.dropdown-menu button', { hasText: '全部项目' }).click()
  await page.waitForTimeout(200)
  check('恢复全部项目记录', (await page.locator('.history-row').count()) === (await page.locator('.history-row .history-name').allTextContents()).length)

  // 编辑目标 web-2
  await page.locator('.deploy-group').first().locator('.deploy-target-row', { hasText: 'web-2' }).locator('button', { hasText: '编辑' }).click()
  check('编辑弹窗预填别名', (await modal.locator('input').nth(1).inputValue()) === 'web-2')
  check('编辑弹窗预填主机', (await modal.locator('input[placeholder="example.com"]').inputValue()) === 'b.org')
  await modal.locator('input').nth(1).fill('web-2b')
  await modal.locator('button[type=submit]').click()
  await page.waitForTimeout(300)
  check('编辑保存到目标 12', saved.targets.at(-1)?.id === 12 && saved.targets.at(-1)?.name === 'web-2b')
  check('列表显示新别名', (await page.locator('.deploy-target-row', { hasText: 'web-2b' }).count()) === 1)

  // 删除目标
  await page.locator('.deploy-target-row', { hasText: 'web-2b' }).locator('button', { hasText: '删除' }).click()
  await page.locator('.confirm-modal button', { hasText: '确认' }).click()
  await page.waitForTimeout(300)
  check('删除请求携带目标 12', saved.deletes.at(-1) === 12)
  check('删除后 proj-one 仅剩 1 行', (await page.locator('.deploy-group').first().locator('.deploy-target-row').count()) === 1)

  // 测试配置:proj-one 已配置(按钮高亮),proj-two 打开弹窗保存
  check('已配置项目按钮高亮', (await page.locator('.deploy-group').first().locator('button.primary', { hasText: '测试配置' }).count()) === 1)
  await page.locator('.deploy-group').last().locator('button', { hasText: '配置测试' }).click()
  const tmodal = page.locator('.test-config-modal')
  check('测试配置弹窗打开', await tmodal.isVisible())
  await tmodal.locator('.command-option-row input').first().fill('单元')
  await tmodal.locator('.command-option-row input').nth(1).fill('vendor/bin/phpunit tests/Unit')
  await tmodal.locator('.command-options-head button').click()
  await tmodal.locator('.command-option-row').nth(1).locator('input').first().fill('全量')
  await tmodal.locator('.command-option-row').nth(1).locator('input').nth(1).fill('vendor/bin/phpunit tests')
  await tmodal.locator('button[type=submit]').click()
  await page.waitForTimeout(300)
  const savedConfig = saved.testConfigs.at(-1)
  check('保存测试配置写入项目 2', savedConfig?.projectId === 2 && savedConfig?.serverMode === 'ssh')
  check('命令选项保存为 JSON 数组', JSON.parse(savedConfig.commands).length === 2 && JSON.parse(savedConfig.commands)[0].label === '单元')

  // 单台执行 + 日志
  await page.locator('.deploy-target-row').first().locator('button', { hasText: '执行' }).click()
  await page.waitForTimeout(500)
  check('日志区显示目标名', (await page.locator('.deploy-log-section h2').textContent()).includes('web-1'))
  check('日志包含完成标记', (await page.locator('.deploy-output').textContent()).includes('[部署完成]'))

  // 再次执行(全部执行按钮,组内 1 台)
  await page.locator('.deploy-group').first().locator('button', { hasText: '全部执行' }).click()
  await page.waitForTimeout(500)
  check('全部执行日志含分段标记', (await page.locator('.deploy-output').textContent()).includes('==> [web-1]'))
  check('部署历史新增到 3 条', (await page.locator('.history-row').count()) === 3)
  await page.screenshot({ path: shot('deploy-run.png') })

  await browser.close()
  console.log(failures ? `\n${failures} failed` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
