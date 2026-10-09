// AI 评估管线单测:内存 SQLite + mock fetch(gitee 与 AI 均不触网)
const { DatabaseSync } = require('node:sqlite')

const ai = require('../dist-server/ai.js')

let failures = 0
function check(name, cond) { if (cond) console.log(`PASS ${name}`); else { failures++; console.log(`FAIL ${name}`) } }

const PR_FILES_BY_PR = {
  1: [{ filename: 'src/a.ts', patch: '+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n-x\n+y' }],
  2: [{ filename: 'db/x.sql', patch: '+++ b/db/x.sql\n@@ -1,1 +1,2 @@\n-a\n+b' }],
  3: [{ filename: 'docs/readme.md', patch: '+++ b/docs/readme.md\n@@ -1,1 +1,2 @@\n-a\n+b' }],
}
const state = { aiCalls: 0, aiFailAlways: false, aiFailFirst: 0 }
const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('/chat/completions')) {
    state.aiCalls += 1
    if (state.aiFailAlways || state.aiCalls <= state.aiFailFirst) return { ok: false, status: 500, text: async () => 'quota exceeded' }
    const content = target.includes('评估中断') ? 'not json' : JSON.stringify({ needs_test: false, reason: '文档变更无需测试', risk_level: 'low' })
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) }
  }
  // gitee pulls files
  const match = target.match(/repos\/owner\/one\/pulls\/(\d+)\/files/)
  if (match) return { ok: true, text: async () => JSON.stringify(PR_FILES_BY_PR[Number(match[1])] ?? []) }
  if (target.includes('/repos/owner/one/pulls?')) {
    return { ok: true, text: async () => JSON.stringify([1, 2, 3].map((number) => ({ number, title: `t${number}`, body: '', state: 'open', merged: false, user: {}, head: { ref: 'f', sha: `s${number}` }, base: { ref: 'master' }, created_at: '2026-09-20T10:00:00+08:00', updated_at: '2026-09-20T10:00:00+08:00' }))) }
  }
  return { ok: false, status: 404, text: async () => '{}' }
}

async function main() {
  const { pollProject, evaluatePending, evaluateManual } = await import('../dist-server/poller.js')
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, repository TEXT, token TEXT DEFAULT '', open_prs INTEGER DEFAULT 0)")
  db.exec("CREATE TABLE pr_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, number INTEGER NOT NULL, title TEXT DEFAULT '', body TEXT DEFAULT '', author TEXT DEFAULT '', head_ref TEXT DEFAULT '', base_ref TEXT DEFAULT '', head_sha TEXT DEFAULT '', state TEXT DEFAULT 'new', status_note TEXT DEFAULT '', raw TEXT DEFAULT '', gitee_created_at TEXT DEFAULT '', gitee_updated_at TEXT DEFAULT '', first_seen_at TEXT DEFAULT '', last_seen_at TEXT DEFAULT '', synced_at TEXT DEFAULT '', mergeable INTEGER DEFAULT -1, draft INTEGER DEFAULT 0, ai_result TEXT DEFAULT '', ai_evaluated_at TEXT DEFAULT '', UNIQUE(project_id, number))")
  db.exec("CREATE TABLE sync_state (project_id INTEGER PRIMARY KEY, last_sync_at TEXT DEFAULT '', last_error TEXT DEFAULT '', enabled INTEGER DEFAULT 1)")
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '')")
  db.prepare("INSERT INTO projects (id,name,repository) VALUES (1,'one','owner/one')").run()
  const project = { id: 1, name: 'one', repository: 'owner/one', token: 't' }

  // 0. 未开启/未配置:完全不触发
  await pollProject(db, project)
  await evaluatePending(db)
  check('未开启时不评估', state.aiCalls === 0 && db.prepare("SELECT COUNT(*) c FROM pr_cache WHERE state='ai_reviewing'").get().c === 0)

  // 配置并开启
  const enable = () => {
    for (const [key, value] of Object.entries({ automationEnabled: '1', aiBaseUrl: 'https://ai.example/v1', aiApiKey: 'sk-test', aiModel: 'test-model' })) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, value)
  }
  enable()

  // 1. 硬规则:PR2(.sql)不调模型 → needs_test
  await evaluatePending(db)
  const row2 = db.prepare('SELECT state, status_note n, ai_result r FROM pr_cache WHERE number=2').get()
  check('SQL 硬规则 needs_test', row2.state === 'needs_test' && row2.n === '包含 SQL 变更')
  check('硬规则结果含 risk high', JSON.parse(row2.r).risk_level === 'high')

  // 2. 模型评估:PR1(.ts)与 PR3(.md);SQL 的 PR2 未调模型
  check('模型评估无需测试', db.prepare("SELECT state FROM pr_cache WHERE number=1").get().state === 'no_test_needed' && db.prepare("SELECT state FROM pr_cache WHERE number=3").get().state === 'no_test_needed')
  check('仅 2 个非 SQL PR 调用模型(SQL 未调)', state.aiCalls === 2)
  check('评估时间写入', db.prepare("SELECT COUNT(*) c FROM pr_cache WHERE ai_evaluated_at != ''").get().c === 3)

  // 3. 同 SHA 去重:再跑一轮不重复评估(无 new 状态行)
  await evaluatePending(db)
  check('无 new 时不重复评估', state.aiCalls === 2)

  // 4. head 变化 → 新评估
  db.prepare("UPDATE pr_cache SET state='new', ai_result='' WHERE number=1").run()
  state.aiFailFirst = state.aiCalls + 1 // 恰好下一次调用失败,触发重试
  await evaluatePending(db)
  check('失败重试后成功', db.prepare('SELECT state FROM pr_cache WHERE number=1').get().state === 'no_test_needed' && state.aiCalls === 4)

  // 5. 连续失败 → 降级 needs_test
  db.prepare("UPDATE pr_cache SET state='new', ai_result='' WHERE number=1").run()
  state.aiFailAlways = true
  await evaluatePending(db)
  const degraded = db.prepare('SELECT state, status_note n FROM pr_cache WHERE number=1').get()
  check('连续失败降级 needs_test', degraded.state === 'needs_test' && degraded.n.includes('默认需要测试'))

  // 7. 自动化进行中(ai_reviewing)手动评审被拒绝
  db.prepare("UPDATE pr_cache SET state='ai_reviewing', ai_result='' WHERE number=3").run()
  try {
    await evaluateManual(db, 1, 3)
    check('ai_reviewing 时手动评审被拒', false)
  } catch (error) {
    check('ai_reviewing 时手动评审被拒', String(error.message).includes('进行中'))
  }

  // 8. 自动化完成后可手动重新评审
  db.prepare("UPDATE pr_cache SET state='needs_test', ai_result='{}' WHERE number=3").run()
  state.aiFailAlways = false
  await evaluateManual(db, 1, 3)
  check('完成后可手动重新评审', db.prepare('SELECT state FROM pr_cache WHERE number=3').get().state === 'no_test_needed')

  // 6. 输入截断:60+ 文件清单与超长 diff
  PR_FILES_BY_PR[1] = Array.from({ length: 70 }, (_, i) => ({ filename: `src/f${i}.ts`, patch: '+x'.repeat(50) }))
  const input = ai.buildEvaluationInput(PR_FILES_BY_PR[1])
  check('文件清单截断到 60 行', input.files.split('\n').length === 61 && input.files.includes('共 70 个文件'))
  check('diff 截断保护', input.diff.length <= 12000 + 20)

  globalThis.fetch = realFetch
  console.log(failures ? `\n${failures} failed` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
