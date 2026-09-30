import type { DatabaseSync } from 'node:sqlite'
import { gitee } from './gitee.js'

type Project = { id: number; name: string; repository: string; token: string }
type PullRow = any

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function projectInput(project: Project) {
  return { repository: project.repository, token: project.token }
}

export function readPollIntervalSec(database: DatabaseSync) {
  const row = database.prepare("SELECT value FROM settings WHERE key='pollIntervalSec'").get() as any
  const value = Number(row?.value) || 180
  return Math.max(60, value)
}

export async function pollProject(database: DatabaseSync, project: Project) {
  const syncedAt = now()
  const list: PullRow[] = await gitee(projectInput(project), 'pulls?state=all&sort=updated&direction=desc&per_page=50')
  const seen = new Set<number>()
  let changed = 0
  for (const pull of list) {
    const number = Number(pull.number)
    seen.add(number)
    const giteeState = pull.state === 'open' ? 'open' : (pull.merged ? 'merged' : 'closed')
    const existing = database.prepare('SELECT id, head_sha AS headSha, state FROM pr_cache WHERE project_id=? AND number=?').get(project.id, number) as any
    const columns = {
      title: String(pull.title ?? ''),
      body: String(pull.body ?? ''),
      author: pull.user?.name || pull.user?.login || pull.user?.username || '未知提交人',
      head_ref: String(pull.head?.ref ?? ''),
      base_ref: String(pull.base?.ref ?? ''),
      head_sha: String(pull.head?.sha ?? ''),
      raw: JSON.stringify(pull),
      gitee_created_at: String(pull.created_at ?? '').replace('T', ' ').slice(0, 19),
      gitee_updated_at: String(pull.updated_at ?? '').replace('T', ' ').slice(0, 19),
    }
    if (!existing) {
      database.prepare(`INSERT INTO pr_cache(project_id,number,title,body,author,head_ref,base_ref,head_sha,raw,gitee_created_at,gitee_updated_at,first_seen_at,last_seen_at,synced_at,state,status_note)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'new','')`)
        .run(project.id, number, columns.title, columns.body, columns.author, columns.head_ref, columns.base_ref, columns.head_sha, columns.raw, columns.gitee_created_at, columns.gitee_updated_at, syncedAt, syncedAt, syncedAt)
      changed += 1
    } else {
      let state = existing.state
      let statusNote = ''
      if (giteeState !== 'open') {
        state = giteeState
      } else if (existing.headSha && columns.head_sha && existing.headSha !== columns.head_sha) {
        state = 'new'
        statusNote = '检测到新提交，待评估'
        changed += 1
      }
      if (state !== 'new' && state !== 'merged' && state !== 'closed' && giteeState === 'open') state = existing.state
      database.prepare(`UPDATE pr_cache SET title=?,body=?,author=?,head_ref=?,base_ref=?,head_sha=?,state=?,status_note=?,raw=?,gitee_updated_at=?,last_seen_at=?,synced_at=? WHERE id=?`)
        .run(columns.title, columns.body, columns.author, columns.head_ref, columns.base_ref, columns.head_sha, state, statusNote, columns.raw, columns.gitee_updated_at, syncedAt, syncedAt, existing.id)
    }
  }
  // 缓存中仍为开放态、但列表中不存在的 PR:查详情确认最终状态
  const openCached = database.prepare("SELECT number FROM pr_cache WHERE project_id=? AND state NOT IN ('merged','closed')").all(project.id) as Array<{ number: number }>
  for (const row of openCached) {
    if (seen.has(row.number)) continue
    try {
      const detail = await gitee(projectInput(project), `pulls/${row.number}`)
      const finalState = detail.state === 'open' ? 'open' : (detail.merged ? 'merged' : 'closed')
      if (finalState !== 'open') database.prepare("UPDATE pr_cache SET state=?, synced_at=? WHERE project_id=? AND number=?").run(finalState, syncedAt, project.id, row.number)
    } catch { /* 详情查询失败留给下轮 */ }
  }
  return { changed, synced: list.length }
}

export async function pollAll(database: DatabaseSync, projectId = 0) {
  const projects = (projectId
    ? database.prepare('SELECT id,name,repository,token FROM projects WHERE id=?').all(projectId) as any[]
    : database.prepare('SELECT id,name,repository,token FROM projects').all() as any[]).filter((project) => project.repository)
  const enabled = new Set((database.prepare('SELECT project_id FROM sync_state WHERE enabled=1').all() as any[]).map((row) => row.project_id))
  const results: Array<{ projectId: number; name: string; error: string }> = []
  const queue = projects.filter((project) => !enabled.size || enabled.has(project.id))
  const worker = async () => {
    for (;;) {
      const project = queue.shift()
      if (!project) return
      try {
        await pollProject(database, project)
        database.prepare("INSERT INTO sync_state(project_id,last_sync_at,last_error,enabled) VALUES(?,?,'',1) ON CONFLICT(project_id) DO UPDATE SET last_sync_at=excluded.last_sync_at,last_error=''").run(project.id, now())
        results.push({ projectId: project.id, name: project.name, error: '' })
      } catch (error) {
        const message = error instanceof Error ? error.message : '同步失败'
        database.prepare('INSERT INTO sync_state(project_id,last_sync_at,last_error,enabled) VALUES(?,?,?,1) ON CONFLICT(project_id) DO UPDATE SET last_error=excluded.last_error').run(project.id, now(), message)
        results.push({ projectId: project.id, name: project.name, error: message })
      }
    }
  }
  await Promise.all([worker(), worker(), worker()])
  return results
}

export function startPoller(database: DatabaseSync) {
  let running = false
  let timer: ReturnType<typeof setInterval> | undefined
  const tick = async () => {
    if (running) return
    running = true
    try { await pollAll(database) } finally { running = false }
  }
  const schedule = () => {
    if (timer) clearInterval(timer)
    timer = setInterval(tick, readPollIntervalSec(database) * 1000)
  }
  schedule()
  void tick()
  return {
    pollNow: tick,
    reschedule: schedule,
    stop: () => { if (timer) clearInterval(timer) },
  }
}
