<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github.css'
import DropdownSelect from './DropdownSelect.vue'
import LoadingAnim from './LoadingAnim.vue'

type Project = { id: number; name: string; repository: string; token: string; openPrs: number }
type PullItem = { project: Project; pull: any }
type DeploymentRow = { id: number; projectId: number; projectName: string; name: string; host: string; username: string; remotePath: string; command: string; position: number }
type DeployGroup = { project: Project; targets: DeploymentRow[] }

const projects = ref<Project[]>([])
const pageList = [
  { id: 'projects', label: '项目' },
  { id: 'pulls', label: 'PR' },
  { id: 'deployments', label: '部署' },
  { id: 'logs', label: '日志' },
  { id: 'settings', label: '设置' },
]
function pageFromHash() {
  const segments = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  return pageList.some((item) => item.id === segments[0]) ? segments[0] : 'projects'
}
function selectedFromHash(): { projectId: number; number: number } | null {
  const segments = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (segments[0] !== 'pulls' || segments.length < 3) return null
  const projectId = Number(segments[1])
  const number = Number(segments[2])
  return projectId && number ? { projectId, number } : null
}
const activePage = ref(pageFromHash())
const hashSelected = selectedFromHash()
function switchPage(page: string) {
  activePage.value = page
  const target = `#/${page}`
  if (location.hash !== target) location.hash = target
}
window.addEventListener('hashchange', () => {
  const next = pageFromHash()
  if (next !== activePage.value) clearSelection()
  activePage.value = next
})

function notifyDesktop(title: string, body: string) {
  try {
    if (!('Notification' in window)) return
    if (Notification.permission === 'granted') new Notification(title, { body })
    else if (Notification.permission !== 'denied') void Notification.requestPermission().then((permission) => { if (permission === 'granted') new Notification(title, { body }) })
  } catch { }
}

const showProjectForm = ref(false)
const projectName = ref('')
const repository = ref('')
const token = ref('')

const pulls = ref<PullItem[]>([])
const loadingPulls = ref(false)
const pullLoadErrors = ref<string[]>([])
const syncStatusRows = ref<Array<{ projectId: number; name: string; lastSyncAt: string; lastError: string; enabled: number }>>([])

const stateBadgeMap: Record<string, { label: string; cls: string }> = {
  new: { label: '待评估', cls: 'st-new' },
  ai_reviewing: { label: 'AI 评估中', cls: 'st-running' },
  no_test_needed: { label: '无需测试', cls: 'st-pass' },
  needs_test: { label: '待测试', cls: 'st-warn' },
  testing: { label: '测试中', cls: 'st-running' },
  test_passed: { label: '测试通过', cls: 'st-pass' },
  test_failed: { label: '测试失败', cls: 'st-fail' },
  merged: { label: '已合并', cls: 'st-merged' },
  closed: { label: '已关闭', cls: 'st-closed' },
}

function stateBadge(state: string) {
  return stateBadgeMap[state] ?? { label: state, cls: 'st-new' }
}

const selectedAiVerdict = computed<{ needs_test: boolean; reason: string; risk_level: string } | null>(() => {
  const raw = selectedPull.value?.pull?.ai_result
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
})

const settingsTab = ref<'general' | 'automation' | 'ai' | 'projects' | 'about'>('general')
const aiTesting = ref(false)
const aiTestMessage = ref('')
const evaluatingPr = ref(false)
const testConfigs = ref<Array<{ project_id: number; server_mode: string; host: string; username: string; workdir_template: string; source_path: string; commands: string; ai_decides: number; ai_prompt: string; timeout_sec: number; projectName: string }>>([])
const testModal = ref(false)
const testForm = ref({ projectId: 0, projectName: '', serverMode: 'ssh', host: '', username: '', workdirTemplate: '~/TEST/{project}_{pr}', sourcePath: '', commandOptions: [{ label: '全量', command: 'vendor/bin/phpunit tests' }], aiDecides: false, aiPrompt: '', timeoutSec: 600 })
const testFormError = ref('')
const savingTest = ref(false)
const runningTest = ref(false)
const testOutput = ref('')
const testSummary = ref('')
const testOutputEl = ref<HTMLElement | null>(null)

function testConfigOf(projectId: number) {
  return testConfigs.value.find((row) => row.project_id === projectId)
}

async function loadTestConfigs() {
  try {
    const rows = await window.releaseConsole.listTestConfigs()
    if (Array.isArray(rows)) testConfigs.value = rows
  } catch { }
}

function openTestConfig(group: DeployGroup) {
  const existing = testConfigOf(group.project.id)
  let options = [{ label: '全量', command: 'vendor/bin/phpunit tests' }]
  if (existing) {
    try { const parsed = JSON.parse(existing.commands); if (Array.isArray(parsed) && parsed.length) options = parsed } catch { }
  }
  testForm.value = {
    projectId: group.project.id,
    projectName: group.project.name,
    serverMode: existing?.server_mode ?? 'ssh',
    host: existing?.host ?? '',
    username: existing?.username ?? '',
    workdirTemplate: existing?.workdir_template ?? '~/TEST/{project}_{pr}',
    sourcePath: existing?.source_path ?? '',
    commandOptions: options,
    aiDecides: !!existing?.ai_decides,
    aiPrompt: existing?.ai_prompt ?? '',
    timeoutSec: existing?.timeout_sec ?? 600,
  }
  testFormError.value = ''
  testModal.value = true
}

function addCommandOption() { testForm.value.commandOptions.push({ label: '', command: '' }) }
function removeCommandOption(index: number) { if (testForm.value.commandOptions.length > 1) testForm.value.commandOptions.splice(index, 1) }

async function saveTestConfig() {
  const valid = testForm.value.commandOptions.every((option) => option.label.trim() && option.command.trim())
  if (!valid) { testFormError.value = '每个命令选项都需要名称和命令'; return }
  savingTest.value = true
  try {
    await window.releaseConsole.saveTestConfig({
      projectId: testForm.value.projectId,
      serverMode: testForm.value.serverMode,
      host: testForm.value.host.trim(),
      username: testForm.value.username.trim(),
      workdirTemplate: testForm.value.workdirTemplate.trim(),
      sourcePath: testForm.value.sourcePath.trim(),
      commands: JSON.stringify(testForm.value.commandOptions.map((option) => ({ label: option.label.trim(), command: option.command.trim() }))),
      aiDecides: testForm.value.aiDecides,
      aiPrompt: testForm.value.aiPrompt,
      timeoutSec: Number(testForm.value.timeoutSec) || 600,
    })
    testModal.value = false
    mergeMessage.value = '测试配置已保存'
    await loadTestConfigs()
  } catch (error) { testFormError.value = error instanceof Error ? error.message : '保存失败' } finally { savingTest.value = false }
}

async function runSelectedTest() {
  const target = selectedPull.value
  if (!target || runningTest.value) return
  runningTest.value = true
  testOutput.value = ''
  target.pull.state = 'testing'
  try {
    testOutput.value = await window.releaseConsole.runPrTest({ projectId: target.project.id, number: Number(target.pull.number) }, (text) => {
      testOutput.value += text
      nextTick(() => testOutputEl.value?.scrollTo({ top: testOutputEl.value.scrollHeight }))
    })
    const success = testOutput.value.includes('[测试通过]')
    target.pull.state = success ? 'test_passed' : 'test_failed'
    mergeMessage.value = success ? '测试通过' : '测试失败'
    try {
      const logs = await window.releaseConsole.listDeploymentLogs({ projectId: target.project.id, limit: 5 })
      const entry = logs.find((row) => row.kind === 'test' && row.prNumber === Number(target.pull.number))
      testSummary.value = entry?.aiSummary ?? ''
    } catch { }
  } catch (error) {
    target.pull.state = 'needs_test'
    mergeMessage.value = error instanceof Error ? error.message : '测试发起失败'
  } finally { runningTest.value = false }
}

async function reevaluateSelected() {
  const target = selectedPull.value
  if (!target || evaluatingPr.value) return
  evaluatingPr.value = true
  try {
    const { verdict } = await window.releaseConsole.evaluatePr({ projectId: target.project.id, number: Number(target.pull.number) })
    target.pull.state = verdict.needs_test ? 'needs_test' : 'no_test_needed'
    target.pull.status_note = verdict.reason
    target.pull.ai_result = JSON.stringify(verdict)
    target.pull.ai_evaluated_at = new Date().toISOString().replace('T', ' ').slice(0, 19)
    mergeMessage.value = 'AI 评审完成'
  } catch (error) { mergeMessage.value = error instanceof Error ? error.message : '评审失败' } finally { evaluatingPr.value = false }
}

