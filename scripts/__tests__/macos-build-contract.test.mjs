import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const json = name => JSON.parse(readFileSync(path.join(root, name), 'utf8'))

test('Mac bundles and native chrome do not change Windows defaults or window identity', () => {
  const base = json('src-tauri/tauri.conf.json')
  const mac = json('src-tauri/tauri.macos.conf.json')
  assert.deepEqual(base.bundle.targets, ['nsis'])
  assert.equal(base.bundle.windows.nsis.installMode, 'currentUser')
  assert.equal(base.identifier, 'com.console.2api')
  assert.deepEqual(mac.bundle.targets, ['app', 'dmg'])
  assert.equal(mac.bundle.macOS.minimumSystemVersion, '13.0')
  assert.equal(mac.bundle.macOS.infoPlist, 'Info.macos.plist')
  assert(existsSync(path.join(root, 'src-tauri', mac.bundle.macOS.infoPlist)))
  assert.deepEqual(mac.app.windows, base.app.windows.map(window => ({ ...window, decorations: true })))
  assert.equal(mac.identifier, undefined)
  for (const icon of mac.bundle.icon) assert(existsSync(path.join(root, 'src-tauri', icon)))
})

test('Mac test packages use ad-hoc signing without weakening Windows updater signing', () => {
  const base = json('src-tauri/tauri.conf.json')
  const local = json('src-tauri/tauri.macos.test.conf.json')
  assert.equal(base.bundle.createUpdaterArtifacts, true)
  assert.equal(local.bundle.createUpdaterArtifacts, false)
  assert.equal(local.bundle.macOS.signingIdentity, '-')
  assert.equal(local.app, undefined)
})

test('Mac-only commands stop on other hosts without starting a build', { skip: process.platform === 'darwin' }, () => {
  for (const script of ['scripts/build-macos.mjs', 'scripts/test-macos.mjs']) {
    const result = spawnSync(process.execPath, [path.join(root, script)], { cwd: root, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /macOS|Mac/)
    assert.equal(result.stdout, '')
  }
})
