import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { gitee } from './gitee.js'
import { startPoller, pollAll, evaluateManual } from './poller.js'
import { initErrorLog, logError, listErrors } from './error-log.js'

const port = Number(process.env.PORT) || 18763
const root = process.cwd()
const databasePath = join(root, 'release-console.sqlite')
const database = new DatabaseSync(databasePath)
initErrorLog(database)
const version = (() => { try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '' } catch { return '' } })()
database.exec('CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, repository TEXT NOT NULL, token TEXT NOT NULL DEFAULT "", open_prs INTEGER NOT NULL DEFAULT 0)')
database.exec('CREATE TABLE IF NOT EXISTS deployment_configs (project_id INTEGER PRIMARY KEY, host TEXT NOT NULL DEFAULT "", username TEXT NOT NULL DEFAULT "", remote_path TEXT NOT NULL DEFAULT "", command TEXT NOT NULL DEFAULT "")')
database.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT "")')
database.exec('CREATE TABLE IF NOT EXISTS deployment_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, project_name TEXT NOT NULL DEFAULT "", target_name TEXT NOT NULL DEFAULT "", host TEXT NOT NULL DEFAULT "", output TEXT NOT NULL DEFAULT "", success INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT "")')
try { database.exec('ALTER TABLE deployment_logs ADD COLUMN target_name TEXT NOT NULL DEFAULT ""') } catch { }
database.exec('CREATE TABLE IF NOT EXISTS deploy_targets (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL DEFAULT "", host TEXT NOT NULL DEFAULT "", username TEXT NOT NULL DEFAULT "", remote_path TEXT NOT NULL DEFAULT "", command TEXT NOT NULL DEFAULT "", position INTEGER NOT NULL DEFAULT 0)')
database.exec('CREATE TABLE IF NOT EXISTS pr_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL DEFAULT "", body TEXT NOT NULL DEFAULT "", author TEXT NOT NULL DEFAULT "", head_ref TEXT NOT NULL DEFAULT "", base_ref TEXT NOT NULL DEFAULT "", head_sha TEXT NOT NULL DEFAULT "", state TEXT NOT NULL DEFAULT "new", status_note TEXT NOT NULL DEFAULT "", raw TEXT NOT NULL DEFAULT "", gitee_created_at TEXT NOT NULL DEFAULT "", gitee_updated_at TEXT NOT NULL DEFAULT "", first_seen_at TEXT NOT NULL DEFAULT "", last_seen_at TEXT NOT NULL DEFAULT "", synced_at TEXT NOT NULL DEFAULT "", UNIQUE(project_id, number))')
database.exec('CREATE TABLE IF NOT EXISTS sync_state (project_id INTEGER PRIMARY KEY, last_sync_at TEXT NOT NULL DEFAULT "", last_error TEXT NOT NULL DEFAULT "", enabled INTEGER NOT NULL DEFAULT 1)')
database.exec('CREATE TABLE IF NOT EXISTS test_configs (project_id INTEGER PRIMARY KEY, server_mode TEXT NOT NULL DEFAULT "ssh", host TEXT NOT NULL DEFAULT "", username TEXT NOT NULL DEFAULT "", workdir_template TEXT NOT NULL DEFAULT "~/TEST/{project}_{pr}", source_path TEXT NOT NULL DEFAULT "", commands TEXT NOT NULL DEFAULT "", ai_decides INTEGER NOT NULL DEFAULT 0, ai_prompt TEXT NOT NULL DEFAULT "", timeout_sec INTEGER NOT NULL DEFAULT 600)')
try { database.exec('ALTER TABLE test_configs ADD COLUMN source_path TEXT NOT NULL DEFAULT ""') } catch { }
try { database.exec('ALTER TABLE deployment_logs ADD COLUMN kind TEXT NOT NULL DEFAULT "deploy"') } catch { }
try { database.exec('ALTER TABLE deployment_logs ADD COLUMN pr_number INTEGER NOT NULL DEFAULT 0') } catch { }
try { database.exec('ALTER TABLE pr_cache ADD COLUMN ai_result TEXT NOT NULL DEFAULT ""') } catch { }
try { database.exec('ALTER TABLE pr_cache ADD COLUMN ai_evaluated_at TEXT NOT NULL DEFAULT ""') } catch { }
database.exec("UPDATE pr_cache SET state='needs_test', status_note='服务重启,测试中断,可重新发起' WHERE state='testing'")
database.exec('CREATE TABLE IF NOT EXISTS request_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL DEFAULT 0, project_name TEXT NOT NULL DEFAULT "", endpoint TEXT NOT NULL DEFAULT "", method TEXT NOT NULL DEFAULT "GET", ok INTEGER NOT NULL DEFAULT 1, status INTEGER NOT NULL DEFAULT 0, error_message TEXT NOT NULL DEFAULT "", duration_ms INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT "")')
{
  const targetCount = (database.prepare('SELECT COUNT(*) AS c FROM deploy_targets').get() as any).c
  if (!targetCount) {
    const legacyRows = database.prepare('SELECT project_id, host, username, remote_path AS remotePath, command FROM deployment_configs ORDER BY project_id').all() as any[]
    let lastProject = 0
    let position = 0
    for (const row of legacyRows) {
      if (!row.host && !row.command) continue
      if (row.project_id !== lastProject) { position = 0; lastProject = row.project_id }
      database.prepare('INSERT INTO deploy_targets(project_id,name,host,username,remote_path,command,position) VALUES(?,?,?,?,?,?,?)').run(row.project_id, '默认', row.host, row.username, row.remotePath, row.command, position++)
    }
  }
}

