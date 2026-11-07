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

run(process.execPath, [join(root, 'scripts/test-native.mjs')])
console.log('Mac host tests passed with isolated account and ledger directories. Packaged GUI behavior still needs a manual check on each architecture.')
