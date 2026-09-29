const { chromium } = require('playwright-core')
const { findChromium, shot, BASE_URL } = require('./helpers.cjs')
const PROJECTS = [{ id: 1, name: 'proj-one', repository: 'owner/proj-one', token: 't', openPrs: 1 }]
const mk = (n, dir = 'src/module') => ({ filename: `${dir}/file${n}.ts`, patch: `+++ b/x\n@@ -1,3 +1,6 @@\n-a\n-b\n-c\n+new${n}-1\n+new${n}-2\n+new${n}-3\n+new${n}-4\n+new${n}-5\n+new${n}-6` })
const FILES = [mk(1), mk(2), mk(3), mk(4, 'docs/guide'), mk(5), mk(6)]
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
    if (path === '/api/gitee/pulls') return route.fulfill({ json: [{ number: 7, title: 'fake pr', head: { ref: 'dock' }, base: { ref: 'master' } }] })
    if (path === '/api/gitee/pull-logs') return route.fulfill({ json: [] })
    if (path === '/api/gitee/pull-files') return route.fulfill({ json: FILES })
    if (path === '/api/gitee/pull-commits') return route.fulfill({ json: [
      { sha: 'abc1234567890abcdef', commit: { message: 'fix: 修复登录问题\n\n详细说明', author: { name: 'alice', date: '2026-09-27T10:00:00+08:00' } } },
      { sha: 'def9876543210abcdef', commit: { message: 'chore: 升级依赖', author: { name: 'bob', date: '2026-09-28T11:30:00+08:00' } } },
    ] })
    if (path === '/api/gitee/commit-detail') {
      const sha = req.postDataJSON().sha
      return route.fulfill({ json: { sha, files: [{ filename: `from-${sha.slice(0, 7)}.ts`, patch: `+++ b/x\n@@ -1,1 +1,2 @@\n-old\n+new-${sha.slice(0, 7)}` }] } })
    }
    if (path === '/api/gitee/file') return route.fulfill({ json: { content: Buffer.from('full file content line1\nline2').toString('base64') } })
    return route.fulfill({ json: {} })
  })

  await page.goto(`${BASE_URL}/#/pulls`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)

  // 先选中 PR 加载文件
  await page.locator('.pr-item').first().click()
  await page.waitForTimeout(400)

  // 目录树侧栏
  const names = async () => page.locator('.file-item .file-name').allTextContents()
  check('目录排在文件前', (await names())[0] === 'docs' && (await names())[3] === 'src' && (await names())[4] === 'module')
  check('树共 10 行', (await names()).length === 10)
  check('目录聚合统计 src +30', (await page.locator('.file-item.dir', { hasText: 'src' }).locator('.stat-added').textContent()) === '+30')

  const srcRow = page.locator('.file-item.dir', { hasText: 'src' })
  await srcRow.click()
  await page.waitForTimeout(150)
  check('折叠 src 后 4 行', (await names()).length === 4)
  await srcRow.click()
  await page.waitForTimeout(150)
  check('重新展开恢复 10 行', (await names()).length === 10)

  await page.locator('.file-item', { hasText: 'file6.ts' }).last().click()
  await page.waitForTimeout(500)
  check('点击文件行高亮', (await page.locator('.file-item.active .file-name').textContent()) === 'file6.ts')

  // 工具栏
  check('工具栏显示 6 个文件', (await page.locator('.files-toolbar span').first().textContent()) === '6 个文件')
  check('工具栏总统计 +36/-18', (await page.locator('.toolbar-stats').textContent()) === '+36-18')
  check('每卡片有复制按钮', (await page.locator('.copy-btn:not(.full-toggle)').count()) === 6)
  check('默认全展开 6 个 diff', (await page.locator('.file-diff').count()) === 6)

  await page.locator('.files-toolbar button', { hasText: '全部收起' }).click()
  check('全部收起生效', (await page.locator('.file-diff').count()) === 0)
  await page.locator('.files-toolbar button', { hasText: '全部展开' }).click()
  check('全部展开生效', (await page.locator('.file-diff').count()) === 6)

  // 文件搜索
  await page.locator('.file-search').fill('file4')
  await page.waitForTimeout(100)
  check('搜索过滤卡片', (await page.locator('.file-card:visible').count()) === 1)
  check('搜索联动侧栏', JSON.stringify(await names()) === JSON.stringify(['docs', 'guide', 'file4.ts']))
  await page.locator('.file-search').fill('')
  await page.waitForTimeout(100)
  check('清空恢复', (await page.locator('.file-card:visible').count()) === 6)

  // 拖拽调宽
  const asideWidthBefore = (await page.locator('.file-list').boundingBox()).width
  const handle = await page.locator('.resize-handle').boundingBox()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 200)
  await page.mouse.down()
  await page.mouse.move(handle.x + 120, handle.y + 200, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(100)
  const asideWidthAfter = (await page.locator('.file-list').boundingBox()).width
  check(`拖拽调宽生效(${Math.round(asideWidthBefore)}→${Math.round(asideWidthAfter)})`, asideWidthAfter > asideWidthBefore + 80)

  // 完整文件切换
  await page.locator('.copy-btn.full-toggle').first().click()
  await page.waitForTimeout(300)
  check('完整文件按钮变为返回 diff', (await page.locator('.copy-btn.full-toggle').first().textContent()) === '返回 diff')
  check('完整文件内容已加载', (await page.locator('.full-file').first().textContent()).includes('line2'))
  await page.locator('.copy-btn.full-toggle').first().click()
  await page.waitForTimeout(200)
  check('切回 diff 视图', (await page.locator('.full-file').count()) === 0 && (await page.locator('.file-diff').count()) === 6)

  // 侧栏切换提交记录
  check('侧栏默认文件页签', (await page.locator('.file-list-scroll .file-item').count()) > 0)
  await page.locator('.sidebar-tabs button', { hasText: '提交记录' }).click()
  await page.waitForTimeout(100)
  check('切换后显示 2 条提交', (await page.locator('.commit-item').count()) === 2)
  check('提交信息首行展示', (await page.locator('.commit-item').first().locator('.commit-message').textContent()) === 'fix: 修复登录问题')
  check('短 SHA 展示', (await page.locator('.commit-item').first().locator('.commit-sha').textContent()) === 'abc1234')
  check('提交时间展示', (await page.locator('.commit-item').first().locator('.history-time').textContent()) === '2026-09-27 10:00')
  check('文件树随切换隐藏', (await page.locator('.file-list-scroll .file-item').count()) === 0)

  // 点击提交 → 文件区展示该提交变动
  await page.locator('.commit-item').first().click()
  await page.waitForTimeout(300)
  check('工具栏显示正在查看提交', (await page.locator('.commit-viewing').textContent()).includes('abc1234'))
  check('文件区展示该提交的文件', (await page.locator('.file-card').count()) === 1 && (await page.locator('.file-card-header .file-name').textContent()) === 'from-abc1234.ts')
  check('侧栏对应提交高亮', (await page.locator('.commit-item.active').count()) === 1)

  // 再点同一条 → 返回 PR 文件
  await page.locator('.commit-item').first().click()
  await page.waitForTimeout(300)
  check('再次点击返回 PR 文件', (await page.locator('.commit-viewing').count()) === 0 && (await page.locator('.file-card').count()) === 6)

  // 切换到另一条提交
  await page.locator('.commit-item').nth(1).click()
  await page.waitForTimeout(300)
  check('切换提交展示其文件', (await page.locator('.file-card-header .file-name').textContent()) === 'from-def9876.ts')

  // 返回按钮
  await page.locator('.commit-back').click()
  await page.waitForTimeout(200)
  check('返回按钮恢复 PR 文件', (await page.locator('.file-card').count()) === 6)

  await page.locator('.sidebar-tabs button', { hasText: '文件' }).click()
  await page.waitForTimeout(100)
  check('切回文件页签恢复树', (await page.locator('.file-list-scroll .file-item').count()) === 10)
  await page.screenshot({ path: shot('pr-files.png') })
  await browser.close()
  console.log(failures ? `\n${failures} failed` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
