const { chromium } = require('playwright-core')
const { findChromium, shot, BASE_URL } = require('./helpers.cjs')
const PROJECTS = [
  { id: 1, name: 'proj-one', repository: 'owner/proj-one', token: 'tok1', openPrs: 1 },
  { id: 2, name: 'proj-two', repository: 'owner/proj-two', token: 'tok2', openPrs: 0 },
]
const SETTINGS = { prHead: 'feat', prBase: 'stable', mergeMethod: 'rebase' }
const saved = { settings: [], updates: [], merges: [], creates: [], deletes: [] }
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
    if (path === '/api/settings' && req.method() === 'GET') return route.fulfill({ json: SETTINGS })
    if (path === '/api/settings' && req.method() === 'POST') { saved.settings.push(req.postDataJSON()); return route.fulfill({ json: req.postDataJSON() }) }
    if (path === '/api/projects/update') { const input = req.postDataJSON(); saved.updates.push(input); return route.fulfill({ json: { id: input.id, name: input.name, repository: input.repository, token: input.token || 'kept', openPrs: 0 } }) }
    if (path === '/api/meta') return route.fulfill({ json: { version: '9.9.9', dataPath: '/tmp/fake/release-console.sqlite' } })
    if (path === '/api/gitee/pulls') return route.fulfill({ json: [{ number: 7, title: 'fake pr', user: { login: 'alice' }, head: { ref: 'feat' }, base: { ref: 'stable' }, created_at: '2026-09-20T10:30:00+08:00' }] })
    if (path === '/api/gitee/approve-pull') { saved.approves = saved.approves || []; saved.approves.push(req.postDataJSON()); return route.fulfill({ json: {} }) }
    if (path === '/api/gitee/merge-pull') { saved.merges.push(req.postDataJSON()); return route.fulfill({ json: {} }) }
    if (path === '/api/gitee/pull-logs') return route.fulfill({ json: [] })
    if (path === '/api/gitee/pull-files') return route.fulfill({ json: [] })
    if (path === '/api/gitee/create-pull') { saved.creates.push(req.postDataJSON()); return route.fulfill({ json: {} }) }
    if (req.method() === 'DELETE' && path.startsWith('/api/projects/')) { saved.deletes.push(Number(path.split('/').pop())); return route.fulfill({ json: {} }) }
    return route.fulfill({ json: {} })
  })

  await page.goto(`${BASE_URL}/#/settings`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(200)

  check('设置页三个区块', (await page.locator('.settings-section').count()) === 3)
  check('head 预填 feat', (await page.locator('.settings-section input').first().inputValue()) === 'feat')
  check('base 预填 stable', (await page.locator('.settings-section input').nth(1).inputValue()) === 'stable')
  check('合并方式预填 rebase', (await page.locator('.settings-section .dropdown-toggle').textContent()).includes('rebase'))
  check('项目管理列出 2 个项目', (await page.locator('.project-row').count()) === 2)
  check('版本信息展示', (await page.locator('.meta-row code').first().textContent()) === '9.9.9')
  await page.screenshot({ path: shot('settings.png'), fullPage: true })

  await page.locator('.settings-section .dropdown-toggle').click()
  await page.locator('.dropdown-menu button', { hasText: 'squash' }).click()
  await page.locator('.settings-section button[type=submit]').click()
  await page.waitForTimeout(200)
  check('保存请求携带 squash', saved.settings.at(-1)?.mergeMethod === 'squash')

  // 创建 PR 弹窗:项目下拉 + 设置预填分支
  await page.locator('.nav-item', { hasText: /^PR$/ }).click()
  await page.waitForTimeout(300)
  await page.locator('.heading-actions button', { hasText: '创建 PR' }).click()
  const createModal = page.locator('.modal')
  check('创建弹窗默认第一个项目', (await createModal.locator('.dropdown-toggle').textContent()).includes('proj-one'))
  check('head 预填设置值 feat', (await createModal.locator('input').nth(1).inputValue()) === 'feat')
  check('base 预填设置值 stable', (await createModal.locator('input').nth(2).inputValue()) === 'stable')
  await createModal.locator('.dropdown-toggle').click()
  await page.locator('.dropdown-menu button', { hasText: 'proj-two' }).first().click()
  await createModal.locator('input').first().fill('new pr')
  await createModal.locator('button[type=submit]').click()
  await page.waitForTimeout(300)
  check('创建请求发到所选项目且带分支', saved.creates.at(-1)?.repository === 'owner/proj-two' && saved.creates.at(-1)?.head === 'feat' && saved.creates.at(-1)?.base === 'stable' && saved.creates.at(-1)?.title === 'new pr')

  // 选中 PR 后合并,使用保存后的合并方式
  await page.locator('.pr-item').first().click()
  await page.waitForTimeout(300)
  const mergeBtn = page.locator('.merge-action')
  await mergeBtn.click(); await mergeBtn.click()
  await page.waitForTimeout(300)
  check('合并请求携带 mergeMethod=squash', saved.merges.at(-1)?.mergeMethod === 'squash' && saved.merges.at(-1)?.repository === 'owner/proj-one')

  // 项目编辑与删除(二次确认)
  await page.locator('.nav-item', { hasText: '设置' }).click()
  await page.locator('.project-row', { hasText: 'proj-two' }).locator('button', { hasText: '编辑' }).click()
  const modal = page.locator('.modal')
  check('编辑弹窗预填名称', (await modal.locator('input').first().inputValue()) === 'proj-two')
  await modal.locator('input').first().fill('proj-two-renamed')
  await modal.locator('input').nth(2).fill('')
  await modal.locator('button[type=submit]').click()
  await page.waitForTimeout(200)
  check('保存后列表更新为新名称', (await page.locator('.project-row', { hasText: 'proj-two-renamed' }).count()) === 1)
  check('更新请求 token 为空串(服务端保留旧值)', saved.updates.at(-1)?.token === '')

  await page.locator('.project-row', { hasText: 'proj-two-renamed' }).locator('button', { hasText: '删除' }).click()
  await page.locator('.confirm-modal button', { hasText: '确认' }).click()
  await page.waitForTimeout(300)
  check('删除请求发出', saved.deletes[0] === 2)
  await page.screenshot({ path: shot('settings-final.png') })

  await browser.close()
  console.log(failures ? `\n${failures} failed` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
