import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

if (process.platform !== 'darwin') {
  console.error('Run the packaged application smoke check on macOS. It cannot run on Windows.')
  process.exit(1)
}

assert.equal(process.argv.length, 3, 'Usage: node scripts/smoke-macos.mjs <application.app>')
const application = resolve(process.argv[2])
assert(application.endsWith('.app'), 'Expected one .app bundle path')
const plist = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(application, 'Contents/Info.plist')], { encoding: 'utf8' })
assert(!plist.error && plist.status === 0, plist.error?.message || plist.stderr || 'Cannot read CFBundleExecutable')
const executable = plist.stdout.trim()
assert(executable && basename(executable) === executable, 'Invalid CFBundleExecutable')

// Refuse to attach to a pre-existing proxy, including another application instance.
const probe = createServer()
await new Promise((accept, reject) => {
  probe.once('error', reject)
  probe.listen(18765, '127.0.0.1', accept)
})
await new Promise((accept, reject) => probe.close(error => error ? reject(error) : accept()))

const fixture = mkdtempSync(join(tmpdir(), 'console2api-mac-smoke-'))
const env = {
  ...process.env,
  HOME: fixture, USERPROFILE: fixture, APPDATA: fixture, LOCALAPPDATA: fixture,
  CODEX_HOME: join(fixture, '.codex'), CLAUDE_CONFIG_DIR: join(fixture, '.claude'), DSH_HOME: join(fixture, '.dsh'),
  CONSOLE2API_LEDGER_DIR: join(fixture, 'ledger'),
}
delete env.USAGE_LEDGER_REAL_DATA_AUDIT
delete env.MONITOR_ACCOUNT_DIAGNOSTIC_COPY

let child
let finished
let exited = false
let exitResult
let interrupted
const onSignal = signal => { interrupted = new Error(`Smoke check interrupted by ${signal}`) }
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)
let receipt
try {
  child = spawn(join(application, 'Contents/MacOS', executable), ['--background'], { env, stdio: 'inherit' })
  finished = new Promise(accept => {
    child.once('error', error => { exited = true; exitResult = error.message; accept() })
    child.once('exit', (code, signal) => { exited = true; exitResult = `code=${code}, signal=${signal}`; accept() })
  })
  const assertAlive = () => {
    if (interrupted) throw interrupted
    assert(!exited, `Application exited before smoke check completed: ${exitResult}`)
  }
  const deadline = Date.now() + 30_000
  let ready = false
  while (Date.now() < deadline) {
    assertAlive()
    let response
    try {
      response = await fetch('http://127.0.0.1:18765/', { signal: AbortSignal.timeout(Math.min(1000, deadline - Date.now())) })
    } catch {
      await delay(250)
      continue
    }
    assert.equal(response.status, 502, 'Expected the local proxy to reject a missing target')
    const body = await response.json()
    assert.equal(body.code, -1)
    assert.match(body.message, /X-Target-Base/)
    const owner = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(child.pid), '-iTCP:18765', '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 5000 })
    assert(!owner.error && owner.status === 0, owner.error?.message || owner.stderr || 'Spawned application does not own proxy port 18765')
    ready = true
    break
  }
  assert(ready, 'Local proxy did not become ready within 30 seconds')
  await delay(3000)
  assertAlive()
  receipt = { arch: process.arch, startup: 'passed', proxy: 'owned-pid-missing-target-rejected', guiInteraction: 'not-checked' }
} finally {
  try {
    if (child?.pid && !exited) {
      child.kill('SIGTERM')
      await Promise.race([finished, delay(5000, undefined, { ref: false })])
      if (!exited) {
        child.kill('SIGKILL')
        await Promise.race([finished, delay(5000, undefined, { ref: false })])
      }
      assert(exited, `Cannot stop owned application PID ${child.pid}; isolated directory retained at ${fixture}`)
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    if (!child?.pid || exited) rmSync(fixture, { recursive: true })
  }
}
console.log(JSON.stringify(receipt))
