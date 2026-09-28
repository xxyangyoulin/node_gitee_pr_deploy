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
const configs = [
  { projectId: 1, projectName: 'proj-one', host: 'a.com', username: 'deploy', remotePath: '/srv/one', command: './deploy.sh' },
  { projectId: 2, projectName: 'proj-two', host: '', username: '', remotePath: '', command: '' },
]
const saved = { configs: [], deletes: [] }
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
    if (url.pathname === '/api/deployment/configs') return route.fulfill({ json: configs.map((row) => ({ ...row })) })
    if (url.pathname === '/api/deployment/servers') return route.fulfill({ json: SERVERS })
    if (url.pathname === '/api/deployment/config' && req.method() === 'POST') {
      const input = req.postDataJSON()
      saved.configs.push(input)
      const row = configs.find((item) => item.projectId === input.projectId)
      if (row) Object.assign(row, { host: input.host, username: input.username, remotePath: input.remotePath, command: input.command })
      return route.fulfill({ json: input })
    }
    if (url.pathname === '/api/deployment/config' && req.method() === 'DELETE') {
      const projectId = Number(url.searchParams.get('projectId'))
      saved.deletes.push(projectId)
      const row = configs.find((item) => item.projectId === projectId)
      if (row) Object.assign(row, { host: '', username: '', remotePath: '', command: '' })
      return route.fulfill({ json: {} })
    }
    if (url.pathname === '/api/deployment/run') return route.fulfill({ json: 'step1\n[部署完成]' })
    return route.fulfill({ json: {} })
  })

  await page.goto(`${BASE_URL}/#/deployments`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(300)

  check('表格展示全部项目(2 行)', (await page.locator('.deploy-table tbody tr').count()) === 2)
  check('已配置项目显示地址', (await page.locator('.deploy-table tbody tr').first().textContent()).includes('a.com'))
  check('未配置项目显示未配置', (await page.locator('.deploy-table tbody tr').last().textContent()).includes('未配置'))
  check('未配置项目禁用执行部署', await page.locator('.deploy-table .row-actions button.primary').last().isDisabled())
  await page.screenshot({ path: shot('deploy-table.png') })

  await page.locator('.page-heading button', { hasText: '添加配置' }).click()
  const modal = page.locator('.modal')
  check('弹窗默认选中未配置项目', (await modal.locator('select').inputValue()) === '2')
  const hostInput = modal.locator('input[placeholder="example.com"]')
  await hostInput.click()
  const hostMenu = modal.locator('.combo-menu').first()
  check('弹窗内聚焦地址出现建议', await hostMenu.isVisible())
  check('建议去重 2 项', (await hostMenu.locator('button').count()) === 2)
  await hostMenu.locator('button', { hasText: 'a.com' }).dispatchEvent('mousedown')
  check('选中地址带出用户', (await modal.locator('input[placeholder="deploy"]').inputValue()) === 'deploy')
  await modal.locator('input[placeholder="/srv/app"]').fill('/srv/two')
  await modal.locator('input[placeholder="git pull && ./deploy.sh"]').fill('./ship.sh')
  await modal.locator('button[type=submit]').click()
  await page.waitForTimeout(300)
  check('保存请求写入项目 2', saved.configs.at(-1)?.projectId === 2 && saved.configs.at(-1)?.host === 'a.com')
  check('表格刷新显示新配置', (await page.locator('.deploy-table tbody tr').last().textContent()).includes('/srv/two'))

  await page.locator('.deploy-table tbody tr').last().locator('button', { hasText: '编辑' }).click()
  check('编辑弹窗预填', (await modal.locator('input[placeholder="example.com"]').inputValue()) === 'a.com')
  await modal.locator('input[placeholder="example.com"]').fill('c.net')
  await modal.locator('button[type=submit]').click()
  await page.waitForTimeout(300)
  check('编辑保存到项目 2', saved.configs.at(-1)?.projectId === 2 && saved.configs.at(-1)?.host === 'c.net')

  await page.locator('.deploy-table tbody tr').last().locator('button', { hasText: '删除' }).click()
  await page.locator('.confirm-modal button', { hasText: '确认' }).click()
  await page.waitForTimeout(300)
  check('删除请求携带项目 2', saved.deletes.at(-1) === 2)
  check('删除后恢复未配置', (await page.locator('.deploy-table tbody tr').last().textContent()).includes('未配置'))

  await page.locator('.deploy-table tbody tr').first().locator('button', { hasText: '执行部署' }).click()
  await page.waitForTimeout(500)
  check('日志区显示项目名', (await page.locator('.deploy-log-section h2').textContent()).includes('部署日志 · proj-one'))
  check('日志包含输出与完成标记', (await page.locator('.deploy-output').textContent()).includes('[部署完成]'))
  await page.screenshot({ path: shot('deploy-run.png') })

  await browser.close()
  console.log(failures ? `\n${failures} failed` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
