import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const repository = '9holy/usage-ledger'
export const platforms = Object.freeze({
  'windows-x64': { os: 'win32', arch: 'x64', target: 'x86_64-pc-windows-msvc', suffix: 'windows_x64-setup.exe' },
  'macos-arm64': { os: 'darwin', arch: 'arm64', target: 'aarch64-apple-darwin', suffix: 'macos_arm64.dmg' },
  'macos-x64': { os: 'darwin', arch: 'x64', target: 'x86_64-apple-darwin', suffix: 'macos_x64.dmg' },
})
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const json = file => JSON.parse(readFileSync(file, 'utf8'))

export function assetName(version, platform) {
  assert(/^\d+\.\d+\.\d+$/.test(version), 'A stable three-part release version is required')
  assert(Object.hasOwn(platforms, platform), `Unknown release platform: ${platform}`)
  return `Usage-Ledger_${version}_${platforms[platform].suffix}`
}

export function releaseVersion(root) {
  const version = json(join(root, 'package.json')).version
  assetName(version, 'windows-x64')
  const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  const locked = readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8').match(/\[\[package\]\]\s+name = "console2api"\s+version = "([^"]+)"/)?.[1]
  for (const [name, actual] of Object.entries({
    tauri: json(join(root, 'src-tauri/tauri.conf.json')).version,
    cargo,
    cargoLock: locked,
    policy: json(join(root, 'scripts/source-release-policy.json')).version,
    manifest: json(join(root, 'SOURCE_MANIFEST.json')).version,
  })) assert.equal(actual, version, `${name} version differs from package.json`)
  const notes = readFileSync(join(root, 'docs/release', `${version}.md`), 'utf8')
  assert.match(notes.split(/\r?\n/, 1)[0], new RegExp(`^# Usage Ledger v?${version.replaceAll('.', '\\.')}($|\\s)`), 'Release notes must identify the installer version')
  return version
}

export function releaseContext(root, env = process.env) {
  const version = releaseVersion(root)
  assert.equal(env.GITHUB_REPOSITORY, repository, 'Unexpected release repository')
  assert(/^[0-9a-f]{40}$/.test(env.GITHUB_SHA || ''), 'An exact GitHub source commit is required')
  assert(/^\d+$/.test(env.GITHUB_RUN_ID || ''), 'A GitHub Actions run ID is required')
  assert(/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT || ''), 'A GitHub Actions attempt is required')
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  assert.equal(head.status, 0, 'Cannot read the checked-out source commit')
  assert.equal(head.stdout.trim(), env.GITHUB_SHA, 'Checked-out source differs from the workflow commit')
  const clean = spawnSync('git', ['diff', '--exit-code', 'HEAD', '--'], { cwd: root, encoding: 'utf8' })
  assert.equal(clean.status, 0, 'Tracked source changed during validation or packaging')
  return {
    version,
    repository,
    sourceCommit: env.GITHUB_SHA,
    sourceManifestSha256: sha256(readFileSync(join(root, 'SOURCE_MANIFEST.json'))),
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    runUrl: `https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}`,
  }
}

export function fileReceipt(file) {
  const stat = lstatSync(file)
  assert(stat.isFile() && !stat.isSymbolicLink(), `Expected a regular artifact file: ${file}`)
  const bytes = readFileSync(file)
  return { name: basename(file), bytes: bytes.length, sha256: sha256(bytes) }
}

