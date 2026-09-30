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
  listDeploymentConfigs: () => request('/api/deployment/targets'),
  saveDeploymentTarget: (input) => request('/api/deployment/targets', { method: 'POST', body: JSON.stringify(input) }),
  deleteDeploymentTarget: (id) => request('/api/deployment/targets/delete', { method: 'POST', body: JSON.stringify({ id }) }),
  reorderDeploymentTargets: (ids) => request('/api/deployment/targets/reorder', { method: 'POST', body: JSON.stringify({ ids }) }),
  listDeploymentServers: () => request('/api/deployment/servers'),
  runDeployment: async (targetId, onChunk) => {
    const response = await fetch('/api/deployment/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId }) })
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
  pullRequestCommits: (input) => request('/api/gitee/pull-commits', { method: 'POST', body: JSON.stringify(input) }),
  commitDetail: (input) => request('/api/gitee/commit-detail', { method: 'POST', body: JSON.stringify(input) }),
  approvePullRequest: (input) => request('/api/gitee/approve-pull', { method: 'POST', body: JSON.stringify(input) }),
  testPullRequest: (input) => request('/api/gitee/test-pull', { method: 'POST', body: JSON.stringify(input) }),
  pullFileContent: async () => '',
  repositoryFile: (input) => request('/api/gitee/file', { method: 'POST', body: JSON.stringify(input) }),
  createPullRequest: (input) => request('/api/gitee/create-pull', { method: 'POST', body: JSON.stringify(input) }),
  mergePullRequest: (input) => request('/api/gitee/merge-pull', { method: 'POST', body: JSON.stringify(input) }),
}

createApp(App).mount('#app')
