<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github.css'

type Project = { id: number; name: string; repository: string; token: string; openPrs: number }
type PullItem = { project: Project; pull: any }
type DeploymentRow = { projectId: number; projectName: string; host: string; username: string; remotePath: string; command: string }

const projects = ref<Project[]>([])
const pageList = [
  { id: 'projects', label: '项目' },
  { id: 'pulls', label: 'PR' },
  { id: 'deployments', label: '部署' },
  { id: 'settings', label: '设置' },
]
function pageFromHash() {
  const page = location.hash.replace(/^#\/?/, '')
  return pageList.some((item) => item.id === page) ? page : 'projects'
}
const activePage = ref(pageFromHash())
function switchPage(page: string) {
  activePage.value = page
  if (location.hash !== `#/${page}`) location.hash = `#/${page}`
}
window.addEventListener('hashchange', () => { activePage.value = pageFromHash() })

const showProjectForm = ref(false)
const projectName = ref('')
const repository = ref('')
const token = ref('')

const pulls = ref<PullItem[]>([])
const loadingPulls = ref(false)
const pullFilter = ref<number | 'all'>('all')
const filteredPulls = computed(() => pullFilter.value === 'all' ? pulls.value : pulls.value.filter((item) => item.project.id === pullFilter.value))
const selectedPull = ref<PullItem | null>(null)

const files = ref<any[]>([])
const expandedFiles = ref<Record<string, boolean>>({})
const loadingFiles = ref(false)
const errorMessage = ref('')
const mergeMessage = ref('')
const reviewPassed = ref(false)
const testPassed = ref(false)
const mergeConfirming = ref(false)
let mergeConfirmTimer: ReturnType<typeof setTimeout> | undefined
const oneClickAction = ref<'' | 'master' | 'deploy'>('')
const oneClickBusy = ref(false)
let oneClickTimer: ReturnType<typeof setTimeout> | undefined
const oneClickProgress = ref<null | { kind: 'master' | 'deploy'; step: number; total: number; log: string; running: boolean }>(null)
const modalLogEl = ref<HTMLElement | null>(null)

const oneClickSteps = computed(() => {
  const progress = oneClickProgress.value
  if (!progress) return []
  const prHead = settings.value.prHead
  const prBase = settings.value.prBase
  const labels = [`合并 ${prHead} 分支 PR`, `创建 ${prHead} → ${prBase} 分支 PR`, `合并 ${prBase} 分支 PR`]
  if (progress.kind === 'deploy') labels.push('执行部署')
  return labels.map((label, index) => {
    const num = index + 1
    let state = 'pending'
    if (num < progress.step || (!progress.running && num <= progress.step)) state = 'done'
    else if (num === progress.step && progress.running) state = 'running'
    return { label, state }
  })
})

const oneClickTarget = computed(() => {
  const item = selectedPull.value
  if (!item) return null
  const head = String(item.pull.head?.ref ?? '')
  const base = String(item.pull.base?.ref ?? '')
  const prHead = settings.value.prHead
  const prBase = settings.value.prBase
  if (!prHead || !prBase || prHead === prBase) return null
  if (base !== prHead || head === prHead) return null
  return { ...item, head, base }
})

const settings = ref({ prHead: 'dock', prBase: 'master', mergeMethod: 'merge' })
const meta = ref({ version: '', dataPath: '' })

const showCreatePr = ref(false)
const createPrForm = ref({ projectId: 0, title: '', head: '', base: '' })
const createPrError = ref('')
const creatingPr = ref(false)

const deploymentRows = ref<DeploymentRow[]>([])
const loadingDeployments = ref(false)
const deploymentServers = ref<{ host: string; username: string }[]>([])
const configModal = ref(false)
const configForm = ref({ projectId: 0, projectName: '', isNew: true, host: '', username: '', remotePath: '', command: '' })
const configFormError = ref('')
const savingConfig = ref(false)
const showHostSuggestions = ref(false)
const showUserSuggestions = ref(false)
const hostSuggestions = computed(() => deploymentServers.value.map((server) => server.host))
const userSuggestions = computed(() => [...new Set(deploymentServers.value.map((server) => server.username))])
const deployLog = ref({ projectId: 0, projectName: '', output: '', running: false })
const deployOutputEl = ref<HTMLElement | null>(null)

const projectFormError = ref('')
const savingProject = ref(false)
const editForm = ref({ id: 0, name: '', repository: '', token: '' })
const editFormError = ref('')
const savingEdit = ref(false)
const toastMessage = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined
const confirmMessage = ref('')
const confirmPending = ref<(() => void) | null>(null)

const fileStats = computed(() => files.value.map((file) => fileStat(file)))
const totalStats = computed(() => fileStats.value.reduce((sum, stat) => ({ added: sum.added + stat.added, removed: sum.removed + stat.removed }), { added: 0, removed: 0 }))
const fileDiffs = computed(() => files.value.map((file) => {
  const patch = patchText(file) || ''
  const language = languageFor(file?.filename || '')
  return patch.split('\n').map((line: string) => {
    const marker = line[0]
    const kind = marker === '+' && !line.startsWith('+++') ? 'added' : marker === '-' && !line.startsWith('---') ? 'removed' : marker === '@' ? 'hunk' : 'context'
    const source = kind === 'added' || kind === 'removed' ? line.slice(1) : line
    const html = language ? hljs.highlight(source, { language, ignoreIllegals: true }).value : hljs.highlightAuto(source).value
    return { kind, prefix: kind === 'added' || kind === 'removed' ? marker : '', html }
  })
}))

function isFileExpanded(filename: string) {
  return expandedFiles.value[filename] !== false
}

function toggleFile(filename: string) {
  expandedFiles.value[filename] = !isFileExpanded(filename)
}

function setAllFilesExpanded(expanded: boolean) {
  for (const file of files.value) expandedFiles.value[file.filename] = expanded
}

const fileQuery = ref('')
const matchedCount = computed(() => files.value.filter((file) => fileMatches(file.filename)).length)
const activeFileIndex = ref(0)
const filesScrollEl = ref<HTMLElement | null>(null)

function fileMatches(filename: string) {
  const query = fileQuery.value.trim().toLowerCase()
  return !query || filename.toLowerCase().includes(query)
}

interface FileTreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  index: number
  children: FileTreeNode[]
}