async function testAi() {
  aiTesting.value = true
  aiTestMessage.value = ''
  try {
    const { message } = await window.releaseConsole.testAiConnection({ aiBaseUrl: settings.value.aiBaseUrl, aiApiKey: settings.value.aiApiKey, aiModel: settings.value.aiModel, aiPrompt: settings.value.aiPrompt })
    aiTestMessage.value = message
  } catch (error) { aiTestMessage.value = error instanceof Error ? error.message : '连接失败' } finally { aiTesting.value = false }
}
const pullFilter = ref<number | 'all'>('all')
const pullListTab = ref<'open' | 'ended'>('open')
const isEndedPull = (item: PullItem) => item.pull.state === 'merged' || item.pull.state === 'closed'
const filteredPulls = computed(() => pulls.value.filter((item) => (pullListTab.value === 'open' ? !isEndedPull(item) : isEndedPull(item)) && (pullFilter.value === 'all' || item.project.id === pullFilter.value)))
const selectedPull = ref<PullItem | null>(null)

const files = ref<any[]>([])
const expandedFiles = ref<Record<string, boolean>>({})
const loadingFiles = ref(false)
const commits = ref<any[]>([])
const sidebarTab = ref<'files' | 'commits'>('files')
const sqlFiles = computed(() => files.value.filter((file) => isSqlFile(file.filename)))
const sqlPopVisible = computed(() => sqlFiles.value.length > 0)
const sqlPopStyle = ref<{ left: string; top: string }>({ left: '-999px', top: '-999px' })

function updateSqlPopPosition() {
  const tab = document.querySelector('.files-tab')
  if (!tab) return
  const rect = tab.getBoundingClientRect()
  sqlPopStyle.value = { left: `${Math.max(8, rect.left - 4)}px`, top: `${rect.top - 10}px` }
}

function locateFirstSql() {
  sidebarTab.value = 'files'
  const index = files.value.findIndex((file) => isSqlFile(file.filename))
  if (index >= 0) jumpToFile(index)
}
const prDescription = ref('')
const prDescriptionOpen = ref(false)
const prFilesCache = ref<any[]>([])
const viewingCommit = ref<any | null>(null)
const commitLoading = ref(false)
const errorMessage = ref('')
const mergeMessage = ref('')
const reviewPassed = ref(false)
const testPassed = ref(false)
const mergeConfirming = ref(false)
let mergeConfirmTimer: ReturnType<typeof setTimeout> | undefined
const oneClickAction = ref<'' | 'master' | 'deploy'>('')
let oneClickTimer: ReturnType<typeof setTimeout> | undefined

type OneClickRun = {
  project: Project
  pull: any
  title: string
  created: any
  withDeploy: boolean
  direct: boolean
  merged1: boolean
  created2: boolean
  merged2: boolean
  deployed: boolean
  deployedTargetIds: number[]
  lastDeploy: { createdAt: string; success: number } | null
  deployTarget: { name: string; host: string; username: string; remotePath: string; command: string } | null
  log: string
  failed: boolean
  running: boolean
}
const oneClickRun = ref<OneClickRun | null>(null)
const modalLogEl = ref<HTMLElement | null>(null)

