export type AiSettings = { aiBaseUrl: string; aiApiKey: string; aiModel: string; aiPrompt: string }

export type AiVerdict = { needs_test: boolean; reason: string; risk_level: string }

export const DEFAULT_PROMPT = `你是代码评审助手。根据以下 PR 信息判断该变更是否需要运行自动化测试。
规则:.sql 文件变更一律需要测试;仅文档/注释/格式化改动通常不需要。
PR 标题:{{title}}
PR 描述:{{body}}
变更文件:
{{files}}
关键 diff:
{{diff}}
仅输出 JSON:{"needs_test": true|false, "reason": "一句话理由", "risk_level": "low"|"medium"|"high"}`

const CODE_EXTENSIONS = ['.ts', '.js', '.py', '.go', '.java', '.rs', '.php', '.dart', '.vue', '.sql', '.sh', '.c', '.cpp']

function isCodeFile(filename: string) {
  return CODE_EXTENSIONS.some((extension) => filename.toLowerCase().endsWith(extension))
}

export function buildEvaluationInput(files: Array<{ filename: string; patch?: string }>) {
  const lines = files.map((file) => {
    let added = 0
    let removed = 0
    const patch = typeof file.patch === 'string' ? file.patch : ''
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added += 1
      else if (line.startsWith('-') && !line.startsWith('---')) removed += 1
    }
    return `${file.filename} (+${added} -${removed})`
  })
  let fileList = lines.slice(0, 60).join('\n')
  if (lines.length > 60) fileList += `\n… 共 ${lines.length} 个文件`

  const ordered = [...files].sort((a, b) => Number(isCodeFile(b.filename)) - Number(isCodeFile(a.filename)))
  const parts: string[] = []
  let total = 0
  for (const file of ordered.slice(0, 6)) {
    const patch = (typeof file.patch === 'string' ? file.patch : '').split('\n').slice(0, 80).join('\n')
    if (!patch) continue
    const piece = `--- ${file.filename} ---\n${patch}`
    if (total + piece.length > 12000) { parts.push('…(已截断)'); break }
    parts.push(piece)
    total += piece.length
  }
  return { files: fileList, diff: parts.join('\n\n') || '(无文本 diff)' }
}

export function renderPrompt(template: string, vars: { title: string; body: string; files: string; diff: string }) {
  return template
    .replaceAll('{{title}}', vars.title.slice(0, 200))
    .replaceAll('{{body}}', vars.body.slice(0, 500))
    .replaceAll('{{files}}', vars.files)
    .replaceAll('{{diff}}', vars.diff)
}

export function parseVerdict(text: string): AiVerdict | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0])
    if (typeof parsed?.needs_test !== 'boolean' || typeof parsed?.reason !== 'string') return null
    const risk = ['low', 'medium', 'high'].includes(parsed.risk_level) ? parsed.risk_level : 'medium'
    return { needs_test: parsed.needs_test, reason: parsed.reason.slice(0, 300), risk_level: risk }
  } catch { return null }
}

export async function callModelJson(settings: AiSettings, prompt: string): Promise<any> {
  const response = await fetch(`${settings.aiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.aiApiKey}` },
    body: JSON.stringify({ model: settings.aiModel, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, temperature: 0 }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`AI ${response.status}: ${text.slice(0, 300)}`)
  let body: any
  try { body = JSON.parse(text) } catch { throw new Error('AI 返回非 JSON') }
  const content = String(body?.choices?.[0]?.message?.content ?? '')
  const match = content.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('AI 输出无法解析为 JSON')
  return JSON.parse(match[0])
}

export async function callModel(settings: AiSettings, prompt: string): Promise<AiVerdict> {
  const response = await fetch(`${settings.aiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.aiApiKey}` },
    body: JSON.stringify({
      model: settings.aiModel,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`AI ${response.status}: ${text.slice(0, 300)}`)
  let body: any
  try { body = JSON.parse(text) } catch { throw new Error('AI 返回非 JSON') }
  const verdict = parseVerdict(String(body?.choices?.[0]?.message?.content ?? ''))
  if (!verdict) throw new Error('AI 输出无法解析为结论')
  return verdict
}

export async function testModelConnection(settings: AiSettings) {
  const verdict = await callModel(settings, '仅输出 JSON:{"needs_test": false, "reason": "连接测试", "risk_level": "low"}')
  return verdict.reason
}