const expandedDirs = ref<Record<string, boolean>>({})
const fileListWidth = ref(Number(localStorage.getItem('file-list-width')) || 280)

function startResize(event: MouseEvent) {
  const panel = (event.currentTarget as HTMLElement).parentElement
  if (!panel) return
  const rect = panel.getBoundingClientRect()
  const onMove = (moveEvent: MouseEvent) => {
    fileListWidth.value = Math.min(560, Math.max(180, moveEvent.clientX - rect.left))
  }
  const onUp = () => {
    try { localStorage.setItem('file-list-width', String(fileListWidth.value)) } catch { }
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

function isDirExpanded(path: string) {
  return expandedDirs.value[path] !== false
}

function toggleDir(path: string) {
  expandedDirs.value[path] = !isDirExpanded(path)
}

function buildFileTree(files: any[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', path: '', type: 'dir', index: -1, children: [] }
  files.forEach((file, index) => {
    const segments = String(file.filename).split('/')
    let node = root
    segments.forEach((segment, i) => {
      const path = segments.slice(0, i + 1).join('/')
      if (i === segments.length - 1) {
        node.children.push({ name: segment, path, type: 'file', index, children: [] })
      } else {
        let child = node.children.find((item) => item.type === 'dir' && item.path === path)
        if (!child) { child = { name: segment, path, type: 'dir', index: -1, children: [] }; node.children.push(child) }
        node = child
      }
    })
  })
  const order = (nodes: FileTreeNode[]): FileTreeNode[] => {
    const dirs = nodes.filter((node) => node.type === 'dir').sort((a, b) => a.name.localeCompare(b.name))
    const leaves = nodes.filter((node) => node.type === 'file').sort((a, b) => a.name.localeCompare(b.name))
    for (const dir of dirs) dir.children = order(dir.children)
    return [...dirs, ...leaves]
  }
  return order(root.children)
}

interface TreeRow { key: string; name: string; type: 'dir' | 'file'; depth: number; index: number; added: number; removed: number }

const fileTree = computed(() => buildFileTree(files.value))

const fileTreeRows = computed<TreeRow[]>(() => {
  const stats = fileStats.value
  const query = fileQuery.value.trim().toLowerCase()
  const rows: TreeRow[] = []
  const walk = (nodes: FileTreeNode[], depth: number) => {
    for (const node of nodes) {
      if (node.type === 'dir') {
        const members = files.value.map((file, i) => ({ filename: String(file.filename), i })).filter((file) => file.filename.startsWith(node.path + '/'))
        if (query && !members.some((file) => file.filename.toLowerCase().includes(query))) continue
        const totals = members.reduce((acc, file) => ({ added: acc.added + stats[file.i].added, removed: acc.removed + stats[file.i].removed }), { added: 0, removed: 0 })
        rows.push({ key: node.path, name: node.name, type: 'dir', depth, index: -1, added: totals.added, removed: totals.removed })
        if (!query && expandedDirs.value[node.path] === false) continue
        walk(node.children, depth + 1)
      } else {
        if (query && !node.path.toLowerCase().includes(query)) continue
        rows.push({ key: node.path, name: node.name, type: 'file', depth, index: node.index, added: stats[node.index].added, removed: stats[node.index].removed })
      }
    }
  }
  walk(fileTree.value, 0)
  return rows
})

function jumpToFile(index: number) {
  const file = files.value[index]
  if (!file) return
  if (!isFileExpanded(file.filename)) expandedFiles.value[file.filename] = true
  activeFileIndex.value = index
  nextTick(() => {
    const container = filesScrollEl.value
    const card = document.getElementById(`pr-file-card-${index}`)
    if (!container || !card) return
    container.scrollTop += card.getBoundingClientRect().top - container.getBoundingClientRect().top - 12
  })
}

function onFilesScroll() {
  const container = filesScrollEl.value
  if (!container) return
  const containerTop = container.getBoundingClientRect().top
  const cards = Array.from(container.querySelectorAll<HTMLElement>('.file-card')).filter((card) => card.style.display !== 'none')
  if (!cards.length) return
  if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
    activeFileIndex.value = Number(cards[cards.length - 1].dataset.index ?? 0)
    return
  }
  let current = Number(cards[0].dataset.index ?? 0)
  for (const card of cards) {
    if (card.getBoundingClientRect().top - containerTop <= 90) current = Number(card.dataset.index ?? 0)
  }
  activeFileIndex.value = current
}

function patchText(file: any) {
  const value = file?.patch
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.join('\n')
  if (value && typeof value === 'object') return value.content || value.diff || value.text || null
  return null
}

function isMainBranch(name: unknown) {
  const value = String(name ?? '').split(/[:/]/).pop()?.toLowerCase()
  return value === 'master' || value === 'main'
}

function formatTime(value: unknown) {
  const date = new Date(String(value ?? ''))
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fileStat(file: any) {
  const patch = patchText(file)
  let added = 0
  let removed = 0
  if (typeof patch === 'string') {
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++
      else if (line.startsWith('-') && !line.startsWith('---')) removed++
    }
  }
  return {
    added: added || Number(file?.additions) || 0,
    removed: removed || Number(file?.deletions) || 0,
  }
}

function passedValue(value: unknown) {
  return value === true || value === 'passed' || value === 'success' || value === 'approved'
}

function languageFor(filename: string) {
  const extension = filename.split('.').pop()?.toLowerCase()
  const candidate = ({ js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', vue: 'xml', html: 'xml', css: 'css', scss: 'scss', json: 'json', dart: 'dart', py: 'python', php: 'php', java: 'java', go: 'go', rs: 'rust', sh: 'bash', yml: 'yaml', yaml: 'yaml', md: 'markdown' } as Record<string, string>)[extension || '']
  return candidate && hljs.getLanguage(candidate) ? candidate : undefined
}

function authorOf(pull: any) {
  return pull?.user?.name || pull?.user?.login || pull?.user?.username || '未知提交人'
}

function isSelected(item: PullItem) {
  return !!selectedPull.value && item.project.id === selectedPull.value.project.id && Number(item.pull.number) === Number(selectedPull.value.pull.number)
}

async function addProject() {
  projectFormError.value = ''
  if (!projectName.value.trim() || !repository.value.trim()) { projectFormError.value = '项目名称和仓库地址不能为空'; return }
  savingProject.value = true
  try {
    const project = await window.releaseConsole.addProject({ name: projectName.value.trim(), repository: repository.value.trim(), token: token.value.trim() })
    projects.value.push(project)
    projectName.value = ''
    repository.value = ''
    token.value = ''
    showProjectForm.value = false
  } catch (error) { projectFormError.value = error instanceof Error ? error.message : '保存项目失败' } finally { savingProject.value = false }
}

onMounted(async () => {
  try {
    projects.value = await window.releaseConsole.listProjects()
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : '加载项目失败' }
  loadSettings()
  try { meta.value = await window.releaseConsole.getMeta() } catch { }
  if (activePage.value === 'pulls') loadPulls()
  if (activePage.value === 'deployments') loadDeploymentRows()
})

async function removeProject(project: Project) {
  await window.releaseConsole.deleteProject(project.id)
  projects.value = projects.value.filter((item) => item.id !== project.id)
  deploymentRows.value = deploymentRows.value.filter((row) => row.projectId !== project.id)
}

function deleteProject(project: Project) {
  askConfirmation(`确认删除项目「${project.name}」？其部署配置也会一并删除。`, () => { void removeProject(project) })
}

function startEditProject(project: Project) {
  editForm.value = { id: project.id, name: project.name, repository: project.repository, token: project.token }
  editFormError.value = ''
}

async function saveProjectEdit() {
  editFormError.value = ''
  if (!editForm.value.name.trim() || !editForm.value.repository.trim()) { editFormError.value = '项目名称和仓库地址不能为空'; return }
  savingEdit.value = true
  try {
    const updated = await window.releaseConsole.updateProject({ id: editForm.value.id, name: editForm.value.name.trim(), repository: editForm.value.repository.trim(), token: editForm.value.token.trim() })
    const index = projects.value.findIndex((project) => project.id === updated.id)
    if (index >= 0) projects.value[index] = updated
    editForm.value.id = 0
  } catch (error) { editFormError.value = error instanceof Error ? error.message : '保存项目失败' } finally { savingEdit.value = false }
}

function applyPrDefaults() {
  if (settings.value.prHead && !createPrForm.value.head) createPrForm.value.head = settings.value.prHead
  if (settings.value.prBase && !createPrForm.value.base) createPrForm.value.base = settings.value.prBase
}

async function loadSettings() {
  try { settings.value = await window.releaseConsole.getSettings() } catch { }
  applyPrDefaults()
}

async function saveAppSettings() {
  try { settings.value = await window.releaseConsole.saveSettings({ ...settings.value }) } catch (error) { mergeMessage.value = error instanceof Error ? error.message : '保存设置失败'; return }
  mergeMessage.value = '设置已保存'
}

async function loadDeploymentRows() {
  if (!projects.value.length) { deploymentRows.value = []; return }
  loadingDeployments.value = true
  try {
    deploymentRows.value = await window.releaseConsole.listDeploymentConfigs()
    try { deploymentServers.value = await window.releaseConsole.listDeploymentServers() } catch { }
  } finally {
    loadingDeployments.value = false
  }
}

function pickHost(host: string) {
  configForm.value.host = host
  configForm.value.username = deploymentServers.value.find((server) => server.host === host)?.username || configForm.value.username
  showHostSuggestions.value = false
}

function pickUser(username: string) {
  configForm.value.username = username
  showUserSuggestions.value = false
}

function openAddConfig() {
  const configured = new Set(deploymentRows.value.filter((row) => row.host).map((row) => row.projectId))
  const free = projects.value.find((project) => !configured.has(project.id)) ?? projects.value[0]
  configForm.value = { projectId: free?.id ?? 0, projectName: free?.name ?? '', isNew: true, host: '', username: '', remotePath: '', command: '' }
  configFormError.value = ''
  configModal.value = true
}

function openEditConfig(row: DeploymentRow) {
  configForm.value = { projectId: row.projectId, projectName: row.projectName, isNew: false, host: row.host, username: row.username, remotePath: row.remotePath, command: row.command }
  configFormError.value = ''
  configModal.value = true
}

async function saveConfig() {
  if (!configForm.value.projectId) { configFormError.value = '请选择项目'; return }
  savingConfig.value = true
  try {
    await window.releaseConsole.saveDeploymentConfig({
      projectId: configForm.value.projectId,
      host: configForm.value.host.trim(),
      username: configForm.value.username.trim(),
      remotePath: configForm.value.remotePath.trim(),
      command: configForm.value.command.trim(),
    })
    configModal.value = false
    mergeMessage.value = '部署配置已保存'
    await loadDeploymentRows()
  } catch (error) { configFormError.value = error instanceof Error ? error.message : '保存配置失败' } finally { savingConfig.value = false }
}

function askDeleteConfig(row: DeploymentRow) {
  askConfirmation(`确认删除「${row.projectName}」的部署配置？`, () => { void (async () => {
    await window.releaseConsole.deleteDeploymentConfig(row.projectId)
    mergeMessage.value = '部署配置已删除'
    await loadDeploymentRows()
  })() })
}

function configComplete(row: DeploymentRow) {
  return !!(row.host && row.username && row.remotePath && row.command)
}

async function runProjectDeployment(row: DeploymentRow) {
  if (!configComplete(row) || deployLog.value.running) return
  deployLog.value = { projectId: row.projectId, projectName: row.projectName, output: '', running: true }
  try {
    deployLog.value.output = await window.releaseConsole.runDeployment(row.projectId, (text) => {
      deployLog.value.output += text
      nextTick(() => deployOutputEl.value?.scrollTo({ top: deployOutputEl.value.scrollHeight }))
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '部署失败'
    deployLog.value.output += (deployLog.value.output ? '\n' : '') + message
  } finally {
    deployLog.value.running = false
  }
}

async function loadPulls() {
  if (!projects.value.length) { pulls.value = []; return }
  loadingPulls.value = true
  errorMessage.value = ''
  try {
    const results = await Promise.all(projects.value.map(async (project) => {
      try {
        const list = await window.releaseConsole.listPullRequests({ repository: project.repository, token: project.token })
        return list.map((pull: any) => ({ project, pull }))
      } catch { return [] }
    }))
    pulls.value = results.flat().sort((a, b) => (Date.parse(String(b.pull.created_at ?? '')) || 0) - (Date.parse(String(a.pull.created_at ?? '')) || 0))
    for (const project of projects.value) {
      project.openPrs = pulls.value.filter((item) => item.project.id === project.id).length
    }
    if (selectedPull.value && !pulls.value.some((item) => isSelected(item))) clearSelection()
  } finally {
    loadingPulls.value = false
  }
}

function clearSelection() {
  resetMergeConfirm()
  resetOneClickConfirm()
  selectedPull.value = null
  files.value = []
  expandedFiles.value = {}
  expandedDirs.value = {}
  fullFileViews.value = {}
  fullFileContents.value = {}
  fileQuery.value = ''
  reviewPassed.value = false
  testPassed.value = false
}

let selectionSeq = 0

function selectPull(item: PullItem) {
  const seq = ++selectionSeq
  void openPull(item, seq)
}

async function openPull(item: PullItem, seq: number) {
  resetMergeConfirm()
  resetOneClickConfirm()
  files.value = []
  expandedFiles.value = {}
  expandedDirs.value = {}
  fullFileViews.value = {}
  fullFileContents.value = {}
  selectedPull.value = item
  const { project, pull } = item
  reviewPassed.value = passedValue(pull.approved) || passedValue(pull.reviewed) || passedValue(pull.review_status)
  testPassed.value = passedValue(pull.test_passed) || passedValue(pull.tests_passed) || passedValue(pull.ci_status)
  loadingFiles.value = true
  errorMessage.value = ''
  try {
    const stale = () => seq !== selectionSeq || selectedPull.value !== item
    await window.releaseConsole.pullRequestDetail({ repository: project.repository, token: project.token, number: Number(pull.number) })
    const logs = await window.releaseConsole.pullRequestLogs({ repository: project.repository, token: project.token, number: Number(pull.number) })
    if (stale()) return
    const logText = (log: any) => `${log.content || ''} ${log.action_type || ''} ${log.after_change_value || ''}`.toLowerCase()
    const positive = (log: any, kind: 'review' | 'test') => {
      const text = logText(log)
      const keyword = kind === 'review' ? /审查.*(通过|成功)|通过.*审查|review.*(pass|success)/ : /测试.*(通过|成功)|通过.*测试|test.*(pass|success)/
      return keyword.test(text) && !/未通过|失败|拒绝|取消|not\s*pass|fail/.test(text)
    }
    reviewPassed.value = reviewPassed.value || logs.some((log: any) => positive(log, 'review'))
    testPassed.value = testPassed.value || logs.some((log: any) => positive(log, 'test'))
    files.value = await window.releaseConsole.pullRequestFiles({ repository: project.repository, token: project.token, number: Number(pull.number) })
  } catch (error) {
    if (seq === selectionSeq) errorMessage.value = error instanceof Error ? error.message : '加载文件失败'
  } finally {
    if (seq === selectionSeq) loadingFiles.value = false
  }
}

async function mergeFlow(project: Project, pull: any) {
  await window.releaseConsole.approvePullRequest({ repository: project.repository, token: project.token, number: Number(pull.number) })
  await window.releaseConsole.testPullRequest({ repository: project.repository, token: project.token, number: Number(pull.number) })
  await window.releaseConsole.mergePullRequest({ repository: project.repository, token: project.token, number: Number(pull.number), mergeMethod: settings.value.mergeMethod })
}

async function mergeSelectedPull() {
  const target = selectedPull.value
  if (!target) return
  mergeMessage.value = '审查中…'
  try {
    await mergeFlow(target.project, target.pull)
    reviewPassed.value = true
    testPassed.value = true
    mergeMessage.value = '合并成功'
    await loadPulls()
  } catch (error) { mergeMessage.value = error instanceof Error ? error.message : '合并失败' }
}

function resetOneClickConfirm() {
  if (oneClickTimer) clearTimeout(oneClickTimer)
  oneClickAction.value = ''
}

function requestOneClick(kind: 'master' | 'deploy') {
  if (oneClickBusy.value) return
  if (oneClickAction.value !== kind) {
    oneClickAction.value = kind
    oneClickTimer = setTimeout(resetOneClickConfirm, 2000)
    return
  }
  resetOneClickConfirm()
  void oneClickMaster(kind === 'deploy')
}

async function findCreatedPull(project: Project, title: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await loadPulls()
    const found = pulls.value.find((item) => item.project.id === project.id && String(item.pull.head?.ref) === settings.value.prHead && String(item.pull.base?.ref) === settings.value.prBase && String(item.pull.title ?? '') === title)
    if (found) return found.pull
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('未找到新创建的 PR')
}

async function oneClickMaster(withDeploy: boolean) {
  const target = oneClickTarget.value
  if (!target) return
  const { project, pull } = target
  const title = String(pull.title ?? '')
  const total = withDeploy ? 4 : 3
  oneClickBusy.value = true
  oneClickProgress.value = { kind: withDeploy ? 'deploy' : 'master', step: 1, total, log: '', running: true }
  try {
    await mergeFlow(project, pull)
    if (oneClickProgress.value) oneClickProgress.value.step = 2
    await window.releaseConsole.createPullRequest({ repository: project.repository, token: project.token, title, head: settings.value.prHead, base: settings.value.prBase })
    if (oneClickProgress.value) oneClickProgress.value.step = 3
    const created = await findCreatedPull(project, title)
    await mergeFlow(project, created)
    if (withDeploy) {
      if (oneClickProgress.value) oneClickProgress.value.step = 4
      if (!deploymentRows.value.length) { try { await loadDeploymentRows() } catch { } }
      const row = deploymentRows.value.find((item) => item.projectId === project.id)
      if (!row || !configComplete(row)) throw new Error(`项目 ${project.name} 未配置部署，无法执行部署`)
      deployLog.value = { projectId: row.projectId, projectName: row.projectName, output: '', running: true }
      try {
        deployLog.value.output = await window.releaseConsole.runDeployment(row.projectId, (text) => {
          deployLog.value.output += text
          if (oneClickProgress.value) oneClickProgress.value.log += text
          nextTick(() => {
            modalLogEl.value?.scrollTo({ top: modalLogEl.value.scrollHeight })
            deployOutputEl.value?.scrollTo({ top: deployOutputEl.value.scrollHeight })
          })
        })
      } finally {
        deployLog.value.running = false
      }
    }
    mergeMessage.value = withDeploy ? '一键部署完成' : '一键合并完成'
    await loadPulls()
  } catch (error) {
    mergeMessage.value = error instanceof Error ? error.message : '一键操作失败'
  } finally {
    oneClickBusy.value = false
    if (oneClickProgress.value) oneClickProgress.value.running = false
  }
}

function askConfirmation(message: string, action: () => void) {
  confirmMessage.value = message
  confirmPending.value = action
}

function acceptConfirmation() {
  const action = confirmPending.value
  confirmMessage.value = ''
  confirmPending.value = null
  action?.()
}

function cancelConfirmation() {
  confirmMessage.value = ''
  confirmPending.value = null
}

function resetMergeConfirm() {
  if (mergeConfirmTimer) clearTimeout(mergeConfirmTimer)
  mergeConfirming.value = false
}

function requestMerge() {
  if (!selectedPull.value) return
  if (!mergeConfirming.value) {
    mergeConfirming.value = true
    mergeConfirmTimer = setTimeout(resetMergeConfirm, 2000)
    return
  }
  resetMergeConfirm()
  void mergeSelectedPull()
}

async function approveSelectedPull() {
  const target = selectedPull.value
  if (!target) return
  reviewPassed.value = true
  mergeMessage.value = '提交审查通过…'
  try { await window.releaseConsole.approvePullRequest({ repository: target.project.repository, token: target.project.token, number: Number(target.pull.number) }); mergeMessage.value = '审查已通过' } catch (error) { reviewPassed.value = false; mergeMessage.value = error instanceof Error ? error.message : '审查失败' }
}

function markTestPassed() {
  if (!selectedPull.value) return
  testPassed.value = true
  mergeMessage.value = '测试已通过'
}

function requestTestPassed() {
  if (!selectedPull.value) return
  askConfirmation('确认该 PR 的测试已经通过？', markTestPassed)
}

function openCreatePr() {
  createPrForm.value = {
    projectId: projects.value[0]?.id ?? 0,
    title: '',
    head: settings.value.prHead || 'dock',
    base: settings.value.prBase || 'master',
  }
  createPrError.value = ''
  showCreatePr.value = true
}

async function submitCreatePr() {
  const project = projects.value.find((item) => item.id === createPrForm.value.projectId)
  createPrError.value = ''
  if (!project) { createPrError.value = '请选择项目'; return }
  if (!createPrForm.value.title.trim() || !createPrForm.value.head.trim() || !createPrForm.value.base.trim()) { createPrError.value = '标题和分支不能为空'; return }
  creatingPr.value = true
  try {
    await window.releaseConsole.createPullRequest({ repository: project.repository, token: project.token, title: createPrForm.value.title.trim(), head: createPrForm.value.head.trim(), base: createPrForm.value.base.trim() })
    showCreatePr.value = false
    mergeMessage.value = 'PR 创建成功'
    await loadPulls()
  } catch (error) { createPrError.value = error instanceof Error ? error.message : '创建 PR 失败' } finally { creatingPr.value = false }
}

function copyPatch(file: any) {
  const content = patchText(file)
  if (content) navigator.clipboard?.writeText(content)
}

const fullFileViews = ref<Record<string, boolean>>({})
const fullFileContents = ref<Record<string, string>>({})
const fullFileLoading = ref<Record<string, boolean>>({})

function isFullFileView(filename: string) {
  return fullFileViews.value[filename] === true
}

async function toggleFullFile(file: any) {
  const filename = file.filename
  if (isFullFileView(filename)) {
    fullFileViews.value[filename] = false
    return
  }
  fullFileViews.value[filename] = true
  expandedFiles.value[filename] = true
  if (fullFileContents.value[filename] || fullFileLoading.value[filename]) return
  const target = selectedPull.value
  if (!target || !target.pull.head?.ref) return
  fullFileLoading.value[filename] = true
  try {
    const result = await window.releaseConsole.repositoryFile({ repository: target.project.repository, token: target.project.token, path: filename, ref: target.pull.head.ref })
    let content = ''
    if (typeof result === 'string') content = result
    else if (result.content) {
      const binary = atob(result.content.replace(/\s/g, ''))
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
      content = new TextDecoder().decode(bytes)
    } else content = JSON.stringify(result, null, 2)
    fullFileContents.value[filename] = content
  } catch (error) {
    fullFileViews.value[filename] = false
    errorMessage.value = error instanceof Error ? error.message : '无法读取文件内容'
  } finally {
    fullFileLoading.value[filename] = false
  }
}

watch(activePage, (page) => {
  if (page === 'pulls') loadPulls()
  if (page === 'deployments') loadDeploymentRows()
})

watch([errorMessage, mergeMessage], ([error, success]) => {
  const message = success || error
  if (!message) return
  toastMessage.value = message
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMessage.value = '' }, 3500)
})
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">Gitee Release Console</div>
      <nav class="topbar-nav">
        <button v-for="page in pageList" :key="page.id" :class="['nav-item', { active: activePage === page.id }]" @click="switchPage(page.id)">{{ page.label }}</button>
      </nav>
    </header>
    <div class="workspace">
      <main class="content">
        <section v-if="activePage === 'projects'" class="page">
          <div class="page-heading"><div><h1>项目</h1><p>管理 Gitee 仓库项目，PR 与部署按项目自动汇总。</p></div><button class="primary" @click="showProjectForm = true">添加项目</button></div>
          <div v-if="projects.length" class="project-grid">
            <div v-for="project in projects" :key="project.id" class="project-card-wrap"><div class="project-card">
              <strong>{{ project.name }}</strong><span>{{ project.repository }}</span><small>{{ project.openPrs }} 个开放 PR</small>
            </div><button class="delete-project" @click="deleteProject(project)">删除</button></div>
          </div>
          <div v-else class="empty-state">还没有项目，请先添加一个 Gitee 仓库。</div>
        </section>
        <section v-else-if="activePage === 'pulls'" class="page pulls-page">
          <div class="page-heading">
            <div><h1>PR</h1><p>{{ selectedPull ? `已选 ${selectedPull.project.name} #${selectedPull.pull.number} · ${selectedPull.pull.title}` : '汇总所有项目的开放 PR，点击左侧 PR 查看变更与操作。' }}</p></div>
            <div class="heading-actions">
              <select v-model="pullFilter" class="filter-select"><option value="all">全部项目</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select>
              <button :class="{ passed: reviewPassed }" :disabled="!selectedPull || reviewPassed" @click="approveSelectedPull">{{ reviewPassed ? '审查已通过' : '审查通过' }}</button><button :class="{ passed: testPassed }" :disabled="!selectedPull || testPassed" @click="requestTestPassed">{{ testPassed ? '测试已通过' : '测试通过' }}</button><button class="merge-action" :class="{ ready: reviewPassed && testPassed, confirming: mergeConfirming }" :disabled="!selectedPull" @click="requestMerge">{{ mergeConfirming ? '再次点击确认合并' : reviewPassed && testPassed ? '合并 PR' : '一键审查、测试并合并' }}</button><button v-if="oneClickTarget" class="one-click" :class="{ confirming: oneClickAction === 'master' }" :disabled="oneClickBusy" @click="requestOneClick('master')">{{ oneClickAction === 'master' ? '再次点击确认' : `一键 ${settings.prBase}` }}</button><button v-if="oneClickTarget" class="one-click" :class="{ confirming: oneClickAction === 'deploy' }" :disabled="oneClickBusy" @click="requestOneClick('deploy')">{{ oneClickAction === 'deploy' ? '再次点击确认' : '一键部署' }}</button><button class="primary" :disabled="!projects.length" @click="openCreatePr">创建 PR</button><button :disabled="loadingPulls" @click="loadPulls">{{ loadingPulls ? '加载中…' : '刷新' }}</button>
            </div>
          </div>
          <div v-if="!projects.length" class="empty-state">还没有项目，请先在项目页添加。</div>
          <div v-else class="pr-workspace">
            <aside class="pr-list"><div v-if="!filteredPulls.length && !loadingPulls" class="list-empty">没有开放 PR</div><button v-for="item in filteredPulls" :key="`${item.project.id}-${item.pull.number}`" :class="['pr-item', { selected: isSelected(item) }]" @click="selectPull(item)"><span class="project-badge" :title="item.project.repository">{{ item.project.name }}</span><strong>#{{ item.pull.number }} {{ item.pull.title }}</strong><span>{{ authorOf(item.pull) }}</span><small class="pr-branches"><span class="branch-chip branch-head" :class="{ 'branch-main': isMainBranch(item.pull.head?.ref || item.pull.head?.label) }" :title="item.pull.head?.label || item.pull.head?.ref">{{ item.pull.head?.ref || item.pull.head?.label || '?' }}</span><span class="branch-arrow">→</span><span class="branch-chip branch-base" :class="{ 'branch-main': isMainBranch(item.pull.base?.ref || item.pull.base?.label) }" :title="item.pull.base?.label || item.pull.base?.ref">{{ item.pull.base?.ref || item.pull.base?.label || '?' }}</span></small><small class="pr-time">{{ formatTime(item.pull.created_at) }}</small></button></aside>
            <section class="code-panel" :class="{ 'has-list': files.length > 0 && !loadingFiles }" :style="files.length > 0 && !loadingFiles ? { gridTemplateColumns: `${fileListWidth}px 5px minmax(0, 1fr)` } : undefined"><aside v-if="files.length > 0 && !loadingFiles" class="file-list"><button v-for="row in fileTreeRows" :key="row.type + ':' + row.key" :class="['file-item', { dir: row.type === 'dir', active: row.type === 'file' && row.index === activeFileIndex }]" :style="{ paddingLeft: 8 + row.depth * 14 + 'px' }" :title="row.key" @click="row.type === 'dir' ? toggleDir(row.key) : jumpToFile(row.index)"><span v-if="row.type === 'dir'" class="file-toggle">{{ isDirExpanded(row.key) || fileQuery.trim() ? '▾' : '▸' }}</span><span class="file-name">{{ row.name }}</span><span class="file-stat"><span class="stat-added">+{{ row.added }}</span><span class="stat-removed">-{{ row.removed }}</span></span></button></aside><div v-if="files.length > 0 && !loadingFiles" class="resize-handle" @mousedown="startResize"></div><div class="files-main"><div v-if="loadingFiles" class="empty-state">加载文件中…</div><div v-else-if="!selectedPull" class="empty-state">选择一个 PR 查看变更与操作</div><div v-else-if="!files.length" class="empty-state">该 PR 没有可展示的文件</div><template v-else><div class="files-toolbar"><span>{{ fileQuery.trim() ? `${matchedCount}/${files.length} 个文件` : `${files.length} 个文件` }}</span><span class="toolbar-stats"><span class="stat-added">+{{ totalStats.added }}</span><span class="stat-removed">-{{ totalStats.removed }}</span></span><span class="toolbar-spacer"></span><input v-model="fileQuery" class="file-search" placeholder="搜索文件名" /><button @click="setAllFilesExpanded(true)">全部展开</button><button @click="setAllFilesExpanded(false)">全部收起</button></div><div ref="filesScrollEl" class="files-scroll" @scroll="onFilesScroll"><div v-for="(file, index) in files" :id="`pr-file-card-${index}`" :key="file.filename" v-show="fileMatches(file.filename)" :data-index="index" class="file-card"><button class="file-card-header" @click="toggleFile(file.filename)"><span class="file-toggle">{{ isFileExpanded(file.filename) ? '▾' : '▸' }}</span><span class="file-name" :title="file.filename">{{ file.filename }}</span><span class="file-stat"><span class="stat-added">+{{ fileStats[index]?.added ?? 0 }}</span><span class="stat-removed">-{{ fileStats[index]?.removed ?? 0 }}</span></span><span class="copy-btn" title="复制 diff" @click.stop="copyPatch(file)">复制</span><span class="copy-btn full-toggle" :class="{ active: isFullFileView(file.filename) }" title="查看完整文件 / 切回 diff" @click.stop="toggleFullFile(file)">{{ isFullFileView(file.filename) ? '返回 diff' : '完整文件' }}</span></button><pre v-if="isFileExpanded(file.filename) && isFullFileView(file.filename)" class="code-view file-diff full-file">{{ fullFileLoading[file.filename] ? '加载中…' : fullFileContents[file.filename] || '无法加载文件内容' }}</pre><pre v-else-if="isFileExpanded(file.filename)" class="code-view file-diff"><code><span v-for="(line, lineIndex) in fileDiffs[index]" :key="lineIndex" :class="['code-line', `line-${line.kind}`]"><span class="line-prefix">{{ line.prefix }}</span><span v-html="line.html"></span></span></code></pre></div></div></template></div></section>
          </div>
        </section>
        <section v-else-if="activePage === 'deployments'" class="page">
          <div class="page-heading"><div><h1>部署</h1><p>管理各项目的部署配置，执行部署并查看日志。</p></div><button class="primary" :disabled="!projects.length" @click="openAddConfig">添加配置</button></div>
          <div v-if="!projects.length" class="empty-state">还没有项目，请先在项目页添加。</div>
          <div v-else class="deploy-table-wrap">
            <table class="deploy-table">
              <thead><tr><th>项目</th><th>服务器</th><th>用户</th><th>远程目录</th><th>命令</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="row in deploymentRows" :key="row.projectId">
                  <td>{{ row.projectName }}</td>
                  <td><span v-if="row.host">{{ row.host }}</span><span v-else class="muted">未配置</span></td>
                  <td>{{ row.username }}</td>
                  <td>{{ row.remotePath }}</td>
                  <td class="deploy-cmd">{{ row.command }}</td>
                  <td><div class="row-actions"><button class="primary" :disabled="!configComplete(row) || deployLog.running" :title="configComplete(row) ? '' : '请先完善配置'" @click="runProjectDeployment(row)">{{ deployLog.running && deployLog.projectId === row.projectId ? '部署中…' : '执行部署' }}</button><button @click="openEditConfig(row)">编辑</button><button class="danger" :disabled="!row.host && !row.username && !row.remotePath && !row.command" @click="askDeleteConfig(row)">删除</button></div></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="deployLog.projectId" class="settings-section deploy-log-section">
            <h2>部署日志 · {{ deployLog.projectName }}<span v-if="deployLog.running" class="deploy-running">执行中…</span></h2>
            <pre ref="deployOutputEl" class="deploy-output">{{ deployLog.output || '等待输出…' }}</pre>
          </div>
        </section>
        <section v-else class="page">
          <h1>设置</h1>
          <form class="settings-section" @submit.prevent="saveAppSettings">
            <h2>PR 与合并</h2>
            <label>PR 来源分支(head)<input v-model="settings.prHead" placeholder="dock" /></label>
            <label>PR 目标分支(base)<input v-model="settings.prBase" placeholder="master" /></label>
            <label>合并方式<select v-model="settings.mergeMethod"><option value="merge">merge · 保留完整历史</option><option value="rebase">rebase · 变基合并</option><option value="squash">squash · 压缩为单个提交</option></select></label>
            <button class="primary" type="submit">保存设置</button>
          </form>
          <div class="settings-section">
            <h2>项目管理</h2>
            <div v-if="!projects.length" class="settings-empty">暂无项目，请先在项目页添加。</div>
            <div v-for="project in projects" :key="project.id" class="project-row">
              <div class="project-row-info"><strong>{{ project.name }}</strong><span>{{ project.repository }}</span></div>
              <div class="row-actions"><button @click="startEditProject(project)">编辑</button><button class="danger" @click="deleteProject(project)">删除</button></div>
            </div>
          </div>
          <div class="settings-section">
            <h2>关于</h2>
            <div class="meta-row"><span>应用版本</span><code>{{ meta.version || '未知' }}</code></div>
            <div class="meta-row"><span>数据存储</span><code>{{ meta.dataPath || '未知' }}</code></div>
          </div>
        </section>
      </main>
    </div>
    <div v-if="showProjectForm" class="modal-backdrop" @click.self="showProjectForm = false">
      <form class="modal" @submit.prevent="addProject"><h2>添加项目</h2><div v-if="projectFormError" class="error-message">{{ projectFormError }}</div><label>项目名称<input v-model="projectName" autofocus /></label><label>仓库地址<input v-model="repository" placeholder="owner/repository" /></label><label>Gitee Token<input v-model="token" type="password" autocomplete="off" /></label><div class="modal-actions"><button type="button" @click="showProjectForm = false">取消</button><button class="primary" type="submit" :disabled="savingProject">{{ savingProject ? '保存中…' : '保存' }}</button></div></form>
    </div>
    <div v-if="showCreatePr" class="modal-backdrop" @click.self="showCreatePr = false">
      <form class="modal" @submit.prevent="submitCreatePr"><h2>创建 PR</h2><div v-if="createPrError" class="error-message">{{ createPrError }}</div><label>项目<select v-model="createPrForm.projectId"><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}（{{ project.repository }}）</option></select></label><label>标题<input v-model="createPrForm.title" placeholder="PR 标题" /></label><label>来源分支(head)<input v-model="createPrForm.head" placeholder="dock" /></label><label>目标分支(base)<input v-model="createPrForm.base" placeholder="master" /></label><div class="modal-actions"><button type="button" @click="showCreatePr = false">取消</button><button class="primary" type="submit" :disabled="creatingPr">{{ creatingPr ? '创建中…' : '创建' }}</button></div></form>
    </div>
    <div v-if="configModal" class="modal-backdrop" @click.self="configModal = false">
      <form class="modal" @submit.prevent="saveConfig"><h2>{{ configForm.isNew ? '添加部署配置' : '编辑部署配置' }}</h2><div v-if="configFormError" class="error-message">{{ configFormError }}</div><label>项目<select v-if="configForm.isNew" v-model="configForm.projectId"><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}（{{ project.repository }}）</option></select><input v-else :value="configForm.projectName" disabled /></label><label>服务器地址<span class="combo"><input v-model="configForm.host" placeholder="example.com" @focus="showHostSuggestions = true" @blur="showHostSuggestions = false" /><span v-if="showHostSuggestions && hostSuggestions.length" class="combo-menu"><button type="button" v-for="host in hostSuggestions" :key="host" @mousedown.prevent="pickHost(host)">{{ host }}</button></span></span></label><label>SSH 用户<span class="combo"><input v-model="configForm.username" placeholder="deploy" @focus="showUserSuggestions = true" @blur="showUserSuggestions = false" /><span v-if="showUserSuggestions && userSuggestions.length" class="combo-menu"><button type="button" v-for="username in userSuggestions" :key="username" @mousedown.prevent="pickUser(username)">{{ username }}</button></span></span></label><label>远程目录<input v-model="configForm.remotePath" placeholder="/srv/app" /></label><label>部署命令<input v-model="configForm.command" placeholder="git pull && ./deploy.sh" /></label><div class="modal-actions"><button type="button" @click="configModal = false">取消</button><button class="primary" type="submit" :disabled="savingConfig">{{ savingConfig ? '保存中…' : '保存' }}</button></div></form>
    </div>
    <div v-if="toastMessage" class="toast">{{ toastMessage }}</div>
    <div v-if="oneClickProgress" class="modal-backdrop">
      <div class="modal one-click-modal">
        <h2>{{ oneClickProgress.kind === 'deploy' ? '一键部署' : `一键 ${settings.prBase}` }}</h2>
        <ol class="progress-steps">
          <li v-for="(step, index) in oneClickSteps" :key="index" :class="step.state"><span class="step-dot">{{ step.state === 'done' ? '✓' : index + 1 }}</span>{{ step.label }}</li>
        </ol>
        <pre v-if="oneClickProgress.kind === 'deploy'" ref="modalLogEl" class="deploy-output">{{ oneClickProgress.log || '等待部署输出…' }}</pre>
        <div class="modal-actions"><button :disabled="oneClickProgress.running" @click="oneClickProgress = null">{{ oneClickProgress.running ? '执行中…' : '关闭' }}</button></div>
      </div>
    </div>
    <div v-if="confirmMessage" class="modal-backdrop" @click.self="cancelConfirmation"><div class="confirm-modal"><h3>请确认操作</h3><p>{{ confirmMessage }}</p><div class="modal-actions"><button @click="cancelConfirmation">取消</button><button class="primary" @click="acceptConfirmation">确认</button></div></div></div>
    <div v-if="editForm.id !== 0" class="modal-backdrop" @click.self="editForm.id = 0">
      <form class="modal" @submit.prevent="saveProjectEdit"><h2>编辑项目</h2><div v-if="editFormError" class="error-message">{{ editFormError }}</div><label>项目名称<input v-model="editForm.name" /></label><label>仓库地址<input v-model="editForm.repository" placeholder="owner/repository" /></label><label>Gitee Token<input v-model="editForm.token" type="password" autocomplete="off" /></label><div class="modal-actions"><button type="button" @click="editForm.id = 0">取消</button><button class="primary" type="submit" :disabled="savingEdit">{{ savingEdit ? '保存中…' : '保存' }}</button></div></form>
    </div>
  </div>
</template>
