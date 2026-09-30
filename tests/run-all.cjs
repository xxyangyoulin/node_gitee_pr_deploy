const { spawn, spawnSync } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')

const unitTests = ['poller.test.cjs', 'ai.test.cjs']
const tests = ['nav.test.cjs', 'pulls.test.cjs', 'pulls-overflow.test.cjs', 'deploy.test.cjs', 'settings.test.cjs', 'pr-files.test.cjs', 'branches.test.cjs', 'logs.test.cjs']
const PORT = process.env.TEST_PORT || 5299
const root = path.join(__dirname, '..')

function waitForServer(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = () => {
      const req = http.get(url, (res) => { res.resume(); resolve() })
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) reject(new Error('dev server 启动超时'))
        else setTimeout(poll, 300)
      })
    }
    poll()
  })
}

;(async () => {
  const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' })
  try {
    await waitForServer(`http://localhost:${PORT}/`)
    const failed = []
    for (const test of unitTests) {
      console.log(`\n=== ${test} ===`)
      const result = spawnSync('node', [path.join(__dirname, test)], { stdio: 'inherit', cwd: path.join(__dirname, '..') })
      if (result.status !== 0) failed.push(test)
    }
    for (const test of tests) {
      console.log(`\n=== ${test} ===`)
      const result = spawnSync('node', [path.join(__dirname, test)], { stdio: 'inherit', env: { ...process.env, BASE_URL: `http://localhost:${PORT}` } })
      if (result.status !== 0) failed.push(test)
    }
    if (failed.length) { console.error(`\n失败的用例: ${failed.join(', ')}`); process.exitCode = 1 }
    else console.log('\n全部用例通过')
  } finally {
    vite.kill('SIGTERM')
  }
})()
