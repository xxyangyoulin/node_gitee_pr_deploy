import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'

const port = Number(process.env.PORT) || 18763
const root = process.cwd()
const databasePath = join(root, 'release-console.sqlite')
const database = new DatabaseSync(databasePath)
const version = (() => { try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '' } catch { return '' } })()
database.exec('CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, repository TEXT NOT NULL, token TEXT NOT NULL DEFAULT "", open_prs INTEGER NOT NULL DEFAULT 0)')
database.exec('CREATE TABLE IF NOT EXISTS deployment_configs (project_id INTEGER PRIMARY KEY, host TEXT NOT NULL DEFAULT "", username TEXT NOT NULL DEFAULT "", remote_path TEXT NOT NULL DEFAULT "", command TEXT NOT NULL DEFAULT "")')
database.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT "")')
database.exec('CREATE TABLE IF NOT EXISTS deployment_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, project_name TEXT NOT NULL DEFAULT "", host TEXT NOT NULL DEFAULT "", output TEXT NOT NULL DEFAULT "", success INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT "")')

const defaultSettings = { prHead: 'dock', prBase: 'master', mergeMethod: 'merge' }

function readSettings() {
  const rows = database.prepare('SELECT key,value FROM settings').all() as Array<{ key: string; value: string }>
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]))
  return {
    prHead: stored.prHead || defaultSettings.prHead,
    prBase: stored.prBase || defaultSettings.prBase,
    mergeMethod: stored.mergeMethod || defaultSettings.mergeMethod,
  }
}

function saveSettings(input: Record<string, unknown>) {
  const statement = database.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  for (const key of Object.keys(defaultSettings)) if (typeof input[key] === 'string' && input[key]) statement.run(key, input[key])
  return readSettings()
}

type Input = { repository: string; token: string }

