import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const policy = JSON.parse(readFileSync(path.join(repo, 'scripts/source-release-policy.json'), 'utf8'))
const args = process.argv.slice(2)
const arg = name => args.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3)
const slash = value => value.split(path.sep).join('/')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const textExtension = /\.(?:vue|[cm]?[jt]sx?|json|ya?ml|css|scss|html|xml|md|txt|rs|toml|lock|svg|sh|py)$/i

function excluded(relative) {
  const parts = relative.split('/')
  return parts.some(part => ['.git', '.omc', 'node_modules', 'target', 'dist', '__pycache__'].includes(part)
    || part.startsWith('.tmp') || part.startsWith('backup-') || part.includes('-backup-'))
    || /(?:^|\/)\.env(?:\.|$)/i.test(relative)
    || /\.(?:bak|log|db|sqlite\d?|sqlite\d?-(?:wal|shm)|pem|key|p12|pfx|exe|dll|pdb|tsbuildinfo)$/i.test(relative)
    || /\.timestamp-[^/]+\.mjs$/i.test(relative)
}

function included(relative) {
  return !excluded(relative) && (policy.files.includes(relative)
    || policy.directories.some(directory => relative.startsWith(directory + '/')))
}

function selfCheck() {
  for (const file of ['src/features/cost-center/accountIdentity.ts', 'src/api/admin/backup.ts', 'src/views/admin/BackupView.vue', 'src/i18n/locales/en/costData.ts', '.gitignore']) assert(included(file), file)
  for (const file of ['.git/config', 'docs/handoff/private.md', 'docs/audit/private.md', 'docs/screenshots/native-private.png', 'docs/design/usage-monitor/cache-weave-loop-reference.png', '.env.local', 'src/data.sqlite', 'src/backup-old/view.vue', 'src-tauri/target/release/app.exe', 'node_modules/pkg/index.js']) assert(!included(file), file)
}

function collect() {
  const files = new Set(policy.files)
  function walk(relative) {
    const absolute = path.join(repo, relative)
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) throw new Error(`Release candidate is a symlink: ${relative}`)
    if (excluded(relative)) return
    if (stat.isDirectory()) for (const name of readdirSync(absolute).sort()) walk(slash(path.join(relative, name)))
    else if (stat.isFile()) files.add(relative)
  }
  for (const directory of policy.directories) walk(directory)
  const result = [...files].sort()
  for (const file of result) {
    assert(included(file), `Outside release policy: ${file}`)
    const stat = lstatSync(path.join(repo, file))
    assert(stat.isFile() && !stat.isSymbolicLink(), `Not a regular source file: ${file}`)
  }
  for (const file of policy.required) assert(files.has(file), `Missing required module: ${file}`)
  return result
}

