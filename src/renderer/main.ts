import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

const request = async (path: string, options: RequestInit = {}) => {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...options.headers } })
  const text = await response.text()
  let data: any
  try { data = JSON.parse(text) } catch { data = { message: text.slice(0, 300) } }
  if (!response.ok) throw new Error(data.message || `请求失败: ${response.status}`)
  return data
}

window.releaseConsole = {
  listProjects: () => request('/api/projects'),
  addProject: (input) => request('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  deleteProject: (id) => request(`/api/projects/${id}`, { method: 'DELETE' }),
  updateProject: (input) => request('/api/projects/update', { method: 'POST', body: JSON.stringify(input) }),
  getSettings: () => request('/api/settings'),
  saveSettings: (input) => request('/api/settings', { method: 'POST', body: JSON.stringify(input) }),
  getMeta: () => request('/api/meta'),
  listDeploymentConfigs: () => request('/api/deployment/configs'),
  deleteDeploymentConfig: (projectId) => request(`/api/deployment/config?projectId=${projectId}`, { method: 'DELETE' }),
  listDeploymentServers: () => request('/api/deployment/servers'),
  saveDeploymentConfig: (input) => request('/api/deployment/config', { method: 'POST', body: JSON.stringify(input) }),
  runDeployment: async (projectId, onChunk) => {
    const response = await fetch('/api/deployment/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId }) })
    if (!response.ok) {
      let message = `请求失败: ${response.status}`
      try { message = (await response.json()).message || message } catch { }
      throw new Error(message)
    }
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let output = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      output += text
      onChunk?.(text)
    }
    return output
  },
  listDeploymentLogs: (query: { projectId?: number; limit?: number } = {}) => {
    const params = new URLSearchParams()
    if (query.projectId) params.set('projectId', String(query.projectId))
    if (query.limit) params.set('limit', String(query.limit))
    const queryString = params.toString()
    return request(`/api/deployment/logs${queryString ? `?${queryString}` : ''}`)
  },
  listPullRequests: (input) => request('/api/gitee/pulls', { method: 'POST', body: JSON.stringify(input) }),
  pullRequestDetail: (input) => request('/api/gitee/pull-detail', { method: 'POST', body: JSON.stringify(input) }),
  pullRequestLogs: (input) => request('/api/gitee/pull-logs', { method: 'POST', body: JSON.stringify(input) }),
  pullRequestFiles: (input) => request('/api/gitee/pull-files', { method: 'POST', body: JSON.stringify(input) }),
  approvePullRequest: (input) => request('/api/gitee/approve-pull', { method: 'POST', body: JSON.stringify(input) }),
  testPullRequest: (input) => request('/api/gitee/test-pull', { method: 'POST', body: JSON.stringify(input) }),
  pullFileContent: async () => '',
  repositoryFile: (input) => request('/api/gitee/file', { method: 'POST', body: JSON.stringify(input) }),
  createPullRequest: (input) => request('/api/gitee/create-pull', { method: 'POST', body: JSON.stringify(input) }),
  mergePullRequest: (input) => request('/api/gitee/merge-pull', { method: 'POST', body: JSON.stringify(input) }),
}

createApp(App).mount('#app')
