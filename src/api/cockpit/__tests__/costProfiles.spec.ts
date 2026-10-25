import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { readCostProfiles, writeCostProfiles } from '../index'

const runtime = vi.hoisted(() => ({ desktop: true }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/api/url', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/url')>(), isDesktopRuntime: () => runtime.desktop }))

beforeEach(() => { vi.clearAllMocks(); runtime.desktop = true })

describe('local profile read/write boundary', () => {
  it('preserves canonical and unresolved legacy keys without guessing ownership', async () => {
    const profiles = { '42': { amount: 100 }, 'cliproxy:raw-id': { amount: 20 }, cockpit_global_multiplier: { amount: 0.2 } }
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
})
