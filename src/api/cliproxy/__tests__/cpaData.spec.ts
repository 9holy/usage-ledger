import { beforeEach, describe, expect, it, vi } from 'vitest'
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
import { getCliproxyUsageEvents, getCliproxyUsageSnapshot } from '../cpaData'
beforeEach(() => vi.clearAllMocks())

describe('CPA query availability metadata', () => {
  it('keeps the legacy array reader unchanged', async () => {
    invoke.mockResolvedValue('[]')
    expect(await getCliproxyUsageEvents()).toEqual([])
    expect(invoke).toHaveBeenCalledWith('read_cliproxy_usage_events')
  })

  it.each([true, false])('preserves the native availability flag for an empty result: %s', async (available) => {
    const result = { available, events: [], readStartMs: available ? 1 : null, readEndMs: available ? 2 : null }
    invoke.mockResolvedValue(JSON.stringify(result))
    expect(await getCliproxyUsageSnapshot()).toEqual(result)
    expect(invoke).toHaveBeenCalledWith('read_cliproxy_usage_events', { withMetadata: true })
  })

  it('does not claim availability when an older native build returns only an array', async () => {
    invoke.mockResolvedValue('[]')
    expect(await getCliproxyUsageSnapshot()).toEqual({ available: false, events: [], readStartMs: null, readEndMs: null })
  })

  it('passes an exact millisecond period rather than computing a second 30-day anchor', async () => {
    const window = { start: new Date('2026-09-16T12:00:00.123Z'), end: new Date('2026-10-16T12:00:00.123Z') }
    invoke.mockResolvedValue(JSON.stringify({ available: true, events: [], readStartMs: window.start.getTime(), readEndMs: window.end.getTime() }))
    await getCliproxyUsageSnapshot(window)
    expect(invoke).toHaveBeenCalledWith('read_cliproxy_usage_events', { withMetadata: true, startMs: window.start.getTime(), endMs: window.end.getTime() })
  })

  it.each([
    { start: new Date(NaN), end: new Date() },
    { start: new Date(2), end: new Date(1) },
    { start: new Date(1), end: new Date(1) },
  ])('rejects invalid parser bounds before invoking native code', async (window) => {
    await expect(getCliproxyUsageSnapshot(window)).rejects.toThrow('Invalid CPA query window')
    expect(invoke).not.toHaveBeenCalled()
  })
})