async function gitee(input: Input, endpoint: string, init?: RequestInit) {
  const url = new URL(`https://gitee.com/api/v5/repos/${input.repository}/${endpoint}`)
  url.searchParams.set('access_token', input.token)
  const response = await fetch(url, init)
  const text = await response.text()
  let body: any
  try { body = JSON.parse(text) } catch { body = { message: text.slice(0, 300) } }
  if (!response.ok) throw new Error(`Gitee ${response.status}: ${body.message ?? JSON.stringify(body)}`)
  return body
}

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
  if (request.method === 'DELETE' && path.startsWith('/api/projects/')) { const id = Number(path.split('/').pop()); database.prepare('DELETE FROM projects WHERE id=?').run(id); database.prepare('DELETE FROM deployment_configs WHERE project_id=?').run(id); return json(response, 200, {}) }
  if (path === '/api/deployment/configs' && request.method === 'GET') return json(response, 200, database.prepare('SELECT p.id AS projectId, p.name AS projectName, c.host, c.username, c.remote_path AS remotePath, c.command FROM projects p LEFT JOIN deployment_configs c ON c.project_id = p.id ORDER BY p.id DESC').all())
  if (path === '/api/deployment/logs' && request.method === 'GET') {
    const params = new URL(request.url || '', 'http://localhost').searchParams
    const projectId = Number(params.get('projectId')) || 0
    const limit = Math.min(Number(params.get('limit')) || 20, 100)
    const rows = projectId
      ? database.prepare('SELECT id, project_id AS projectId, project_name AS projectName, host, output, success, created_at AS createdAt FROM deployment_logs WHERE project_id=? ORDER BY id DESC LIMIT ?').all(projectId, limit)
      : database.prepare('SELECT id, project_id AS projectId, project_name AS projectName, host, output, success, created_at AS createdAt FROM deployment_logs ORDER BY id DESC LIMIT ?').all(limit)
    return json(response, 200, rows)
  }
  if (path === '/api/deployment/servers' && request.method === 'GET') return json(response, 200, database.prepare("SELECT host,username FROM deployment_configs WHERE host != '' GROUP BY host").all())
  if (path === '/api/settings' && request.method === 'GET') return json(response, 200, readSettings())
  if (path === '/api/settings' && request.method === 'POST') return json(response, 200, saveSettings(input))
  if (path === '/api/meta' && request.method === 'GET') return json(response, 200, { version, dataPath: databasePath })
  if (path === '/api/deployment/config' && request.method === 'POST') { database.prepare('INSERT INTO deployment_configs(project_id,host,username,remote_path,command) VALUES(?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET host=excluded.host,username=excluded.username,remote_path=excluded.remote_path,command=excluded.command').run(input.projectId, input.host, input.username, input.remotePath, input.command); return json(response, 200, input) }
  if (path === '/api/deployment/config' && request.method === 'DELETE') { database.prepare('DELETE FROM deployment_configs WHERE project_id=?').run(Number(new URL(request.url || '', 'http://localhost').searchParams.get('projectId'))); return json(response, 200, {}) }
  if (path === '/api/deployment/run' && request.method === 'POST') return runDeployment(response, input.projectId)
  if (request.method === 'POST' && path === '/api/gitee/pulls') return json(response, 200, await gitee(input, 'pulls?state=open&per_page=50'))
  if (request.method === 'POST' && path === '/api/gitee/pull-detail') return json(response, 200, await gitee(input, `pulls/${input.number}`))
  if (request.method === 'POST' && path === '/api/gitee/pull-logs') return json(response, 200, await gitee(input, `pulls/${input.number}/operate_logs`))
  if (request.method === 'POST' && path === '/api/gitee/pull-files') return json(response, 200, await gitee(input, `pulls/${input.number}/files`))
  if (request.method === 'POST' && path === '/api/gitee/pull-commits') return json(response, 200, await gitee(input, `pulls/${input.number}/commits`))
  if (request.method === 'POST' && path === '/api/gitee/approve-pull') return json(response, 200, await gitee(input, `pulls/${input.number}/review`, { method: 'POST', body: new URLSearchParams({ force: 'true' }) }))
  if (request.method === 'POST' && path === '/api/gitee/test-pull') return json(response, 200, await gitee(input, `pulls/${input.number}/test`, { method: 'POST', body: new URLSearchParams({ force: 'true' }) }))
  if (request.method === 'POST' && path === '/api/gitee/file') return json(response, 200, await gitee(input, `contents/${input.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(input.ref)}`))
  if (request.method === 'POST' && path === '/api/gitee/create-pull') return json(response, 200, await gitee(input, 'pulls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: input.title, head: input.head, base: input.base }) }))
  if (request.method === 'POST' && path === '/api/gitee/merge-pull') { const mergeMethod = ['merge', 'rebase', 'squash'].includes(input.mergeMethod) ? input.mergeMethod : 'merge'; return json(response, 200, await gitee(input, `pulls/${input.number}/merge`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ merge_method: mergeMethod }) })) }
  return json(response, 404, { message: 'Not found' })
}

function recordDeployStart(projectId: number, projectName: string, host: string) {
  const createdAt = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const result = database.prepare('INSERT INTO deployment_logs(project_id,project_name,host,created_at) VALUES(?,?,?,?)').run(projectId, projectName, host, createdAt)
  return Number(result.lastInsertRowid)
}

function recordDeployEnd(id: number, output: string, success: boolean) {
  database.prepare('UPDATE deployment_logs SET output=?, success=? WHERE id=?').run(output, success ? 1 : 0, id)
}

function runDeployment(response: import('node:http').ServerResponse, projectId: number) {
  const config = database.prepare('SELECT host,username,remote_path AS remotePath,command FROM deployment_configs WHERE project_id=?').get(projectId) as any
  if (!config?.host || !config.username || !config.remotePath || !config.command) return json(response, 400, { message: '请先完整配置部署信息' })
  const projectName = (database.prepare('SELECT name FROM projects WHERE id=?').get(projectId) as any)?.name ?? ''
  const logId = recordDeployStart(projectId, projectName, `${config.username}@${config.host}`)
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' })
  const child = spawn('ssh', ['-o', 'BatchMode=yes', `${config.username}@${config.host}`, `cd ${config.remotePath} && ${config.command}`])
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
}).listen(port, '127.0.0.1', () => console.log(`Gitee Release Console: http://127.0.0.1:${port}`))
