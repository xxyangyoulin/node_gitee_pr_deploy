import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'

app.commandLine.appendSwitch('disable-gpu')

type RepositoryInput = { repository: string; token: string }

let database: DatabaseSync
let databasePath = ''

function openDatabase() {
  databasePath = path.join(app.getPath('userData'), 'release-console.sqlite')
  database = new DatabaseSync(databasePath)
  database.exec('CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, repository TEXT NOT NULL, token TEXT NOT NULL DEFAULT "", open_prs INTEGER NOT NULL DEFAULT 0)')
  database.exec('CREATE TABLE IF NOT EXISTS deployment_configs (project_id INTEGER PRIMARY KEY, host TEXT NOT NULL DEFAULT "", username TEXT NOT NULL DEFAULT "", remote_path TEXT NOT NULL DEFAULT "", command TEXT NOT NULL DEFAULT "", FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE)')
  database.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT "")')
  database.exec('CREATE TABLE IF NOT EXISTS deployment_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, project_name TEXT NOT NULL DEFAULT "", host TEXT NOT NULL DEFAULT "", output TEXT NOT NULL DEFAULT "", success INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT "")')
}

const defaultSettings = { prHead: 'dock', prBase: 'master', mergeMethod: 'merge' }

function readSettings() {
  const rows = database.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]))
  return {
    prHead: stored.prHead || defaultSettings.prHead,
    prBase: stored.prBase || defaultSettings.prBase,
    mergeMethod: stored.mergeMethod || defaultSettings.mergeMethod,
  }
}

function saveSettings(input: Record<string, unknown>) {
  const statement = database.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  for (const key of Object.keys(defaultSettings)) if (typeof input[key] === 'string' && input[key]) statement.run(key, input[key])
  return readSettings()
}

async function giteeRequest(input: RepositoryInput, endpoint: string, init?: RequestInit) {
  const url = new URL(`https://gitee.com/api/v5/repos/${input.repository}/${endpoint}`)
  url.searchParams.set('access_token', input.token)
  const response = await fetch(url, init)
  const body = await response.json()
  if (!response.ok) throw new Error(`Gitee ${response.status}: ${body.message ?? JSON.stringify(body)}`)
  return body
}