import { setGiteeLogger } from './gitee.js'
import { testModelConnection } from './ai.js'
import { homedir } from 'node:os'
import { runTest, type TestConfig } from './tester.js'
{
  let logCounter = 0
  setGiteeLogger((entry) => {
    try {
      const project = database.prepare('SELECT id, name FROM projects WHERE repository=?').get(entry.repository) as any
      const createdAt = new Date().toISOString().replace('T', ' ').slice(0, 19)
      database.prepare('INSERT INTO request_logs(project_id,project_name,endpoint,method,ok,status,error_message,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(project?.id ?? 0, project?.name ?? entry.repository, entry.endpoint, entry.method, entry.ok ? 1 : 0, entry.status, entry.errorMessage, entry.durationMs, createdAt)
      logCounter += 1
      if (logCounter % 50 === 0) database.prepare('DELETE FROM request_logs WHERE id <= (SELECT MAX(id) - 500 FROM request_logs)').run()
    } catch { /* 日志失败不影响主流程 */ }
  })
}

const defaultSettings: Record<string, string> = { prHead: 'dock', prBase: 'master', mergeMethod: 'merge', pollIntervalSec: '180', automationEnabled: '0', aiBaseUrl: '', aiApiKey: '', aiModel: '', aiPrompt: '' }

function readSettings() {
  const rows = database.prepare('SELECT key,value FROM settings').all() as Array<{ key: string; value: string }>
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]))
  return Object.fromEntries(Object.keys(defaultSettings).map((key) => [key, stored[key] || defaultSettings[key]]))
}

function saveSettings(input: Record<string, unknown>) {
  const statement = database.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  for (const key of Object.keys(defaultSettings)) if (typeof input[key] === 'string' && input[key]) statement.run(key, input[key])
  return readSettings()
}

type Input = { repository: string; token: string }

function json(response: import('node:http').ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
  response.end(JSON.stringify(body))
}

async function body(request: import('node:http').IncomingMessage) {
  let text = ''
  for await (const chunk of request) text += chunk
  return text ? JSON.parse(text) : {}
}

