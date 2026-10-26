import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

if (process.platform !== 'darwin') {
  console.error('Run this command on a Mac. It does not simulate macOS on Windows.')
  process.exit(1)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' })
  if (result.error || result.status !== 0) throw new Error(result.error?.message || `${command} failed (${result.status})`)
}
run(process.execPath, [join(root, 'node_modules/vue-tsc/bin/vue-tsc.js'), '-b'])
run(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run',
  'src/features/desktop/__tests__/AppNativeChrome.spec.ts',
  'src/features/desktop/__tests__/DesktopTitleBar.spec.ts',
  'src/features/desktop/__tests__/desktopChromeLayout.spec.ts',
  'src/api/cliproxy/__tests__/cpaData.spec.ts',
  'src/api/cliproxy/__tests__/cpaTokenSemantics.spec.ts'])

const home = homedir()
const fixture = mkdtempSync(join(tmpdir(), 'usage-ledger-mac-tests-'))
const env = {
  ...process.env,
  CARGO_HOME: process.env.CARGO_HOME || join(home, '.cargo'),
  RUSTUP_HOME: process.env.RUSTUP_HOME || join(home, '.rustup'),
  HOME: fixture, USERPROFILE: fixture, APPDATA: fixture, LOCALAPPDATA: fixture,
  CODEX_HOME: join(fixture, '.codex'), CLAUDE_CONFIG_DIR: join(fixture, '.claude'), DSH_HOME: join(fixture, '.dsh'),
  CONSOLE2API_LEDGER_DIR: join(fixture, 'ledger'),
}
delete env.USAGE_LEDGER_REAL_DATA_AUDIT
delete env.MONITOR_ACCOUNT_DIAGNOSTIC_COPY
try {
  run('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--', '--test-threads=1'], env)
  console.log('Mac host tests passed with isolated account and ledger directories. Packaged GUI behavior still needs a manual check on each architecture.')
} finally {
  rmSync(fixture, { recursive: true })
}