function registerHandlers() {
  ipcMain.handle('projects:list', () => database.prepare('SELECT id, name, repository, token, open_prs AS openPrs FROM projects ORDER BY id DESC').all())
  ipcMain.handle('projects:add', (_, project: { name: string; repository: string; token: string }) => {
    const result = database.prepare('INSERT INTO projects (name, repository, token) VALUES (?, ?, ?)').run(project.name, project.repository, project.token)
    return { id: Number(result.lastInsertRowid), ...project, openPrs: 0 }
  })
  ipcMain.handle('projects:delete', (_, id: number) => {
    database.prepare('DELETE FROM projects WHERE id = ?').run(id)
    database.prepare('DELETE FROM deployment_configs WHERE project_id = ?').run(id)
  })
  ipcMain.handle('projects:update', (_, input: { id: number; name: string; repository: string; token: string }) => {
    const existing = database.prepare('SELECT token, open_prs FROM projects WHERE id = ?').get(input.id) as { token: string; open_prs: number } | undefined
    if (!existing) throw new Error('项目不存在')
    database.prepare('UPDATE projects SET name = ?, repository = ?, token = ? WHERE id = ?').run(input.name, input.repository, input.token || existing.token, input.id)
    return { id: input.id, name: input.name, repository: input.repository, token: input.token || existing.token, openPrs: existing.open_prs }
  })
  ipcMain.handle('settings:get', () => readSettings())
  ipcMain.handle('settings:save', (_, input: Record<string, unknown>) => saveSettings(input))
  ipcMain.handle('meta:get', () => ({ version: app.getVersion(), dataPath: databasePath }))
  ipcMain.handle('deployment:list-configs', () => database.prepare('SELECT p.id AS projectId, p.name AS projectName, c.host, c.username, c.remote_path AS remotePath, c.command FROM projects p LEFT JOIN deployment_configs c ON c.project_id = p.id ORDER BY p.id DESC').all())
  ipcMain.handle('deployment:delete-config', (_, projectId: number) => database.prepare('DELETE FROM deployment_configs WHERE project_id = ?').run(projectId))
  ipcMain.handle('deployment:list-servers', () => database.prepare("SELECT host, username FROM deployment_configs WHERE host != '' GROUP BY host").all())
  ipcMain.handle('deployment:save-config', (_, input: { projectId: number; host: string; username: string; remotePath: string; command: string }) => {
    database.prepare('INSERT INTO deployment_configs (project_id, host, username, remote_path, command) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET host=excluded.host, username=excluded.username, remote_path=excluded.remote_path, command=excluded.command').run(input.projectId, input.host, input.username, input.remotePath, input.command)
    return input
  })
  ipcMain.handle('deployment:run', (_, input: { projectId: number }) => {
    const config = database.prepare('SELECT host, username, remote_path AS remotePath, command FROM deployment_configs WHERE project_id = ?').get(input.projectId) as { host: string; username: string; remotePath: string; command: string } | undefined
    if (!config?.host || !config.username || !config.remotePath || !config.command) throw new Error('请先完整配置部署信息')
    const projectName = (database.prepare('SELECT name FROM projects WHERE id = ?').get(input.projectId) as any)?.name ?? ''
    const createdAt = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const logId = Number(database.prepare('INSERT INTO deployment_logs (project_id, project_name, host, created_at) VALUES (?, ?, ?, ?)').run(input.projectId, projectName, `${config.username}@${config.host}`, createdAt).lastInsertRowid)
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', ['-o', 'BatchMode=yes', `${config.username}@${config.host}`, `cd ${config.remotePath} && ${config.command}`])
      let output = ''
      child.stdout.on('data', (data) => { output += data.toString() })
      child.stderr.on('data', (data) => { output += data.toString() })
      child.on('error', (error) => { database.prepare('UPDATE deployment_logs SET output = ?, success = 0 WHERE id = ?').run(`${output}\n[错误] ${error.message}`, logId); reject(error) })
      child.on('close', (code) => {
        const marker = code === 0 ? '\n[部署完成]' : `\n[部署失败，退出码 ${code}]`
        database.prepare('UPDATE deployment_logs SET output = ?, success = ? WHERE id = ?').run(output + marker, code === 0 ? 1 : 0, logId)
        code === 0 ? resolve(output + marker) : reject(new Error(output + marker))
      })
    })
  })
  ipcMain.handle('deployment:list-logs', (_, query: { projectId?: number; limit?: number } = {}) => {
    const limit = Math.min(Number(query.limit) || 20, 100)
    return query.projectId
      ? database.prepare('SELECT id, project_id AS projectId, project_name AS projectName, host, output, success, created_at AS createdAt FROM deployment_logs WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(query.projectId, limit)
      : database.prepare('SELECT id, project_id AS projectId, project_name AS projectName, host, output, success, created_at AS createdAt FROM deployment_logs ORDER BY id DESC LIMIT ?').all(limit)
  })
  ipcMain.handle('gitee:list-pulls', (_, input: RepositoryInput) => giteeRequest(input, 'pulls?state=open&per_page=50'))
  ipcMain.handle('gitee:pull-files', (_, input: RepositoryInput & { number: number }) => giteeRequest(input, `pulls/${input.number}/files`))
  ipcMain.handle('gitee:approve-pull', async (_, input: RepositoryInput & { number: number }) => {
    try { return await giteeRequest(input, `pulls/${input.number}/review`, { method: 'POST', body: new URLSearchParams({ force: 'true' }) }) } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (/already|approved|通过|审查/i.test(message)) return { alreadyApproved: true }
      throw error
    }
  })
  ipcMain.handle('gitee:test-pull', (_, input: RepositoryInput & { number: number }) => giteeRequest(input, `pulls/${input.number}/test`, { method: 'POST', body: new URLSearchParams({ force: 'true' }) }))
  ipcMain.handle('gitee:file-content', async (_, input: RepositoryInput & { url: string }) => {
    const url = new URL(input.url)
    if (url.hostname !== 'gitee.com') throw new Error('不支持的文件地址')
    url.searchParams.set('access_token', input.token)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Gitee ${response.status}: 无法读取文件内容`)
    return response.text()
  })
  ipcMain.handle('gitee:repository-file', (_, input: RepositoryInput & { path: string; ref: string }) => {
    const encodedPath = input.path.split('/').map((part) => encodeURIComponent(part)).join('/')
    return giteeRequest(input, `contents/${encodedPath}?ref=${encodeURIComponent(input.ref)}`)
  })
  ipcMain.handle('gitee:create-pull', (_, input: RepositoryInput & { title: string; head: string; base: string }) => giteeRequest(input, 'pulls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: input.title, head: input.head, base: input.base }) }))
  ipcMain.handle('gitee:merge-pull', (_, input: RepositoryInput & { number: number; mergeMethod?: string }) => giteeRequest(input, `pulls/${input.number}/merge`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ merge_method: ['merge', 'rebase', 'squash'].includes(input.mergeMethod || '') ? input.mergeMethod : 'merge' }) }))
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(app.getAppPath(), 'dist-electron/preload.cjs'),
    },
  })
  window.loadFile(path.join(app.getAppPath(), 'dist/index.html'))
}

app.whenReady().then(() => { openDatabase(); registerHandlers(); createWindow() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
