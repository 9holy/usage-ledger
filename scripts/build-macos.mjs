import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

if (process.platform !== 'darwin') {
  console.error('macOS is required to build and verify the Mac application bundle. Windows builds are unchanged.')
  process.exit(1)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const env = { ...process.env, APPLE_SIGNING_IDENTITY: '-' }
// This command builds test packages, never submits credentials to Apple's notary service.
for (const key of ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_PATH', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']) delete env[key]

function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `${command} failed (${result.status})`)
  return result.stdout?.trim()
}

const args = process.argv.slice(2)
assert(args.length === 0 || (args.length === 2 && args[0] === '--target'), 'Usage: build-macos.mjs [--target <Mac target>]')
const target = args[1] || 'universal-apple-darwin'
const expectedArchitectures = {
  'universal-apple-darwin': ['arm64', 'x86_64'],
  'aarch64-apple-darwin': ['arm64'],
  'x86_64-apple-darwin': ['x86_64'],
}[target]
assert(expectedArchitectures, 'Only universal, Apple Silicon and Intel Mac targets are supported')
const targets = run('rustup', ['target', 'list', '--installed'], true).split(/\s+/)
const requiredTargets = target === 'universal-apple-darwin' ? ['aarch64-apple-darwin', 'x86_64-apple-darwin'] : [target]
for (const required of requiredTargets) {
  assert(targets.includes(required), `Install the Rust target first: rustup target add ${required}`)
}
const metadata = JSON.parse(run('cargo', ['metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--no-deps', '--format-version', '1', '--locked'], true))
run(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--target', target, '--bundles', 'app,dmg', '--config', 'src-tauri/tauri.macos.test.conf.json', '--', '--locked'])

const bundles = join(metadata.target_directory, target, 'release/bundle')
const application = join(bundles, 'macos', `${config.productName}.app`)
const executable = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(application, 'Contents/Info.plist')], true)
const localTransport = run('/usr/libexec/PlistBuddy', ['-c', 'Print :NSAppTransportSecurity:NSExceptionDomains:127.0.0.1:NSExceptionAllowsInsecureHTTPLoads', join(application, 'Contents/Info.plist')], true)
assert.equal(localTransport, 'true', 'The packaged WebView must be able to reach its local proxy')
const architectures = run('/usr/bin/lipo', ['-archs', join(application, 'Contents/MacOS', executable)], true).split(/\s+/).sort()
assert.deepEqual(architectures, expectedArchitectures, 'The application must contain exactly the requested Mac architectures')
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application])
const diskImages = readdirSync(join(bundles, 'dmg')).filter(name => name.endsWith('.dmg') && name.includes(config.version))
assert.equal(diskImages.length, 1, 'Expected one current-version DMG for the requested target')
run('/usr/bin/hdiutil', ['verify', join(bundles, 'dmg', diskImages[0])])
console.log(JSON.stringify({ version: config.version, target, application, diskImage: join(bundles, 'dmg', diskImages[0]), architectures, signing: 'ad-hoc', notarized: false }, null, 2))
