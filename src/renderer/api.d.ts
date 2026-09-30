interface Window {
  releaseConsole: {
    listProjects(): Promise<Array<{ id: number; name: string; repository: string; token: string; openPrs: number }>>
    addProject(input: { name: string; repository: string; token: string }): Promise<{ id: number; name: string; repository: string; token: string; openPrs: number }>
    deleteProject(id: number): Promise<unknown>
    updateProject(input: { id: number; name: string; repository: string; token: string }): Promise<{ id: number; name: string; repository: string; token: string; openPrs: number }>
    getSettings(): Promise<{ prHead: string; prBase: string; mergeMethod: string; pollIntervalSec: string; automationEnabled: string; aiBaseUrl: string; aiApiKey: string; aiModel: string; aiPrompt: string }>
    saveSettings(input: { prHead: string; prBase: string; mergeMethod: string; pollIntervalSec?: string; automationEnabled?: string; aiBaseUrl?: string; aiApiKey?: string; aiModel?: string; aiPrompt?: string }): Promise<{ prHead: string; prBase: string; mergeMethod: string; pollIntervalSec: string; automationEnabled: string; aiBaseUrl: string; aiApiKey: string; aiModel: string; aiPrompt: string }>
    getMeta(): Promise<{ version: string; dataPath: string }>
    listDeploymentConfigs(): Promise<Array<{ id: number; projectId: number; projectName: string; name: string; host: string; username: string; remotePath: string; command: string; position: number }>>
    saveDeploymentTarget(input: { id?: number; projectId: number; name: string; host: string; username: string; remotePath: string; command: string }): Promise<unknown>
    deleteDeploymentTarget(id: number): Promise<unknown>
    reorderDeploymentTargets(ids: number[]): Promise<unknown>
    runDeployment(targetId: number, onChunk?: (text: string) => void): Promise<string>
    listDeploymentServers(): Promise<Array<{ host: string; username: string }>>
    listDeploymentLogs(query?: { projectId?: number; limit?: number }): Promise<Array<{ id: number; projectId: number; projectName: string; targetName: string; host: string; output: string; success: number; createdAt: string }>>
    listPullRequests(input: { repository: string; token: string }): Promise<any[]>
    cachedPulls(query?: { projectId?: number }): Promise<Array<{ projectId: number; projectName: string; repository: string; token: string; number: number; title: string; body: string; author: string; headRef: string; baseRef: string; headSha: string; state: string; statusNote: string; aiResult: string; aiEvaluatedAt: string; createdAt: string; updatedAt: string }>>
    refreshPulls(projectId?: number): Promise<{ results: Array<{ projectId: number; name: string; error: string }> }>
    syncStatus(): Promise<Array<{ projectId: number; name: string; lastSyncAt: string; lastError: string; enabled: number }>>
    testAiConnection(input: { aiBaseUrl: string; aiApiKey: string; aiModel: string; aiPrompt: string }): Promise<{ message: string }>
    evaluatePr(input: { projectId: number; number: number }): Promise<{ verdict: { needs_test: boolean; reason: string; risk_level: string } }>
    listTestConfigs(): Promise<Array<{ project_id: number; server_mode: string; host: string; username: string; workdir_template: string; commands: string; ai_decides: number; ai_prompt: string; timeout_sec: number; projectName: string }>>
    saveTestConfig(input: { projectId: number; serverMode: string; host: string; username: string; workdirTemplate: string; commands: string; aiDecides: boolean; aiPrompt: string; timeoutSec: number }): Promise<unknown>
    runPrTest(input: { projectId: number; number: number }, onChunk?: (text: string) => void): Promise<string>
    requestLogs(query?: { projectId?: number; status?: string; limit?: number }): Promise<Array<{ id: number; projectId: number; projectName: string; endpoint: string; method: string; ok: number; status: number; errorMessage: string; durationMs: number; createdAt: string }>>
    toggleSync(projectId: number, enabled: boolean): Promise<unknown>
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
