import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assembleRelease, assetName, fileReceipt, platforms, sha256, verifyPlatformReceipt, verifyReleaseFiles } from '../release-desktop.mjs'
import { publishRelease, releaseNotesForGitHub, verifyRemoteRelease } from '../publish-release.mjs'

const context = {
  version: '0.2.37',
  repository: '9holy/usage-ledger',
  sourceCommit: 'a'.repeat(40),
  sourceManifestSha256: 'b'.repeat(64),
  runId: '1234',
  runAttempt: 2,
  runUrl: 'https://github.com/9holy/usage-ledger/actions/runs/1234',
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'usage-ledger-release-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const input = join(directory, 'input')
  const output = join(directory, 'output')
  mkdirSync(input)
  for (const [platform, definition] of Object.entries(platforms)) {
    const folder = join(input, `usage-ledger-${context.version}-${platform}`)
    mkdirSync(folder)
    const installer = join(folder, assetName(context.version, platform))
    writeFileSync(installer, Buffer.alloc(1_000_001, Object.keys(platforms).indexOf(platform) + 1))
    writeFileSync(join(folder, `BUILD-INFO.${platform}.json`), JSON.stringify({
      schemaVersion: 1,
      ...context,
      runAttempt: platform === 'windows-x64' ? 1 : 2,
      platform,
      target: definition.target,
      artifact: fileReceipt(installer),
      verification: { nativeTests: 'passed', packagedStartup: 'passed' },
    }))
  }
  const info = assembleRelease(input, output, context)
  const artifacts = verifyReleaseFiles(output, context)
  return { directory, input, output, info, artifacts }
}

function remoteAssets(artifacts) {
  return artifacts.map((artifact, index) => ({ id: index + 1, name: artifact.name, size: artifact.bytes, digest: `sha256:${artifact.sha256}`, state: 'uploaded' }))
}

function remoteRelease() {
  return { id: 10, tag_name: `v${context.version}`, draft: false, prerelease: false, html_url: `https://github.com/${context.repository}/releases/tag/v${context.version}` }
}

test('published notes resolve repository links at the exact source without changing external URLs or allowing path escape', () => {
  const prefix = `https://github.com/9holy/usage-ledger/blob/${context.sourceCommit}`
  const notes = '[Guide](../../README.md) [Audit](../audit-2026-11-07.md#limits) [CI](../../.github/workflows/ci.yml) [Download](https://github.com/9holy/usage-ledger/releases/tag/v0.2.37)'
  assert.equal(releaseNotesForGitHub(notes, context), `[Guide](${prefix}/README.md) [Audit](${prefix}/docs/audit-2026-11-07.md#limits) [CI](${prefix}/.github/workflows/ci.yml) [Download](https://github.com/9holy/usage-ledger/releases/tag/v0.2.37)`)
  assert.throws(() => releaseNotesForGitHub('[Invalid](../../../outside.md)', context), /escapes the repository/)
  assert.throws(() => releaseNotesForGitHub('[Invalid](../%2e%2e/%2e%2e/outside.md)', context), /escapes the repository/)
})

test('release assembly verifies all three native receipts, including a rerun of only failed jobs', t => {
  const { output, info, artifacts } = fixture(t)
  assert.equal(artifacts.length, 5)
  assert.equal(info.builds.length, 3)
  assert.equal(info.sourceCommit, context.sourceCommit)
  assert(readFileSync(join(output, 'SHA256SUMS.txt'), 'utf8').includes('  BUILD-INFO.json\n'))
  writeFileSync(join(output, assetName(context.version, 'windows-x64')), Buffer.alloc(1_000_001, 4))
  assert.throws(() => verifyReleaseFiles(output, context), /checksum mismatch/)
})

