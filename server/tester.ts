import type { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { buildEvaluationInput, callModelJson, renderPrompt, type AiSettings } from './ai.js'

export type TestCommandOption = { label: string; command: string }

export type TestConfig = {
  project_id: number
  server_mode: 'local' | 'ssh'
  host: string
  username: string
  workdir_template: string
  commands: string
  ai_decides: number
  ai_prompt: string
  timeout_sec: number
}

export type TestContext = {
  project: { id: number; name: string; repository: string; token: string }
  pr: { number: number; title: string; body: string; head_sha: string }
}

const DEFAULT_COMMANDS: TestCommandOption[] = [{ label: '全量', command: 'vendor/bin/phpunit tests' }]

export const DEFAULT_TEST_PROMPT = `你是测试策略助手。根据 PR 变更从下列测试命令选项中选择最合适的一个(仅输出序号)。
可选命令:
{{options}}
PR 标题:{{title}}
变更文件:
{{files}}
仅输出 JSON:{"command_index": 0}`

const projectLocks = new Set<number>()
let globalRunning = 0

export function parseCommands(raw: string): TestCommandOption[] {
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.length && parsed.every((item) => typeof item?.label === 'string' && typeof item?.command === 'string')) return parsed
  } catch { }
  return DEFAULT_COMMANDS
}

async function pickCommand(database: DatabaseSync, config: TestConfig, context: TestContext): Promise<{ option: TestCommandOption; note: string }> {
  const options = parseCommands(config.commands)
  if (!config.ai_decides) return { option: options[0], note: '' }
  const settingsRows = database.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
  const stored: Record<string, string> = Object.fromEntries(settingsRows.map((row) => [row.key, row.value]))
  const aiSettings: AiSettings = { aiBaseUrl: stored.aiBaseUrl ?? '', aiApiKey: stored.aiApiKey ?? '', aiModel: stored.aiModel ?? '', aiPrompt: stored.aiPrompt || '' }
  if (!aiSettings.aiApiKey || !aiSettings.aiBaseUrl || !aiSettings.aiModel) return { option: options[0], note: 'AI 未配置,使用默认命令' }
  const files = await fetchPrFiles(context.project, context.pr.number)
  const input = buildEvaluationInput(files)
  const optionsText = options.map((option, index) => `${index}. ${option.label} — ${option.command}`).join('\n')
  const prompt = renderPrompt(config.ai_prompt || DEFAULT_TEST_PROMPT, { title: context.pr.title, body: context.pr.body, files: optionsText, diff: input.diff })
  try {
    const parsed = await callModelJson(aiSettings, prompt)
    const index = Number(parsed.command_index)
    if (Number.isInteger(index) && index >= 0 && index < options.length) return { option: options[index], note: `AI 选择:${options[index].label}` }
    return { option: options[0], note: `AI 选择越界,使用默认:${options[0].label}` }
  } catch (error) {
    return { option: options[0], note: `AI 选择失败(${error instanceof Error ? error.message : '未知'}),使用默认:${options[0].label}` }
  }
}

async function fetchPrFiles(project: TestContext['project'], number: number) {
  const { gitee } = await import('./gitee.js')
  return (await gitee({ repository: project.repository, token: project.token }, `pulls/${number}/files`)) as any[]
}

function buildScript(context: TestContext, config: TestConfig, command: string) {
  const workdir = (config.workdir_template || '~/TEST/{project}_{pr}')
    .replaceAll('{project}', context.project.name)
    .replaceAll('{pr}', String(context.pr.number))
  const cloneUrl = `https://oauth2:${context.project.token}@gitee.com/${context.project.repository}.git`
  return [
    `mkdir -p ${shellQuote(workdir)}`,
    `cd ${shellQuote(workdir)}`,
    `if [ ! -d .git ]; then git clone ${shellQuote(cloneUrl)} . ; fi`,
    'git fetch --all --prune',
    `git checkout -f ${shellQuote(context.pr.head_sha || 'HEAD')}`,
    command,
  ].join(' && ')
}

function shellQuote(value: string) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

export type TestRunHandle = { promise: Promise<{ success: boolean; logId: number }> }

export function runTest(database: DatabaseSync, config: TestConfig, context: TestContext, onChunk?: (text: string) => void): TestRunHandle {
  if (projectLocks.has(context.project.id)) return { promise: Promise.reject(new Error('该项目已有测试在运行')) }
  if (globalRunning >= 2) return { promise: Promise.reject(new Error('全局测试并发已满,请稍后')) }
  projectLocks.add(context.project.id)
  globalRunning += 1
  const promise = (async () => {
    try {
    const startedAt = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const insert = database.prepare("INSERT INTO deployment_logs(project_id,project_name,target_name,host,kind,pr_number,output,success,created_at) VALUES(?,?,?,?,'test',?,?,?,?)")
      .run(context.project.id, context.project.name, `PR#${context.pr.number} 测试`, config.server_mode === 'local' ? 'local' : `${config.username}@${config.host}`, context.pr.number, '', 0, startedAt) as any
    const logId = Number(insert.lastInsertRowid)
    let output = ''
    try {
      const { option, note } = await pickCommand(database, config, context)
      if (note) output += `[${note}]\n`
      const script = buildScript(context, config, option.command)
      const result = await execute(config, script, (text) => { output += text; onChunk?.(text) })
      const marker = result === 0 ? '\n[测试通过]' : result === 'timeout' ? '\n[执行超时]' : `\n[测试失败,退出码 ${result}]`
      output += marker
      const success = result === 0
      database.prepare('UPDATE deployment_logs SET output=?, success=? WHERE id=?').run(output, success ? 1 : 0, logId)
      updatePrState(database, context, success ? 'test_passed' : 'test_failed')
      return { success, logId }
    } finally {
      database.prepare('UPDATE deployment_logs SET output=? WHERE id=?').run(output, logId)
      projectLocks.delete(context.project.id)
      globalRunning -= 1
    }
    } catch (error) {
      projectLocks.delete(context.project.id)
      globalRunning -= 1
      throw error
    }
  })()
  return { promise }
}

function updatePrState(database: DatabaseSync, context: TestContext, state: string) {
  database.prepare("UPDATE pr_cache SET state=? WHERE project_id=? AND number=? AND state='testing'").run(state, context.project.id, context.pr.number)
}

function execute(config: TestConfig, script: string, onChunk: (text: string) => void): Promise<number | 'timeout'> {
  return new Promise((resolve) => {
    const hardened = `export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true; ${script}`
    const args = config.server_mode === 'local' ? ['-lc', hardened] : ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', `${config.username}@${config.host}`, hardened]
    const child = spawn(config.server_mode === 'local' ? 'bash' : 'ssh', args)
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      if (!settled) { settled = true; resolve('timeout') }
    }, Math.max(30, config.timeout_sec || 600) * 1000)
    child.stdout.on('data', (data) => onChunk(data.toString()))
    child.stderr.on('data', (data) => onChunk(data.toString()))
    child.on('error', () => { clearTimeout(timer); if (!settled) { settled = true; resolve(1) } })
    child.on('close', (code) => { clearTimeout(timer); if (!settled) { settled = true; resolve(code ?? 1) } })
  })
}