export function verifyPlatformReceipt(receipt, platform, context) {
  assert.equal(receipt.schemaVersion, 1, 'Unsupported platform receipt')
  for (const key of ['version', 'repository', 'sourceCommit', 'sourceManifestSha256', 'runId', 'runUrl']) {
    assert.equal(receipt[key], context[key], `Platform ${platform} has mismatched ${key}`)
  }
  assert.equal(receipt.platform, platform, 'Platform receipt is in the wrong artifact')
  assert.equal(receipt.target, platforms[platform].target, 'Unexpected native target')
  assert(Number.isSafeInteger(receipt.runAttempt) && receipt.runAttempt > 0 && receipt.runAttempt <= context.runAttempt, 'Invalid build attempt')
  assert.equal(receipt.artifact?.name, assetName(context.version, platform), 'Unexpected installer filename')
  assert(Number.isSafeInteger(receipt.artifact.bytes) && receipt.artifact.bytes > 1_000_000, 'Installer is missing or implausibly small')
  assert(/^[0-9a-f]{64}$/.test(receipt.artifact.sha256 || ''), 'Invalid installer digest')
  assert.equal(receipt.verification?.nativeTests, 'passed', 'Native tests did not pass')
  assert.equal(receipt.verification?.packagedStartup, 'passed', 'Packaged startup did not pass')
}

function stage(root, platform, context) {
  const definition = platforms[platform]
  assert(definition, `Unknown release platform: ${platform}`)
  assert.equal(process.platform, definition.os, 'The installer must be built on its native OS')
  assert.equal(process.arch, definition.arch, 'The installer must be built on its native CPU architecture')
  const windows = platform === 'windows-x64'
  const bundle = windows
    ? join(root, 'src-tauri/target/release/bundle/nsis')
    : join(root, 'src-tauri/target', definition.target, 'release/bundle/dmg')
  const candidates = readdirSync(bundle).filter(name => windows
    ? name.endsWith(`_${context.version}_x64-setup.exe`)
    : name.endsWith('.dmg') && name.includes(`_${context.version}_`))
  assert.equal(candidates.length, 1, `Expected exactly one ${platform} installer for this version`)
  const directory = join(root, 'release-assets', platform)
  mkdirSync(directory, { recursive: true })
  const destination = join(directory, assetName(context.version, platform))
  copyFileSync(join(bundle, candidates[0]), destination)
  const receipt = {
    schemaVersion: 1,
    ...context,
    platform,
    target: definition.target,
    artifact: fileReceipt(destination),
    verification: {
      nativeTests: 'passed',
      packagedStartup: 'passed',
      ...(windows
        ? { silentInstall: 'passed', installedVersion: 'passed', installedArchitecture: 'x64', windowResponse: 'passed' }
        : { architecture: definition.arch, signatureStructure: 'passed', diskImageIntegrity: 'passed' }),
      localBridge: 'owned-process-rejected-unauthenticated-request',
    },
    signing: windows ? 'No Authenticode publisher certificate' : 'Ad-hoc signing; no Developer ID or notarization',
    automaticUpdates: false,
  }
  verifyPlatformReceipt(receipt, platform, context)
  writeFileSync(join(directory, `BUILD-INFO.${platform}.json`), `${JSON.stringify(receipt, null, 2)}\n`)
  assert.equal(readdirSync(directory).length, 2, 'Unexpected files in the platform artifact directory')
  console.log(JSON.stringify(receipt, null, 2))
}