test('release assembly refuses mixed source commits, extra platform inputs and replaced installer bytes', t => {
  const { input, directory } = fixture(t)
  const platform = 'macos-arm64'
  const receiptPath = join(input, `usage-ledger-${context.version}-${platform}`, `BUILD-INFO.${platform}.json`)
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  writeFileSync(receiptPath, JSON.stringify({ ...receipt, sourceCommit: 'c'.repeat(40) }))
  assert.throws(() => assembleRelease(input, join(directory, 'mixed'), context), /mismatched sourceCommit/)
  writeFileSync(receiptPath, JSON.stringify(receipt))
  writeFileSync(join(input, 'unexpected.txt'), 'unexpected')
  assert.throws(() => assembleRelease(input, join(directory, 'extra'), context), /exactly the three/)
  rmSync(join(input, 'unexpected.txt'))
  writeFileSync(join(input, `usage-ledger-${context.version}-${platform}`, receipt.artifact.name), Buffer.alloc(1_000_001, 8))
  assert.throws(() => assembleRelease(input, join(directory, 'replaced'), context), /differ from the macos-arm64 build receipt/)
})

test('platform receipts reject changed architecture, failed smoke checks and version-derived path injection', t => {
  const { info } = fixture(t)
  const receipt = info.builds[0]
  assert.throws(() => verifyPlatformReceipt({ ...receipt, target: 'x86_64-apple-darwin' }, 'windows-x64', context), /native target/)
  assert.throws(() => verifyPlatformReceipt({ ...receipt, verification: { nativeTests: 'passed', packagedStartup: 'failed' } }, 'windows-x64', context), /startup did not pass/)
  assert.throws(() => assetName('../0.2.37', 'windows-x64'), /release version/)
  assert.throws(() => assetName('0.2.37', '../windows'), /Unknown release platform/)
})

test('remote release verification rejects incomplete uploads, stale sources and inconsistent published checksums', t => {
  const { output, artifacts } = fixture(t)
  const assets = remoteAssets(artifacts)
  const info = readFileSync(join(output, 'BUILD-INFO.json'))
  const sums = readFileSync(join(output, 'SHA256SUMS.txt'))
  verifyRemoteRelease(remoteRelease(), assets, info, sums, context)
  assert.throws(() => verifyRemoteRelease(remoteRelease(), assets.slice(1), info, sums, context), /missing, duplicated or unexpected/)
  assert.throws(() => verifyRemoteRelease(remoteRelease(), assets.map((asset, i) => i === 0 ? { ...asset, state: 'starter' } : asset), info, sums, context), /incomplete/)
  assert.throws(() => verifyRemoteRelease(remoteRelease(), assets, info, sums, { ...context, sourceCommit: 'd'.repeat(40) }), /mismatched sourceCommit/)
  const wrongSums = Buffer.from('invalid checksums\n')
  const tamperedAssets = assets.map(asset => asset.name === 'SHA256SUMS.txt' ? { ...asset, size: wrongSums.length, digest: `sha256:${sha256(wrongSums)}` } : asset)
  assert.throws(() => verifyRemoteRelease(remoteRelease(), tamperedAssets, info, wrongSums, context), /checksum manifest is inconsistent/)
})

