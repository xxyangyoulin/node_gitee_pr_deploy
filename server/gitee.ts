type Input = { repository: string; token: string }

export async function gitee(input: Input, endpoint: string, init?: RequestInit) {
  const url = new URL(`https://gitee.com/api/v5/repos/${input.repository}/${endpoint}`)
  url.searchParams.set('access_token', input.token)
  const response = await fetch(url, init)
  const text = await response.text()
  let body: any
  try { body = JSON.parse(text) } catch { body = { message: text.slice(0, 300) } }
  if (!response.ok) throw new Error(`Gitee ${response.status}: ${body.message ?? JSON.stringify(body)}`)
  return body
}