async function api(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, path: string) {
  const input = await body(request)
  if (request.method === 'GET' && path === '/api/projects') return json(response, 200, database.prepare('SELECT id,name,repository,token,open_prs AS openPrs FROM projects ORDER BY id DESC').all())
  if (request.method === 'POST' && path === '/api/projects') { const result = database.prepare('INSERT INTO projects (name,repository,token) VALUES (?,?,?)').run(input.name, input.repository, input.token || ''); return json(response, 200, { id: Number(result.lastInsertRowid), ...input, openPrs: 0 }) }
  if (request.method === 'POST' && path === '/api/projects/update') {
    const id = Number(input.id)
    const existing = database.prepare('SELECT token,open_prs FROM projects WHERE id=?').get(id) as { token: string; open_prs: number } | undefined
    if (!existing) return json(response, 404, { message: '项目不存在' })
    database.prepare('UPDATE projects SET name=?,repository=?,token=? WHERE id=?').run(input.name, input.repository, input.token || existing.token, id)
    return json(response, 200, { id, name: input.name, repository: input.repository, token: input.token || existing.token, openPrs: existing.open_prs })
  }
  if (request.method === 'DELETE' && path.startsWith('/api/projects/')) { const id = Number(path.split('/').pop()); database.prepare('DELETE FROM projects WHERE id=?').run(id); database.prepare('DELETE FROM deployment_configs WHERE project_id=?').run(id); database.prepare('DELETE FROM deploy_targets WHERE project_id=?').run(id); return json(response, 200, {}) }
  if (path === '/api/deployment/targets' && request.method === 'GET') return json(response, 200, database.prepare('SELECT t.id, t.project_id AS projectId, t.name, t.host, t.username, t.remote_path AS remotePath, t.command, t.position, p.name AS projectName FROM deploy_targets t JOIN projects p ON p.id = t.project_id ORDER BY t.project_id DESC, t.position, t.id').all())
  if (path === '/api/deployment/targets' && request.method === 'POST') {
    if (input.id) {
      database.prepare('UPDATE deploy_targets SET project_id=?,name=?,host=?,username=?,remote_path=?,command=? WHERE id=?').run(input.projectId, input.name, input.host, input.username, input.remotePath, input.command, input.id)
      return json(response, 200, input)
    }
    const position = (database.prepare('SELECT COALESCE(MAX(position),0)+1 AS p FROM deploy_targets WHERE project_id=?').get(input.projectId) as any).p
    const result = database.prepare('INSERT INTO deploy_targets(project_id,name,host,username,remote_path,command,position) VALUES(?,?,?,?,?,?,?)').run(input.projectId, input.name, input.host, input.username, input.remotePath, input.command, position)
    return json(response, 200, { id: Number(result.lastInsertRowid), ...input, position: Number(position) })
  }
  if (path === '/api/deployment/targets/delete' && request.method === 'POST') { database.prepare('DELETE FROM deploy_targets WHERE id=?').run(input.id); return json(response, 200, {}) }
  if (path === '/api/deployment/targets/reorder' && request.method === 'POST') {
    for (const [index, id] of (input.ids as number[]).entries()) database.prepare('UPDATE deploy_targets SET position=? WHERE id=?').run(index, id)
    return json(response, 200, {})
  }
  if (path === '/api/deployment/logs' && request.method === 'GET') {
    const params = new URL(request.url || '', 'http://localhost').searchParams
    const projectId = Number(params.get('projectId')) || 0
    void 0
    const limit = Math.min(Number(params.get('limit')) || 20, 100)
    const kind = params.get('kind')
    const conditions: string[] = []
    const args: any[] = []
    if (projectId) { conditions.push('project_id=?'); args.push(projectId) }
    if (kind === 'test' || kind === 'deploy') { conditions.push('kind=?'); args.push(kind) }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
    const rows = database.prepare(`SELECT id, project_id AS projectId, project_name AS projectName, target_name, kind, pr_number AS prNumber, host, output, success, created_at AS createdAt FROM deployment_logs${where} ORDER BY id DESC LIMIT ?`).all(...args, limit)
    return json(response, 200, rows)
  }
  if (path === '/api/deployment/servers' && request.method === 'GET') return json(response, 200, database.prepare("SELECT host,username FROM deploy_targets WHERE host != '' GROUP BY host").all())
  if (path === '/api/pulls' && request.method === 'GET') {
    const params = new URL(request.url || '', 'http://localhost').searchParams
    const projectId = Number(params.get('projectId')) || 0
    const rows = projectId
      ? database.prepare('SELECT c.*, p.name AS projectName, p.repository, p.token FROM pr_cache c JOIN projects p ON p.id=c.project_id WHERE c.project_id=? ORDER BY c.gitee_updated_at DESC').all(projectId)
      : database.prepare('SELECT c.*, p.name AS projectName, p.repository, p.token FROM pr_cache c JOIN projects p ON p.id=c.project_id ORDER BY c.gitee_updated_at DESC').all()
    return json(response, 200, rows.map((row: any) => ({
      projectId: row.project_id,
      projectName: row.projectName,
      repository: row.repository,
      token: row.token,
      number: row.number,
      title: row.title,
      body: row.body,
      author: row.author,
      headRef: row.head_ref,
      baseRef: row.base_ref,
      headSha: row.head_sha,
      state: row.state,
      statusNote: row.status_note,
      aiResult: row.ai_result,
      aiEvaluatedAt: row.ai_evaluated_at,
      createdAt: row.gitee_created_at,
      updatedAt: row.gitee_updated_at,
    })))
  }
  if (path === '/api/pulls/refresh' && request.method === 'POST') {
    const results = await pollAll(database, Number(input.projectId) || 0)
    return json(response, 200, { results })
  }
  if (path === '/api/sync/status' && request.method === 'GET') {
    const rows = database.prepare('SELECT s.project_id AS projectId, p.name, s.last_sync_at AS lastSyncAt, s.last_error AS lastError, s.enabled FROM sync_state s JOIN projects p ON p.id=s.project_id ORDER BY s.project_id DESC').all()
    return json(response, 200, rows)
  }
  if (path === '/api/test/configs' && request.method === 'GET') return json(response, 200, database.prepare('SELECT t.*, p.name AS projectName FROM test_configs t JOIN projects p ON p.id=t.project_id ORDER BY t.project_id DESC').all())
  if (path === '/api/test/configs' && request.method === 'POST') {
    database.prepare('INSERT INTO test_configs(project_id,server_mode,host,username,workdir_template,source_path,commands,ai_decides,ai_prompt,timeout_sec) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET server_mode=excluded.server_mode,host=excluded.host,username=excluded.username,workdir_template=excluded.workdir_template,source_path=excluded.source_path,commands=excluded.commands,ai_decides=excluded.ai_decides,ai_prompt=excluded.ai_prompt,timeout_sec=excluded.timeout_sec')
      .run(input.projectId, input.serverMode, input.host, input.username, input.workdirTemplate, input.sourcePath ?? '', input.commands, input.aiDecides ? 1 : 0, input.aiPrompt, input.timeoutSec)
    return json(response, 200, input)
  }
  if (path === '/api/test/run' && request.method === 'POST') {
    const projectId = Number(input.projectId)
    const number = Number(input.number)
    const prRow = database.prepare('SELECT c.number, c.title, c.body, c.head_sha AS headSha, c.state, p.id, p.name, p.repository, p.token FROM pr_cache c JOIN projects p ON p.id=c.project_id WHERE c.project_id=? AND c.number=?').get(projectId, number) as any
    if (!prRow) return json(response, 404, { message: 'PR 不在缓存中' })
    if (prRow.state === 'testing') return json(response, 409, { message: '测试进行中,请稍后再试' })
    const config = database.prepare('SELECT * FROM test_configs WHERE project_id=?').get(projectId) as any
    if (!config) return json(response, 400, { message: '该项目未配置测试,请先在部署页配置' })
    if (config.server_mode === 'ssh' && (!config.host || !config.username)) return json(response, 400, { message: '测试服务器配置不完整' })
    if (config.server_mode === 'local') {
      const sourcePath = (config.source_path || '').replace(/^~(?=\/|$)/, homedir())
      const deployTarget = database.prepare('SELECT remote_path FROM deploy_targets WHERE project_id=? ORDER BY position, id LIMIT 1').get(projectId) as any
      const fallback = deployTarget?.remote_path ? deployTarget.remote_path.replace(/^~(?=\/|$)/, homedir()) : ''
      if (!sourcePath && !fallback) return json(response, 400, { message: '未配置测试源目录(测试配置的 source_path 或部署目标目录),无法初始化测试副本' })
    }
    database.prepare("UPDATE pr_cache SET state='testing' WHERE project_id=? AND number=?").run(projectId, number)
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' })
    const handle = runTest(database, config as TestConfig, { project: { id: prRow.id, name: prRow.name, repository: prRow.repository, token: prRow.token }, pr: { number: prRow.number, title: prRow.title, body: prRow.body, head_sha: prRow.headSha } }, (text) => response.write(text))
    handle.promise.then(() => response.end()).catch((error) => {
      const message = error instanceof Error ? error.message : '执行失败'
      logError('tester', `手动测试发起失败 PR#${number}`, message)
      database.prepare("UPDATE pr_cache SET state='needs_test' WHERE project_id=? AND number=? AND state='testing'").run(projectId, number)
      response.write(`\n[错误] ${message}`)
      response.end()
    })
    return
  }
  if (path === '/api/pr/evaluate' && request.method === 'POST') {
    try {
      const verdict = await evaluateManual(database, Number(input.projectId), Number(input.number))
      return json(response, 200, { verdict })
    } catch (error) { return json(response, 500, { message: error instanceof Error ? error.message : '评估失败' }) }
  }
  if (path === '/api/ai/test' && request.method === 'POST') {
    const aiSettings = { aiBaseUrl: String(input.aiBaseUrl ?? ''), aiApiKey: String(input.aiApiKey ?? ''), aiModel: String(input.aiModel ?? ''), aiPrompt: String(input.aiPrompt ?? '') }
    if (!aiSettings.aiBaseUrl || !aiSettings.aiApiKey || !aiSettings.aiModel) return json(response, 400, { message: '请先完整配置模型' })
    try {
      const reply = await testModelConnection(aiSettings)
      return json(response, 200, { message: `连接成功:${reply}` })
    } catch (error) { return json(response, 500, { message: error instanceof Error ? error.message : '连接失败' }) }
  }
  if (path === '/api/error-logs' && request.method === 'GET') {
    const params = new URL(request.url || '', 'http://localhost').searchParams
    return json(response, 200, listErrors(params.get('source') || '', Math.min(Number(params.get('limit')) || 100, 300)))
  }
  if (path === '/api/request-logs' && request.method === 'GET') {
    const params = new URL(request.url || '', 'http://localhost').searchParams
    const projectId = Number(params.get('projectId')) || 0
    const status = params.get('status') || 'all'
    const limit = Math.min(Number(params.get('limit')) || 100, 300)
    const conditions: string[] = []
    const args: any[] = []
    if (projectId) { conditions.push('project_id=?'); args.push(projectId) }
    if (status === 'ok') conditions.push('ok=1')
    if (status === 'error') conditions.push('ok=0')
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
    const rows = database.prepare(`SELECT id, project_id AS projectId, project_name AS projectName, endpoint, method, ok, status, error_message AS errorMessage, duration_ms AS durationMs, created_at AS createdAt FROM request_logs${where} ORDER BY id DESC LIMIT ?`).all(...args, limit)
    return json(response, 200, rows)
  }
  if (path === '/api/sync/toggle' && request.method === 'POST') {
    database.prepare('INSERT INTO sync_state(project_id,enabled) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled').run(input.projectId, input.enabled ? 1 : 0)
    return json(response, 200, {})
  }
  if (path === '/api/settings' && request.method === 'GET') return json(response, 200, readSettings())
  if (path === '/api/settings' && request.method === 'POST') return json(response, 200, saveSettings(input))
  if (path === '/api/meta' && request.method === 'GET') return json(response, 200, { version, dataPath: databasePath })
  if (path === '/api/deployment/run' && request.method === 'POST') return runDeployment(response, input.targetId)
  if (request.method === 'POST' && path === '/api/gitee/pulls') return json(response, 200, await gitee(input, 'pulls?state=open&per_page=50'))
  if (request.method === 'POST' && path === '/api/gitee/pull-detail') return json(response, 200, await gitee(input, `pulls/${input.number}`))
  if (request.method === 'POST' && path === '/api/gitee/pull-logs') return json(response, 200, await gitee(input, `pulls/${input.number}/operate_logs`))
  if (request.method === 'POST' && path === '/api/gitee/pull-files') return json(response, 200, await gitee(input, `pulls/${input.number}/files`))
  if (request.method === 'POST' && path === '/api/gitee/pull-commits') return json(response, 200, await gitee(input, `pulls/${input.number}/commits`))
  if (request.method === 'POST' && path === '/api/gitee/commit-detail') return json(response, 200, await gitee(input, `commits/${input.sha}`))
  if (request.method === 'POST' && path === '/api/gitee/approve-pull') return json(response, 200, await gitee(input, `pulls/${input.number}/review`, { method: 'POST', body: new URLSearchParams({ force: 'true' }) }))
  if (request.method === 'POST' && path === '/api/gitee/test-pull') return json(response, 200, await gitee(input, `pulls/${input.number}/test`, { method: 'POST', body: new URLSearchParams({ force: 'true' }) }))
  if (request.method === 'POST' && path === '/api/gitee/file') return json(response, 200, await gitee(input, `contents/${input.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(input.ref)}`))
  if (request.method === 'POST' && path === '/api/gitee/create-pull') return json(response, 200, await gitee(input, 'pulls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: input.title, head: input.head, base: input.base }) }))
  if (request.method === 'POST' && path === '/api/gitee/merge-pull') { const mergeMethod = ['merge', 'rebase', 'squash'].includes(input.mergeMethod) ? input.mergeMethod : 'merge'; return json(response, 200, await gitee(input, `pulls/${input.number}/merge`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ merge_method: mergeMethod }) })) }
  return json(response, 404, { message: 'Not found' })
}