function fakeClient() {
  const state = { reference: undefined, release: undefined, assets: [], mutations: [], nextId: 1, corruptDownload: false, mainCommit: context.sourceCommit }
  const publicAsset = asset => ({ id: asset.id, name: asset.name, size: asset.size, digest: asset.digest, state: asset.state })
  const client = {
    async optional(route) {
      if (route.startsWith('/git/ref/tags/')) return state.reference
      if (route.startsWith('/releases/tags/')) return state.release
      throw new Error(`Unexpected read ${route}`)
    },
    async json(route, method = 'GET', body) {
      if (method !== 'GET') state.mutations.push({ route, method, body })
      if (route === '/git/ref/heads/main') return { object: { type: 'commit', sha: state.mainCommit } }
      if (route.startsWith('/git/ref/tags/')) return state.reference
      if (route === '/git/refs' && method === 'POST') return state.reference = { object: { type: 'commit', sha: body.sha } }
      if (route === '/releases' && method === 'POST') return state.release = { ...remoteRelease(), ...body }
      if (route === '/releases/10' && method === 'GET') return state.release
      if (route === '/releases/10' && method === 'PATCH') {
        assert.equal(state.assets.length, 5, 'No public release may omit an installer or its evidence')
        return state.release = { ...state.release, ...body }
      }
      if (route.startsWith('/releases/assets/') && method === 'DELETE') {
        state.assets = state.assets.filter(asset => asset.id !== Number(route.split('/').pop()))
        return undefined
      }
      throw new Error(`Unexpected request ${method} ${route}`)
    },
    async assets() { return state.assets.map(publicAsset) },
    async upload(_release, artifact) {
      state.mutations.push({ method: 'UPLOAD', name: artifact.name })
      const bytes = readFileSync(artifact.path)
      const asset = { id: state.nextId++, name: artifact.name, size: bytes.length, digest: `sha256:${sha256(bytes)}`, state: 'uploaded', bytes }
      state.assets.push(asset)
      return publicAsset(asset)
    },
    async download(asset) {
      if (state.corruptDownload && asset.name === 'BUILD-INFO.json') return Buffer.from('corrupt')
      return state.assets.find(item => item.id === asset.id).bytes
    },
  }
  return { client, state }
}

test('publisher creates a verified draft before publishing and never replaces a completed release on retry', async t => {
  const { artifacts } = fixture(t)
  const { client, state } = fakeClient()
  await publishRelease(client, context, artifacts, '# Usage Ledger v0.2.37\n')
  assert.equal(state.release.draft, false)
  const creation = state.mutations.find(call => call.route === '/releases' && call.method === 'POST')
  assert.equal(creation.body.draft, true)
  assert.equal(creation.body.target_commitish, context.sourceCommit)
  const before = state.mutations.length
  await publishRelease(client, context, artifacts, '# Usage Ledger v0.2.37\n')
  assert.equal(state.mutations.length, before, 'Retry must verify the existing public release without mutating it')
})

test('publisher leaves a partial draft private on failed verification and safely repairs that same-source draft', async t => {
  const { artifacts } = fixture(t)
  const { client, state } = fakeClient()
  state.corruptDownload = true
  await assert.rejects(publishRelease(client, context, artifacts, '# Usage Ledger v0.2.37\n'), /wrong digest/)
  assert.equal(state.release.draft, true)
  assert(!state.mutations.some(call => call.method === 'PATCH' && call.body?.draft === false))
  state.corruptDownload = false
  state.assets = state.assets.filter(asset => !asset.name.endsWith('.exe'))
  await publishRelease(client, context, artifacts, '# Usage Ledger v0.2.37\n')
  assert.equal(state.release.draft, false)
  assert.equal(state.assets.length, 5)
})

test('publisher refuses a different tag source and a moved main without any mutation', async t => {
  const { artifacts } = fixture(t)
  const { client, state } = fakeClient()
  state.reference = { object: { type: 'commit', sha: 'e'.repeat(40) } }
  await assert.rejects(publishRelease(client, context, artifacts, 'notes'), /different source/)
  assert.equal(state.mutations.length, 0)
  state.reference = undefined
  state.mainCommit = 'e'.repeat(40)
  await assert.rejects(publishRelease(client, context, artifacts, 'notes'), /main moved/)
  assert.equal(state.mutations.length, 0)
})

test('publisher leaves another draft untouched before creating any tag or asset', async t => {
  const { artifacts } = fixture(t)
  const { client, state } = fakeClient()
  state.release = { ...remoteRelease(), draft: true, target_commitish: context.sourceCommit, body: 'Prepared separately by the maintainer.' }
  await assert.rejects(publishRelease(client, context, artifacts, 'notes'), /not owned by this release workflow/)
  assert.equal(state.mutations.length, 0)
})
