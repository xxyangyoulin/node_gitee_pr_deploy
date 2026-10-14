import type { DatabaseSync } from 'node:sqlite'
import { logError } from './error-log.js'

export function readFeishuWebhook(database: DatabaseSync) {
  const row = database.prepare("SELECT value FROM settings WHERE key='feishuWebhook'").get() as any
  return String(row?.value ?? '').trim()
}

function buildPrMergedCard(input: { project: string; repository: string; number: number; title: string; author: string; branchText: string; targets: string[]; deployTime: string }) {
  return {
    msg_type: 'interactive',
    card: {
      header: {
        template: 'green',
        title: { tag: 'plain_text', content: '✅ PR 已合并并完成部署' },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**${input.title}**  ·  \`${input.repository}#${input.number}\`\n分支:${input.branchText}\n提交人:<font color='green'>**${input.author}**</font>,你的 PR 已自动合并并成功部署 🎉`,
          },
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: { tag: 'lark_md', content: `**部署目标(${input.targets.length})**\n${input.targets.map((target) => `• ${target}`).join('\n')}` },
        },
        {
          tag: 'note',
          elements: [{ tag: 'plain_text', content: `项目:${input.project} · 部署时间:${input.deployTime}` }],
        },
        {
          tag: 'action',
          actions: [{
            tag: 'button',
            type: 'primary',
            text: { tag: 'plain_text', content: '在 Gitee 查看 PR' },
            url: `https://gitee.com/${input.repository}/pulls/${input.number}`,
          }],
        },
      ],
    },
  }
}

export async function notifyPrMerged(database: DatabaseSync, input: { projectId: number; number: number; targets: string[] }) {
  const webhook = readFeishuWebhook(database)
  if (!webhook) return { sent: false, reason: '未配置飞书 Webhook' }
  const row = database.prepare('SELECT c.title, c.author, c.head_ref, c.base_ref, p.name AS projectName, p.repository FROM pr_cache c JOIN projects p ON p.id=c.project_id WHERE c.project_id=? AND c.number=?').get(input.projectId, input.number) as any
  if (!row) return { sent: false, reason: 'PR 不在缓存中' }
  const branchText = `${row.head_ref || '?'} → ${row.base_ref || '?'}`
  const deployTime = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const mapping = database.prepare('SELECT feishu_id AS feishuId, feishu_name AS feishuName FROM user_mapping WHERE gitee_login=?').get(String(row.author ?? '').trim()) as any
  const author = mapping?.feishuId ? `<at id="${mapping.feishuId}"></at>` : (row.author || '未知')
  const payload = buildPrMergedCard({ project: row.projectName, repository: row.repository, number: input.number, title: row.title || '(无标题)', author, branchText, targets: input.targets, deployTime })
  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`飞书 ${response.status}: ${text.slice(0, 200)}`)
    let body: any
    try { body = JSON.parse(text) } catch { body = {} }
    if (body.code !== undefined && body.code !== 0) throw new Error(`飞书 ${body.code}: ${body.msg ?? ''}`)
    return { sent: true }
  } catch (error) {
    logError('feishu', 'PR 合并通知发送失败', error instanceof Error ? error.message : String(error))
    return { sent: false, reason: error instanceof Error ? error.message : '发送失败' }
  }
}

export async function sendFeishuTest(database: DatabaseSync) {
  const webhook = readFeishuWebhook(database)
  if (!webhook) throw new Error('请先配置飞书 Webhook')
  const payload = {
    msg_type: 'interactive',
    card: {
      header: { template: 'turquoise', title: { tag: 'plain_text', content: '🔔 Gitee Release Console' } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '**飞书通知测试成功**\nPR 合并部署通知将发送到本群。' } },
        { tag: 'note', 'elements': [{ tag: 'plain_text', content: new Date().toISOString().replace('T', ' ').slice(0, 19) }] },
      ],
    },
  }
  const response = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) })
  const text = await response.text()
  if (!response.ok) throw new Error(`飞书 ${response.status}: ${text.slice(0, 200)}`)
  let body: any
  try { body = JSON.parse(text) } catch { body = {} }
  if (body.code !== undefined && body.code !== 0) throw new Error(`飞书 ${body.code}: ${body.msg ?? ''}`)
  return true
}
