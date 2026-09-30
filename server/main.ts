import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { gitee } from './gitee.js'
import { startPoller, pollAll } from './poller.js'

const port = Number(process.env.PORT) || 18763
const root = process.cwd()
const databasePath = join(root, 'release-console.sqlite')
const database = new DatabaseSync(databasePath)
const version = (() => { try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '' } catch { return '' } })()
database.exec('CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, repository TEXT NOT NULL, token TEXT NOT NULL DEFAULT "", open_prs INTEGER NOT NULL DEFAULT 0)')
database.exec('CREATE TABLE IF NOT EXISTS deployment_configs (project_id INTEGER PRIMARY KEY, host TEXT NOT NULL DEFAULT "", username TEXT NOT NULL DEFAULT "", remote_path TEXT NOT NULL DEFAULT "", command TEXT NOT NULL DEFAULT "")')
database.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT "")')
database.exec('CREATE TABLE IF NOT EXISTS deployment_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, project_name TEXT NOT NULL DEFAULT "", target_name TEXT NOT NULL DEFAULT "", host TEXT NOT NULL DEFAULT "", output TEXT NOT NULL DEFAULT "", success INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT "")')
try { database.exec('ALTER TABLE deployment_logs ADD COLUMN target_name TEXT NOT NULL DEFAULT ""') } catch { }
database.exec('CREATE TABLE IF NOT EXISTS deploy_targets (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL DEFAULT "", host TEXT NOT NULL DEFAULT "", username TEXT NOT NULL DEFAULT "", remote_path TEXT NOT NULL DEFAULT "", command TEXT NOT NULL DEFAULT "", position INTEGER NOT NULL DEFAULT 0)')
database.exec('CREATE TABLE IF NOT EXISTS pr_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL DEFAULT "", body TEXT NOT NULL DEFAULT "", author TEXT NOT NULL DEFAULT "", head_ref TEXT NOT NULL DEFAULT "", base_ref TEXT NOT NULL DEFAULT "", head_sha TEXT NOT NULL DEFAULT "", state TEXT NOT NULL DEFAULT "new", status_note TEXT NOT NULL DEFAULT "", raw TEXT NOT NULL DEFAULT "", gitee_created_at TEXT NOT NULL DEFAULT "", gitee_updated_at TEXT NOT NULL DEFAULT "", first_seen_at TEXT NOT NULL DEFAULT "", last_seen_at TEXT NOT NULL DEFAULT "", synced_at TEXT NOT NULL DEFAULT "", UNIQUE(project_id, number))')
database.exec('CREATE TABLE IF NOT EXISTS sync_state (project_id INTEGER PRIMARY KEY, last_sync_at TEXT NOT NULL DEFAULT "", last_error TEXT NOT NULL DEFAULT "", enabled INTEGER NOT NULL DEFAULT 1)')
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

const defaultSettings: Record<string, string> = { prHead: 'dock', prBase: 'master', mergeMethod: 'merge', pollIntervalSec: '180', automationEnabled: '0' }

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
    const limit = Math.min(Number(params.get('limit')) || 20, 100)
    const rows = projectId
      ? database.prepare('SELECT id, project_id AS projectId, project_name AS projectName, target_name, host, output, success, created_at AS createdAt FROM deployment_logs WHERE project_id=? ORDER BY id DESC LIMIT ?').all(projectId, limit)
      : database.prepare('SELECT id, project_id AS projectId, project_name AS projectName, target_name, host, output, success, created_at AS createdAt FROM deployment_logs ORDER BY id DESC LIMIT ?').all(limit)
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
