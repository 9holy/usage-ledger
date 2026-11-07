interface AccountLabelIdentity {
  accountKey: string
  tool: string
  label: string
}

function anonymousToken(key: string): string {
  // Native report keys contain an anonymous digest, never the provider account ID.
  const digest = /^[^:]+:account-([a-f0-9]{12})$/i.exec(key)?.[1]
  if (digest) return digest.toLowerCase()
  // Legacy keys are opaque too: do not expose arbitrary raw IDs in display text.
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193)
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Display-only suffixes. Account selection and aggregation must keep using accountKey. */
export function accountLabelSuffixes(accounts: readonly AccountLabelIdentity[]): Map<string, string> {
  const groups = new Map<string, Set<string>>()
  for (const account of accounts) {
    const group = JSON.stringify([account.tool, account.label])
    if (!groups.has(group)) groups.set(group, new Set())
    groups.get(group)!.add(account.accountKey)
  }
  const result = new Map<string, string>()
  for (const keys of groups.values()) {
    if (keys.size < 2) continue
    const identities = [...keys].sort().map(key => ({ key, token: anonymousToken(key) }))
    for (const identity of identities) {
      let length = Math.min(6, identity.token.length)
      while (length < identity.token.length && identities.some(other => other.key !== identity.key
        && other.token.slice(-length) === identity.token.slice(-length))) length++
      let suffix = identity.token.slice(-length)
      const equalTokens = identities.filter(other => other.token === identity.token)
      // A complete legacy fingerprint collision must remain distinguishable too.
      if (equalTokens.length > 1) suffix += `-${equalTokens.findIndex(other => other.key === identity.key) + 1}`
      result.set(identity.key, suffix)
    }
  }
  return result
}
