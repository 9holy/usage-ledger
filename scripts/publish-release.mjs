import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetName, platforms, releaseContext, repository, sha256, verifyPlatformReceipt, verifyReleaseFiles } from './release-desktop.mjs'

export function releaseNotesForGitHub(notes, context) {
  assert(/^[0-9a-f]{40}$/.test(context.sourceCommit), 'An exact source commit is required for documentation links')
  return notes.replace(/\]\((\.\.?\/[^\s)]+)\)/g, (_match, destination) => {
    const suffixIndex = destination.search(/[?#]/)
    const pathname = suffixIndex < 0 ? destination : destination.slice(0, suffixIndex)
    const suffix = suffixIndex < 0 ? '' : destination.slice(suffixIndex)
    const decoded = decodeURIComponent(pathname)
    assert(!decoded.includes('\\') && !decoded.includes('\0'), 'Invalid relative documentation link')
    const resolvedPath = posix.normalize(posix.join('docs/release', decoded))
    assert(resolvedPath !== '..' && !resolvedPath.startsWith('../') && !posix.isAbsolute(resolvedPath), 'Documentation link escapes the repository')
    const encodedPath = resolvedPath.split('/').map(encodeURIComponent).join('/')
    return `](https://github.com/${repository}/blob/${context.sourceCommit}/${encodedPath}${suffix})`
  })
}

export function verifyRemoteRelease(release, assets, buildInfoBytes, checksumBytes, context) {
  assert.equal(release.tag_name, `v${context.version}`, 'Remote release has the wrong version')
  assert.equal(release.prerelease, false, 'Expected a stable release')
  const names = [...Object.keys(platforms).map(platform => assetName(context.version, platform)), 'BUILD-INFO.json', 'SHA256SUMS.txt'].sort()
  assert.deepEqual(assets.map(asset => asset.name).sort(), names, 'Remote release assets are missing, duplicated or unexpected')
  for (const asset of assets) {
    assert.equal(asset.state, 'uploaded', `Remote asset ${asset.name} is incomplete`)
    assert(Number.isSafeInteger(asset.size) && asset.size > 0, `Remote asset ${asset.name} is empty`)
    assert(/^sha256:[0-9a-f]{64}$/.test(asset.digest || ''), `Remote asset ${asset.name} has no verifiable SHA-256 digest`)
  }
  const byName = new Map(assets.map(asset => [asset.name, asset]))
  for (const [name, bytes] of [['BUILD-INFO.json', buildInfoBytes], ['SHA256SUMS.txt', checksumBytes]]) {
    assert.equal(byName.get(name).digest, `sha256:${sha256(bytes)}`, `Downloaded ${name} has the wrong digest`)
    assert.equal(byName.get(name).size, bytes.length, `Downloaded ${name} has the wrong size`)
  }
  const info = JSON.parse(Buffer.from(buildInfoBytes).toString('utf8'))
  assert.equal(info.schemaVersion, 1, 'Unsupported published build information')
  for (const key of ['version', 'repository', 'sourceCommit', 'sourceManifestSha256']) {
    assert.equal(info[key], context[key], `Published release has mismatched ${key}; refusing to overwrite it`)
  }
  assert(/^\d+$/.test(info.runId || ''), 'Published run ID is missing')
  assert.equal(info.runUrl, `https://github.com/${repository}/actions/runs/${info.runId}`, 'Invalid published workflow URL')
  assert(Number.isSafeInteger(info.runAttempt) && info.runAttempt > 0, 'Invalid published workflow attempt')
  assert.deepEqual(info.builds?.map(build => build.platform).sort(), Object.keys(platforms).sort(), 'Published platform evidence is incomplete')
  for (const build of info.builds) {
    verifyPlatformReceipt(build, build.platform, { ...context, runId: info.runId, runUrl: info.runUrl, runAttempt: info.runAttempt })
    const asset = byName.get(build.artifact.name)
    assert.equal(asset.size, build.artifact.bytes, `Published ${asset.name} has the wrong size`)
    assert.equal(asset.digest, `sha256:${build.artifact.sha256}`, `Published ${asset.name} differs from its build evidence`)
  }
  const expectedChecksums = names.filter(name => name !== 'SHA256SUMS.txt')
    .map(name => `${byName.get(name).digest.slice(7)}  ${name}`).join('\n') + '\n'
  assert.equal(Buffer.from(checksumBytes).toString('utf8'), expectedChecksums, 'Published checksum manifest is inconsistent')
  return info
}

