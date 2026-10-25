import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
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

describe('native CPA SQL half-open bounds', () => {
  const source = readFileSync(resolve(process.cwd(), 'src-tauri/src/main.rs'), 'utf8')
  const python = source.match(/let script = r#"(import sqlite3, json, sys, time[\s\S]*?)"#\.replace\("__DB__"/i)?.[1]
  const columns = 'requested_at provider executor_type model alias auth_index auth_type source reasoning_effort service_tier latency_ms ttft_ms failed status_code input_tokens output_tokens reasoning_tokens cached_tokens cache_read_tokens cache_creation_tokens total_tokens primary_used_percent primary_reset_at primary_used_tokens primary_remaining_tokens primary_limit_tokens secondary_used_percent secondary_reset_at secondary_used_tokens secondary_remaining_tokens secondary_limit_tokens'.split(' ')
  function query(start: number | null, end: number | null, metadata = true) {
    expect(python).toBeTruthy()
    const setup = `con = sqlite3.connect(':memory:')\ncon.execute('CREATE TABLE usage_events (${columns.join(',')})')\ncon.executemany('INSERT INTO usage_events(requested_at) VALUES (?)', [(10,), (11,), (12,)])`
    const script = python!.replace('con = sqlite3.connect("file:__DB__?mode=ro", uri=True)', setup)
      .replaceAll('__START_MS__', start == null ? 'None' : String(start))
      .replaceAll('__END_MS__', end == null ? 'None' : String(end))
      .replaceAll('__META__', metadata ? 'True' : 'False')
    const result = spawnSync('python', ['-c', script], { encoding: 'utf8', windowsHide: true })
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }

  it.each([
    { start: 10000, end: 11000, expected: 10000 },
    { start: 10001, end: 11001, expected: 11000 },
  ])('uses the same exact [$start,$end) for SQL and metadata', ({ start, end, expected }) => {
    const result = query(start, end)
    expect(result).toMatchObject({ available: true, readStartMs: start, readEndMs: end })
    expect(result.events.map((row: { requested_at: number }) => row.requested_at)).toEqual([expected])
  })

  it('retains the default 30-day period and legacy array output', () => {
    const result = query(null, null)
    expect(result.readEndMs - result.readStartMs).toBe(30 * 86400000)
    expect(query(null, null, false)).toEqual([])
  })
})