function recordDeployStart(projectId: number, projectName: string, targetName: string, host: string) {
  const createdAt = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const result = database.prepare('INSERT INTO deployment_logs(project_id,project_name,target_name,host,created_at) VALUES(?,?,?,?,?)').run(projectId, projectName, targetName, host, createdAt)
  return Number(result.lastInsertRowid)
}

function recordDeployEnd(id: number, output: string, success: boolean) {
  database.prepare('UPDATE deployment_logs SET output=?, success=? WHERE id=?').run(output, success ? 1 : 0, id)
}

function runDeployment(response: import('node:http').ServerResponse, targetId: number) {
  const target = database.prepare('SELECT t.*, p.name AS projectName FROM deploy_targets t JOIN projects p ON p.id = t.project_id WHERE t.id=?').get(targetId) as any
  if (!target) return json(response, 404, { message: '部署目标不存在' })
  if (!target.host || !target.username || !target.remote_path || !target.command) return json(response, 400, { message: '部署目标配置不完整' })
  const logId = recordDeployStart(target.project_id, target.projectName, target.name, `${target.username}@${target.host}`)
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' })
  const child = spawn('ssh', ['-o', 'BatchMode=yes', `${target.username}@${target.host}`, `cd ${target.remote_path} && ${target.command}`])
  let collected = ''
  child.stdout.on('data', (data) => { collected += data.toString(); response.write(data.toString()) })
  child.stderr.on('data', (data) => { collected += data.toString(); response.write(data.toString()) })
  child.on('error', (error) => { const text = `${collected}\n[错误] ${error.message}`; recordDeployEnd(logId, text, false); response.write(`\n[错误] ${error.message}`); response.end() })
  child.on('close', (code) => {
    const marker = code === 0 ? '\n[部署完成]' : `\n[部署失败，退出码 ${code}]`
    recordDeployEnd(logId, collected + marker, code === 0)
    response.write(marker)
    response.end()
  })
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    if (url.pathname.startsWith('/api/')) return await api(request, response, url.pathname)
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const target = join(root, 'dist', file)
    const content = existsSync(target) ? readFileSync(target) : readFileSync(join(root, 'dist', 'index.html'))
    const type = extname(target) === '.js' ? 'text/javascript' : extname(target) === '.css' ? 'text/css' : 'text/html'
    response.writeHead(200, { 'content-type': `${type}; charset=utf-8` }); response.end(content)
  } catch (error) { json(response, 500, { message: error instanceof Error ? error.message : '服务器错误' }) }
}).listen(port, '127.0.0.1', () => {
  console.log(`Gitee Release Console: http://127.0.0.1:${port}`)
  pollerHandle = startPoller(database)
})
let pollerHandle: ReturnType<typeof startPoller> | undefined
