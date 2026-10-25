import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const frontendDirectory = resolve(scriptDirectory, '..')
const mode = process.argv[2] === 'dev' ? 'dev' : 'build'

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: frontendDirectory,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

// 桌面端构建:先用 desktop 模式构建前端,再调 Tauri。
// 无内置 sub2api sidecar,不再需要 prepare-desktop-sidecar。
// Invoke the installed CLI with Node, without Windows .cmd resolution or a shell.
run(process.execPath, [resolve(frontendDirectory, 'node_modules/@tauri-apps/cli/tauri.js'), mode, ...process.argv.slice(3)])