function githubClient(token) {
  const root = `https://api.github.com/repos/${repository}`
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(120_000) })
    if (!response.ok) {
      const error = new Error(`GitHub request failed with status ${response.status}: ${(await response.text()).slice(0, 600)}`)
      error.status = response.status
      throw error
    }
    return response
  }
  return {
    async json(route, method = 'GET', body) {
      const response = await request(`${root}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      return response.status === 204 ? undefined : response.json()
    },
    async optional(route) {
      try { return await this.json(route) } catch (error) {
        if (error.status === 404) return undefined
        throw error
      }
    },
    async assets(releaseId) {
      const assets = []
      for (let page = 1; ; page++) {
        const batch = await this.json(`/releases/${releaseId}/assets?per_page=100&page=${page}`)
        assets.push(...batch)
        if (batch.length < 100) return assets
      }
    },
    async download(asset) {
      const response = await request(`${root}/releases/assets/${asset.id}`, { headers: { ...headers, Accept: 'application/octet-stream' } })
      return Buffer.from(await response.arrayBuffer())
    },
    async upload(release, artifact) {
      const url = new URL(release.upload_url.replace(/\{.*$/, ''))
      assert.equal(url.origin, 'https://uploads.github.com', 'Unexpected GitHub upload host')
      assert.equal(url.pathname, `/repos/${repository}/releases/${release.id}/assets`, 'Unexpected GitHub upload path')
      url.searchParams.set('name', artifact.name)
      const response = await request(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/octet-stream' },
        body: readFileSync(artifact.path),
      })
      return response.json()
    },
  }
}

export async function publishRelease(client, context, artifacts, notes) {
  const tag = `v${context.version}`
  const marker = `<!-- usage-ledger-release-source:${context.sourceCommit} -->`
  const body = `${releaseNotesForGitHub(notes, context).trim()}\n\nSource: [${context.sourceCommit}](https://github.com/${repository}/commit/${context.sourceCommit})\n\nBuild and native validation: [GitHub Actions run](${context.runUrl}).\n\n${marker}\n`
  let reference = await client.optional(`/git/ref/tags/${tag}`)
  let release = await client.optional(`/releases/tags/${tag}`)

  async function validateTag(ref) {
    assert(ref, 'Release tag is missing')
    let object = ref.object
    for (let depth = 0; object.type === 'tag' && depth < 5; depth++) object = (await client.json(`/git/tags/${object.sha}`)).object
    assert.equal(object.type, 'commit', 'Release tag does not resolve to a commit')
    assert.equal(object.sha, context.sourceCommit, 'Release tag points to different source; refusing to overwrite it')
  }

  async function verifyRemote(currentRelease) {
    await validateTag(await client.json(`/git/ref/tags/${tag}`))
    const assets = await client.assets(currentRelease.id)
    const info = assets.find(asset => asset.name === 'BUILD-INFO.json')
    const checksums = assets.find(asset => asset.name === 'SHA256SUMS.txt')
    assert(info && checksums, 'Remote release evidence is missing')
    const [infoBytes, checksumBytes] = await Promise.all([client.download(info), client.download(checksums)])
    verifyRemoteRelease(currentRelease, assets, infoBytes, checksumBytes, context)
    return assets
  }

  if (reference) await validateTag(reference)
  if (release && !release.draft) {
    await verifyRemote(release)
    console.log(`Verified existing release without changing its files: ${release.html_url}`)
    return release
  }
  if (release) {
    assert.equal(release.target_commitish, context.sourceCommit, 'Existing draft targets different source')
    assert(release.body?.includes(marker), 'Existing draft is not owned by this release workflow; leaving it unchanged')
  }

  const main = await client.json('/git/ref/heads/main')
  assert.equal(main.object.sha, context.sourceCommit, 'main moved after this build; refusing to publish an outdated candidate')
  if (!reference) {
    reference = await client.json('/git/refs', 'POST', { ref: `refs/tags/${tag}`, sha: context.sourceCommit })
    await validateTag(reference)
  }
  if (!release) {
    release = await client.json('/releases', 'POST', {
      tag_name: tag,
      target_commitish: context.sourceCommit,
      name: `${tag} - Usage accuracy and audited desktop installers`,
      body,
      draft: true,
      prerelease: false,
    })
  }

  async function requireOwnedDraft() {
    const current = await client.json(`/releases/${release.id}`)
    assert.equal(current.draft, true, 'The release was published concurrently; refusing to change its assets')
    assert.equal(current.target_commitish, context.sourceCommit, 'Draft source changed during publication')
    assert(current.body?.includes(marker), 'Draft ownership changed during publication')
  }

  const existing = await client.assets(release.id)
  const wanted = new Set(artifacts.map(artifact => artifact.name))
  assert(existing.every(asset => wanted.has(asset.name)), 'Draft contains unexpected assets; leaving them unchanged')
  for (const artifact of artifacts) {
    const matches = existing.filter(asset => asset.name === artifact.name)
    assert(matches.length <= 1, 'Draft contains duplicate asset names')
    const previous = matches[0]
    if (previous?.state === 'uploaded' && previous.size === artifact.bytes && previous.digest === `sha256:${artifact.sha256}`) continue
    // Only this workflow's unpublicized draft may be repaired on a retry.
    await requireOwnedDraft()
    if (previous) await client.json(`/releases/assets/${previous.id}`, 'DELETE')
    const uploaded = await client.upload(release, artifact)
    assert.equal(uploaded.state, 'uploaded', `Upload did not finish for ${artifact.name}`)
    assert.equal(uploaded.size, artifact.bytes, `Uploaded size differs for ${artifact.name}`)
    assert.equal(uploaded.digest, `sha256:${artifact.sha256}`, `Uploaded digest differs for ${artifact.name}`)
  }
  await verifyRemote(release)
  assert.equal((await client.json('/git/ref/heads/main')).object.sha, context.sourceCommit, 'main moved before publication; leaving the verified draft unpublished')
  await requireOwnedDraft()
  release = await client.json(`/releases/${release.id}`, 'PATCH', { draft: false, prerelease: false, make_latest: 'true', body })
  assert.equal(release.draft, false, 'Release remains a draft')
  await verifyRemote(release)
  console.log(`Published and verified ${release.html_url}`)
  return release
}

async function main() {
  assert.equal(process.argv.length, 2, 'Usage: node scripts/publish-release.mjs')
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Publication is restricted to the gated GitHub Actions job')
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Only main may publish installers')
  assert(['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME), 'Unexpected publication event')
  assert(process.env.GH_TOKEN, 'The publishing job needs its scoped GitHub token')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const context = releaseContext(root)
  const artifacts = verifyReleaseFiles(join(root, 'release-assets'), context)
  const notes = readFileSync(join(root, 'docs/release', `${context.version}.md`), 'utf8')
  await publishRelease(githubClient(process.env.GH_TOKEN), context, artifacts, notes)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