const oneClickSteps = computed(() => {
  const run = oneClickRun.value
  if (!run) return []
  const prHead = settings.value.prHead
  const prBase = settings.value.prBase
  const rows: Array<{ label: string; done: boolean }> = []
  if (run.direct) rows.push({ label: `合并 ${prHead} → ${prBase} 分支 PR`, done: run.merged1 })
  else {
    rows.push({ label: `合并 ${prHead} 分支 PR`, done: run.merged1 })
    rows.push({ label: `创建 ${prHead} → ${prBase} 分支 PR`, done: run.created2 })
    rows.push({ label: `合并 ${prBase} 分支 PR`, done: run.merged2 })
  }
  if (run.withDeploy) rows.push({ label: '执行部署', done: run.deployed })
  const firstOpen = rows.findIndex((row) => !row.done)
  return rows.map((row, index) => ({
    label: row.label,
    state: row.done ? 'done' : index === firstOpen ? (run.failed ? 'failed' : run.running ? 'running' : 'pending') : 'pending',
  }))
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

const isDockToMaster = computed(() => {
  const item = selectedPull.value
  if (!item) return false
  const prHead = settings.value.prHead
  const prBase = settings.value.prBase
  if (!prHead || !prBase || prHead === prBase) return false
  return String(item.pull.head?.ref ?? '') === prHead && String(item.pull.base?.ref ?? '') === prBase
})

const showOneClickDeploy = computed(() => !!oneClickTarget.value || isDockToMaster.value)
const selectedEnded = computed(() => !!selectedPull.value && isEndedPull(selectedPull.value))

const settings = ref({ prHead: 'dock', prBase: 'master', mergeMethod: 'merge', pollIntervalSec: '180', automationEnabled: '0', aiBaseUrl: '', aiApiKey: '', aiModel: '', aiPrompt: '' })
const meta = ref({ version: '', dataPath: '' })

const showCreatePr = ref(false)
const createPrForm = ref({ projectId: 0, title: '', head: '', base: '' })
const createPrError = ref('')
const creatingPr = ref(false)

const deploymentRows = ref<DeploymentRow[]>([])
const loadingDeployments = ref(false)
const deploymentServers = ref<{ host: string; username: string }[]>([])
const deploymentGroups = computed<DeployGroup[]>(() => projects.value.map((project) => ({
  project,
  targets: deploymentRows.value.filter((row) => row.projectId === project.id).sort((a, b) => a.position - b.position || a.id - b.id),
})))
const deployHistory = ref<Array<{ id: number; projectId: number; projectName: string; targetName: string; kind: string; prNumber: number; host: string; output: string; aiSummary: string; success: number; createdAt: string }>>([])
const historyFilter = ref<number | 'all'>('all')
const requestLogRows = ref<Array<{ id: number; projectId: number; projectName: string; endpoint: string; method: string; ok: number; status: number; errorMessage: string; durationMs: number; createdAt: string }>>([])
const requestLogDetail = ref<{ projectName: string; endpoint: string; method: string; ok: number; status: number; errorMessage: string; durationMs: number; createdAt: string } | null>(null)
const requestLogFilter = ref<number | 'all'>('all')
const requestLogStatus = ref<'all' | 'ok' | 'error'>('all')
const loadingRequestLogs = ref(false)
const filteredHistory = computed(() => historyFilter.value === 'all' ? deployHistory.value : deployHistory.value.filter((entry) => entry.projectId === historyFilter.value))
const activeHistoryId = ref(0)
const configModal = ref(false)
const configForm = ref({ id: 0, projectId: 0, projectName: '', name: '', host: '', username: '', remotePath: '', command: '' })
const configFormError = ref('')
const savingConfig = ref(false)
const showHostSuggestions = ref(false)
const showUserSuggestions = ref(false)
const hostSuggestions = computed(() => deploymentServers.value.map((server) => server.host))
const userSuggestions = computed(() => [...new Set(deploymentServers.value.map((server) => server.username))])
const deployLog = ref({ projectId: 0, projectName: '', output: '', aiSummary: '', running: false })
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

let suppressFileSpy = false

function jumpToFile(index: number) {
  const file = files.value[index]
  if (!file) return
  if (!isFileExpanded(file.filename)) expandedFiles.value[file.filename] = true
  activeFileIndex.value = index
  suppressFileSpy = true
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
  if (suppressFileSpy) { suppressFileSpy = false; return }
  const containerTop = container.getBoundingClientRect().top
  const containerBottom = containerTop + container.clientHeight
  const cards = Array.from(container.querySelectorAll<HTMLElement>('.file-card')).filter((card) => card.style.display !== 'none')
  if (!cards.length) return
  if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
    let last = Number(cards[0].dataset.index ?? 0)
    for (const card of cards) {
      if (card.getBoundingClientRect().top < containerBottom) last = Number(card.dataset.index ?? 0)
    }
    activeFileIndex.value = last
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
  if (activePage.value === 'logs') loadRequestLogs()
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

async function loadRequestLogs() {
  loadingRequestLogs.value = true
  try {
    requestLogRows.value = await window.releaseConsole.requestLogs({ projectId: requestLogFilter.value === 'all' ? undefined : requestLogFilter.value, status: requestLogStatus.value })
  } finally { loadingRequestLogs.value = false }
}

async function toggleProjectSync(row: { projectId: number; enabled: number }) {
  await window.releaseConsole.toggleSync(row.projectId, !row.enabled)
  row.enabled = row.enabled ? 0 : 1
  syncStatusRows.value = [...syncStatusRows.value]
}

async function saveAppSettings() {
  try { settings.value = await window.releaseConsole.saveSettings({ ...settings.value }) } catch (error) { mergeMessage.value = error instanceof Error ? error.message : '保存设置失败'; return }
  mergeMessage.value = '设置已保存'
}

async function loadDeployHistory() {
  try { deployHistory.value = await window.releaseConsole.listDeploymentLogs({ limit: 20 }) } catch { }
}

async function loadDeploymentRows() {
  if (!projects.value.length) { deploymentRows.value = []; return }
  loadingDeployments.value = true
  try {
    deploymentRows.value = await window.releaseConsole.listDeploymentConfigs()
    try { deploymentServers.value = await window.releaseConsole.listDeploymentServers() } catch { }
    loadTestConfigs()
  } finally {
    loadingDeployments.value = false
  }
  loadDeployHistory()
}

function showHistory(entry: { id: number; projectId: number; projectName: string; output: string; aiSummary?: string }) {
  activeHistoryId.value = entry.id
  deployLog.value = { projectId: entry.projectId, projectName: entry.projectName, output: entry.output, aiSummary: entry.aiSummary ?? '', running: false }
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

function openAddTarget(group: DeployGroup) {
  configForm.value = { id: 0, projectId: group.project.id, projectName: group.project.name, name: '', host: '', username: '', remotePath: '', command: '' }
  configFormError.value = ''
  configModal.value = true
}

function openEditTarget(row: DeploymentRow) {
  configForm.value = { id: row.id, projectId: row.projectId, projectName: row.projectName, name: row.name, host: row.host, username: row.username, remotePath: row.remotePath, command: row.command }
  configFormError.value = ''
  configModal.value = true
}

async function saveTarget() {
  if (!configForm.value.projectId) { configFormError.value = '请选择项目'; return }
  savingConfig.value = true
  try {
    await window.releaseConsole.saveDeploymentTarget({
      id: configForm.value.id || undefined,
      projectId: configForm.value.projectId,
      name: configForm.value.name.trim(),
      host: configForm.value.host.trim(),
      username: configForm.value.username.trim(),
      remotePath: configForm.value.remotePath.trim(),
      command: configForm.value.command.trim(),
    })
    configModal.value = false
    mergeMessage.value = '部署目标已保存'
    await loadDeploymentRows()
  } catch (error) { configFormError.value = error instanceof Error ? error.message : '保存配置失败' } finally { savingConfig.value = false }
}

async function moveTarget(row: DeploymentRow, direction: -1 | 1) {
  const group = deploymentGroups.value.find((item) => item.project.id === row.projectId)
  if (!group) return
  const ids = group.targets.map((target) => target.id)
  const index = ids.indexOf(row.id)
  const swapWith = index + direction
  if (index < 0 || swapWith < 0 || swapWith >= ids.length) return
  ;[ids[index], ids[swapWith]] = [ids[swapWith], ids[index]]
  await window.releaseConsole.reorderDeploymentTargets(ids)
  await loadDeploymentRows()
}

function askDeleteTarget(row: DeploymentRow) {
  askConfirmation(`确认删除「${row.projectName}」的目标「${row.name || row.host}」？`, () => { void (async () => {
    await window.releaseConsole.deleteDeploymentTarget(row.id)
    mergeMessage.value = '部署目标已删除'
    await loadDeploymentRows()
  })() })
}

function configComplete(row: DeploymentRow) {
  return !!(row.host && row.username && row.remotePath && row.command)
}

async function streamTarget(target: DeploymentRow, onChunk: (text: string) => void) {
  return window.releaseConsole.runDeployment(target.id, onChunk)
}

async function runTargetDeployment(row: DeploymentRow) {
  if (!configComplete(row) || deployLog.value.running) return
  deployLog.value = { projectId: row.projectId, projectName: `${row.projectName} · ${row.name || row.host}`, output: '', aiSummary: '', running: true }
  try {
    deployLog.value.output = await streamTarget(row, (text) => {
      deployLog.value.output += text
      nextTick(() => deployOutputEl.value?.scrollTo({ top: deployOutputEl.value.scrollHeight }))
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '部署失败'
    deployLog.value.output += (deployLog.value.output ? '\n' : '') + message
    notifyDesktop('部署失败', `${row.projectName} · ${row.name || row.host}`)
  } finally {
    deployLog.value.running = false
    loadDeployHistory()
  }
  if (deployLog.value.output.includes('[部署完成]')) notifyDesktop('部署完成', `${row.projectName} · ${row.name || row.host}`)
}

async function runGroupDeployment(group: DeployGroup) {
  const targets = group.targets.filter(configComplete)
  if (!targets.length || deployLog.value.running) return
  deployLog.value = { projectId: group.project.id, projectName: group.project.name, output: '', aiSummary: '', running: true }
  try {
    for (const target of targets) {
      deployLog.value.output += `\n==> [${target.name || target.host}] ${target.username}@${target.host}\n`
      try {
        await streamTarget(target, (text) => {
          deployLog.value.output += text
          nextTick(() => deployOutputEl.value?.scrollTo({ top: deployOutputEl.value.scrollHeight }))
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : '部署失败'
        deployLog.value.output += `\n[部署失败] ${target.name || target.host}：${message}\n[后续目标已跳过]`
        notifyDesktop('部署失败', `${group.project.name} · ${target.name || target.host}（后续目标已跳过）`)
        return
      }
    }
    deployLog.value.output += '\n[全部部署完成]'
    notifyDesktop('部署完成', `${group.project.name} · ${targets.length} 个目标全部成功`)
  } finally {
    deployLog.value.running = false
    loadDeployHistory()
  }
}

async function loadPulls() {
  if (!projects.value.length) { pulls.value = []; pullLoadErrors.value = []; return }
  loadingPulls.value = true
  errorMessage.value = ''
  try {
    const rows = await window.releaseConsole.cachedPulls()
    pulls.value = rows
      .map((row) => ({
        project: { id: row.projectId, name: row.projectName, repository: row.repository, token: row.token, openPrs: 0 },
        pull: {
          number: row.number,
          title: row.title,
          body: row.body,
          user: { name: row.author },
          head: { ref: row.headRef, sha: row.headSha },
          base: { ref: row.baseRef },
          created_at: row.createdAt,
          updated_at: row.updatedAt,
          state: row.state,
          status_note: row.statusNote,
          ai_result: row.aiResult,
          ai_evaluated_at: row.aiEvaluatedAt,
        },
      }))
      .sort((a, b) => (Date.parse(String(b.pull.updated_at ?? b.pull.created_at ?? '')) || 0) - (Date.parse(String(a.pull.updated_at ?? a.pull.created_at ?? '')) || 0))
    for (const project of projects.value) {
      project.openPrs = pulls.value.filter((item) => item.project.id === project.id && !isEndedPull(item)).length
    }
    loadTestConfigs()
    try {
      syncStatusRows.value = await window.releaseConsole.syncStatus()
      pullLoadErrors.value = syncStatusRows.value.filter((row) => row.lastError).map((row) => `${row.name}：${row.lastError}`)
    } catch { }
    if (hashSelected && !selectedPull.value) {
      const match = pulls.value.find((item) => item.project.id === hashSelected.projectId && Number(item.pull.number) === hashSelected.number)
      if (match) selectPull(match)
      else if (!loadingPulls.value) history.replaceState(null, '', '#/pulls')
    }
    if (selectedPull.value && !pulls.value.some((item) => isSelected(item))) clearSelection()
  } finally {
    loadingPulls.value = false
  }
}

async function refreshPulls() {
  loadingPulls.value = true
  try {
    const { results } = await window.releaseConsole.refreshPulls()
    pullLoadErrors.value = results.filter((row) => row.error).map((row) => `${row.name}：${row.error}`)
  } catch (error) { pullLoadErrors.value = [error instanceof Error ? error.message : '刷新失败'] } finally { await loadPulls() }
}

function clearSelection() {
  resetMergeConfirm()
  resetOneClickConfirm()
  selectedPull.value = null
  prDescription.value = ''
  prDescriptionOpen.value = false
  files.value = []
  commits.value = []
  prFilesCache.value = []
  viewingCommit.value = null
  sidebarTab.value = 'files'
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
  history.replaceState(null, '', `#/pulls/${item.project.id}/${item.pull.number}`)
  void openPull(item, seq)
}

async function openPull(item: PullItem, seq: number) {
  resetMergeConfirm()
  resetOneClickConfirm()
  files.value = []
  commits.value = []
  sidebarTab.value = 'files'
  testOutput.value = ''
  testSummary.value = ''
  if (item.pull.state === 'test_passed' || item.pull.state === 'test_failed') {
    try {
      const logs = await window.releaseConsole.listDeploymentLogs({ projectId: item.project.id, limit: 10 })
      const entry = logs.find((row) => row.kind === 'test' && row.prNumber === Number(item.pull.number))
      if (entry && seq === selectionSeq) testSummary.value = entry.aiSummary ?? ''
    } catch { }
  }
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
    prDescription.value = String(pull.body ?? '').trim() || prDescription.value
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
    const [fileList, commitList] = await Promise.all([
      window.releaseConsole.pullRequestFiles({ repository: project.repository, token: project.token, number: Number(pull.number) }),
      window.releaseConsole.pullRequestCommits({ repository: project.repository, token: project.token, number: Number(pull.number) }).catch(() => []),
    ])
    if (stale()) return
    files.value = fileList
    prFilesCache.value = fileList
    commits.value = commitList
    viewingCommit.value = null
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
  if (oneClickRun.value?.running) return
  if (oneClickAction.value !== kind) {
    oneClickAction.value = kind
    oneClickTimer = setTimeout(resetOneClickConfirm, 2000)
    return
  }
  resetOneClickConfirm()
  if (kind === 'deploy' && !oneClickTarget.value && isDockToMaster.value) {
    const target = selectedPull.value!
    oneClickRun.value = { project: target.project, pull: target.pull, title: '', created: null, withDeploy: true, direct: true, merged1: false, created2: false, merged2: false, deployed: false, deployedTargetIds: [] as number[], lastDeploy: null, deployTarget: null, log: '', failed: false, running: false }
  } else {
    const target = oneClickTarget.value
    if (!target) return
    oneClickRun.value = { project: target.project, pull: target.pull, title: String(target.pull.title ?? ''), created: null, withDeploy: kind === 'deploy', direct: false, merged1: false, created2: false, merged2: false, deployed: false, deployedTargetIds: [] as number[], lastDeploy: null, deployTarget: null, log: '', failed: false, running: false }
  }
  void runOneClick()
}

async function syncProjectPulls(projectId: number) {
  try { await window.releaseConsole.refreshPulls(projectId) } catch { }
  await loadPulls()
}

function matchCreatedPull(project: Project, title: string) {
  return pulls.value.find((item) => item.project.id === project.id && String(item.pull.head?.ref) === settings.value.prHead && String(item.pull.base?.ref) === settings.value.prBase && String(item.pull.title ?? '') === title)?.pull ?? null
}

async function findCreatedPull(project: Project, title: string) {
  // 创建后 Gitee 列表可能短暂不可见(最终一致性),且本地缓存需强制同步才会更新:
  // 每轮先触发服务端即时轮询再读缓存,重试 8 次 × 1s
  for (let attempt = 0; attempt < 8; attempt++) {
    await syncProjectPulls(project.id)
    const found = matchCreatedPull(project, title)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`创建 PR 后 ${8}s 内未在 Gitee 列表中出现,可在 PR 页刷新后手动合并`)
}

async function findCreatedPullQuiet(project: Project, title: string) {
  try {
    await syncProjectPulls(project.id)
    return matchCreatedPull(project, title)
  } catch { return null }
}

async function runDeployStage(run: OneClickRun) {
  try {
    const logs = await window.releaseConsole.listDeploymentLogs({ projectId: run.project.id, limit: 1 })
    run.lastDeploy = logs[0] ? { createdAt: logs[0].createdAt, success: logs[0].success } : null
  } catch { }
  console.log('[runDeployStage] project:', run.project.id, run.project.name, '| rows:', deploymentRows.value.length)
  if (!deploymentRows.value.length) { try { await loadDeploymentRows() } catch { } }
  console.log('[runDeployStage] rows after load:', deploymentRows.value.map((r) => `${r.projectId}:${r.name}`).join(','))
  const targets = deploymentRows.value
    .filter((row) => row.projectId === run.project.id && configComplete(row))
    .sort((a, b) => a.position - b.position || a.id - b.id)
  if (!targets.length) throw new Error(`项目 ${run.project.name} 未配置部署目标，无法执行部署`)
  for (const target of targets) {
    if (run.deployedTargetIds.includes(target.id)) continue
    run.deployTarget = { name: target.name || target.host, host: target.host, username: target.username, remotePath: target.remotePath, command: target.command }
    run.log += `\n==> [${target.name || target.host}] ${target.username}@${target.host}\n`
    try {
      await window.releaseConsole.runDeployment(target.id, (text) => {
        run.log += text
        nextTick(() => modalLogEl.value?.scrollTo({ top: modalLogEl.value.scrollHeight }))
      })
      run.deployedTargetIds.push(target.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : '部署失败'
      run.log += `\n[部署失败] ${target.name || target.host}：${message}\n[后续目标已跳过，可重试继续]`
      throw new Error(`目标 [${target.name || target.host}] 部署失败`)
    }
  }
}

async function runOneClick() {
  const run = oneClickRun.value
  if (!run || run.running) return
  run.failed = false
  run.running = true
  try {
    if (!run.merged1) {
      await mergeFlow(run.project, run.pull)
      run.merged1 = true
    }
    if (!run.direct) {
      if (!run.created2) {
        const existing = await findCreatedPullQuiet(run.project, run.title)
        if (existing) {
          run.created = existing
        } else {
          await window.releaseConsole.createPullRequest({ repository: run.project.repository, token: run.project.token, title: run.title, head: settings.value.prHead, base: settings.value.prBase })
          run.created = await findCreatedPull(run.project, run.title)
        }
        run.created2 = true
      }
      if (!run.merged2) {
        await mergeFlow(run.project, run.created)
        run.merged2 = true
      }
    }
    if (run.withDeploy && !run.deployed) {
      await runDeployStage(run)
      run.deployed = true
    }
    mergeMessage.value = run.withDeploy ? '一键部署完成' : '一键合并完成'
    if (run.withDeploy) notifyDesktop('一键部署完成', `${run.project.name} 全流程成功`)
    await loadPulls()
  } catch (error) {
    run.failed = true
    const message = error instanceof Error ? error.message : '一键操作失败'
    mergeMessage.value = message
    notifyDesktop(run.withDeploy ? '一键部署失败' : '一键合并失败', `${run.project.name}：${message}`)
  } finally {
    run.running = false
    loadDeployHistory()
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

function isSqlFile(filename: unknown) {
  return String(filename ?? '').toLowerCase().endsWith('.sql')
}

function firstLine(text: unknown) {
  return String(text ?? '').split('\n')[0]
}

function shortSha(sha: unknown) {
  return String(sha ?? '').slice(0, 7)
}

function copyCommitSha(commit: any) {
  navigator.clipboard?.writeText(String(commit.sha ?? ''))
  mergeMessage.value = '提交 SHA 已复制'
}

async function selectCommit(commit: any) {
  if (viewingCommit.value?.sha === commit.sha) { exitCommitView(); return }
  const target = selectedPull.value
  if (!target) return
  commitLoading.value = true
  errorMessage.value = ''
  try {
    const detail = await window.releaseConsole.commitDetail({ repository: target.project.repository, token: target.project.token, sha: String(commit.sha) })
    viewingCommit.value = commit
    files.value = detail.files ?? []
    expandedFiles.value = {}
    expandedDirs.value = {}
    activeFileIndex.value = 0
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : '加载提交内容失败' } finally { commitLoading.value = false }
}

function exitCommitView() {
  viewingCommit.value = null
  files.value = prFilesCache.value
  expandedFiles.value = {}
  expandedDirs.value = {}
  activeFileIndex.value = 0
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
  if (!target) return
  const fileRef = viewingCommit.value?.sha ? String(viewingCommit.value.sha) : target.pull.head?.ref
  if (!fileRef) return
  fullFileLoading.value[filename] = true
  try {
    const result = await window.releaseConsole.repositoryFile({ repository: target.project.repository, token: target.project.token, path: filename, ref: fileRef })
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
  if (page === 'logs') loadRequestLogs()
})
watch([requestLogFilter, requestLogStatus], () => { if (activePage.value === 'logs') loadRequestLogs() })
watch([sqlPopVisible, activePage, loadingFiles], () => nextTick(updateSqlPopPosition))
window.addEventListener('resize', updateSqlPopPosition)
window.addEventListener('scroll', updateSqlPopPosition, true)
onMounted(updateSqlPopPosition)
onBeforeUnmount(() => window.removeEventListener('resize', updateSqlPopPosition))

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
            <div><h1>PR</h1><p v-if="selectedPull" class="selected-pr-line">已选<span class="project-badge selected-project-badge" :title="selectedPull.project.repository">{{ selectedPull.project.name }}</span><strong class="selected-pr-ref">#{{ selectedPull.pull.number }} · {{ selectedPull.pull.title }}</strong></p><p v-else>汇总所有项目的开放 PR，点击左侧 PR 查看变更与操作。</p></div>
            <div class="heading-actions">
              <DropdownSelect v-model="pullFilter" class="filter-select" :options="[{ value: 'all', label: '全部项目' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]" />
              <button class="merge-action" :class="{ ready: reviewPassed && testPassed, confirming: mergeConfirming }" :disabled="!selectedPull || selectedEnded" @click="requestMerge">{{ mergeConfirming ? '再次点击确认合并' : reviewPassed && testPassed ? '合并 PR' : '一键合并' }}</button><button v-if="oneClickTarget" class="one-click primary" :class="{ confirming: oneClickAction === 'master' }" :disabled="!!oneClickRun?.running || selectedEnded" @click="requestOneClick('master')">{{ oneClickAction === 'master' ? '再次点击确认' : `一键 ${settings.prBase}` }}</button><button v-if="showOneClickDeploy" class="one-click" :class="{ confirming: oneClickAction === 'deploy' }" :disabled="!!oneClickRun?.running || selectedEnded" @click="requestOneClick('deploy')">{{ oneClickAction === 'deploy' ? '再次点击确认' : '一键部署' }}</button><button :disabled="!projects.length" @click="openCreatePr">创建 PR</button><button :disabled="loadingPulls" @click="refreshPulls">{{ loadingPulls ? '刷新中…' : '刷新' }}</button>
            </div>
          </div>
          <div v-if="!projects.length" class="empty-state">还没有项目，请先在项目页添加。</div>
          <template v-else>
            <div v-if="pullLoadErrors.length" class="load-warning">部分项目 PR 加载失败：{{ pullLoadErrors.join('；') }}</div>
            <div v-if="selectedPull" class="automation-panel">
              <div class="automation-row">
                <span class="automation-label">AI 评审</span>
                <template v-if="evaluatingPr || selectedPull.pull.state === 'ai_reviewing'"><span class="st-running-text">评审中…</span></template>
                <template v-else-if="selectedAiVerdict"><span :class="['verdict-chip', `risk-${selectedAiVerdict.risk_level}`]">{{ selectedAiVerdict.needs_test ? '需要测试' : '无需测试' }} · {{ selectedAiVerdict.risk_level }}</span><span class="automation-note">{{ selectedAiVerdict.reason }}</span><span class="automation-time" v-if="selectedPull.pull.ai_evaluated_at">{{ selectedPull.pull.ai_evaluated_at }}</span></template>
                <span v-else class="automation-note">未评审{{ selectedPull.pull.status_note ? ` · ${selectedPull.pull.status_note}` : '' }}</span>
                <button class="automation-action" :disabled="evaluatingPr || selectedEnded || selectedPull.pull.state === 'ai_reviewing'" @click="reevaluateSelected">{{ selectedAiVerdict ? '重新评审' : '发起评审' }}</button>
              </div>
              <div class="automation-row">
                <span class="automation-label">测试</span>
                <span v-if="runningTest || selectedPull.pull.state === 'testing'" class="st-running-text">运行中…</span>
                <span v-else-if="selectedPull.pull.state === 'test_passed'" class="stat-added">✓ 通过</span>
                <span v-else-if="selectedPull.pull.state === 'test_failed'" class="stat-removed">✗ 失败</span>
                <span v-else-if="testConfigOf(selectedPull.project.id)" class="automation-note">未执行</span>
                <span v-else class="automation-note">未配置测试(部署页配置)</span>
                <button class="automation-action" :disabled="runningTest || selectedEnded || selectedPull.pull.state === 'testing' || !testConfigOf(selectedPull.project.id)" @click="runSelectedTest">发起测试</button>
              </div>
              <div v-if="testSummary" class="test-summary-card"><strong>AI 汇总</strong><p>{{ testSummary }}</p></div>
              <div v-if="testOutput" class="test-output-row"><pre ref="testOutputEl" class="automation-test-output">{{ testOutput }}</pre></div>
              <div class="automation-row">
                <span class="automation-label">人工标记</span>
                <button class="automation-action" :class="{ passed: reviewPassed }" :disabled="!selectedPull || selectedEnded || reviewPassed" @click="approveSelectedPull">{{ reviewPassed ? '✓ 审查已通过' : '标记审查通过' }}</button>
                <button class="automation-action" :class="{ passed: testPassed }" :disabled="!selectedPull || selectedEnded || testPassed" @click="requestTestPassed">{{ testPassed ? '✓ 测试已通过' : '标记测试通过' }}</button>
              </div>
            </div>
            <div class="pr-workspace">
            <aside class="pr-list"><div class="sidebar-tabs pr-list-tabs"><button :class="{ active: pullListTab === 'open' }" @click="pullListTab = 'open'">进行中</button><button :class="{ active: pullListTab === 'ended' }" @click="pullListTab = 'ended'">已结束</button></div><div v-if="!filteredPulls.length && !loadingPulls" class="list-empty">{{ pullListTab === 'open' ? '没有进行中的 PR' : '没有已结束的 PR' }}</div><button v-for="item in filteredPulls" :key="`${item.project.id}-${item.pull.number}`" :class="['pr-item', { selected: isSelected(item) }]" @click="selectPull(item)"><span class="project-badge" :title="item.project.repository">{{ item.project.name }}</span><strong>#{{ item.pull.number }} {{ item.pull.title }}</strong><span v-if="item.pull.state && item.pull.state !== 'open'" :class="['state-badge', stateBadge(item.pull.state).cls]" :title="item.pull.status_note || ''">{{ stateBadge(item.pull.state).label }}</span><span>{{ authorOf(item.pull) }}</span><small class="pr-branches"><span class="branch-chip branch-head" :class="{ 'branch-main': isMainBranch(item.pull.head?.ref || item.pull.head?.label) }" :title="item.pull.head?.label || item.pull.head?.ref">{{ item.pull.head?.ref || item.pull.head?.label || '?' }}</span><span class="branch-arrow">→</span><span class="branch-chip branch-base" :class="{ 'branch-main': isMainBranch(item.pull.base?.ref || item.pull.base?.label) }" :title="item.pull.base?.label || item.pull.base?.ref">{{ item.pull.base?.ref || item.pull.base?.label || '?' }}</span></small><small class="pr-time">{{ formatTime(item.pull.created_at) }}</small></button></aside>
            <section class="code-panel" :class="{ 'has-list': files.length > 0 && !loadingFiles }" :style="files.length > 0 && !loadingFiles ? { gridTemplateColumns: `${fileListWidth}px 5px minmax(0, 1fr)` } : undefined"><aside v-if="files.length > 0 && !loadingFiles" class="file-list"><div class="sidebar-tabs"><button :class="{ active: sidebarTab === 'files' }" class="files-tab" @click="sidebarTab = 'files'">文件<span v-if="sqlFiles.length" class="sql-dot"></span></button><button :class="{ active: sidebarTab === 'commits' }" @click="sidebarTab = 'commits'">提交记录</button></div><div class="file-list-scroll"><template v-if="sidebarTab === 'files'"><button v-for="row in fileTreeRows" :key="row.type + ':' + row.key" :class="['file-item', { dir: row.type === 'dir', active: row.type === 'file' && row.index === activeFileIndex, sql: row.type === 'file' && isSqlFile(row.key) }]" :style="{ paddingLeft: 8 + row.depth * 14 + 'px' }" :title="row.key" @click="row.type === 'dir' ? toggleDir(row.key) : jumpToFile(row.index)"><span v-if="row.type === 'dir'" class="file-toggle">{{ isDirExpanded(row.key) || fileQuery.trim() ? '▾' : '▸' }}</span><span class="file-name">{{ row.name }}</span><span v-if="row.type === 'file' && isSqlFile(row.key)" class="sql-tag">SQL</span><span class="file-stat"><span class="stat-added">+{{ row.added }}</span><span class="stat-removed">-{{ row.removed }}</span></span></button></template><template v-else><button v-for="commit in commits" :key="commit.sha" :class="['commit-item', { active: viewingCommit?.sha === commit.sha }]" :title="firstLine(commit.commit?.message)" @click="selectCommit(commit)"><span class="commit-message">{{ firstLine(commit.commit?.message) }}</span><span class="commit-meta"><span>{{ commit.commit?.author?.name || '未知提交人' }}</span><span class="commit-sha" title="点击复制 SHA" @click.stop="copyCommitSha(commit)">{{ shortSha(commit.sha) }}</span><span class="history-time">{{ formatTime(commit.commit?.author?.date) }}</span></span></button><div v-if="!commits.length" class="settings-empty">暂无提交记录</div></template></div></aside><div v-if="files.length > 0 && !loadingFiles" class="resize-handle" @mousedown="startResize"></div><div class="files-main"><div v-if="loadingFiles" class="empty-state loading-state"><LoadingAnim /><p>加载文件中…</p></div><div v-else-if="commitLoading" class="empty-state loading-state"><LoadingAnim /><p>加载提交内容…</p></div><div v-else-if="!selectedPull" class="empty-state">选择一个 PR 查看变更与操作</div><div v-else-if="!files.length" class="empty-state">该 PR 没有可展示的文件</div><template v-else><div v-if="prDescription" class="pr-description" :class="{ open: prDescriptionOpen }"><button class="pr-description-toggle" type="button" @click="prDescriptionOpen = !prDescriptionOpen">{{ prDescriptionOpen ? '▾' : '▸' }} PR 描述</button><pre v-if="prDescriptionOpen" class="pr-description-body">{{ prDescription }}</pre></div><div class="files-toolbar"><span v-if="viewingCommit" class="commit-viewing">正在查看提交 <span class="commit-sha">{{ shortSha(viewingCommit.sha) }}</span> · {{ files.length }} 个文件<button type="button" class="commit-back" @click="exitCommitView">← 返回 PR 文件</button></span><span v-else>{{ fileQuery.trim() ? `${matchedCount}/${files.length} 个文件` : `${files.length} 个文件` }}</span><span class="toolbar-stats"><span class="stat-added">+{{ totalStats.added }}</span><span class="stat-removed">-{{ totalStats.removed }}</span></span><span class="toolbar-spacer"></span><input v-model="fileQuery" class="file-search" placeholder="搜索文件名" /><button @click="setAllFilesExpanded(true)">全部展开</button><button @click="setAllFilesExpanded(false)">全部收起</button></div><div ref="filesScrollEl" class="files-scroll" @scroll="onFilesScroll"><div v-for="(file, index) in files" :id="`pr-file-card-${index}`" :key="file.filename" v-show="fileMatches(file.filename)" :data-index="index" class="file-card"><button class="file-card-header" :class="{ 'sql-card': isSqlFile(file.filename) }" @click="toggleFile(file.filename)"><span class="file-toggle">{{ isFileExpanded(file.filename) ? '▾' : '▸' }}</span><span class="file-name" :title="file.filename">{{ file.filename }}</span><span v-if="isSqlFile(file.filename)" class="sql-tag">SQL</span><span class="file-stat"><span class="stat-added">+{{ fileStats[index]?.added ?? 0 }}</span><span class="stat-removed">-{{ fileStats[index]?.removed ?? 0 }}</span></span><span class="copy-btn" title="复制 diff" @click.stop="copyPatch(file)">复制</span><span class="copy-btn full-toggle" :class="{ active: isFullFileView(file.filename) }" title="查看完整文件 / 切回 diff" @click.stop="toggleFullFile(file)">{{ isFullFileView(file.filename) ? '返回 diff' : '完整文件' }}</span></button><pre v-if="isFileExpanded(file.filename) && isFullFileView(file.filename)" class="code-view file-diff full-file">{{ fullFileLoading[file.filename] ? '加载中…' : fullFileContents[file.filename] || '无法加载文件内容' }}</pre><pre v-else-if="isFileExpanded(file.filename)" class="code-view file-diff"><code><span v-for="(line, lineIndex) in fileDiffs[index]" :key="lineIndex" :class="['code-line', `line-${line.kind}`]"><span class="line-prefix">{{ line.prefix }}</span><span v-html="line.html"></span></span></code></pre></div></div></template></div></section>
          </div>
          </template>
        </section>
        <section v-else-if="activePage === 'deployments'" class="page">
          <div class="page-heading"><div><h1>部署</h1><p>管理各项目的部署目标，支持多服务器顺序执行与单台执行。</p></div></div>
          <div v-if="!projects.length" class="empty-state">还没有项目，请先在项目页添加。</div>
          <div v-else class="deploy-groups">
            <div v-for="group in deploymentGroups" :key="group.project.id" class="deploy-group">
              <div class="deploy-group-header">
                <strong>{{ group.project.name }}</strong>
                <span class="muted">{{ group.targets.length ? `${group.targets.filter(configComplete).length}/${group.targets.length} 台可部署` : '未配置目标' }}</span>
                <span class="toolbar-spacer"></span>
                <div class="row-actions">
                  <button class="primary" :disabled="!group.targets.some(configComplete) || deployLog.running" @click="runGroupDeployment(group)">{{ deployLog.running && deployLog.projectId === group.project.id ? '部署中…' : '全部执行' }}</button>
                  <button @click="openAddTarget(group)">添加目标</button>
                  <button :class="{ primary: !!testConfigOf(group.project.id) }" @click="openTestConfig(group)">{{ testConfigOf(group.project.id) ? '测试配置' : '配置测试' }}</button>
                </div>
              </div>
              <div v-if="group.targets.length" class="deploy-target-rows">
                <div v-for="target in group.targets" :key="target.id" class="deploy-target-row">
                  <span class="target-name">{{ target.name || target.host }}</span>
                  <code class="target-host">{{ target.username }}@{{ target.host }}</code>
                  <span class="target-path">{{ target.remotePath || '—' }}</span>
                  <code class="target-cmd">{{ target.command || '—' }}</code>
                  <div class="row-actions">
                    <button class="move-btn" :disabled="deployLog.running || group.targets.indexOf(target) === 0" title="上移" @click="moveTarget(target, -1)">↑</button>
                    <button class="move-btn" :disabled="deployLog.running || group.targets.indexOf(target) === group.targets.length - 1" title="下移" @click="moveTarget(target, 1)">↓</button>
                    <button class="primary" :disabled="!configComplete(target) || deployLog.running" @click="runTargetDeployment(target)">执行</button>
                    <button @click="openEditTarget(target)">编辑</button>
                    <button class="danger" @click="askDeleteTarget(target)">删除</button>
                  </div>
                </div>
              </div>
              <div v-else class="deploy-target-empty">点击右上角“添加目标”配置第一台服务器。</div>
            </div>
          </div>
          <div v-if="deployLog.projectId" class="settings-section deploy-log-section">
            <h2>部署日志 · {{ deployLog.projectName }}<span v-if="deployLog.running" class="deploy-running">执行中…</span></h2>
            <div v-if="deployLog.aiSummary" class="ai-summary-card"><strong>AI 汇总</strong><p>{{ deployLog.aiSummary }}</p></div>
            <pre ref="deployOutputEl" class="deploy-output">{{ deployLog.output || '等待输出…' }}</pre>
          </div>
          <div class="settings-section">
            <h2>部署历史</h2>
            <div class="history-toolbar"><DropdownSelect v-model="historyFilter" class="history-filter" :options="[{ value: 'all', label: '全部项目' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]" /></div>
            <div v-if="!filteredHistory.length" class="settings-empty">暂无部署记录。</div>
            <div v-for="entry in filteredHistory" :key="entry.id" :class="['history-row', { active: activeHistoryId === entry.id }]" @click="showHistory(entry)">
              <span :class="entry.success ? 'stat-added' : 'stat-removed'">{{ entry.success ? '✓' : '✗' }}</span>
              <span class="history-name">{{ entry.projectName }}<template v-if="entry.kind === 'test'"> · PR#{{ entry.prNumber }} 测试</template><template v-else-if="entry.targetName"> · {{ entry.targetName }}</template></span>
              <span class="history-host">{{ entry.host }}</span>
              <span class="history-time">{{ entry.createdAt }}</span>
            </div>
          </div>
        </section>
        <section v-else-if="activePage === 'logs'" class="page">
          <div class="page-heading">
            <div><h1>日志</h1><p>Gitee 接口调用记录(保留最近 500 条)。</p></div>
            <div class="heading-actions">
              <DropdownSelect v-model="requestLogFilter" class="filter-select" :options="[{ value: 'all', label: '全部项目' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]" />
              <DropdownSelect v-model="requestLogStatus" class="filter-select" :options="[{ value: 'all', label: '全部状态' }, { value: 'ok', label: '仅成功' }, { value: 'error', label: '仅失败' }]" />
              <button :disabled="loadingRequestLogs" @click="loadRequestLogs">{{ loadingRequestLogs ? '加载中…' : '刷新' }}</button>
            </div>
          </div>
          <div class="settings-section log-section">
            <div v-if="!requestLogRows.length && !loadingRequestLogs" class="settings-empty">暂无接口日志。</div>
            <div v-for="row in requestLogRows" :key="row.id" :class="['log-row', { error: !row.ok }]" title="点击查看详情" @click="requestLogDetail = row">
              <span class="log-time">{{ row.createdAt }}</span>
              <span class="log-project">{{ row.projectName }}</span>
              <code class="log-endpoint">{{ row.method }} {{ row.endpoint }}</code>
              <span :class="row.ok ? 'stat-added' : 'stat-removed'">{{ row.ok ? `✓ ${row.status}` : `✗ ${row.status}` }}</span>
              <span class="log-duration">{{ row.durationMs }}ms</span>
              <span class="log-error" :title="row.errorMessage">{{ row.errorMessage }}</span>
            </div>
          </div>
        </section>
        <section v-else class="page">
          <div class="page-heading"><div><h1>设置</h1><p>应用配置按页签分组管理。</p></div></div>
          <div class="settings-tabs">
            <button :class="{ active: settingsTab === 'general' }" @click="settingsTab = 'general'">通用</button>
            <button :class="{ active: settingsTab === 'automation' }" @click="settingsTab = 'automation'">自动化</button>
            <button :class="{ active: settingsTab === 'ai' }" @click="settingsTab = 'ai'">AI 模型</button>
            <button :class="{ active: settingsTab === 'projects' }" @click="settingsTab = 'projects'">项目管理</button>
            <button :class="{ active: settingsTab === 'about' }" @click="settingsTab = 'about'">关于</button>
          </div>
          <form v-if="settingsTab === 'general'" class="settings-section" @submit.prevent="saveAppSettings">
            <h2>PR 与合并</h2>
            <label>PR 来源分支(head)<input v-model="settings.prHead" placeholder="dock" /></label>
            <label>PR 目标分支(base)<input v-model="settings.prBase" placeholder="master" /></label>
            <label>合并方式<DropdownSelect v-model="settings.mergeMethod" :options="[{ value: 'merge', label: 'merge · 保留完整历史' }, { value: 'rebase', label: 'rebase · 变基合并' }, { value: 'squash', label: 'squash · 压缩为单个提交' }]" /></label>
            <button class="primary" type="submit">保存设置</button>
          </form>
          <form v-else-if="settingsTab === 'automation'" class="settings-section" @submit.prevent="saveAppSettings">
            <h2>自动化</h2>
            <label>全局自动化<DropdownSelect v-model="settings.automationEnabled" :options="[{ value: '0', label: '关闭' }, { value: '1', label: '开启' }]" /></label>
            <label>轮询间隔(秒,最小 60)<input v-model="settings.pollIntervalSec" type="number" min="60" step="10" /></label>
            <div class="sync-project-list">
              <div v-for="row in syncStatusRows" :key="row.projectId" class="project-row">
                <div class="project-row-info"><strong>{{ row.name }}</strong><span>{{ row.lastSyncAt ? `上次同步 ${row.lastSyncAt}` : '未同步' }}<template v-if="row.lastError"> · <em class="sync-error">{{ row.lastError }}</em></template></span></div>
                <div class="row-actions"><button :class="{ primary: !row.enabled }" @click="toggleProjectSync(row)">{{ row.enabled ? '暂停轮询' : '恢复轮询' }}</button></div>
              </div>
            </div>
            <button class="primary" type="submit">保存设置</button>
          </form>
          <form v-else-if="settingsTab === 'ai'" class="settings-section" @submit.prevent="saveAppSettings">
            <h2>AI 模型</h2>
            <label>模型 Base URL<input v-model="settings.aiBaseUrl" placeholder="https://api.deepseek.com/v1" /></label>
            <label>API Key<input v-model="settings.aiApiKey" type="password" autocomplete="off" placeholder="sk-..." /></label>
            <label>模型名<input v-model="settings.aiModel" placeholder="deepseek-chat" /></label>
            <label>评估提示词(留空用默认,支持 <code v-pre>{{title}}</code>/<code v-pre>{{body}}</code>/<code v-pre>{{files}}</code>/<code v-pre>{{diff}}</code> 变量)<textarea v-model="settings.aiPrompt" rows="5" class="ai-prompt"></textarea></label>
            <details class="default-prompt-details">
              <summary>查看默认提示词{{ settings.aiPrompt ? '(当前使用自定义)' : '(当前生效)' }}</summary>
              <pre class="default-prompt-view" v-pre>你是代码评审助手。根据以下 PR 信息判断该变更是否需要运行自动化测试。
规则:.sql 文件变更一律需要测试;仅文档/注释/格式化改动通常不需要。
PR 标题:{{title}}
PR 描述:{{body}}
变更文件:
{{files}}
关键 diff:
{{diff}}
仅输出 JSON:{"needs_test": true|false, "reason": "一句话理由", "risk_level": "low"|"medium"|"high"}</pre>
            </details>
            <div class="ai-test-row"><button type="button" :disabled="aiTesting" @click="testAi">{{ aiTesting ? '测试中…' : '测试连接' }}</button><span v-if="aiTestMessage" :class="aiTestMessage.startsWith('连接成功') ? 'stat-added' : 'stat-removed'">{{ aiTestMessage }}</span></div>
            <button class="primary" type="submit">保存设置</button>
          </form>
          <div v-else-if="settingsTab === 'projects'" class="settings-section">
            <h2>项目管理</h2>
            <div v-if="!projects.length" class="settings-empty">暂无项目，请先在项目页添加。</div>
            <div v-for="project in projects" :key="project.id" class="project-row">
              <div class="project-row-info"><strong>{{ project.name }}</strong><span>{{ project.repository }}</span></div>
              <div class="row-actions"><button @click="startEditProject(project)">编辑</button><button class="danger" @click="deleteProject(project)">删除</button></div>
            </div>
          </div>
          <div v-else-if="settingsTab === 'about'" class="settings-section">
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
      <form class="modal" @submit.prevent="submitCreatePr"><h2>创建 PR</h2><div v-if="createPrError" class="error-message">{{ createPrError }}</div><label>项目<DropdownSelect v-model="createPrForm.projectId" :options="projects.map((project) => ({ value: project.id, label: `${project.name}（${project.repository}）` }))" /></label><label>标题<input v-model="createPrForm.title" placeholder="PR 标题" /></label><label>来源分支(head)<input v-model="createPrForm.head" placeholder="dock" /></label><label>目标分支(base)<input v-model="createPrForm.base" placeholder="master" /></label><div class="modal-actions"><button type="button" @click="showCreatePr = false">取消</button><button class="primary" type="submit" :disabled="creatingPr">{{ creatingPr ? '创建中…' : '创建' }}</button></div></form>
    </div>
    <div v-if="configModal" class="modal-backdrop" @click.self="configModal = false">
      <form class="modal" @submit.prevent="saveTarget"><h2>{{ configForm.id ? '编辑部署目标' : '添加部署目标' }}</h2><div v-if="configFormError" class="error-message">{{ configFormError }}</div><label>项目<input :value="configForm.projectName" disabled /></label><label>目标别名<input v-model="configForm.name" placeholder="如 web-1 / staging" /></label><label>服务器地址<span class="combo"><input v-model="configForm.host" placeholder="example.com" @focus="showHostSuggestions = true" @blur="showHostSuggestions = false" /><span v-if="showHostSuggestions && hostSuggestions.length" class="combo-menu"><button type="button" v-for="host in hostSuggestions" :key="host" @mousedown.prevent="pickHost(host)">{{ host }}</button></span></span></label><label>SSH 用户<span class="combo"><input v-model="configForm.username" placeholder="deploy" @focus="showUserSuggestions = true" @blur="showUserSuggestions = false" /><span v-if="showUserSuggestions && userSuggestions.length" class="combo-menu"><button type="button" v-for="username in userSuggestions" :key="username" @mousedown.prevent="pickUser(username)">{{ username }}</button></span></span></label><label>远程目录<input v-model="configForm.remotePath" placeholder="/srv/app" /></label><label>部署命令<input v-model="configForm.command" placeholder="git pull && ./deploy.sh" /></label><div class="modal-actions"><button type="button" @click="configModal = false">取消</button><button class="primary" type="submit" :disabled="savingConfig">{{ savingConfig ? '保存中…' : '保存' }}</button></div></form>
    </div>
    <div v-if="sqlPopVisible && activePage === 'pulls'" class="sql-pop" title="点击定位第一个 SQL 文件" :style="sqlPopStyle" @click="locateFirstSql()"><span class="sql-pop-text">有 SQL 变动：{{ sqlFiles.map((file) => file.filename.split('/').pop()).join('、') }}</span></div>
    <div v-if="toastMessage" class="toast">{{ toastMessage }}</div>
    <div v-if="testModal" class="modal-backdrop" @click.self="testModal = false">
      <form class="modal test-config-modal" @submit.prevent="saveTestConfig"><h2>测试配置 · {{ testForm.projectName }}</h2><div v-if="testFormError" class="error-message">{{ testFormError }}</div>
        <label>服务器模式<DropdownSelect v-model="testForm.serverMode" :options="[{ value: 'ssh', label: 'SSH 远程' }, { value: 'local', label: '本地' }]" /></label>
        <template v-if="testForm.serverMode === 'ssh'">
          <label>服务器地址<span class="combo"><input v-model="testForm.host" placeholder="example.com" @focus="showHostSuggestions = true" @blur="showHostSuggestions = false" /><span v-if="showHostSuggestions && hostSuggestions.length" class="combo-menu"><button type="button" v-for="host in hostSuggestions" :key="host" @mousedown.prevent="testForm.host = host; testForm.username = deploymentServers.find((server) => server.host === host)?.username || testForm.username; showHostSuggestions = false">{{ host }}</button></span></span></label>
          <label>SSH 用户<input v-model="testForm.username" placeholder="deploy" /></label>
        </template>
        <label>测试项目位置(支持 {project} {pr} 变量)<input v-model="testForm.workdirTemplate" placeholder="~/TEST/{project}_{pr}" /></label>
        <label>源项目目录(测试副本从此复制,含 .git 与已装依赖;留空回退部署目标目录)<input v-model="testForm.sourcePath" placeholder="如 /www/wwwroot/business" /></label>
        <div class="command-options">
          <div class="command-options-head"><span>测试命令选项(第一条为默认)</span><button type="button" @click="addCommandOption">+ 添加</button></div>
          <div v-for="(option, index) in testForm.commandOptions" :key="index" class="command-option-row">
            <input v-model="option.label" placeholder="名称,如 全量" />
            <input v-model="option.command" placeholder="vendor/bin/phpunit tests" />
            <button type="button" class="danger" :disabled="testForm.commandOptions.length <= 1" @click="removeCommandOption(index)">删</button>
          </div>
        </div>
        <label class="checkbox-label"><input v-model="testForm.aiDecides" type="checkbox" />由 AI 根据变更从选项中选择</label>
        <label v-if="testForm.aiDecides">AI 提示词(留空用默认)<textarea v-model="testForm.aiPrompt" rows="3"></textarea></label>
        <label>超时(秒)<input v-model="testForm.timeoutSec" type="number" min="30" step="30" /></label>
        <div class="modal-actions"><button type="button" @click="testModal = false">取消</button><button class="primary" type="submit" :disabled="savingTest">{{ savingTest ? '保存中…' : '保存' }}</button></div>
      </form>
    </div>
    <div v-if="requestLogDetail" class="modal-backdrop" @click.self="requestLogDetail = null">
      <div class="modal log-detail-modal">
        <h2>接口日志详情</h2>
        <div class="log-detail-grid">
          <span>时间</span><code>{{ requestLogDetail.createdAt }}</code>
          <span>项目</span><code>{{ requestLogDetail.projectName }}</code>
          <span>请求</span><code>{{ requestLogDetail.method }} {{ requestLogDetail.endpoint }}</code>
          <span>状态</span><code :class="requestLogDetail.ok ? 'stat-added' : 'stat-removed'">{{ requestLogDetail.ok ? `成功 (${requestLogDetail.status})` : `失败 (${requestLogDetail.status || '网络错误'})` }}</code>
          <span>耗时</span><code>{{ requestLogDetail.durationMs }}ms</code>
        </div>
        <div v-if="requestLogDetail.errorMessage" class="error-message log-detail-error">{{ requestLogDetail.errorMessage }}</div>
        <div class="modal-actions"><button class="primary" @click="requestLogDetail = null">关闭</button></div>
      </div>
    </div>
    <div v-if="oneClickRun" class="modal-backdrop">
      <div class="modal one-click-modal">
        <h2>{{ oneClickRun.direct || oneClickRun.withDeploy ? '一键部署' : `一键 ${settings.prBase}` }}</h2>
        <ol class="progress-steps">
          <li v-for="(step, index) in oneClickSteps" :key="index" :class="step.state"><span class="step-dot">{{ step.state === 'done' ? '✓' : step.state === 'failed' ? '✗' : index + 1 }}</span>{{ step.label }}</li>
        </ol>
        <div v-if="oneClickRun.deployTarget" class="deploy-target-info">部署目标：<code>{{ oneClickRun.deployTarget.name || oneClickRun.deployTarget.host }}</code><span class="target-sep">·</span><code>{{ oneClickRun.deployTarget.username }}@{{ oneClickRun.deployTarget.host }}</code><span class="target-sep">·</span>远程目录：<code>{{ oneClickRun.deployTarget.remotePath }}</code></div>
        <div v-if="oneClickRun.deployTarget" class="deploy-target-info">执行命令：<code class="deploy-command-line">ssh {{ oneClickRun.deployTarget.username }}@{{ oneClickRun.deployTarget.host }} 'cd {{ oneClickRun.deployTarget.remotePath }} && {{ oneClickRun.deployTarget.command }}'</code></div>
        <div v-if="oneClickRun.lastDeploy" class="deploy-target-info">上次部署：<code>{{ oneClickRun.lastDeploy.createdAt }}</code><span class="target-sep">·</span>结果：<code>{{ oneClickRun.lastDeploy.success ? '成功' : '失败' }}</code></div>
        <pre v-if="oneClickRun.withDeploy" ref="modalLogEl" class="deploy-output">{{ oneClickRun.log || '等待部署输出…' }}</pre>
        <div class="modal-actions"><button v-if="oneClickRun.failed" class="primary" :disabled="oneClickRun.running" @click="runOneClick()">重试</button><button :disabled="oneClickRun.running" @click="oneClickRun = null">{{ oneClickRun.running ? '执行中…' : '关闭' }}</button></div>
      </div>
    </div>
    <div v-if="confirmMessage" class="modal-backdrop" @click.self="cancelConfirmation"><div class="confirm-modal"><h3>请确认操作</h3><p>{{ confirmMessage }}</p><div class="modal-actions"><button @click="cancelConfirmation">取消</button><button class="primary" @click="acceptConfirmation">确认</button></div></div></div>
    <div v-if="editForm.id !== 0" class="modal-backdrop" @click.self="editForm.id = 0">
      <form class="modal" @submit.prevent="saveProjectEdit"><h2>编辑项目</h2><div v-if="editFormError" class="error-message">{{ editFormError }}</div><label>项目名称<input v-model="editForm.name" /></label><label>仓库地址<input v-model="editForm.repository" placeholder="owner/repository" /></label><label>Gitee Token<input v-model="editForm.token" type="password" autocomplete="off" /></label><div class="modal-actions"><button type="button" @click="editForm.id = 0">取消</button><button class="primary" type="submit" :disabled="savingEdit">{{ savingEdit ? '保存中…' : '保存' }}</button></div></form>
    </div>
  </div>
</template>
