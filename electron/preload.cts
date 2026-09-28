import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('releaseConsole', {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  addProject: (input: { name: string; repository: string; token: string }) => ipcRenderer.invoke('projects:add', input),
  deleteProject: (id: number) => ipcRenderer.invoke('projects:delete', id),
  updateProject: (input: { id: number; name: string; repository: string; token: string }) => ipcRenderer.invoke('projects:update', input),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (input: { prHead: string; prBase: string; mergeMethod: string }) => ipcRenderer.invoke('settings:save', input),
  getMeta: () => ipcRenderer.invoke('meta:get'),
  listDeploymentConfigs: () => ipcRenderer.invoke('deployment:list-configs'),
  deleteDeploymentConfig: (projectId: number) => ipcRenderer.invoke('deployment:delete-config', projectId),
  listDeploymentServers: () => ipcRenderer.invoke('deployment:list-servers'),
  saveDeploymentConfig: (input: { projectId: number; host: string; username: string; remotePath: string; command: string }) => ipcRenderer.invoke('deployment:save-config', input),
  runDeployment: (projectId: number, onChunk?: (text: string) => void) => ipcRenderer.invoke('deployment:run', { projectId }).then((output: string) => { onChunk?.(output); return output }),
  listPullRequests: (input: { repository: string; token: string }) => ipcRenderer.invoke('gitee:list-pulls', input),
  pullRequestFiles: (input: { repository: string; token: string; number: number }) => ipcRenderer.invoke('gitee:pull-files', input),
  approvePullRequest: (input: { repository: string; token: string; number: number }) => ipcRenderer.invoke('gitee:approve-pull', input),
  testPullRequest: (input: { repository: string; token: string; number: number }) => ipcRenderer.invoke('gitee:test-pull', input),
  pullFileContent: (input: { repository: string; token: string; url: string }) => ipcRenderer.invoke('gitee:file-content', input),
  repositoryFile: (input: { repository: string; token: string; path: string; ref: string }) => ipcRenderer.invoke('gitee:repository-file', input),
  createPullRequest: (input: { repository: string; token: string; title: string; head: string; base: string }) => ipcRenderer.invoke('gitee:create-pull', input),
  mergePullRequest: (input: { repository: string; token: string; number: number }) => ipcRenderer.invoke('gitee:merge-pull', input),
})
