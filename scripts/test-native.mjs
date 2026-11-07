import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// Native tests must never discover the developer's real accounts or databases.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const originalHome = homedir()
const fixture = mkdtempSync(join(tmpdir(), 'usage-ledger-native-tests-'))
const env = {
  ...process.env,
  CARGO_HOME: process.env.CARGO_HOME || join(originalHome, '.cargo'),
  RUSTUP_HOME: process.env.RUSTUP_HOME || join(originalHome, '.rustup'),
  HOME: fixture, USERPROFILE: fixture, APPDATA: fixture, LOCALAPPDATA: fixture,
  CODEX_HOME: join(fixture, '.codex'), CLAUDE_CONFIG_DIR: join(fixture, '.claude'), DSH_HOME: join(fixture, '.dsh'),
  CONSOLE2API_LEDGER_DIR: join(fixture, 'ledger'),
}
delete env.USAGE_LEDGER_REAL_DATA_AUDIT
delete env.MONITOR_ACCOUNT_DIAGNOSTIC_COPY
for (const key of ['COCKPIT_TOOLS_DATA_DIR', 'COCKPIT_TOOLS_PROFILE', 'CPA_TOKEN_USAGE_DIR', 'CPA_MODEL_PRICE_FILE']) {
  delete env[key]
}

try {
  const result = spawnSync('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--', '--test-threads=1'], {
    cwd: root, env, stdio: 'inherit', windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status || 1
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
