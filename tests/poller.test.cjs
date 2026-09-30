// poller 逻辑单测:内存 SQLite + mock fetch(不触网)
const assert = require('node:assert')
const { DatabaseSync } = require('node:sqlite')

const PRS = {
  'owner/one': [
    { number: 1, title: 'first', body: 'b1', state: 'open', merged: false, user: { name: 'alice' }, head: { ref: 'feat-a', sha: 'aaa' }, base: { ref: 'master' }, created_at: '2026-09-20T10:00:00+08:00', updated_at: '2026-09-20T10:00:00+08:00' },
    { number: 2, title: 'second', body: '', state: 'open', merged: false, user: { name: 'bob' }, head: { ref: 'feat-b', sha: 'bbb' }, base: { ref: 'master' }, created_at: '2026-09-21T10:00:00+08:00', updated_at: '2026-09-21T10:00:00+08:00' },
  ],
}
const calls = { count: 0 }
const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  calls.count += 1
  const repository = String(url).split('/repos/')[1]?.split('/').slice(0, 2).join('/')
  if (repository === 'owner/one') return { ok: true, text: async () => JSON.stringify(PRS['owner/one']) }
  return { ok: false, status: 500, text: async () => JSON.stringify({ message: 'token 失效' }) }
}

let failures = 0
function check(name, cond) { if (cond) console.log(`PASS ${name}`); else { failures++; console.log(`FAIL ${name}`) } }

async function main() {
  const { pollProject, pollAll, readPollIntervalSec } = await import('../dist-server/poller.js')
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, repository TEXT NOT NULL, token TEXT NOT NULL DEFAULT '', open_prs INTEGER NOT NULL DEFAULT 0)")
  db.exec("CREATE TABLE pr_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', head_ref TEXT NOT NULL DEFAULT '', base_ref TEXT NOT NULL DEFAULT '', head_sha TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'new', status_note TEXT NOT NULL DEFAULT '', raw TEXT NOT NULL DEFAULT '', gitee_created_at TEXT NOT NULL DEFAULT '', gitee_updated_at TEXT NOT NULL DEFAULT '', first_seen_at TEXT NOT NULL DEFAULT '', last_seen_at TEXT NOT NULL DEFAULT '', synced_at TEXT NOT NULL DEFAULT '', UNIQUE(project_id, number))")
  db.exec("CREATE TABLE sync_state (project_id INTEGER PRIMARY KEY, last_sync_at TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1)")
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')")
  db.prepare("INSERT INTO projects (id,name,repository) VALUES (1,'one','owner/one')").run()
  db.prepare("INSERT INTO projects (id,name,repository) VALUES (2,'bad','owner/bad')").run()
  const project = { id: 1, name: 'one', repository: 'owner/one', token: 't' }

  // 1. 新 PR 入库 state=new
  await pollProject(db, project)
  const rows = db.prepare('SELECT number, state, head_sha AS sha FROM pr_cache ORDER BY number').all()
  check('新 PR 入库且 state=new', rows.length === 2 && rows.every((row) => row.state === 'new'))

  // 2. 仅元数据更新:状态不变、备注清空
  PRS['owner/one'][0].title = 'first-renamed'
  PRS['owner/one'][0].updated_at = '2026-09-22T10:00:00+08:00'
  await pollProject(db, project)
  const row1 = db.prepare('SELECT state, status_note AS note FROM pr_cache WHERE number=1').get()
  check('元数据更新不改状态', row1.state === 'new')

  // 3. head_sha 变化 → 回到 new 且有备注(先模拟离开 new 态)
  db.prepare("UPDATE pr_cache SET state='needs_test', status_note='' WHERE number=1").run()
  PRS['owner/one'][0].head.sha = 'aaa2'
  await pollProject(db, project)
  const row1b = db.prepare('SELECT state, status_note AS note FROM pr_cache WHERE number=1').get()
  check('head 变化回到 new', row1b.state === 'new')

  // 4. open → merged
  PRS['owner/one'][1].state = 'merged'
  PRS['owner/one'][1].merged = true
  await pollProject(db, project)
  const row2 = db.prepare('SELECT state FROM pr_cache WHERE number=2').get()
  check('合并状态落库', row2.state === 'merged')

  // 4.5 新出现的已合并 PR 直接落 merged(不进 new)
  PRS['owner/one'].push({ number: 3, title: 'already-merged', body: '', state: 'merged', merged: true, user: { name: 'carol' }, head: { ref: 'x', sha: 'ccc' }, base: { ref: 'master' }, created_at: '2026-09-19T10:00:00+08:00', updated_at: '2026-09-19T11:00:00+08:00' })
  await pollProject(db, project)
  const row3 = db.prepare('SELECT state FROM pr_cache WHERE number=3').get()
  check('首轮已合并 PR 直接落 merged', row3.state === 'merged')

  // 5. pollAll:单项目失败隔离 + sync_state 记录
  const results = await pollAll(db)
  console.log('pollAll results:', JSON.stringify(results))
  const bad = results.find((row) => row.projectId === 2)
  const good = results.find((row) => row.projectId === 1)
  check('失败项目记录错误', bad && bad.error.includes('token 失效'))
  check('成功项目不受影响', good && good.error === '')
  const sync = db.prepare('SELECT last_error FROM sync_state WHERE project_id=2').get()
  check('sync_state 记录 last_error', sync.last_error.includes('token 失效'))

  // 6. 项目级开关:停用后不再轮询
  db.prepare('UPDATE sync_state SET enabled=0 WHERE project_id=1').run()
  const callsBefore = calls.count
  await pollAll(db)
  check('停用项目不轮询', calls.count === callsBefore + 1) // 仅 bad 项目(仍启用)发起请求

  // 7. 间隔下限保护
  db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('pollIntervalSec','10')").run()
  check('间隔最小 60s', readPollIntervalSec(db) === 60)

  globalThis.fetch = realFetch
  console.log(failures ? `\n${failures} failed` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
