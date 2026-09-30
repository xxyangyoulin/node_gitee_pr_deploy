// tester 执行器单测:mock spawn / mock fetch
const { DatabaseSync } = require('node:sqlite')
const { EventEmitter } = require('node:events')

const spawns = []
let scriptOfLast = ''
let exitCode = 0
require('node:child_process').spawn = (...args) => {
  spawns.push(args)
  scriptOfLast = args[args.length - 1]
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  process.nextTick(() => { child.stdout.emit('data', Buffer.from('ran tests')); child.emit('close', exitCode) })
  return child
}
const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('/chat/completions')) {
    if (aiOutOfIndex) return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ command_index: 99 }) } }] }) }
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ command_index: 1 }) } }] }) }
  }
  if (target.includes('/pulls/13/files')) return { ok: true, text: async () => JSON.stringify([{ filename: 'src/a.ts', patch: '+x' }]) }
  if (target.includes('/pulls?')) return { ok: true, text: async () => JSON.stringify([{ number: 13, title: 't', body: '', state: 'open', head: { ref: 'f', sha: 'abc123' }, base: { ref: 'master' } }]) }
  return { ok: false, status: 404, text: async () => '{}' }
}

let aiOutOfIndex = false
let failures = 0
function check(name, cond) { if (cond) console.log(`PASS ${name}`); else { failures++; console.log(`FAIL ${name}`) } }

async function main() {
  const { runTest, parseCommands } = await import('../dist-server/tester.js')
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, repository TEXT, token TEXT DEFAULT '')")
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '')")
  db.exec("CREATE TABLE deployment_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, project_name TEXT DEFAULT '', target_name TEXT DEFAULT '', host TEXT DEFAULT '', kind TEXT DEFAULT 'deploy', pr_number INTEGER DEFAULT 0, output TEXT DEFAULT '', success INTEGER DEFAULT 0, created_at TEXT DEFAULT '')")
  db.exec("CREATE TABLE pr_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, number INTEGER NOT NULL, title TEXT DEFAULT '', body TEXT DEFAULT '', author TEXT DEFAULT '', head_ref TEXT DEFAULT '', base_ref TEXT DEFAULT '', head_sha TEXT DEFAULT '', state TEXT DEFAULT 'testing', status_note TEXT DEFAULT '', raw TEXT DEFAULT '', gitee_created_at TEXT DEFAULT '', gitee_updated_at TEXT DEFAULT '', first_seen_at TEXT DEFAULT '', last_seen_at TEXT DEFAULT '', synced_at TEXT DEFAULT '', ai_result TEXT DEFAULT '', ai_evaluated_at TEXT DEFAULT '', UNIQUE(project_id, number))")
  db.exec("CREATE TABLE sync_state (project_id INTEGER PRIMARY KEY, last_sync_at TEXT DEFAULT '', last_error TEXT DEFAULT '', enabled INTEGER DEFAULT 1)")
  db.prepare("INSERT INTO projects (id,name,repository) VALUES (1,'proj','owner/proj')").run()
  db.prepare("INSERT INTO pr_cache (project_id,number,title,head_sha,state) VALUES (1,13,'t','abc123','testing')").run()
  db.prepare("INSERT INTO settings (key,value) VALUES ('aiBaseUrl','https://ai.example/v1')").run()
  db.prepare("INSERT INTO settings (key,value) VALUES ('aiApiKey','sk-test')").run()
  db.prepare("INSERT INTO settings (key,value) VALUES ('aiModel','test-model')").run()

  const config = { project_id: 1, server_mode: 'ssh', host: 'test.host', username: 'deployer', workdir_template: '~/TEST/{project}_{pr}', commands: JSON.stringify([{ label: '默认', command: 'vendor/bin/phpunit tests' }, { label: '定向', command: 'vendor/bin/phpunit --filter x' }]), ai_decides: 1, ai_prompt: '', timeout_sec: 600 }
  const context = { project: { id: 1, name: 'proj', repository: 'owner/proj', token: 'tok' }, pr: { number: 13, title: 't', body: '', head_sha: 'abc123' } }

  // 1. AI 选择:command_index 1 → 第二个选项
  exitCode = 0
  await runTest(db, config, context).promise
  const lastArgs = spawns[spawns.length - 1]
  const lastScript = lastArgs[1].join(' ')
  check('ssh 拼接主机与 BatchMode', lastArgs[0] === 'ssh' && lastScript.includes('deployer@test.host') && lastScript.includes('BatchMode=yes'))
  check('脚本含条件 clone', lastScript.includes('git clone'))
  check('脚本含 fetch 与 checkout SHA', lastScript.includes('git fetch --all --prune') && lastScript.includes("checkout -f 'abc123'"))
  check('AI 选中第二个命令(--filter)', lastScript.includes('phpunit --filter x'))
  check('状态回写 test_passed', db.prepare("SELECT state FROM pr_cache WHERE number=13").get().state === 'test_passed')
  const log1 = db.prepare('SELECT * FROM deployment_logs').get()
  check('日志 kind=test 且带 PR 号', log1.kind === 'test' && log1.pr_number === 13)
  check('日志含 AI 选择说明', log1.output.includes('AI 选择:定向'))

  // 2. 退出码 1 → test_failed
  exitCode = 1
  db.prepare("UPDATE pr_cache SET state='testing' WHERE number=13").run()
  await runTest(db, config, context).promise
  const log2 = db.prepare('SELECT * FROM deployment_logs ORDER BY id DESC').get()
  check('失败回写 test_failed', log2.success === 0 && db.prepare("SELECT state FROM pr_cache WHERE number=13").get().state === 'test_failed')

  // 3. AI 越界 → 回退第一个选项
  aiOutOfIndex = true
  db.prepare("UPDATE pr_cache SET state='testing' WHERE number=13").run()
  await runTest(db, config, context).promise
  const lastArgs3 = spawns[spawns.length - 1]
  const lastScript3 = lastArgs3[1].join(' ')
  check('越界回退第一个选项', lastScript3.includes('phpunit tests') && !lastScript3.includes('--filter'))
  aiOutOfIndex = false

  // 4. parseCommands 防御
  check('非法 JSON 回退默认命令', parseCommands('not json')[0].command === 'vendor/bin/phpunit tests')

  // 5. 互斥:同项目并发被拒,且拒绝调用不 spawn
  const spawnsBefore = spawns.length
  const first = runTest(db, config, context)
  try { await runTest(db, config, context).promise; check('同项目并发被拒', false) } catch (e) { check('同项目并发被拒', String(e.message).includes('已有测试在运行')) }
  check('拒绝的调用未执行 spawn', spawns.length === spawnsBefore)
  await first.promise
  await first.promise

  console.error('SCRIPT_DEBUG:', JSON.stringify(scriptOfLast))
  console.error('spawn count:', spawns.length, 'last args:', JSON.stringify(spawns[spawns.length - 1]))
  globalThis.fetch = realFetch
  console.log(failures ? `\n${failures} failed` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
