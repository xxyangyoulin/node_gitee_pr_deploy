type Input = { repository: string; token: string }

export type GiteeLogEntry = { repository: string; endpoint: string; method: string; ok: boolean; status: number; errorMessage: string; durationMs: number }

type GiteeLogger = (entry: GiteeLogEntry) => void

let logger: GiteeLogger | undefined

export function setGiteeLogger(fn: GiteeLogger) {
  logger = fn
}

export async function gitee(input: Input, endpoint: string, init?: RequestInit) {
  const url = new URL(`https://gitee.com/api/v5/repos/${input.repository}/${endpoint}`)
  url.searchParams.set('access_token', input.token)
  const method = init?.method ?? 'GET'
  const startedAt = Date.now()
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    const durationMs = Date.now() - startedAt
    const errorMessage = error instanceof Error ? error.message : '网络错误'
    logger?.({ repository: input.repository, endpoint, method, ok: false, status: 0, errorMessage, durationMs })
    throw error
  }
  const durationMs = Date.now() - startedAt
  const text = await response.text()
  let body: any
  try { body = JSON.parse(text) } catch { body = { message: text.slice(0, 300) } }
  if (!response.ok) {
    const errorMessage = `Gitee ${response.status}: ${body.message ?? JSON.stringify(body)}`.slice(0, 500)
    logger?.({ repository: input.repository, endpoint, method, ok: false, status: response.status, errorMessage, durationMs })
    throw new Error(errorMessage)
  }
  logger?.({ repository: input.repository, endpoint, method, ok: true, status: response.status, errorMessage: '', durationMs })
  return body
}
