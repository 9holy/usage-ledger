import { describe, expect, it } from 'vitest'
import { accountLabelSuffixes } from '../accountLabels'

const account = (accountKey: string, tool = 'codex', label = 'm*** · pro') => ({ accountKey, tool, label })

describe('anonymous account display labels', () => {
  it('disambiguates distinct same-tool labels without counting repeat quota windows as accounts', () => {
    const one = account('codex:account-aaaaaa123456')
    const two = account('codex:account-bbbbbb654321')
    const result = accountLabelSuffixes([one, one, two, account('claude:account-aaaaaa123456', 'claude'), account('codex:account-cccccc123456', 'codex', 'another account')])
    expect([...result]).toEqual([[one.accountKey, '123456'], [two.accountKey, '654321']])
    expect(accountLabelSuffixes([one, one]).size).toBe(0)
  })

  it('extends colliding short suffixes to the whole anonymous digest when necessary and survives reordering', () => {
    const rows = [account('codex:account-a00000123456'), account('codex:account-b00000123456')]
    expect([...accountLabelSuffixes(rows)]).toEqual([
      [rows[0].accountKey, 'a00000123456'], [rows[1].accountKey, 'b00000123456'],
    ])
    expect([...accountLabelSuffixes([...rows].reverse())]).toEqual([...accountLabelSuffixes(rows)])
  })

  it('does not expose legacy provider IDs when names collide', () => {
    const rows = [account('codex:private-id-alice@example.test'), account('codex:private-id-alex@example.test')]
    const suffixes = [...accountLabelSuffixes(rows).values()]
    expect(new Set(suffixes).size).toBe(2)
    expect(suffixes.every(suffix => /^[a-f0-9]{6,8}$/.test(suffix))).toBe(true)
    expect(suffixes.join()).not.toContain('private-id')
    expect(suffixes.join()).not.toContain('@')
  })

  it('resolves even complete legacy fingerprint collisions without exposing the underlying identifiers', () => {
    // These strings share the same FNV-1a fingerprint (5e4daa9d).
    const rows = [account('costarring'), account('liquid')]
    const result = accountLabelSuffixes(rows)
    expect([...result.values()]).toEqual(['5e4daa9d-1', '5e4daa9d-2'])
    expect([...accountLabelSuffixes([...rows].reverse())]).toEqual([...result])
  })
})
