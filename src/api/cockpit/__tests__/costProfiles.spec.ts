import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { readCostProfiles, writeCostProfiles } from '../index'

const runtime = vi.hoisted(() => ({ desktop: true }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/api/url', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/url')>(), isDesktopRuntime: () => runtime.desktop }))

beforeEach(() => { vi.clearAllMocks(); runtime.desktop = true })

describe('local profile read/write boundary', () => {
  it('preserves canonical and unresolved legacy keys without guessing ownership', async () => {
    const profiles = { '42': { amount: 100 }, 'cliproxy:raw-id': { amount: 20, currency: 'USD', billing_cycle: 'monthly', started_at: '2026-11-01T00:00:00Z' }, cockpit_global_multiplier: { amount: 0.2 } }
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify(profiles))
    expect(await readCostProfiles()).toEqual(profiles)
  })

  it('does not turn an unreadable or malformed file into an empty writable map', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('permission denied'))
    await expect(readCostProfiles()).rejects.toThrow('permission denied')
    for (const raw of ['', '{broken', '[]', 'null', '3']) {
      vi.mocked(invoke).mockResolvedValueOnce(raw)
      await expect(readCostProfiles()).rejects.toThrow()
    }
    expect(vi.mocked(invoke).mock.calls.every(([command]) => command === 'read_cost_profiles')).toBe(true)
  })

  it('allows the native first-use empty map, but never claims browser persistence succeeded', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('{}')
    await expect(readCostProfiles()).resolves.toEqual({})
    runtime.desktop = false
    await expect(readCostProfiles()).resolves.toEqual({})
    await expect(writeCostProfiles({})).rejects.toThrow('desktop')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it.each([null, '', '20', -1, Number.POSITIVE_INFINITY])('rejects an unusable scoped amount instead of turning it into a default profile: %j', async amount => {
    const map = { 'cliproxy:slot': { amount, currency: 'USD', billing_cycle: 'monthly', started_at: '2026-11-01T00:00:00Z' } }
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify(map))
    await expect(readCostProfiles()).rejects.toThrow('cost profile')
    await expect(writeCostProfiles(map as never)).rejects.toThrow('cost profile')
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'write_cost_profiles')).toBe(false)
  })

  it.each([{ currency: 'EUR' }, { billing_cycle: 'not-a-cycle' }, { started_at: 'not-a-date' }])('rejects an unreadable scoped contract without discarding existing files: %j', async invalid => {
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify({ 'cockpit:slot': { amount: 20, currency: 'USD', billing_cycle: 'monthly', started_at: '2026-11-01T00:00:00Z', ...invalid } }))
    await expect(readCostProfiles()).rejects.toThrow('cost profile')
  })

  it('retains explicit free profiles, legacy algorithm versions, normalized units and positive global multipliers', async () => {
    const map = { 'cliproxy:slot': { amount: 0, currency: ' usd ', billing_cycle: 'one-time', started_at: '2026-11-01T00:00:00Z' }, __cockpit_cost_multiplier__: { amount: 0.3 }, '42': { amount: -1 } }
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify(map))
    expect(await readCostProfiles()).toEqual(map)
    await writeCostProfiles(map as never)
    expect(invoke).toHaveBeenLastCalledWith('write_cost_profiles', { json: JSON.stringify(map, null, 2) })
  })
})
