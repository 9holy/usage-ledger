import type { SourceAccount } from './sourceTypes'

export type LocalCostSource = 'cockpit' | 'cliproxy'

export function localCostAccountId(source: LocalCostSource, rawId: string): string {
  if (!rawId.trim()) throw new Error('A local cost account requires a source identity')
  return `${source}:${encodeURIComponent(rawId)}`
}

export function costAccountGroupNames(account: Pick<SourceAccount, 'extra' | 'groups'>): string[] {
  const localNames = account.extra?.cockpit_group_names
  return Array.isArray(localNames)
    ? localNames.filter((name): name is string => typeof name === 'string' && name.length > 0)
    : account.groups?.map(group => group.name) ?? []
}

/** Legacy numeric aliases may identify old records, never ownership of a new record. */
export function legacyLocalAccountAlias(rawId: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < rawId.length; i++) {
    hash ^= rawId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return Math.abs(hash | 0) || 1
}
