import type { DatabaseSync } from 'node:sqlite'

let database: DatabaseSync | undefined

export function initErrorLog(db: DatabaseSync) {
  database = db
  db.exec('CREATE TABLE IF NOT EXISTS error_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL DEFAULT "", message TEXT NOT NULL DEFAULT "", detail TEXT NOT NULL DEFAULT "", created_at TEXT NOT NULL DEFAULT "")')
  db.exec("CREATE INDEX IF NOT EXISTS idx_error_logs_created ON error_logs(created_at DESC)")
}

export function logError(source: string, message: string, detail = '') {
  try {
    const createdAt = new Date().toISOString().replace('T', ' ').slice(0, 19)
    database?.prepare('INSERT INTO error_logs(source,message,detail,created_at) VALUES(?,?,?,?)').run(source, String(message).slice(0, 500), String(detail).slice(0, 2000), createdAt)
    database?.prepare('DELETE FROM error_logs WHERE id <= (SELECT MIN(id) FROM error_logs WHERE id > (SELECT MAX(id) - 500 FROM error_logs))').run()
  } catch { /* 日志失败不影响主流程 */ }
}

export function listErrors(source = '', limit = 100) {
  const rows = source
    ? database?.prepare('SELECT id, source, message, detail, created_at AS createdAt FROM error_logs WHERE source=? ORDER BY id DESC LIMIT ?').all(source, Math.min(limit, 300))
    : database?.prepare('SELECT id, source, message, detail, created_at AS createdAt FROM error_logs ORDER BY id DESC LIMIT ?').all(Math.min(limit, 300))
  return rows ?? []
}