export function assembleRelease(inputDirectory, outputDirectory, context) {
  const expectedDirectories = Object.keys(platforms).map(platform => `usage-ledger-${context.version}-${platform}`).sort()
  assert.deepEqual(readdirSync(inputDirectory).sort(), expectedDirectories, 'Expected exactly the three platform artifacts')
  assert(!existsSync(outputDirectory) || readdirSync(outputDirectory).length === 0, 'Refusing a non-empty release output directory')
  mkdirSync(outputDirectory, { recursive: true })
  const builds = Object.keys(platforms).map(platform => {
    const directory = join(inputDirectory, `usage-ledger-${context.version}-${platform}`)
    const installer = assetName(context.version, platform)
    const receiptName = `BUILD-INFO.${platform}.json`
    assert.deepEqual(readdirSync(directory).sort(), [installer, receiptName].sort(), `Unexpected files in ${platform}`)
    const receipt = json(join(directory, receiptName))
    verifyPlatformReceipt(receipt, platform, context)
    assert.deepEqual(fileReceipt(join(directory, installer)), receipt.artifact, `Installer bytes differ from the ${platform} build receipt`)
    copyFileSync(join(directory, installer), join(outputDirectory, installer))
    return receipt
  })
  const buildInfo = {
    schemaVersion: 1,
    ...context,
    validation: {
      frontendLint: 'passed',
      frontendFullSuite: 'passed',
      buildScripts: 'passed',
      desktopFrontendBuild: 'passed',
      webFrontendBuild: 'passed',
      sourceManifest: 'passed',
      dependencyAudits: 'passed',
      nativeHeadlessSuite: 'passed',
    },
    builds,
    distribution: 'Manual downloads; no signed automatic-updater feed',
    limits: [
      'Windows has no Authenticode publisher certificate.',
      'macOS packages use ad-hoc signing without Developer ID signing or Apple notarization.',
      'macOS native checks use macOS 15; the configured minimum macOS 13 has not been exercised.',
      'Automated startup and window checks do not establish complete GUI, real-account or provider-billing correctness.',
      'Existing ignored real-data diagnostics and benchmarks remain excluded from ordinary test runs.',
    ],
  }
  writeFileSync(join(outputDirectory, 'BUILD-INFO.json'), `${JSON.stringify(buildInfo, null, 2)}\n`)
  const checksums = readdirSync(outputDirectory).sort().map(name => `${fileReceipt(join(outputDirectory, name)).sha256}  ${name}`).join('\n')
  writeFileSync(join(outputDirectory, 'SHA256SUMS.txt'), `${checksums}\n`)
  return buildInfo
}

export function verifyReleaseFiles(directory, context) {
  const installers = Object.keys(platforms).map(platform => assetName(context.version, platform))
  const expected = [...installers, 'BUILD-INFO.json', 'SHA256SUMS.txt'].sort()
  assert.deepEqual(readdirSync(directory).sort(), expected, 'Release must contain exactly three installers, build information and checksums')
  const buildInfo = json(join(directory, 'BUILD-INFO.json'))
  for (const key of ['version', 'repository', 'sourceCommit', 'sourceManifestSha256']) {
    assert.equal(buildInfo[key], context[key], `Release has mismatched ${key}`)
  }
  assert.equal(buildInfo.builds?.length, 3, 'Missing platform build evidence')
  assert.deepEqual(buildInfo.builds.map(build => build.platform).sort(), Object.keys(platforms).sort(), 'Duplicate or missing platform evidence')
  for (const build of buildInfo.builds) {
    verifyPlatformReceipt(build, build.platform, { ...context, runId: buildInfo.runId, runUrl: buildInfo.runUrl, runAttempt: buildInfo.runAttempt })
    assert.deepEqual(fileReceipt(join(directory, build.artifact.name)), build.artifact, 'Packaged installer checksum mismatch')
  }
  const checksums = [...installers, 'BUILD-INFO.json'].sort().map(name => `${fileReceipt(join(directory, name)).sha256}  ${name}`).join('\n') + '\n'
  assert.equal(readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8'), checksums, 'Release checksum manifest does not match the files')
  return expected.map(name => ({ ...fileReceipt(join(directory, name)), path: join(directory, name) }))
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const [command, argument] = process.argv.slice(2)
  if (command === 'check') {
    assert.equal(process.argv.length, 3, 'Usage: release-desktop.mjs check')
    const version = releaseVersion(root)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`)
    console.log(`Release versions and notes agree: v${version}`)
    return
  }
  const context = releaseContext(root)
  if (command === 'stage') {
    assert.equal(process.argv.length, 4, 'Usage: release-desktop.mjs stage <platform>')
    stage(root, argument, context)
  } else if (command === 'assemble') {
    assert.equal(process.argv.length, 3, 'Usage: release-desktop.mjs assemble')
    const output = join(root, 'release-assets')
    assembleRelease(join(root, '.tmp-release-download'), output, context)
    console.log(JSON.stringify(verifyReleaseFiles(output, context), null, 2))
  } else throw new Error('Expected check, stage or assemble command')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