function inspect(file, bytes) {
  if (!textExtension.test(file) && !file.startsWith('.') && !policy.files.includes(file)) {
    assert(/\.(?:png|jpe?g|webp|gif|ico|icns|woff2?|ttf|otf)$/i.test(file), `Unreviewed binary type: ${file}`)
    return []
  }
  const content = bytes.toString('utf8')
  const rules = [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{128,}?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
    ['github-token', /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}\b/g],
    ['aws-access-id', /\bAKIA[0-9A-Z]{16}\b/g],
    ['api-key', /\b(?:sk-(?:proj-|svcacct-|ant-api\d+-)?[A-Za-z0-9_-]{32,}|AIza[A-Za-z0-9_-]{35})\b/g],
    ['jwt', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g],
    ['token-url', /https?:\/\/[^\s'"<>]+[?&](?:access_token|refresh_token|api_key|secret_key)=[A-Za-z0-9_-]{20,}/g],
  ]
  return rules.flatMap(([rule, pattern]) => [...content.matchAll(pattern)].map(match => ({ file, rule, line: content.slice(0, match.index).split('\n').length })))
}

selfCheck()
if (args.includes('--self-test')) {
  assert.equal(inspect('src/example.ts', Buffer.from('const publicKey = "example"')).length, 0)
  assert.equal(inspect('src/example.ts', Buffer.from('ghp_' + 'a'.repeat(36)))[0].rule, 'github-token')
  console.log('Source policy and redacted credential checks passed (no files copied).')
  process.exit(0)
}
const candidates = collect()
const loaded = candidates.map(file => ({ file, bytes: readFileSync(path.join(repo, file)) }))
const findings = loaded.flatMap(({ file, bytes }) => inspect(file, bytes))
const pkg = JSON.parse(loaded.find(item => item.file === 'package.json').bytes.toString('utf8'))
const tauri = JSON.parse(loaded.find(item => item.file === 'src-tauri/tauri.conf.json').bytes.toString('utf8'))
const cargo = loaded.find(item => item.file === 'src-tauri/Cargo.toml').bytes.toString('utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1]
console.log(JSON.stringify({ mode: args.includes('--export') ? 'export' : 'check-only', version: policy.version, actualVersions: { package: pkg.version, tauri: tauri.version, cargo }, files: candidates.length, bytes: loaded.reduce((sum, item) => sum + item.bytes.length, 0), redactedFindings: findings, excludedCategories: policy.excludedCategories }, null, 2))
assert.equal(findings.length, 0, 'Credential candidates require review; values were not printed')
if (!args.includes('--export')) process.exit(0)
assert(arg('freeze'), 'Explicit maintainer freeze marker is required before export')
assert.equal(pkg.version, policy.version, 'Package version has not reached release freeze')
assert.equal(tauri.version, policy.version, 'Tauri version has not reached release freeze')
assert.equal(cargo, policy.version, 'Cargo version has not reached release freeze')
assert.equal(process.platform, 'win32', 'The archive step uses the Windows .NET ZIP toolchain')
const output = path.resolve(arg('output') || path.join(repo, '..', 'release', `usage-ledger-${policy.version}`))
const outputRelative = path.relative(repo, output)
assert(outputRelative === '..' || outputRelative.startsWith('..' + path.sep), 'Export output must be outside the source checkout')
const source = path.join(output, 'source')
const archive = path.join(output, `usage-ledger-${policy.version}-source.zip`)
for (const destination of [source, archive, path.join(output, 'SOURCE_MANIFEST.json'), archive + '.sha256']) assert(!existsSync(destination), `Refusing existing destination: ${destination}`)
mkdirSync(output, { recursive: true })
mkdirSync(source)
const manifest = { schemaVersion: 1, version: policy.version, repository: policy.repository, freeze: arg('freeze'), createdAt: new Date().toISOString(), gitHistoryIncluded: false, policy, files: loaded.map(({ file, bytes }) => ({ path: file, bytes: bytes.length, sha256: hash(bytes) })) }
for (const { file, bytes } of loaded) {
  const destination = path.join(source, file)
  mkdirSync(path.dirname(destination), { recursive: true })
  writeFileSync(destination, bytes, { flag: 'wx' })
}
for (const file of manifest.files) assert.equal(hash(readFileSync(path.join(source, file.path))), file.sha256, `Export byte mismatch: ${file.path}`)
const manifestBytes = JSON.stringify(manifest, null, 2) + '\n'
writeFileSync(path.join(source, 'SOURCE_MANIFEST.json'), manifestBytes, { flag: 'wx' })
writeFileSync(path.join(output, 'SOURCE_MANIFEST.json'), manifestBytes, { flag: 'wx' })
const quote = value => "'" + value.replaceAll("'", "''") + "'"
const command = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression;Add-Type -AssemblyName System.IO.Compression.FileSystem;$root=${quote(source)};$zip=[IO.Compression.ZipFile]::Open(${quote(archive)},[IO.Compression.ZipArchiveMode]::Create);try{Get-ChildItem -LiteralPath $root -Recurse -File -Force | ForEach-Object {$name='source/'+$_.FullName.Substring($root.Length+1).Replace('\\','/');[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$_.FullName,$name,[IO.Compression.CompressionLevel]::Optimal)|Out-Null}}finally{$zip.Dispose()};$zip=[IO.Compression.ZipFile]::OpenRead(${quote(archive)});try{ConvertTo-Json -Compress -InputObject @($zip.Entries | ForEach-Object {$stream=$_.Open();$sha=[Security.Cryptography.SHA256]::Create();try{@{path=$_.FullName;sha256=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}}finally{$stream.Dispose();$sha.Dispose()}})}finally{$zip.Dispose()}`
const zip = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, encoding: 'utf8' })
assert.equal(zip.status, 0, `ZIP creation failed: ${zip.stderr}`)
const entries = JSON.parse(zip.stdout)
assert.deepEqual(entries.map(item => item.path).sort(), [...candidates, 'SOURCE_MANIFEST.json'].map(file => 'source/' + file).sort(), 'ZIP file list mismatch')
const expectedHashes = new Map(manifest.files.map(file => ['source/' + file.path, file.sha256]))
expectedHashes.set('source/SOURCE_MANIFEST.json', hash(Buffer.from(manifestBytes)))
for (const entry of entries) assert.equal(entry.sha256, expectedHashes.get(entry.path), `ZIP byte mismatch: ${entry.path}`)
const archiveHash = hash(readFileSync(archive))
writeFileSync(archive + '.sha256', `${archiveHash}  ${path.basename(archive)}\n`, { flag: 'wx' })
console.log(JSON.stringify({ exported: source, archive, files: candidates.length, archiveSha256: archiveHash, historyIncluded: false }, null, 2))
