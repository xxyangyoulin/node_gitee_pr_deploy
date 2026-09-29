interface Window {
  releaseConsole: {
    listProjects(): Promise<Array<{ id: number; name: string; repository: string; token: string; openPrs: number }>>
    addProject(input: { name: string; repository: string; token: string }): Promise<{ id: number; name: string; repository: string; token: string; openPrs: number }>
    deleteProject(id: number): Promise<unknown>
    updateProject(input: { id: number; name: string; repository: string; token: string }): Promise<{ id: number; name: string; repository: string; token: string; openPrs: number }>
    getSettings(): Promise<{ prHead: string; prBase: string; mergeMethod: string }>
    saveSettings(input: { prHead: string; prBase: string; mergeMethod: string }): Promise<{ prHead: string; prBase: string; mergeMethod: string }>
    getMeta(): Promise<{ version: string; dataPath: string }>
    listDeploymentConfigs(): Promise<Array<{ projectId: number; projectName: string; host: string; username: string; remotePath: string; command: string }>>
    deleteDeploymentConfig(projectId: number): Promise<unknown>
    saveDeploymentConfig(input: { projectId: number; host: string; username: string; remotePath: string; command: string }): Promise<unknown>
    listDeploymentServers(): Promise<Array<{ host: string; username: string }>>
    runDeployment(projectId: number, onChunk?: (text: string) => void): Promise<string>
    listDeploymentLogs(query?: { projectId?: number; limit?: number }): Promise<Array<{ id: number; projectId: number; projectName: string; host: string; output: string; success: number; createdAt: string }>>
    listPullRequests(input: { repository: string; token: string }): Promise<any[]>
    pullRequestDetail(input: { repository: string; token: string; number: number }): Promise<any>
    pullRequestLogs(input: { repository: string; token: string; number: number }): Promise<any[]>
    pullRequestFiles(input: { repository: string; token: string; number: number }): Promise<any[]>
    pullRequestCommits(input: { repository: string; token: string; number: number }): Promise<any[]>
    commitDetail(input: { repository: string; token: string; sha: string }): Promise<any>
    approvePullRequest(input: { repository: string; token: string; number: number }): Promise<any>
    testPullRequest(input: { repository: string; token: string; number: number }): Promise<any>
    pullFileContent(input: { repository: string; token: string; url: string }): Promise<string>
    repositoryFile(input: { repository: string; token: string; path: string; ref: string }): Promise<{ content?: string; encoding?: string }>
    createPullRequest(input: { repository: string; token: string; title: string; head: string; base: string }): Promise<any>
    mergePullRequest(input: { repository: string; token: string; number: number; mergeMethod?: string }): Promise<any>
  }
}
